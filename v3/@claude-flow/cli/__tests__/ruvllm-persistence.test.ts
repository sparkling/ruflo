/**
 * Tests for ruvllm persistence (W2-I2).
 *
 * The MCP transport runs each tool invocation in a one-shot process, so the
 * in-memory `hnswRouters` / `sonaInstances` / `loraInstances` registries are
 * wiped between calls. These tests simulate that by clearing the registries
 * via `vi.resetModules()` between "processes" and asserting the journaled
 * state is rebuilt from disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Fresh WASM mocks that actually let us observe the journal replay on rebuild.
function makeMocks() {
  const addedPatterns: Array<{ name: string; embedding: Float32Array }> = [];
  const adaptCalls: number[] = [];
  const loraAdaptCalls: Array<{ quality: number; lr?: number; success?: boolean }> = [];
  const sonaRecordCalls: Array<{ embedding: number[]; success: boolean }> = [];

  const mockRouter = {
    addPattern: vi.fn((p: { name: string; embedding: Float32Array }) => {
      addedPatterns.push({ name: p.name, embedding: p.embedding });
      return true;
    }),
    route: vi.fn((_q: Float32Array, k = 3) =>
      addedPatterns.slice(0, k).map((p, i) => ({ name: p.name, score: 1 - i * 0.1 })),
    ),
    clear: vi.fn(),
    patternCount: vi.fn(() => addedPatterns.length),
    toJson: vi.fn(() => '{}'),
  };

  const mockSona = {
    adapt: vi.fn((q: number) => { adaptCalls.push(q); }),
    recordPattern: vi.fn((embedding: number[], success: boolean) => {
      sonaRecordCalls.push({ embedding, success });
    }),
    suggestAction: vi.fn(() => undefined),
    stats: vi.fn(() => `{"adaptations":${adaptCalls.length}}`),
    reset: vi.fn(),
    toJson: vi.fn(() => '{}'),
  };

  const mockLora = {
    apply: vi.fn(() => new Float32Array(32)),
    adapt: vi.fn((q: number, lr?: number, success?: boolean) => {
      loraAdaptCalls.push({ quality: q, lr, success });
    }),
    applyUpdates: vi.fn(),
    stats: vi.fn(() => `{"adaptations":${loraAdaptCalls.length}}`),
    reset: vi.fn(),
    toJson: vi.fn(() => '{}'),
    pendingUpdates: vi.fn(() => 0),
  };

  return {
    mockRouter, mockSona, mockLora,
    addedPatterns, adaptCalls, loraAdaptCalls, sonaRecordCalls,
  };
}

describe('ruvllm persistence (W2-I2)', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ruvllm-persist-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hnsw_create persists config + id to disk', async () => {
    const mocks = makeMocks();
    vi.doMock('../src/ruvector/ruvllm-wasm.js', () => ({
      createHnswRouter: vi.fn().mockResolvedValue(mocks.mockRouter),
    }));
    const { ruvllmWasmTools } = await import('../src/mcp-tools/ruvllm-tools.js');
    const tool = ruvllmWasmTools.find(t => t.name === 'ruvllm_hnsw_create')!;
    const result = await tool.handler({ dimensions: 4, maxPatterns: 16 }) as any;
    const { routerId } = JSON.parse(result.content[0].text);

    const storePath = join(tmpDir, '.claude-flow', 'ruvllm', 'hnsw-store.json');
    expect(existsSync(storePath)).toBe(true);
    const disk = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(disk.routers[routerId].config).toEqual({ dimensions: 4, maxPatterns: 16, efSearch: undefined });
    expect(disk.routers[routerId].journal).toEqual([]);
  });

  it('cross-process: hnsw_add then hnsw_route replays from disk', async () => {
    // ── Process 1: create + add ────────────────────────────────
    const m1 = makeMocks();
    vi.doMock('../src/ruvector/ruvllm-wasm.js', () => ({
      createHnswRouter: vi.fn().mockResolvedValue(m1.mockRouter),
    }));
    const mod1 = await import('../src/mcp-tools/ruvllm-tools.js');
    const createTool = mod1.ruvllmWasmTools.find(t => t.name === 'ruvllm_hnsw_create')!;
    const createResult = await createTool.handler({ dimensions: 4, maxPatterns: 8 }) as any;
    const { routerId } = JSON.parse(createResult.content[0].text);

    const addTool = mod1.ruvllmWasmTools.find(t => t.name === 'ruvllm_hnsw_add')!;
    await addTool.handler({ routerId, name: 'alpha', embedding: [0.1, 0.2, 0.3, 0.4] });
    await addTool.handler({ routerId, name: 'beta', embedding: [0.5, 0.6, 0.7, 0.8], metadata: { tag: 'x' } });

    // Disk has 2 adds in journal
    const storePath = join(tmpDir, '.claude-flow', 'ruvllm', 'hnsw-store.json');
    expect(JSON.parse(readFileSync(storePath, 'utf-8')).routers[routerId].journal).toHaveLength(2);

    // ── "Process 2": clear modules (== fresh in-memory registry) ──
    vi.resetModules();
    vi.doUnmock('../src/ruvector/ruvllm-wasm.js');

    const m2 = makeMocks();
    vi.doMock('../src/ruvector/ruvllm-wasm.js', () => ({
      createHnswRouter: vi.fn().mockResolvedValue(m2.mockRouter),
    }));
    const mod2 = await import('../src/mcp-tools/ruvllm-tools.js');
    const routeTool = mod2.ruvllmWasmTools.find(t => t.name === 'ruvllm_hnsw_route')!;
    const routeResult = await routeTool.handler({ routerId, query: [0, 0, 0, 0], k: 2 }) as any;

    // No error → persistence + replay worked
    expect(routeResult.isError).toBeUndefined();
    const routed = JSON.parse(routeResult.content[0].text);
    expect(routed.patternCount).toBe(2);
    // Replay should have called addPattern twice on the fresh mock
    expect(m2.mockRouter.addPattern).toHaveBeenCalledTimes(2);
    // Names should have been preserved
    expect(m2.addedPatterns.map(p => p.name)).toEqual(['alpha', 'beta']);
  });

  it('cross-process: sona_adapt journal is replayed', async () => {
    const m1 = makeMocks();
    vi.doMock('../src/ruvector/ruvllm-wasm.js', () => ({
      createSonaInstant: vi.fn().mockResolvedValue(m1.mockSona),
    }));
    const mod1 = await import('../src/mcp-tools/ruvllm-tools.js');
    const createResult = await mod1.ruvllmWasmTools.find(t => t.name === 'ruvllm_sona_create')!
      .handler({ hiddenDim: 16, learningRate: 0.05 }) as any;
    const { sonaId } = JSON.parse(createResult.content[0].text);

    const adaptTool = mod1.ruvllmWasmTools.find(t => t.name === 'ruvllm_sona_adapt')!;
    await adaptTool.handler({ sonaId, quality: 0.5 });
    await adaptTool.handler({ sonaId, quality: 0.8 });

    // Cross-process
    vi.resetModules();
    vi.doUnmock('../src/ruvector/ruvllm-wasm.js');
    const m2 = makeMocks();
    vi.doMock('../src/ruvector/ruvllm-wasm.js', () => ({
      createSonaInstant: vi.fn().mockResolvedValue(m2.mockSona),
    }));
    const mod2 = await import('../src/mcp-tools/ruvllm-tools.js');
    const result = await mod2.ruvllmWasmTools.find(t => t.name === 'ruvllm_sona_adapt')!
      .handler({ sonaId, quality: 0.9 }) as any;

    expect(result.isError).toBeUndefined();
    // Replay = 2 historical + 1 new = 3 adapt calls on fresh mock
    expect(m2.adaptCalls).toEqual([0.5, 0.8, 0.9]);
  });

  it('cross-process: microlora_adapt journal is replayed', async () => {
    const m1 = makeMocks();
    vi.doMock('../src/ruvector/ruvllm-wasm.js', () => ({
      createMicroLora: vi.fn().mockResolvedValue(m1.mockLora),
    }));
    const mod1 = await import('../src/mcp-tools/ruvllm-tools.js');
    const createResult = await mod1.ruvllmWasmTools.find(t => t.name === 'ruvllm_microlora_create')!
      .handler({ inputDim: 8, outputDim: 4, rank: 2 }) as any;
    const { loraId } = JSON.parse(createResult.content[0].text);

    const adaptTool = mod1.ruvllmWasmTools.find(t => t.name === 'ruvllm_microlora_adapt')!;
    await adaptTool.handler({ loraId, quality: 0.6, learningRate: 0.02 });

    // Cross-process
    vi.resetModules();
    vi.doUnmock('../src/ruvector/ruvllm-wasm.js');
    const m2 = makeMocks();
    vi.doMock('../src/ruvector/ruvllm-wasm.js', () => ({
      createMicroLora: vi.fn().mockResolvedValue(m2.mockLora),
    }));
    const mod2 = await import('../src/mcp-tools/ruvllm-tools.js');
    const result = await mod2.ruvllmWasmTools.find(t => t.name === 'ruvllm_microlora_adapt')!
      .handler({ loraId, quality: 0.9 }) as any;

    expect(result.isError).toBeUndefined();
    // 1 historical + 1 new = 2 adapt calls on fresh mock
    expect(m2.loraAdaptCalls).toHaveLength(2);
    expect(m2.loraAdaptCalls[0].quality).toBe(0.6);
    expect(m2.loraAdaptCalls[0].lr).toBe(0.02);
    expect(m2.loraAdaptCalls[1].quality).toBe(0.9);
  });

  it('operation on unknown id returns error (not silent success)', async () => {
    vi.doMock('../src/ruvector/ruvllm-wasm.js', () => ({}));
    const { ruvllmWasmTools } = await import('../src/mcp-tools/ruvllm-tools.js');
    const addTool = ruvllmWasmTools.find(t => t.name === 'ruvllm_hnsw_add')!;
    const res = await addTool.handler({ routerId: 'nope', name: 'x', embedding: [0, 0, 0, 0] }) as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Router not found/i);
  });

  it('corrupt store file does not throw on create', async () => {
    // Write a corrupt file first
    const corruptPath = join(tmpDir, '.claude-flow', 'ruvllm', 'hnsw-store.json');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(tmpDir, '.claude-flow', 'ruvllm'), { recursive: true });
    writeFileSync(corruptPath, '{not valid json', 'utf-8');

    const mocks = makeMocks();
    vi.doMock('../src/ruvector/ruvllm-wasm.js', () => ({
      createHnswRouter: vi.fn().mockResolvedValue(mocks.mockRouter),
    }));
    const { ruvllmWasmTools } = await import('../src/mcp-tools/ruvllm-tools.js');
    const tool = ruvllmWasmTools.find(t => t.name === 'ruvllm_hnsw_create')!;
    const result = await tool.handler({ dimensions: 4, maxPatterns: 8 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    // After create, the corrupt file was replaced with a valid one
    const disk = JSON.parse(readFileSync(corruptPath, 'utf-8'));
    expect(disk.routers[parsed.routerId]).toBeDefined();
  });
});
