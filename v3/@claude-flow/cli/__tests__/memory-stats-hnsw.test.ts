/**
 * Regression test for the "HNSW Index: not active" bug.
 *
 * `ruflo memory stats` and `ruflo doctor` were reporting `HNSW Index:
 * not active` despite HNSW being wired in (768-dim mpnet, m=23/efC=100/efS=50
 * per ADR-0069). Two root causes:
 *
 *   1. The reporter called `getController('enhancedEmbedding')` but the
 *      registry registers the controller under the canonical name
 *      `enhancedEmbeddingService` (see controller-registry.ts INIT_LEVELS
 *      level 3). The short-name lookup always returned null.
 *
 *   2. Even with the correct name, `EnhancedEmbeddingService` is a WASM
 *      batch-embedding helper — it has no HNSW state, no `isReady()`, and
 *      its `getStats()` returns `{cacheSize, wasmEnabled, simdEnabled}`,
 *      not `totalEntries`. It's the wrong proxy.
 *
 * Fix: read HNSW state from the storage layer (`routeEmbeddingOp({type:
 * 'hnswStatus'})`), which calls `RvfBackend.getStats()` — the authoritative
 * source per ADR-0086 ("HNSW managed internally by RvfBackend"). When the
 * backend has an HnswLite index wired in, `hnswStats` is present with
 * `vectorCount`. Absence means HNSW is not active.
 *
 * Per memory `feedback-no-fallbacks`: this test mocks the router contract
 * directly (the canonical authority) and asserts the reporter translates
 * the canonical signal into the user-visible row text. It does NOT mock
 * around a silent fallback path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock memory-router so we can drive `routeEmbeddingOp` deterministically.
// loadEmbeddingModel is also mocked to keep the test hermetic (no Xenova
// download). The stats command imports memory-router dynamically inside
// the introspection block — vitest's vi.mock intercepts that dynamic
// import the same way it intercepts a static one.
vi.mock('../src/memory/memory-router.js', () => ({
  loadEmbeddingModel: vi.fn(async () => ({
    success: true,
    modelName: 'Xenova/all-mpnet-base-v2',
    dimensions: 768,
    loadTime: 0,
  })),
  routeEmbeddingOp: vi.fn(),
  // Other exports referenced elsewhere in memory.ts (other subcommands).
  routeMemoryOp: vi.fn(async () => ({ success: true })),
  ensureRouter: vi.fn(async () => {}),
  resetRouter: vi.fn(),
  getController: vi.fn(async () => null),
}));

// stats reads the top-of-table numbers via callMCPTool('memory_stats').
// Stub that so the command doesn't try to talk to a real MCP server.
vi.mock('../src/mcp-client.js', () => ({
  callMCPTool: vi.fn(async (tool: string) => {
    if (tool === 'memory_stats') {
      return {
        backend: 'SQLite + HNSW',
        version: '3.0.0',
        totalEntries: 8,
        totalSize: '1 KB',
        location: '/tmp/test',
        oldestEntry: null,
        newestEntry: null,
      };
    }
    return {};
  }),
  MCPClientError: class MCPClientError extends Error {
    constructor(message: string, public toolName: string, public cause?: Error) {
      super(message);
      this.name = 'MCPClientError';
    }
  },
}));

import { memoryCommand } from '../src/commands/memory.js';
import * as memoryRouter from '../src/memory/memory-router.js';
import type { CommandContext } from '../src/types.js';

function makeCtx(): CommandContext {
  return {
    command: 'stats',
    args: [],
    flags: { _: [] },
    cwd: '/test',
    interactive: false,
  };
}

async function runStatsAndCaptureStdout(): Promise<string> {
  const statsCmd = memoryCommand.subcommands?.find((c) => c.name === 'stats');
  expect(statsCmd, 'memory stats subcommand must exist').toBeDefined();
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, ..._args: any[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await statsCmd!.action!(makeCtx());
  } finally {
    process.stdout.write = origWrite;
  }
  return chunks.join('');
}

describe('memory stats — HNSW Index row (regression for "not active" bug)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports "active" when routeEmbeddingOp returns hnswStats with vectors', async () => {
    vi.mocked(memoryRouter.routeEmbeddingOp).mockResolvedValue({
      success: true,
      totalEntries: 8,
      entriesWithEmbeddings: 8,
      hnswStats: {
        vectorCount: 8,
        memoryUsage: 24576,
        avgSearchTime: 0,
        buildTime: 0,
      },
    } as never);

    const out = await runStatsAndCaptureStdout();
    // Confirm the reporter consulted the canonical authority.
    expect(memoryRouter.routeEmbeddingOp).toHaveBeenCalledWith({ type: 'hnswStatus' });
    // The HNSW Index row should NOT say "not active".
    expect(out).not.toMatch(/HNSW Index.*not active/);
    // It should say "active" and include the vector count.
    expect(out).toMatch(/HNSW Index/);
    expect(out).toMatch(/active.*8/);
  });

  it('reports "active" with 0 entries when hnswStats is present but empty', async () => {
    // Fresh init: index is wired in but no vectors stored yet. Per
    // `feedback-no-fallbacks`, the user-visible signal must say "active"
    // — the index IS active, it just has nothing in it. Reporting "not
    // active" here would mask the failure of the underlying boot path
    // by attributing it to "empty".
    vi.mocked(memoryRouter.routeEmbeddingOp).mockResolvedValue({
      success: true,
      totalEntries: 0,
      hnswStats: {
        vectorCount: 0,
        memoryUsage: 0,
        avgSearchTime: 0,
        buildTime: 0,
      },
    } as never);

    const out = await runStatsAndCaptureStdout();
    expect(out).not.toMatch(/HNSW Index.*not active/);
    expect(out).toMatch(/HNSW Index/);
  });

  it('reports "not active" only when hnswStats is absent from the storage stats', async () => {
    // This is the genuine "HNSW is not wired" case (e.g. native rvf-node
    // owns the index internally and RvfBackend.hnswIndex is null). The
    // row legitimately says "not active" here. The bug being regressed is
    // that the previous code reported "not active" even when hnswStats
    // WAS present — covered by the first two cases above.
    vi.mocked(memoryRouter.routeEmbeddingOp).mockResolvedValue({
      success: true,
      totalEntries: 8,
      entriesWithEmbeddings: 8,
      // No hnswStats key.
    } as never);

    const out = await runStatsAndCaptureStdout();
    expect(out).toMatch(/HNSW Index.*not active/);
  });

  it('does NOT call the old getController("enhancedEmbedding") path', async () => {
    // Anti-regression: before the fix the reporter called
    // `getController('enhancedEmbedding')` (wrong name, wrong proxy).
    // After the fix it must use routeEmbeddingOp({type:'hnswStatus'})
    // exclusively for HNSW state.
    vi.mocked(memoryRouter.routeEmbeddingOp).mockResolvedValue({
      success: true,
      hnswStats: { vectorCount: 1, memoryUsage: 0, avgSearchTime: 0, buildTime: 0 },
    } as never);
    await runStatsAndCaptureStdout();
    // getController is mocked above; if any caller in the HNSW branch
    // invokes it, it would show up here.
    const gcCalls = vi.mocked(memoryRouter.getController).mock.calls;
    const enhancedEmbeddingCalls = gcCalls.filter((c) => c[0] === 'enhancedEmbedding');
    expect(enhancedEmbeddingCalls.length).toBe(0);
  });
});
