/**
 * ADR-0247 site #1 (F-04-009) — callMCPTool must inspect `isError` envelope.
 *
 * Before this fix, `callMCPTool` returned the raw `{ isError: true, content: ... }`
 * envelope. Consumers destructuring `{ safe } = await callMCPTool(...)` saw
 * `undefined` and `if (!safe)` couldn't distinguish a real "unsafe" verdict
 * from a swallowed error.
 *
 * After the fix:
 *   - isError:true → throw MCPClientError with synthesised `cause` Error
 *   - isError:false (or absent) → return as-is (unchanged behaviour)
 *
 * Complement to ADR-0242 (server-side handler-throw rule). The two ADRs
 * operate on disjoint seams (handlers vs callMCPTool).
 */

import { describe, it, expect, vi } from 'vitest';

// Mock just enough of the tool registry to exercise the isError path. We
// reuse the same "mock all the tool modules" approach as mcp-client.test.ts.

vi.mock('../src/mcp-tools/agent-tools.js', () => ({
  agentTools: [
    {
      name: 'mock_iserror',
      description: 'Mock tool that returns isError envelope',
      category: 'mock',
      inputSchema: { type: 'object', properties: {} },
      handler: vi.fn(async () => ({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: 'simulated' }) }],
      })),
    },
    {
      name: 'mock_ok',
      description: 'Mock tool returning a normal envelope',
      category: 'mock',
      inputSchema: { type: 'object', properties: {} },
      handler: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify({ value: 'ok' }) }],
        isError: false,
      })),
    },
    {
      name: 'mock_iserror_no_content',
      description: 'Mock tool returning isError with empty content',
      category: 'mock',
      inputSchema: { type: 'object', properties: {} },
      handler: vi.fn(async () => ({ isError: true })),
    },
    {
      name: 'mock_iserror_plain_text',
      description: 'Mock tool returning isError with non-JSON text',
      category: 'mock',
      inputSchema: { type: 'object', properties: {} },
      handler: vi.fn(async () => ({
        isError: true,
        content: [{ type: 'text', text: 'raw error message' }],
      })),
    },
  ],
}));

// Stub the rest of the tool-module imports so mcp-client.ts loads cleanly.
const empty = (key: string) => ({ [key]: [] });
vi.mock('../src/mcp-tools/swarm-tools.js', () => empty('swarmTools'));
vi.mock('../src/mcp-tools/memory-tools.js', () => empty('memoryTools'));
vi.mock('../src/mcp-tools/config-tools.js', () => empty('configTools'));
vi.mock('../src/mcp-tools/hooks-tools.js', () => empty('hooksTools'));
vi.mock('../src/mcp-tools/task-tools.js', () => empty('taskTools'));
vi.mock('../src/mcp-tools/session-tools.js', () => empty('sessionTools'));
vi.mock('../src/mcp-tools/hive-mind-tools.js', () => empty('hiveMindTools'));
vi.mock('../src/mcp-tools/workflow-tools.js', () => empty('workflowTools'));
vi.mock('../src/mcp-tools/analyze-tools.js', () => empty('analyzeTools'));
vi.mock('../src/mcp-tools/progress-tools.js', () => empty('progressTools'));
vi.mock('../src/mcp-tools/embeddings-tools.js', () => empty('embeddingsTools'));
vi.mock('../src/mcp-tools/claims-tools.js', () => empty('claimsTools'));
vi.mock('../src/mcp-tools/security-tools.js', () => empty('securityTools'));
vi.mock('../src/mcp-tools/transfer-tools.js', () => empty('transferTools'));
vi.mock('../src/mcp-tools/system-tools.js', () => empty('systemTools'));
vi.mock('../src/mcp-tools/terminal-tools.js', () => empty('terminalTools'));
vi.mock('../src/mcp-tools/neural-tools.js', () => empty('neuralTools'));
vi.mock('../src/mcp-tools/performance-tools.js', () => empty('performanceTools'));
vi.mock('../src/mcp-tools/github-tools.js', () => empty('githubTools'));
vi.mock('../src/mcp-tools/daa-tools.js', () => empty('daaTools'));
vi.mock('../src/mcp-tools/coordination-tools.js', () => empty('coordinationTools'));
vi.mock('../src/mcp-tools/browser-tools.js', () => empty('browserTools'));
vi.mock('../src/mcp-tools/browser-session-tools.js', () => empty('browserSessionTools'));
vi.mock('../src/mcp-tools/agentdb-tools.js', () => empty('agentdbTools'));
vi.mock('../src/mcp-tools/ruvllm-tools.js', () => empty('ruvllmWasmTools'));
vi.mock('../src/mcp-tools/wasm-agent-tools.js', () => empty('wasmAgentTools'));
vi.mock('../src/mcp-tools/guidance-tools.js', () => empty('guidanceTools'));
vi.mock('../src/mcp-tools/autopilot-tools.js', () => empty('autopilotTools'));

const { callMCPTool, MCPClientError } = await import('../src/mcp-client.js');

describe('ADR-0247 site #1 — callMCPTool isError envelope inspection', () => {
  it('throws MCPClientError when handler returns isError:true envelope', async () => {
    await expect(callMCPTool('mock_iserror')).rejects.toThrow(MCPClientError);
  });

  it('preserves the simulated error message in cause.message', async () => {
    try {
      await callMCPTool('mock_iserror');
      throw new Error('callMCPTool should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(MCPClientError);
      const mcpErr = err as InstanceType<typeof MCPClientError>;
      expect(mcpErr.toolName).toBe('mock_iserror');
      expect(mcpErr.cause).toBeInstanceOf(Error);
      expect(mcpErr.cause?.message).toContain('simulated');
      expect(mcpErr.message).toContain('isError envelope');
      expect(mcpErr.message).toContain('simulated');
    }
  });

  it('returns normally for tools that do not signal isError', async () => {
    const result = await callMCPTool<{ content: unknown[]; isError: boolean }>('mock_ok');
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
  });

  it('throws sensibly when isError envelope has no content', async () => {
    try {
      await callMCPTool('mock_iserror_no_content');
      throw new Error('callMCPTool should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(MCPClientError);
      expect((err as InstanceType<typeof MCPClientError>).cause).toBeInstanceOf(Error);
      expect((err as InstanceType<typeof MCPClientError>).cause?.message).toContain('no content');
    }
  });

  it('falls back to raw text when content text is not JSON', async () => {
    try {
      await callMCPTool('mock_iserror_plain_text');
      throw new Error('callMCPTool should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(MCPClientError);
      expect((err as InstanceType<typeof MCPClientError>).cause?.message).toContain('raw error message');
    }
  });

  it('does NOT double-wrap when the synthetic throw bubbles up', async () => {
    // The outer try/catch in callMCPTool must re-throw MCPClientError as-is
    // (not wrap it into "Failed to execute MCP tool 'X': MCP tool ..."). This
    // verifies the cause chain is preserved.
    try {
      await callMCPTool('mock_iserror');
    } catch (err) {
      expect((err as InstanceType<typeof MCPClientError>).message).not.toMatch(/^Failed to execute MCP tool/);
      // cause should be the synthesised Error, not another MCPClientError
      expect((err as InstanceType<typeof MCPClientError>).cause).not.toBeInstanceOf(MCPClientError);
    }
  });
});
