/**
 * Tests for EmbeddingPipeline (ADR-0076 Phase 2)
 *
 * London School TDD — mocked deps, no real model loading.
 * Validates:
 *   - cosineSimilarity throws DimensionMismatchError on mismatched lengths
 *   - cosineSimilarity computes correct value for matching vectors
 *   - EmbeddingPipeline constructor stores config
 *   - initPipeline creates singleton
 *   - resetPipeline clears singleton
 *   - Dimension validation on first embed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EmbeddingPipeline,
  DimensionMismatchError,
  cosineSimilarity,
  getPipeline,
  initPipeline,
  resetPipeline,
} from './embedding-pipeline.js';
import type { EmbeddingConfig } from './embedding-pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    model: 'Xenova/all-mpnet-base-v2',
    dimension: 768,
    provider: 'transformers.js',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('throws DimensionMismatchError when vector lengths differ', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);
    expect(() => cosineSimilarity(a, b)).toThrowError(DimensionMismatchError);
  });

  it('error message includes expected and actual dimensions', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3, 4, 5]);
    try {
      cosineSimilarity(a, b);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DimensionMismatchError);
      expect((e as Error).message).toContain('expected 3');
      expect((e as Error).message).toContain('got 5');
    }
  });

  it('throws for number[] with mismatched lengths', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrowError(
      DimensionMismatchError,
    );
  });

  it('returns 1 for identical unit vectors', () => {
    const v = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns -1 for opposite unit vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns 0 when either vector is all zeros', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(cosineSimilarity(b, a)).toBe(0);
  });

  it('returns 0 for two zero vectors', () => {
    const z = new Float32Array([0, 0]);
    expect(cosineSimilarity(z, z)).toBe(0);
  });

  it('returns 0 for two empty vectors', () => {
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
  });

  it('computes correct similarity for known non-trivial vectors', () => {
    // cos(45deg) = sqrt(2)/2 ~ 0.7071
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('accepts plain number[] arrays', () => {
    const a = [3, 4];
    const b = [4, 3];
    // cos = (12+12) / (5*5) = 24/25 = 0.96
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.96, 4);
  });

  it('handles mixed Float32Array and number[]', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });
});

// ---------------------------------------------------------------------------
// DimensionMismatchError
// ---------------------------------------------------------------------------

describe('DimensionMismatchError', () => {
  it('has the correct name property', () => {
    const err = new DimensionMismatchError(768, 384);
    expect(err.name).toBe('DimensionMismatchError');
  });

  it('is an instance of Error', () => {
    const err = new DimensionMismatchError(768, 384);
    expect(err).toBeInstanceOf(Error);
  });

  it('includes dimensions in the message', () => {
    const err = new DimensionMismatchError(768, 384);
    expect(err.message).toContain('768');
    expect(err.message).toContain('384');
  });
});

// ---------------------------------------------------------------------------
// EmbeddingPipeline constructor
// ---------------------------------------------------------------------------

describe('EmbeddingPipeline', () => {
  it('stores config via getDimension() and getModel()', () => {
    const cfg = makeConfig({ dimension: 768, model: 'Xenova/all-mpnet-base-v2' });
    const pipeline = new EmbeddingPipeline(cfg);
    expect(pipeline.getDimension()).toBe(768);
    expect(pipeline.getModel()).toBe('Xenova/all-mpnet-base-v2');
  });

  it('reports not initialized before initialize()', () => {
    const pipeline = new EmbeddingPipeline(makeConfig());
    expect(pipeline.isInitialized()).toBe(false);
  });

  // ADR-0234: `'hash-fallback'` provider value is removed; the
  // pre-initialize provider is now `'uninitialized'`. The actual provider
  // is only set after `_doInitialize` resolves a real binding.
  it('defaults to uninitialized provider before initialize()', () => {
    const pipeline = new EmbeddingPipeline(makeConfig());
    expect(pipeline.getProvider()).toBe('uninitialized');
  });

  describe('initialize()', () => {
    // ADR-0234: with neither @xenova/transformers nor ruvector available
    // in this test env, initialize() now throws (silent hash-fallback is
    // removed per feedback-no-fallbacks). Pre-fix tests that assumed
    // initialize() always succeeds via the hash provider are revised to
    // assert the throw.
    it('throws when neither transformers.js nor ruvector is installed (ADR-0234)', async () => {
      const pipeline = new EmbeddingPipeline(makeConfig());
      await expect(pipeline.initialize()).rejects.toThrow(/ADR-0234/);
    });

    it('init error mentions both transformers and ruvector causes', async () => {
      const pipeline = new EmbeddingPipeline(makeConfig());
      let caught: unknown;
      try {
        await pipeline.initialize();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/transformers/i);
      expect((caught as Error).message).toMatch(/ruvector/i);
    });
  });

  describe('embed()', () => {
    // ADR-0234: with no real provider available, embed() throws at
    // auto-initialize. The shape of returned Float32Arrays is only
    // observable from environments with a real binding (covered by the
    // memory-pkg integration tests in `index.test.ts`).
    it('throws when no provider is installed (ADR-0234)', async () => {
      const pipeline = new EmbeddingPipeline(makeConfig({ dimension: 8 }));
      await expect(pipeline.embed('test')).rejects.toThrow(/ADR-0234/);
    });
  });
});

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

describe('singleton management', () => {
  afterEach(() => {
    resetPipeline();
  });

  it('getPipeline() returns null before initPipeline()', () => {
    expect(getPipeline()).toBeNull();
  });

  // ADR-0234: with no real embedding provider available, `initPipeline()`
  // throws. The singleton lifecycle (idempotent init, resetPipeline()
  // clears state) is still exercised via the throw branch:
  //   - `initPipeline()` throws and does NOT cache a partial singleton
  //   - `getPipeline()` remains null after a failed init
  //   - `resetPipeline()` is callable in either state
  // Full success-path coverage is in environments where a real binding
  // is installed (memory-pkg integration tests in `index.test.ts`).
  it('initPipeline() throws when no provider installed and leaves singleton null (ADR-0234)', async () => {
    const cfg = makeConfig({ dimension: 8 });
    await expect(initPipeline(cfg)).rejects.toThrow(/ADR-0234/);
    expect(getPipeline()).toBeNull();
  });

  it('resetPipeline() is safe to call after a failed init', async () => {
    await expect(initPipeline(makeConfig({ dimension: 8 }))).rejects.toThrow();
    // Should not throw.
    resetPipeline();
    expect(getPipeline()).toBeNull();
  });
});
