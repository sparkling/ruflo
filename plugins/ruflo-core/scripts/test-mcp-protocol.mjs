#!/usr/bin/env node
/**
 * Regression guard for ruvnet/ruflo#1874.
 *
 * Boots an HTTP MCP server (or talks to a stdio one), sends a real
 * `initialize` JSON-RPC request, and validates the response against
 * the [MCP spec's required shape](https://spec.modelcontextprotocol.io/specification/basic/lifecycle/#initialization).
 *
 * The bug this catches: returning `protocolVersion` as an object like
 * `{major,minor,patch}` instead of the spec-required `YYYY-MM-DD`
 * string. Claude Code's Zod validator rejects with "Invalid input:
 * expected string, received object" — a connection-blocking failure
 * that the existing in-process unit tests didn't catch because the
 * tests asserted the wrong shape (test and prod agreed on the bug).
 *
 * Validates:
 *   - response.result.protocolVersion is a string
 *   - matches /^\d{4}-\d{2}-\d{2}$/ (date-shaped)
 *   - response.result.capabilities is an object
 *   - response.result.serverInfo has {name, version} strings
 *
 * Usage:
 *   node plugins/ruflo-core/scripts/test-mcp-protocol.mjs <cli-invocation>
 *   # cli-invocation defaults to "node v3/@claude-flow/cli/bin/cli.js"
 *
 * Wired into v3-ci.yml as the `mcp-protocol-smoke` job.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CLI = process.argv[2] ?? 'node v3/@claude-flow/cli/bin/cli.js';
const PORT = process.env.PORT ?? 41874; // arbitrary, avoid common ports
const TIMEOUT_MS = 30_000;

// Spec-required shape per https://spec.modelcontextprotocol.io/specification/basic/lifecycle/#initialization
const SPEC_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

let server;
let failed = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed++; };
const pass = (msg) => console.log(`ok: ${msg}`);

try {
  // Boot the server. Splitting CLI on whitespace gives [executable, ...args].
  const [bin, ...binArgs] = CLI.split(/\s+/);
  server = spawn(bin, [...binArgs, 'mcp', 'start', '-t', 'http', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {}); // drain
  server.stderr.on('data', () => {}); // drain

  // Wait until the port responds. Poll every 200ms up to 15s.
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
        signal: AbortSignal.timeout(500),
      });
      if (r.status < 600) { ready = true; break; }
    } catch { /* not yet */ }
    await sleep(200);
  }
  if (!ready) { fail(`server didn't become ready on :${PORT} within 15s`); throw new Error('boot timeout'); }
  pass(`server is listening on :${PORT}`);

  // Send the real initialize request — same wire format Claude Code uses.
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ruflo-protocol-smoke', version: '1.0' },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) fail(`HTTP ${res.status} from /mcp`);
  else pass(`HTTP 200 from /mcp`);

  const body = await res.json();
  if (body.error) fail(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  if (!body.result) { fail('response has no .result'); throw new Error('no result'); }
  pass('JSON-RPC response has .result');

  const r = body.result;

  // ── Spec compliance assertions ──────────────────────────────────
  if (typeof r.protocolVersion !== 'string') {
    fail(`protocolVersion is ${typeof r.protocolVersion} (${JSON.stringify(r.protocolVersion)}) — spec requires string`);
  } else if (!SPEC_DATE_REGEX.test(r.protocolVersion)) {
    fail(`protocolVersion '${r.protocolVersion}' doesn't match YYYY-MM-DD spec`);
  } else {
    pass(`protocolVersion is spec-compliant string: '${r.protocolVersion}'`);
  }

  if (typeof r.capabilities !== 'object' || r.capabilities === null) {
    fail(`capabilities is ${typeof r.capabilities} — spec requires object`);
  } else {
    pass('capabilities is an object');
  }

  if (typeof r.serverInfo !== 'object' || r.serverInfo === null) {
    fail(`serverInfo is ${typeof r.serverInfo} — spec requires object`);
  } else if (typeof r.serverInfo.name !== 'string' || typeof r.serverInfo.version !== 'string') {
    fail(`serverInfo.{name,version} must be strings; got name=${typeof r.serverInfo.name} version=${typeof r.serverInfo.version}`);
  } else {
    pass(`serverInfo: ${r.serverInfo.name} ${r.serverInfo.version}`);
  }

  // ── Final: this is what Claude Code's Zod expects ───────────────
  // From the issue's error message:
  //   {"expected":"string","code":"invalid_type","path":["protocolVersion"]}
  // If we passed the protocolVersion check above, Claude Code would
  // accept this response. Mirror that finding:
  if (typeof r.protocolVersion === 'string' && SPEC_DATE_REGEX.test(r.protocolVersion)) {
    pass('Claude Code Zod compatibility: would accept this response');
  }
} catch (e) {
  fail(`unexpected: ${e?.message ?? String(e)}`);
} finally {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await sleep(500);
    if (!server.killed) server.kill('SIGKILL');
  }
}

console.log(failed === 0 ? '\nall MCP-protocol assertions passed ✓' : `\n${failed} assertion(s) failed ✗`);
process.exit(failed > 0 ? 1 : 0);
