/**
 * Tests for ruvllm-wasm MCP tools.
 * Mocks the integration module to test tool handlers in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the integration module
const mockRouter = {
  addPattern: vi.fn().mockReturnValue(true),
  route: vi.fn().mockReturnValue([{ name: 'test', score: 0.9 }]),
  clear: vi.fn(),
  patternCount: vi.fn().mockReturnValue(1),
  toJson: vi.fn().mockReturnValue('{}'),
};

const mockSona = {
  adapt: vi.fn(),
  recordPattern: vi.fn(),
  suggestAction: vi.fn().mockReturnValue('optimize'),
  stats: vi.fn().mockReturnValue('{"adaptations":1}'),
  reset: vi.fn(),
  toJson: vi.fn().mockReturnValue('{}'),
};

const mockLora = {
  apply: vi.fn().mockReturnValue(new Float32Array(32)),
  adapt: vi.fn(),
  applyUpdates: vi.fn(),
  stats: vi.fn().mockReturnValue('{"rank":2}'),
  reset: vi.fn(),
  toJson: vi.fn().mockReturnValue('{}'),
  pendingUpdates: vi.fn().mockReturnValue(0),
};

vi.mock('../src/ruvector/ruvllm-wasm.js', () => ({
  isRuvllmWasmAvailable: vi.fn().mockResolvedValue(true),
  initRuvllmWasm: vi.fn().mockResolvedValue(undefined),
  getRuvllmStatus: vi.fn().mockResolvedValue({ available: true, initialized: true, version: '2.0.1' }),
  createHnswRouter: vi.fn().mockResolvedValue(mockRouter),
  createSonaInstant: vi.fn().mockResolvedValue(mockSona),
  createMicroLora: vi.fn().mockResolvedValue(mockLora),
  formatChat: vi.fn().mockResolvedValue('<|begin|>system\nHello<|end|>'),
  createGenerateConfig: vi.fn().mockResolvedValue('{"maxTokens":100}'),
  createKvCache: vi.fn().mockResolvedValue({ append: vi.fn(), clear: vi.fn(), stats: vi.fn(), tokenCount: vi.fn() }),
  createBufferPool: vi.fn().mockResolvedValue({ prewarm: vi.fn(), stats: vi.fn(), hitRate: vi.fn(), clear: vi.fn() }),
  createInferenceArena: vi.fn().mockResolvedValue({ reset: vi.fn(), used: vi.fn(), capacity: vi.fn(), remaining: vi.fn() }),
  HNSW_MAX_SAFE_PATTERNS: 11,
}));

import { ruvllmWasmTools } from '../src/mcp-tools/ruvllm-tools.js';

function findTool(name: string) {
  const tool = ruvllmWasmTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

describe('ruvllm-wasm MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export 10 tools', () => {
    expect(ruvllmWasmTools).toHaveLength(10);
  });

  describe('ruvllm_status', () => {
    it('should return status', async () => {
      const tool = findTool('ruvllm_status');
      const result = await tool.handler({}) as any;
      const data = JSON.parse(result.content[0].text);
      expect(data.wasm.available).toBe(true);
      expect(data.wasm.version).toBe('2.0.1');
      expect(data.native).toBeDefined();
    });
  });

  describe('ruvllm_hnsw_create', () => {
    it('should create router and return ID', async () => {
      const tool = findTool('ruvllm_hnsw_create');
      const result = await tool.handler({ dimensions: 64, maxPatterns: 10 }) as any;
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.routerId).toMatch(/^hnsw-/);
    });
  });

  describe('ruvllm_hnsw_add', () => {
    it('should add pattern to router', async () => {
      // First create
      const createTool = findTool('ruvllm_hnsw_create');
      const createResult = await createTool.handler({ dimensions: 64, maxPatterns: 10 }) as any;
      const routerId = JSON.parse(createResult.content[0].text).routerId;

      const addTool = findTool('ruvllm_hnsw_add');
      const result = await addTool.handler({ routerId, name: 'test', embedding: Array(64).fill(0) }) as any;
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should error on unknown router', async () => {
      const tool = findTool('ruvllm_hnsw_add');
      const result = await tool.handler({ routerId: 'nonexistent', name: 'test', embedding: [] }) as any;
      expect(result.isError).toBe(true);
    });
  });

  describe('ruvllm_hnsw_route', () => {
    it('should route query', async () => {
      const createTool = findTool('ruvllm_hnsw_create');
      const createResult = await createTool.handler({ dimensions: 64, maxPatterns: 10 }) as any;
      const routerId = JSON.parse(createResult.content[0].text).routerId;

      const routeTool = findTool('ruvllm_hnsw_route');
      const result = await routeTool.handler({ routerId, query: Array(64).fill(0) }) as any;
      const data = JSON.parse(result.content[0].text);
      expect(data.results).toBeDefined();
    });
  });

  describe('ruvllm_sona_create', () => {
    it('should create SONA instance', async () => {
      const tool = findTool('ruvllm_sona_create');
      const result = await tool.handler({ hiddenDim: 32 }) as any;
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.sonaId).toMatch(/^sona-/);
    });
  });

  describe('ruvllm_sona_adapt', () => {
    it('should adapt with quality signal', async () => {
      const createTool = findTool('ruvllm_sona_create');
      const createResult = await createTool.handler({}) as any;
      const sonaId = JSON.parse(createResult.content[0].text).sonaId;

      const adaptTool = findTool('ruvllm_sona_adapt');
      const result = await adaptTool.handler({ sonaId, quality: 0.85 }) as any;
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  describe('ruvllm_microlora_create', () => {
    it('should create MicroLoRA', async () => {
      const tool = findTool('ruvllm_microlora_create');
      const result = await tool.handler({ inputDim: 64, outputDim: 32, rank: 2 }) as any;
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.loraId).toMatch(/^lora-/);
    });
  });

  describe('ruvllm_microlora_adapt', () => {
    // Updated for ADR-0231 wave 2 (da975df8f): `input` is now a required
    // schema field; handler throws if missing. The original "should adapt
    // with feedback" case is preserved here as the happy-path test,
    // augmented with the required `input` vector.
    it('should adapt with feedback (with input)', async () => {
      const createTool = findTool('ruvllm_microlora_create');
      const createResult = await createTool.handler({ inputDim: 64, outputDim: 32 }) as any;
      const loraId = JSON.parse(createResult.content[0].text).loraId;

      const adaptTool = findTool('ruvllm_microlora_adapt');
      const result = await adaptTool.handler({
        loraId,
        quality: 0.9,
        input: Array(64).fill(0).map((_, i) => (i % 2 === 0 ? 0.1 : -0.1)),
      }) as any;
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    // -----------------------------------------------------------------
    // Group A — schema-level + handler-validation (ADR-0231 wave 3 C1)
    // No WASM runtime needed.
    // -----------------------------------------------------------------
    describe('schema (ADR-0231 wave 2)', () => {
      const tool = findTool('ruvllm_microlora_adapt');
      const schema = tool.inputSchema as {
        properties: Record<string, { type: string; items?: { type: string } }>;
        required: string[];
      };

      it('declares input as required with array-of-numbers shape', () => {
        expect(schema.required).toContain('input');
        const prop = schema.properties.input;
        expect(prop).toBeDefined();
        expect(prop.type).toBe('array');
        expect(prop.items?.type).toBe('number');
      });

      it('declares consolidate as optional boolean (default true)', () => {
        const prop = schema.properties.consolidate;
        expect(prop).toBeDefined();
        expect(prop.type).toBe('boolean');
        expect(schema.required).not.toContain('consolidate');
      });
    });

    it('returns isError when input is missing (handler-level validation)', async () => {
      const createTool = findTool('ruvllm_microlora_create');
      const createResult = await createTool.handler({ inputDim: 64, outputDim: 32 }) as any;
      const loraId = JSON.parse(createResult.content[0].text).loraId;

      const adaptTool = findTool('ruvllm_microlora_adapt');
      // No `input` supplied — handler hits Float32Array.from(undefined) which
      // throws synchronously, caught by the try/catch returning isError.
      const result = await adaptTool.handler({ loraId, quality: 0.5 }) as any;
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBeDefined();
      expect(data.success).toBeUndefined();
    });

    // -----------------------------------------------------------------
    // Group B — dispatch contract (ADR-0231 wave 3 C1)
    //
    // The wrapper module is mocked at the top of this file, so the
    // *handler-level* contract (passes consolidate flag through to the
    // wrapper's adapt() 5th arg) is verifiable here. The deeper assertion
    // — that the wrapper's adapt() routes to MicroLoraWasm.adaptConstrained
    // when consolidate=true — lives behind the mock and requires the
    // republished @ruvector/ruvllm-wasm artifact (wave 4). Those tests are
    // skipped with a citation.
    // -----------------------------------------------------------------
    it('handler defaults consolidate=true and forwards input to wrapper.adapt', async () => {
      const createTool = findTool('ruvllm_microlora_create');
      const createResult = await createTool.handler({ inputDim: 64, outputDim: 32 }) as any;
      const loraId = JSON.parse(createResult.content[0].text).loraId;

      mockLora.adapt.mockClear();
      const adaptTool = findTool('ruvllm_microlora_adapt');
      const inputArr = Array(64).fill(0).map((_, i) => i * 0.001);
      await adaptTool.handler({ loraId, quality: 0.8, input: inputArr });

      expect(mockLora.adapt).toHaveBeenCalledTimes(1);
      const callArgs = mockLora.adapt.mock.calls[0];
      // (input: Float32Array, quality, learningRate, success, consolidate)
      expect(callArgs[0]).toBeInstanceOf(Float32Array);
      expect(callArgs[0].length).toBe(64);
      expect(callArgs[1]).toBe(0.8);
      // 5th arg = consolidate; defaults to true at the handler.
      expect(callArgs[4]).toBe(true);
    });

    it('handler forwards consolidate=false to wrapper.adapt', async () => {
      const createTool = findTool('ruvllm_microlora_create');
      const createResult = await createTool.handler({ inputDim: 64, outputDim: 32 }) as any;
      const loraId = JSON.parse(createResult.content[0].text).loraId;

      mockLora.adapt.mockClear();
      const adaptTool = findTool('ruvllm_microlora_adapt');
      await adaptTool.handler({
        loraId,
        quality: 0.7,
        input: Array(64).fill(0.05),
        consolidate: false,
      });

      expect(mockLora.adapt).toHaveBeenCalledTimes(1);
      const callArgs = mockLora.adapt.mock.calls[0];
      expect(callArgs[4]).toBe(false);
    });

    // The wrapper's adapt() at ruvllm-wasm.ts:286-307 contains both the
    // consolidate dispatch (calls adaptConstrained vs adapt) and the strict
    // input.length guard. Vite's test-loader intercepts the wrapper's
    // `await import('@ruvector/ruvllm-wasm')` even with `external: true`,
    // so we follow the same pattern as the MICROLORA_WASM_MIN_DIM check
    // below: assert on wrapper source, then probe the underlying WASM via
    // createRequire (CJS bypasses Vite). The binding probe will gracefully
    // skip if the WASM package is not locally installed — in published
    // installs the codemod-renamed @sparkleideas/ruvector-ruvllm-wasm is
    // a pinned dep and the probe will assert the binding exists.

    async function probeWasmBinding(): Promise<any | null> {
      try {
        const { createRequire } = await import('node:module');
        const req = createRequire(import.meta.url);
        return req('@ruvector/ruvllm-wasm');
      } catch {
        return null;
      }
    }

    async function readWrapperSource(): Promise<string> {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const here = fileURLToPath(import.meta.url);
      return readFile(
        new URL('../src/ruvector/ruvllm-wasm.ts', `file://${here}`),
        'utf8',
      );
    }

    it('wrapper dispatches to MicroLoraWasm.adaptConstrained when consolidate=true', async () => {
      const src = await readWrapperSource();
      // Dispatch: consolidate=true → adaptConstrained
      expect(src).toMatch(/if\s*\(\s*consolidate\s*\)\s*\{[^}]*adaptConstrained\s*\(/);
      const mod = await probeWasmBinding();
      if (mod) {
        expect(typeof mod.MicroLoraWasm.prototype.adaptConstrained).toBe('function');
      }
    });

    it('wrapper dispatches to MicroLoraWasm.adapt when consolidate=false', async () => {
      const src = await readWrapperSource();
      // Dispatch: consolidate=false → plain adapt
      expect(src).toMatch(/else\s*\{[^}]*lora\.adapt\s*\(\s*input\s*,\s*feedback\s*\)/);
      const mod = await probeWasmBinding();
      if (mod) {
        expect(typeof mod.MicroLoraWasm.prototype.adapt).toBe('function');
      }
    });

    it('wrapper throws when input.length !== config.inputDim', async () => {
      // Fail-loud guard added at wave 2 (replaces MICROLORA_WASM_MIN_DIM
      // zero-padding). Lives at ruvllm-wasm.ts:293-297.
      const src = await readWrapperSource();
      expect(src).toMatch(
        /if\s*\(\s*input\.length\s*!==\s*config\.inputDim\s*\)\s*\{[\s\S]*?throw new Error\([\s\S]*?input\.length=/,
      );
    });

    // -----------------------------------------------------------------
    // Group C — archivist invariant integration (ADR-0231 wave 3 C1)
    //
    // Omitted: @sparkleideas/agentdb is not locally linked into this
    // workspace, so the cross-fork invariant ("all-zero input rejected at
    // archivist layer") can't be exercised in this test file. The
    // assertion lives in forks/agentdb commit 6d53621's own test suite.
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // Static / build-time guarantees
    // -----------------------------------------------------------------
    it('MICROLORA_WASM_MIN_DIM zero-pad constant has been removed from the wrapper source (ADR-0231 wave 2)', async () => {
      // Module-import probe would need vi.importActual + a different mock
      // shape; cheaper to assert against the source file directly. The
      // constant's removal is a hard contract — its presence would
      // resurrect the silent zero-pad that wave 2 deleted.
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const here = fileURLToPath(import.meta.url);
      const src = await readFile(
        new URL('../src/ruvector/ruvllm-wasm.ts', `file://${here}`),
        'utf8',
      );
      expect(src).not.toContain('MICROLORA_WASM_MIN_DIM');
    });
  });

  describe('ruvllm_chat_format', () => {
    it('should format with preset', async () => {
      const tool = findTool('ruvllm_chat_format');
      const result = await tool.handler({
        messages: [{ role: 'user', content: 'Hi' }],
        template: 'llama3',
      }) as any;
      expect(result.content[0].text).toContain('system');
    });
  });

  describe('ruvllm_generate_config', () => {
    it('should create config', async () => {
      const tool = findTool('ruvllm_generate_config');
      const result = await tool.handler({ maxTokens: 100, temperature: 0.7 }) as any;
      expect(result.content[0].text).toContain('maxTokens');
    });
  });
});
