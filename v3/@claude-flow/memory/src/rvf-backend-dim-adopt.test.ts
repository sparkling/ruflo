/**
 * Unit tests for RvfBackend.adoptOnDiskDimIfDiffers (ADR-0181 handover §E
 * ergonomic).
 *
 * The behaviour under test is invoked at three callsites in tryNativeInit
 * (SFVR-open branch, openOrCreate branch, dispatch-to-open compatibility
 * branch). We exercise it directly with mock `nativeDb` instances rather
 * than spinning up the real @ruvector/rvf-node binding — that's an
 * optional runtime dep that isn't installed in this fork's test runtime,
 * and the helper's semantics are pure-data: read dim, compare, adopt.
 *
 * Covered cases:
 *   1. on-disk dim matches configured dim → no warn, no adopt
 *   2. on-disk dim differs from configured dim → warn + adopt
 *   3. nativeDb is null (cold fallback path) → no-op
 *   4. nativeDb.dimension is missing (older binding) → no-op, ingest fail loud
 *   5. nativeDb.dimension throws → no-op (let downstream surface)
 *   6. on-disk dim is invalid (0, NaN, negative) → no-op
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RvfBackend } from './rvf-backend.js';

function makeBackend(dim: number): RvfBackend {
  return new RvfBackend({
    databasePath: ':memory:',
    dimensions: dim,
  });
}

describe('RvfBackend.adoptOnDiskDimIfDiffers', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('no-op when on-disk dim matches configured dim', () => {
    const backend = makeBackend(384);
    (backend as any).nativeDb = { dimension: () => 384 };

    (backend as any).adoptOnDiskDimIfDiffers();

    expect((backend as any).config.dimensions).toBe(384);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('adopts on-disk dim and warns when dims differ (smaller on-disk)', () => {
    const backend = makeBackend(768);
    (backend as any).nativeDb = { dimension: () => 384 };

    (backend as any).adoptOnDiskDimIfDiffers();

    expect((backend as any).config.dimensions).toBe(384);
    expect(warnSpy).toHaveBeenCalledOnce();
    const warning = warnSpy.mock.calls[0][0] as string;
    expect(warning).toMatch(/On-disk dim 384/);
    expect(warning).toMatch(/configured 768/);
    expect(warning).toMatch(/adopting on-disk dim/);
  });

  it('adopts on-disk dim and warns when dims differ (larger on-disk)', () => {
    const backend = makeBackend(384);
    (backend as any).nativeDb = { dimension: () => 1536 };

    (backend as any).adoptOnDiskDimIfDiffers();

    expect((backend as any).config.dimensions).toBe(1536);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('no-op when nativeDb is null (cold fallback path)', () => {
    const backend = makeBackend(384);
    (backend as any).nativeDb = null;

    (backend as any).adoptOnDiskDimIfDiffers();

    expect((backend as any).config.dimensions).toBe(384);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no-op when nativeDb.dimension is missing (older binding)', () => {
    const backend = makeBackend(384);
    // Binding without the dimension() accessor — config left alone so
    // an ingest-time dim-mismatch can still surface fail-loud.
    (backend as any).nativeDb = { open: () => {}, ingestBatch: () => {} };

    (backend as any).adoptOnDiskDimIfDiffers();

    expect((backend as any).config.dimensions).toBe(384);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no-op when nativeDb.dimension() throws', () => {
    const backend = makeBackend(384);
    (backend as any).nativeDb = {
      dimension: () => {
        throw new Error('binding internal error');
      },
    };

    (backend as any).adoptOnDiskDimIfDiffers();

    expect((backend as any).config.dimensions).toBe(384);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('no-op when on-disk dim is invalid (%s)', (_label, badDim) => {
    const backend = makeBackend(384);
    (backend as any).nativeDb = { dimension: () => badDim };

    (backend as any).adoptOnDiskDimIfDiffers();

    expect((backend as any).config.dimensions).toBe(384);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
