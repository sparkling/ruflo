/**
 * Unit tests for the canonical @claude-flow/config-chain package.
 *
 * Ported from `forks/agentdb/tests/unit/config-chain.test.ts` as part of the
 * ADR-0177 Phase 1.6 refactor that extracted the walk-up accessor + boot
 * validation into a shared package consumed by both agentdb and memory.
 *
 * Covers: file discovery (walk-up), default fallbacks, nested+top-level shape,
 * `transformers.js` -> `onnx` provider normalisation, boot validation gates
 * (missing model, paid provider without allowPaidProvider), and the explicit
 * EmbeddingDimensionMismatchError shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getConfig,
  getEmbeddingConfig,
  resetConfig,
  isConfigOnDisk,
  validateBoot,
  ConfigChainValidationError,
  EmbeddingDimensionMismatchError,
} from '../src/index.js';

let prevCwd: string;
let scratchDir: string;

function makeScratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-chain-'));
}

function writeEmbeddingsJson(dir: string, body: object): void {
  const claudeFlow = path.join(dir, '.claude-flow');
  fs.mkdirSync(claudeFlow, { recursive: true });
  fs.writeFileSync(path.join(claudeFlow, 'embeddings.json'), JSON.stringify(body, null, 2));
}

beforeEach(() => {
  prevCwd = process.cwd();
  scratchDir = makeScratch();
  process.chdir(scratchDir);
  resetConfig();
});

afterEach(() => {
  process.chdir(prevCwd);
  resetConfig();
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe('config-chain: file discovery', () => {
  it('falls back to hardcoded defaults when no embeddings.json exists', () => {
    const cfg = getConfig();
    expect(cfg.embedding.model).toBe('Xenova/all-mpnet-base-v2');
    expect(cfg.embedding.dimension).toBe(768);
    expect(cfg.embedding.provider).toBe('onnx');
    expect(cfg.embedding.allowPaidProvider).toBe(false);
    expect(isConfigOnDisk()).toBe(false);
  });

  it('reads top-level keys from .claude-flow/embeddings.json in cwd', () => {
    writeEmbeddingsJson(scratchDir, {
      model: 'BAAI/bge-small-en-v1.5',
      dimension: 384,
      provider: 'onnx',
      allowPaidProvider: false,
    });
    const cfg = getConfig();
    expect(cfg.embedding.model).toBe('BAAI/bge-small-en-v1.5');
    expect(cfg.embedding.dimension).toBe(384);
    expect(cfg.embedding.provider).toBe('onnx');
    expect(isConfigOnDisk()).toBe(true);
  });

  it('walks up from a subdirectory to find embeddings.json', () => {
    writeEmbeddingsJson(scratchDir, {
      model: 'Xenova/all-MiniLM-L6-v2',
      dimension: 384,
      provider: 'transformers.js',
    });
    const nested = path.join(scratchDir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    resetConfig();
    const cfg = getConfig();
    expect(cfg.embedding.model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(cfg.embedding.dimension).toBe(384);
  });

  it('accepts nested embedding.* shape (config.json-style)', () => {
    writeEmbeddingsJson(scratchDir, {
      embedding: {
        model: 'custom/model',
        dimension: 512,
        provider: 'onnx',
      },
    });
    const cfg = getConfig();
    expect(cfg.embedding.model).toBe('custom/model');
    expect(cfg.embedding.dimension).toBe(512);
  });

  it('normalises transformers/transformers.js provider to onnx', () => {
    writeEmbeddingsJson(scratchDir, {
      model: 'Xenova/all-mpnet-base-v2',
      dimension: 768,
      provider: 'transformers.js',
    });
    expect(getConfig().embedding.provider).toBe('onnx');
  });

  it('returns a frozen config object', () => {
    const cfg = getConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.embedding)).toBe(true);
  });

  it('caches the resolved config across calls', () => {
    writeEmbeddingsJson(scratchDir, { model: 'a/b', dimension: 768, provider: 'onnx' });
    const first = getConfig();
    const second = getConfig();
    expect(first).toBe(second);
  });
});

describe('config-chain: getEmbeddingConfig export', () => {
  it('returns a plain (non-frozen) shape for memory/resolve-config consumption', () => {
    writeEmbeddingsJson(scratchDir, {
      model: 'Xenova/all-mpnet-base-v2',
      dimension: 768,
      provider: 'onnx',
      allowPaidProvider: false,
    });
    const cfg = getEmbeddingConfig();
    expect(cfg.model).toBe('Xenova/all-mpnet-base-v2');
    expect(cfg.dimension).toBe(768);
    expect(cfg.provider).toBe('onnx');
    expect(cfg.allowPaidProvider).toBe(false);
  });
});

describe('config-chain: validateBoot', () => {
  it('passes on defaults (no on-disk config — embedded use)', () => {
    expect(() => validateBoot()).not.toThrow();
  });

  it('passes for valid onnx provider with allowPaidProvider=false', () => {
    writeEmbeddingsJson(scratchDir, {
      model: 'Xenova/all-mpnet-base-v2',
      dimension: 768,
      provider: 'onnx',
      allowPaidProvider: false,
    });
    expect(() => validateBoot()).not.toThrow();
  });

  it('throws ConfigChainValidationError for paid provider with allowPaidProvider=false', () => {
    writeEmbeddingsJson(scratchDir, {
      model: 'text-embedding-3-small',
      dimension: 1536,
      provider: 'openai',
      allowPaidProvider: false,
    });
    expect(() => validateBoot()).toThrow(ConfigChainValidationError);
    expect(() => validateBoot()).toThrow(/feedback-no-api-keys|allowPaidProvider/);
  });

  it('accepts paid provider when allowPaidProvider=true', () => {
    writeEmbeddingsJson(scratchDir, {
      model: 'text-embedding-3-small',
      dimension: 1536,
      provider: 'openai',
      allowPaidProvider: true,
    });
    expect(() => validateBoot()).not.toThrow();
  });

  it('throws ConfigChainValidationError when embeddings.json exists but model is missing', () => {
    // file present, model field present-but-empty -> rejected
    fs.mkdirSync(path.join(scratchDir, '.claude-flow'), { recursive: true });
    fs.writeFileSync(
      path.join(scratchDir, '.claude-flow', 'embeddings.json'),
      JSON.stringify({ dimension: 768, provider: 'onnx', model: '' }),
    );
    resetConfig();
    expect(() => validateBoot()).toThrow(ConfigChainValidationError);
    expect(() => validateBoot()).toThrow(/embedding\.model missing|ruflo init/);
  });
});

describe('config-chain: EmbeddingDimensionMismatchError', () => {
  it('carries model, expected, and actual fields', () => {
    const err = new EmbeddingDimensionMismatchError('m/x', 768, 384);
    expect(err.name).toBe('EmbeddingDimensionMismatchError');
    expect(err.model).toBe('m/x');
    expect(err.expected).toBe(768);
    expect(err.actual).toBe(384);
    expect(err.message).toMatch(/768/);
    expect(err.message).toMatch(/384/);
  });
});
