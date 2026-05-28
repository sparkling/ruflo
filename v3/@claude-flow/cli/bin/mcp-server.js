#!/usr/bin/env node
/**
 * @claude-flow/cli - MCP Server Entry Point
 *
 * Direct stdio MCP server for Claude Code integration.
 * This entry point handles stdin/stdout directly for MCP protocol
 * without any CLI formatting output that would corrupt the protocol.
 */

import { randomUUID } from 'crypto';

// Suppress the SPECIFIC cosmetic "[AgentDB Patch] Controller index not found"
// noise. Tight match (both prefix AND "Controller index not found") so other
// [AgentDB Patch] warnings about real issues still flow through. Also patch
// console.log because the underlying call site uses it. See bin/cli.js for
// the same rationale.
const _origWarn = console.warn;
const _origLog = console.log;
const _isCosmeticAgentdbPatchNoise = (msg) =>
  msg.includes('[AgentDB Patch]') && msg.includes('Controller index not found');
console.warn = (...args) => {
  if (_isCosmeticAgentdbPatchNoise(String(args[0] ?? ''))) return;
  _origWarn.apply(console, args);
};
console.log = (...args) => {
  if (_isCosmeticAgentdbPatchNoise(String(args[0] ?? ''))) return;
  _origLog.apply(console, args);
};

import { listMCPTools, callMCPTool, hasTool } from '../dist/src/mcp-client.js';

const VERSION = '3.0.0';
const sessionId = `mcp-${Date.now()}-${randomUUID().slice(0, 8)}`;

// Log to stderr (doesn't corrupt stdout for MCP protocol)
console.error(
  `[${new Date().toISOString()}] INFO [ruflo-mcp] (${sessionId}) Starting in stdio mode`
);

// ADR-0204 (a) F-09-011: wire the archivist substrate before any tool call (the
// only route to archivist.dispatch()), but do NOT block the JSON-RPC handshake
// on it — `initialize`/`tools/list` need no archivist; only `tools/call` awaits
// `archivistReady` below.
//
// ADR-0267 fix (Option F final — bin entry): the warmUpRvfWithRetry call was
// the actual lock holder. The cli MCP server process keeps _isPersistent=true
// by default, so once warmup opens the RVF backend the kernel flock stays
// held for the server's lifetime → blocks CLI memory operations from a
// separate process.
//
// Resolution: defer warmUpRvfWithRetry to the first `tools/call` that needs
// the RVF substrate. initProcessArchivist alone is safe — it does NOT open
// RVF (verified by reading the function body: no calls to ensureRouter /
// ensureRvfWired). The first archivist.dispatch / routeMemoryOp call from
// inside a tool handler triggers ensureRvfWired lazily, which is the
// existing memo-only-success path.
//
// Trade-off accepted: structural RVF faults surface in the first tool-call
// error frame instead of at MCP server startup. Equivalent for a long-lived
// server — the fault still surfaces LOUDLY.
const { initProcessArchivist, ensureRvfWired } = await import('../dist/src/memory/archivist-init.js');
let archivistFatal = null;
let rvfWarmedUp = false;
const archivistReady = (async () => {
  await initProcessArchivist();
})().catch((err) => {
  archivistFatal = err instanceof Error ? err : new Error(String(err));
});
// Lazy RVF warmup — invoked from tools/call below on first need; memoized
// after first success so subsequent calls are no-ops.
async function ensureRvfWarmedUp() {
  if (rvfWarmedUp) return;
  await ensureRvfWired();
  rvfWarmedUp = true;
}

// ADR-0204 (b) F-09-001: import validateSchema for tools/call pre-validation.
const { validateSchema } = await import('@claude-flow/mcp/schema-validator');

console.error(JSON.stringify({
  arch: process.arch,
  mode: 'mcp-stdio',
  nodeVersion: process.version,
  pid: process.pid,
  platform: process.platform,
  protocol: 'stdio',
  sessionId,
  version: VERSION,
}));

