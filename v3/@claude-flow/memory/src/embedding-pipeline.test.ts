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

  it('defaults to hash-fallback provider', () => {
    const pipeline = new EmbeddingPipeline(makeConfig());
    expect(pipeline.getProvider()).toBe('hash-fallback');
  });

  describe('initialize()', () => {
    it('sets isInitialized to true after successful init', async () => {
      // With hash-fallback (no real model), initialize always succeeds
      const pipeline = new EmbeddingPipeline(makeConfig());
      await pipeline.initialize();
      expect(pipeline.isInitialized()).toBe(true);
    });

    it('is idempotent — second call is a no-op', async () => {
      const pipeline = new EmbeddingPipeline(makeConfig());
      await pipeline.initialize();
      await pipeline.initialize(); // should not throw
      expect(pipeline.isInitialized()).toBe(true);
    });
  });

  describe('embed()', () => {
    it('returns Float32Array of configured dimension', async () => {
      const dim = 16; // small for speed
      const pipeline = new EmbeddingPipeline(makeConfig({ dimension: dim }));
      await pipeline.initialize();
      const result = await pipeline.embed('hello world');
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(dim);
    });

    it('auto-initializes if not yet initialized', async () => {
      const pipeline = new EmbeddingPipeline(makeConfig({ dimension: 8 }));
      expect(pipeline.isInitialized()).toBe(false);
      const result = await pipeline.embed('test');
      expect(pipeline.isInitialized()).toBe(true);
      expect(result.length).toBe(8);
    });

    it('returns normalized vectors (unit length)', async () => {
      const pipeline = new EmbeddingPipeline(makeConfig({ dimension: 32 }));
      await pipeline.initialize();
      const result = await pipeline.embed('some text for embedding');
      let mag = 0;
      for (let i = 0; i < result.length; i++) mag += result[i] * result[i];
      mag = Math.sqrt(mag);
      // Hash fallback normalizes to unit length
      expect(mag).toBeCloseTo(1.0, 3);
    });

    it('produces deterministic output for the same input', async () => {
      const pipeline = new EmbeddingPipeline(makeConfig({ dimension: 16 }));
      await pipeline.initialize();
      const a = await pipeline.embed('reproducible');
      const b = await pipeline.embed('reproducible');
      expect(Array.from(a)).toEqual(Array.from(b));
    });

    it('produces different output for different inputs', async () => {
      const pipeline = new EmbeddingPipeline(makeConfig({ dimension: 16 }));
      await pipeline.initialize();
      const a = await pipeline.embed('alpha');
      const b = await pipeline.embed('beta');
      // At least one element must differ
      const differs = Array.from(a).some((v, i) => v !== b[i]);
      expect(differs).toBe(true);
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

  it('initPipeline() creates and returns the singleton', async () => {
    const cfg = makeConfig({ dimension: 8 });
    const pipeline = await initPipeline(cfg);
    expect(pipeline).toBeInstanceOf(EmbeddingPipeline);
    expect(pipeline.isInitialized()).toBe(true);
    expect(pipeline.getDimension()).toBe(8);
  });

  it('initPipeline() returns the same instance on second call', async () => {
    const cfg = makeConfig({ dimension: 8 });
    const first = await initPipeline(cfg);
    const second = await initPipeline(cfg);
    expect(first).toBe(second);
  });

  it('getPipeline() returns the singleton after initPipeline()', async () => {
    const cfg = makeConfig({ dimension: 8 });
    const pipeline = await initPipeline(cfg);
    expect(getPipeline()).toBe(pipeline);
  });

  it('resetPipeline() clears the singleton', async () => {
    await initPipeline(makeConfig({ dimension: 8 }));
    expect(getPipeline()).not.toBeNull();
    resetPipeline();
    expect(getPipeline()).toBeNull();
  });

  it('initPipeline() creates a new instance after resetPipeline()', async () => {
    const first = await initPipeline(makeConfig({ dimension: 8 }));
    resetPipeline();
    const second = await initPipeline(makeConfig({ dimension: 16 }));
    expect(second).not.toBe(first);
    expect(second.getDimension()).toBe(16);
  });
});
