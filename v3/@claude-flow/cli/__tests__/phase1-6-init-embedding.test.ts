/**
 * ADR-0177 Phase 1.6 — init embedding config-chain wiring tests
 *
 * Covers:
 *   (a) Init template generates 7 keys with exact defaults
 *   (b) Each known model produces correct (model, dimension) pair
 *   (g) Bare name rejected with typed error
 *   (b) Unknown model rejected with typed error
 *   Integration: `ruflo init` in temp dir produces .claude-flow/config.json
 *     with 7 keys present at top level.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getMinimalConfigTemplate,
  getFullConfigTemplate,
} from '../src/init/config-template.js';
import {
  KNOWN_EMBEDDING_MODELS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSION,
  validateEmbeddingModel,
  EmbeddingModelValidationError,
} from '../src/init/embedding-models.js';
import { executeInit } from '../src/init/index.js';
import { DEFAULT_INIT_OPTIONS, type InitOptions } from '../src/init/types.js';

describe('ADR-0177 Phase 1.6 (a): init template generates embedding + index keys', () => {
  it('minimal template has top-level embedding.* with the 4 required keys + defaults', () => {
    const tpl = getMinimalConfigTemplate();
    expect(tpl.embedding).toBeDefined();
    const embedding = tpl.embedding as Record<string, unknown>;
    // (a) — required 4 keys with exact default values per spec
    expect(embedding.provider).toBe('onnx');
    expect(embedding.model).toBe('Xenova/all-mpnet-base-v2');
    expect(embedding.dimension).toBe(768);
    expect(embedding.allowPaidProvider).toBe(false);
  });

  it('minimal template has top-level index.hnsw.* with the 3 required keys + defaults', () => {
    const tpl = getMinimalConfigTemplate();
    expect(tpl.index).toBeDefined();
    const index = tpl.index as Record<string, unknown>;
    expect(index.hnsw).toBeDefined();
    const hnsw = index.hnsw as Record<string, unknown>;
    // (a) — required 3 keys with exact default values per spec
    expect(hnsw.m).toBe(23);
    expect(hnsw.efConstruction).toBe(100);
    expect(hnsw.efSearch).toBe(50);
  });

  it('full template inherits the same 7 top-level Phase 1.6 keys via spread', () => {
    const tpl = getFullConfigTemplate();
    const embedding = tpl.embedding as Record<string, unknown>;
    expect(embedding.provider).toBe('onnx');
    expect(embedding.model).toBe('Xenova/all-mpnet-base-v2');
    expect(embedding.dimension).toBe(768);
    expect(embedding.allowPaidProvider).toBe(false);
    const hnsw = (tpl.index as Record<string, unknown>).hnsw as Record<string, unknown>;
    expect(hnsw.m).toBe(23);
    expect(hnsw.efConstruction).toBe(100);
    expect(hnsw.efSearch).toBe(50);
  });

  it('minimal template propagates overrides into embedding.model + embedding.dimension', () => {
    const tpl = getMinimalConfigTemplate({
      embeddingModel: 'Xenova/all-MiniLM-L6-v2',
      embeddingDim: 384,
    });
    const embedding = tpl.embedding as Record<string, unknown>;
    expect(embedding.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(embedding.dimension).toBe(384);
    // Provider + allowPaidProvider keep their defaults; overrides only touch the
    //   (model, dimension) pair per Phase 1.6 (b).
    expect(embedding.provider).toBe('onnx');
    expect(embedding.allowPaidProvider).toBe(false);
  });
});

describe('ADR-0177 Phase 1.6 (b): known-dim table produces correct (model, dimension) pair', () => {
  it('exposes the 5 ADR-mandated models', () => {
    const expected = [
      'Xenova/all-mpnet-base-v2',
      'Xenova/bge-base-en-v1.5',
      'Xenova/gte-base',
      'Xenova/all-MiniLM-L6-v2',
      'Xenova/all-MiniLM-L12-v2',
    ];
    for (const m of expected) {
      expect(KNOWN_EMBEDDING_MODELS[m]).toBeDefined();
    }
    expect(Object.keys(KNOWN_EMBEDDING_MODELS).length).toBe(expected.length);
  });

  it.each([
    ['Xenova/all-mpnet-base-v2', 768],
    ['Xenova/bge-base-en-v1.5', 768],
    ['Xenova/gte-base', 768],
    ['Xenova/all-MiniLM-L6-v2', 384],
    ['Xenova/all-MiniLM-L12-v2', 384],
  ])('validateEmbeddingModel("%s") returns dimension %i', (model, expectedDim) => {
    const result = validateEmbeddingModel(model);
    expect(result.model).toBe(model);
    expect(result.dimension).toBe(expectedDim);
  });

  it('default model + default dimension agree with the known-dim table', () => {
    expect(KNOWN_EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL]).toBe(DEFAULT_EMBEDDING_DIMENSION);
  });
});

describe('ADR-0177 Phase 1.6 (g): full-qualified name guard rejects bare names', () => {
  it.each([
    'all-mpnet-base-v2',
    'all-MiniLM-L6-v2',
    'bge-base-en-v1.5',
  ])('rejects bare name "%s" with BARE_NAME typed error', (bare) => {
    expect(() => validateEmbeddingModel(bare)).toThrow(EmbeddingModelValidationError);
    try {
      validateEmbeddingModel(bare);
    } catch (e) {
      expect(e).toBeInstanceOf(EmbeddingModelValidationError);
      const err = e as EmbeddingModelValidationError;
      expect(err.code).toBe('BARE_NAME');
      expect(err.model).toBe(bare);
      // Error message must surface the known-table to help the user self-correct.
      expect(err.message).toContain('Xenova/');
      expect(err.message).toMatch(/feedback-full-model-names|ADR-0069/);
    }
  });

  it('error type carries the canonical knownModels list', () => {
    try {
      validateEmbeddingModel('bare-name');
    } catch (e) {
      const err = e as EmbeddingModelValidationError;
      expect(err.knownModels.length).toBe(5);
      expect(err.knownModels).toContain('Xenova/all-mpnet-base-v2');
    }
  });
});

describe('ADR-0177 Phase 1.6 (b): unknown model rejected with typed error', () => {
  it.each([
    'Xenova/does-not-exist',
    'OpenAI/text-embedding-3-small',
    'sentence-transformers/all-mpnet-base-v2', // wrong org prefix
    'BAAI/bge-large-en-v1.5', // not in the 5-model table
  ])('rejects qualified unknown "%s" with UNKNOWN_MODEL typed error', (unknown) => {
    expect(() => validateEmbeddingModel(unknown)).toThrow(EmbeddingModelValidationError);
    try {
      validateEmbeddingModel(unknown);
    } catch (e) {
      expect(e).toBeInstanceOf(EmbeddingModelValidationError);
      const err = e as EmbeddingModelValidationError;
      expect(err.code).toBe('UNKNOWN_MODEL');
      expect(err.model).toBe(unknown);
      // Error message must point at the canonical table source for self-correction.
      expect(err.message).toContain('embedding-models.ts');
      expect(err.message).toContain('Xenova/all-mpnet-base-v2'); // table sample
    }
  });
});

describe('ADR-0177 Phase 1.6 integration: `ruflo init` writes 7 Phase 1.6 keys to config.json', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-phase16-init-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs executeInit in a temp dir and the generated config.json has 7 Phase 1.6 keys with defaults', async () => {
    const options: InitOptions = {
      ...JSON.parse(JSON.stringify(DEFAULT_INIT_OPTIONS)),
      targetDir: tempDir,
      force: true,
      interactive: false,
      // Disable expensive components — Phase 1.6 only needs the runtime block.
      components: {
        settings: false,
        skills: false,
        commands: false,
        agents: false,
        helpers: false,
        statusline: false,
        mcp: false,
        runtime: true,
        claudeMd: false,
      },
    };

    const result = await executeInit(options);
    expect(result.success).toBe(true);

    const configPath = join(tempDir, '.claude-flow', 'config.json');
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);

    // (a) — exact 7 keys with exact defaults at TOP level (canonical Phase 1.6
    //   config-chain source of truth per ADR-0068 + ADR-0102).
    expect(config.embedding).toBeDefined();
    expect(config.embedding.provider).toBe('onnx');
    expect(config.embedding.model).toBe('Xenova/all-mpnet-base-v2');
    expect(config.embedding.dimension).toBe(768);
    expect(config.embedding.allowPaidProvider).toBe(false);
    expect(config.index).toBeDefined();
    expect(config.index.hnsw).toBeDefined();
    expect(config.index.hnsw.m).toBe(23);
    expect(config.index.hnsw.efConstruction).toBe(100);
    expect(config.index.hnsw.efSearch).toBe(50);
  });

  it('overrides via options.embeddings round-trip into top-level embedding.{model,dimension}', async () => {
    const options: InitOptions = {
      ...JSON.parse(JSON.stringify(DEFAULT_INIT_OPTIONS)),
      targetDir: tempDir,
      force: true,
      interactive: false,
      components: {
        settings: false,
        skills: false,
        commands: false,
        agents: false,
        helpers: false,
        statusline: false,
        mcp: false,
        runtime: true,
        claudeMd: false,
      },
      embeddings: {
        ...DEFAULT_INIT_OPTIONS.embeddings,
        model: 'Xenova/all-MiniLM-L6-v2',
        dimension: 384,
      },
    };

    const result = await executeInit(options);
    expect(result.success).toBe(true);

    const configPath = join(tempDir, '.claude-flow', 'config.json');
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);

    expect(config.embedding.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(config.embedding.dimension).toBe(384);
    // (a) — HNSW + provider + allowPaidProvider keep defaults.
    expect(config.embedding.provider).toBe('onnx');
    expect(config.embedding.allowPaidProvider).toBe(false);
    expect(config.index.hnsw.m).toBe(23);
    expect(config.index.hnsw.efConstruction).toBe(100);
    expect(config.index.hnsw.efSearch).toBe(50);
  });
});
