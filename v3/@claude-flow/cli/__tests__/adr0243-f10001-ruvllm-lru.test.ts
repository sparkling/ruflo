/**
 * ADR-0243 F-10-001 — bounded LRU on ruvllm-tools.ts module-scope Maps.
 *
 * Before this ADR, three module-scope Maps (`hnswRouters`,
 * `sonaInstances`, `loraInstances`) accumulated a NAPI/WASM-backed handle
 * for every distinct id ever seen, with no LRU, no TTL, no eviction. On
 * the long-lived MCP-stdio process this leaked. The fix wraps each Map
 * in `BoundedLRU<string, ...>` with cap = `CLAUDE_FLOW_RUVLLM_CACHE_MAX`
 * (default 64) and a dispose probe (destroy/free/dispose in priority
 * order) so the JS Map AND the underlying WASM heap are both bounded.
 *
 * Per ADR-0243 §Critique Expert 1 (NAPI/WASM lifecycle), this test
 * asserts BOTH:
 *   1. The cache size stays at the cap regardless of how many ids the
 *      tool creates.
 *   2. The dispose contract fires on every eviction — verified via the
 *      mocked WASM handle's `destroy` spy (proxy for the WASM-heap
 *      reclaim path).
 *
 * It does NOT measure process RSS directly — RSS in a vitest worker is
 * a noisy proxy and the test would be flaky. The dispose-call count is
 * the unambiguous signal that the WASM heap is reclaimable; the RSS
 * shape follows from the dispose contract being honoured.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track dispose calls per handle id so we can correlate with the
// `ruvllm_hnsw_create` calls below.
const disposeCalls: string[] = [];

function makeMockRouter(id: string) {
  return {
    addPattern: vi.fn().mockReturnValue(true),
    route: vi.fn().mockReturnValue([]),
    clear: vi.fn(),
    patternCount: vi.fn().mockReturnValue(0),
    toJson: vi.fn().mockReturnValue('{}'),
    destroy: vi.fn(() => { disposeCalls.push(id); }),
  };
}

// Sequential counter so each createHnswRouter returns a distinguishable mock.
let createCounter = 0;

vi.mock('../src/ruvector/ruvllm-wasm.js', () => ({
  isRuvllmWasmAvailable: vi.fn().mockResolvedValue(true),
  initRuvllmWasm: vi.fn().mockResolvedValue(undefined),
  getRuvllmStatus: vi.fn().mockResolvedValue({ available: true, initialized: true, version: '2.0.1' }),
  createHnswRouter: vi.fn(async () => makeMockRouter(`mock-${createCounter++}`)),
  createSonaInstant: vi.fn().mockResolvedValue({
    adapt: vi.fn(), recordPattern: vi.fn(), suggestAction: vi.fn().mockReturnValue('x'),
    stats: vi.fn().mockReturnValue('{}'), reset: vi.fn(), toJson: vi.fn().mockReturnValue('{}'),
  }),
  createMicroLora: vi.fn().mockResolvedValue({
    apply: vi.fn().mockReturnValue(new Float32Array(8)),
    adapt: vi.fn(), applyUpdates: vi.fn(), stats: vi.fn().mockReturnValue('{}'),
    reset: vi.fn(), toJson: vi.fn().mockReturnValue('{}'), pendingUpdates: vi.fn().mockReturnValue(0),
  }),
  formatChat: vi.fn(),
  createGenerateConfig: vi.fn(),
  createKvCache: vi.fn(),
  createBufferPool: vi.fn(),
  createInferenceArena: vi.fn(),
  HNSW_MAX_SAFE_PATTERNS: 11,
}));

// Mock the persistence store so each create doesn't touch disk.
vi.mock('../src/mcp-tools/ruvllm-store.js', () => ({
  persistHnswCreate: vi.fn(),
  persistHnswAdd: vi.fn(),
  getHnswRecord: vi.fn().mockReturnValue(undefined),
  persistSonaCreate: vi.fn(),
  persistSonaAdapt: vi.fn(),
  getSonaRecord: vi.fn().mockReturnValue(undefined),
  persistMicroLoraCreate: vi.fn(),
  persistMicroLoraAdapt: vi.fn(),
  getMicroLoraRecord: vi.fn().mockReturnValue(undefined),
}));

// Module must be imported AFTER the mocks are wired so the module-scope
// LRU is constructed against the mocked persistence layer.
async function importTools() {
  const mod = await import('../src/mcp-tools/ruvllm-tools.js');
  return mod.ruvllmWasmTools;
}

describe('ADR-0243 F-10-001 — ruvllm-tools BoundedLRU + dispose probe', () => {
  beforeEach(() => {
    disposeCalls.length = 0;
    createCounter = 0;
    vi.clearAllMocks();
  });

  it('caps hnswRouters at CLAUDE_FLOW_RUVLLM_CACHE_MAX (default 64) and disposes evicted handles', async () => {
    const tools = await importTools();
    const createTool = tools.find(t => t.name === 'ruvllm_hnsw_create');
    if (!createTool) throw new Error('ruvllm_hnsw_create not found');

    // Cycle 200 distinct ids through the create path. The LRU's cap is 64;
    // ids 0..135 should be evicted (200 created - 64 retained = 136 evicted)
    // and each eviction MUST invoke the mocked `destroy` on the underlying
    // handle (the WASM heap reclaim contract per ADR-0243 §Critique
    // Expert 1).
    for (let i = 0; i < 200; i++) {
      const result = await createTool.handler({ dimensions: 64, maxPatterns: 10 }) as any;
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    }

    // 200 creates - 64 cap = 136 evictions; each must call destroy exactly once.
    expect(disposeCalls.length).toBe(136);
    expect(new Set(disposeCalls).size).toBe(136); // all distinct ids

    // Earliest creates (mock-0 .. mock-135) should be the ones evicted.
    expect(disposeCalls[0]).toBe('mock-0');
    expect(disposeCalls[135]).toBe('mock-135');
  });

  it('rejects an invalid CLAUDE_FLOW_RUVLLM_CACHE_MAX (fail-loud per feedback-no-fallbacks)', async () => {
    // Re-import bounded-lru directly to assert the env-parse path; doing
    // it via the module-scope construction would require a fresh process.
    const { BoundedLRU } = await import('../src/utils/bounded-lru.js');
    const prev = process.env.CLAUDE_FLOW_RUVLLM_CACHE_MAX_INVALIDTEST;
    process.env.CLAUDE_FLOW_RUVLLM_CACHE_MAX_INVALIDTEST = 'not-a-number';
    try {
      expect(() => BoundedLRU.readEnvMax('CLAUDE_FLOW_RUVLLM_CACHE_MAX_INVALIDTEST', 64))
        .toThrow(/must be a positive integer/);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_FLOW_RUVLLM_CACHE_MAX_INVALIDTEST;
      else process.env.CLAUDE_FLOW_RUVLLM_CACHE_MAX_INVALIDTEST = prev;
    }
  });

  it('dispose probe finds destroy/free/dispose in priority order', async () => {
    const { BoundedLRU } = await import('../src/utils/bounded-lru.js');
    const calls: string[] = [];
    const handleWithDestroy = { destroy: () => calls.push('destroy'), free: () => calls.push('free') };
    const handleWithFree = { free: () => calls.push('free-only') };
    const handleWithDispose = { dispose: () => calls.push('dispose-only') };
    const handlePlain = { value: 42 };

    const lru = new BoundedLRU<string, any>({ maxEntries: 2 });
    lru.set('a', handleWithDestroy);
    lru.set('b', handleWithFree);
    lru.set('c', handleWithDispose); // evicts 'a' → destroy fires
    expect(calls).toEqual(['destroy']);
    lru.set('d', handlePlain); // evicts 'b' → free fires
    expect(calls).toEqual(['destroy', 'free-only']);
    lru.clear(); // disposes 'c' (dispose-only) and 'd' (no probe)
    expect(calls).toEqual(['destroy', 'free-only', 'dispose-only']);
  });
});
