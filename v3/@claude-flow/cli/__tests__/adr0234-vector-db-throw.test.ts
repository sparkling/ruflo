/**
 * ADR-0234 site 1 — vector-db.ts fail-loud loader throw.
 *
 * Verifies that `createVectorDB` and `generateEmbedding` throw a labelled
 * ADR-0234 error when ruvector is unavailable, instead of silently
 * returning the prior `FallbackVectorDB` / hash-stretched-sine embedding.
 *
 * Per ADR-0234 Implementation discipline: TWO tests — one asserts that the
 * production-path API throws; one asserts the thrown error contains the
 * literal `'ADR-0234'` substring (and the labelled-error fields per the
 * F-06-002 cross-cutting `{code, path, adr}` template).
 *
 * The vitest `externalize-optional-deps` plugin marks `ruvector` external,
 * so the dynamic `import('ruvector')` in the source under test resolves
 * to a real module miss at runtime (no fake module is loaded). That is
 * exactly the deployment state the ADR is fail-louding against.
 */

import { describe, it, expect, beforeEach } from 'vitest';

describe('ADR-0234 site 1 — vector-db fail-loud throw on missing ruvector', () => {
  // Force a fresh module state per test so `loadAttempted` / `isAvailable`
  // module-scope variables don't bleed across cases.
  beforeEach(async () => {
    // vitest module cache reset
    const { resetModules } = await import('vitest');
    if (typeof resetModules === 'function') resetModules();
  });

  it('createVectorDB throws when ruvector is not installed', async () => {
    const mod = await import('../src/ruvector/vector-db.js');
    await expect(mod.createVectorDB(768)).rejects.toThrow();
  });

  it('thrown error from createVectorDB contains the literal ADR-0234 substring', async () => {
    const mod = await import('../src/ruvector/vector-db.js');
    let caught: unknown;
    try {
      await mod.createVectorDB(768);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('ADR-0234');
    // F-06-002 typed-error shape (mirror of RvfBackend.ts:1129 template).
    expect((caught as { adr?: string }).adr).toBe('ADR-0234');
    expect(typeof (caught as { code?: string }).code).toBe('string');
    expect(typeof (caught as { path?: string }).path).toBe('string');
  });

  it('generateEmbedding throws ADR-0234 when ruvector not loaded', async () => {
    const mod = await import('../src/ruvector/vector-db.js');
    // generateEmbedding is sync — wrap in expect().toThrow
    expect(() => mod.generateEmbedding('any text', 384)).toThrow(/ADR-0234/);
  });

  it('getStatus() return shape no longer advertises backend:"fallback"', async () => {
    const mod = await import('../src/ruvector/vector-db.js');
    const status = mod.getStatus();
    // The prior `'fallback'` literal in the union is replaced by
    // `'unavailable'`; production callers cannot infer a working fallback
    // from the status.
    expect(status.backend).not.toBe('fallback');
    expect(['ruvector-wasm', 'ruvector', 'unavailable']).toContain(status.backend);
  });
});