// Lost-reply fix: MCP stdio JSON-RPC frames MUST go to the raw stdout channel,
// never through console.log — controller/registry init monkey-patches
// console.log to keep controller noise off stdout, and that patch can swallow a
// reply frame written via console.log. process.stdout.write is immune to any
// in-process console reassignment (the same separation stderr gets via console.error).
const writeFrame = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// Handle stdin messages
// Audit-flagged DoS protection (audit_1776483149979): cap stdin buffer
// to 10MB. See bin/cli.js for the same protection on the auto-detect path.
const MCP_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;

  if (buffer.length > MCP_MAX_BUFFER_BYTES) {
    writeFrame({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: `Buffered stdin exceeds ${MCP_MAX_BUFFER_BYTES} bytes without newline; resetting`,
      },
    });
    buffer = '';
    return;
  }

  // Process complete JSON messages (newline-delimited)
  let lines = buffer.split('\n');
  buffer = lines.pop() || ''; // Keep incomplete line in buffer

  for (const line of lines) {
    if (line.trim()) {
      try {
        const message = JSON.parse(line);
        const response = await handleMessage(message);
        if (response) {
          writeFrame(response);
        }
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] ERROR [ruflo-mcp] Failed to parse:`,
          error instanceof Error ? error.message : String(error)
        );
        // Send parse error response
        writeFrame({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
    }
  }
});

process.stdin.on('end', () => {
  console.error(
    `[${new Date().toISOString()}] INFO [ruflo-mcp] (${sessionId}) stdin closed, shutting down...`
  );
  process.exit(0);
});

// Handle process termination
process.on('SIGINT', () => {
  console.error(`[${new Date().toISOString()}] INFO [ruflo-mcp] Received SIGINT`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error(`[${new Date().toISOString()}] INFO [ruflo-mcp] Received SIGTERM`);
  process.exit(0);
});

/**
 * Handle MCP message
 */
async function handleMessage(message) {
  if (!message.method) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32600, message: 'Invalid Request: missing method' },
    };
  }

  const params = message.params || {};

  try {
    switch (message.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'ruflo', version: VERSION },
            capabilities: {
              tools: { listChanged: true },
              resources: { subscribe: true, listChanged: true },
            },
          },
        };

      case 'tools/list': {
        const tools = listMCPTools();
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        };
      }

      case 'tools/call': {
        const toolName = params.name;
        const toolParams = params.arguments || {};

        if (!hasTool(toolName)) {
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Tool not found: ${toolName}` },
          };
        }

        // ADR-0204 (b) F-09-001: validate input schema before reaching the handler.
        const toolMeta = listMCPTools().find(t => t.name === toolName);
        if (toolMeta?.inputSchema) {
          const vr = validateSchema(toolParams, toolMeta.inputSchema);
          if (!vr.valid) {
            const diag = vr.errors.map(e => `${e.path ? e.path + ': ' : ''}${e.message}`).join('; ');
            return {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32602, message: `Invalid params: ${diag}` },
            };
          }
        }

        // ADR-0204 (a) F-09-011: ensure the archivist substrate is wired before
        // dispatch (the handshake did not wait for it). Fatal warm-up → loud error.
        // ADR-0267 Option F: warmUpRvfWithRetry was moved out of archivistReady
        // to avoid holding the RVF flock for the server's lifetime; the lazy
        // ensureRvfWarmedUp() call below triggers it on first tools/call.
        await archivistReady;
        if (archivistFatal) {
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: `Archivist substrate failed to initialize: ${archivistFatal.message}` },
          };
        }
        try {
          await ensureRvfWarmedUp();
        } catch (rvfErr) {
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32603,
              message: `RVF substrate failed to initialize: ${rvfErr instanceof Error ? rvfErr.message : String(rvfErr)}`,
            },
          };
        }

        try {
          const result = await callMCPTool(toolName, toolParams, { sessionId });
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Tool execution failed',
            },
          };
        }
      }

      case 'notifications/initialized':
        console.error(`[${new Date().toISOString()}] INFO [ruflo-mcp] Client initialized`);
        return null; // No response for notifications

      case 'ping':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {},
        };

      default:
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        };
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ERROR [ruflo-mcp] ${message.method}:`, error);
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    };
  }
}
