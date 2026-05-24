/**
 * ADR-0234 site 2 — diskann-backend.ts fail-loud throws at each loader tier.
 *
 * Verifies that `getDiskAnnIndex` throws a labelled ADR-0234 error when
 * neither @ruvector/diskann nor @ruvector/router is installed, instead of
 * silently falling through to the pure-JS cosine fixture.
 *
 * Fork-only divergence: upstream (`ruvnet/ruflo`) ships the silent
 * cascade `diskann → hnsw → cosine-js` by design. ADR-0234 §Check 2 site 2
 * confirmed byte-identity with upstream at 2026-05-24. This test pins the
 * fork's fail-loud throw so sync agents preserve it.
 *
 * Per ADR-0234 Implementation discipline: TWO tests — one asserts throw,
 * one asserts the error message + typed-error shape carry the literal
 * `'ADR-0234'` substring.
 */

import { describe, it, expect, beforeEach } from 'vitest';

describe('ADR-0234 site 2 — diskann-backend fail-loud throw', () => {
  beforeEach(async () => {
    // Reset module state so resetIndex / module-scope `diskannInstance`
    // doesn't bleed across tests.
    const mod = await import('../src/ruvector/diskann-backend.js');
    if (typeof mod.resetIndex === 'function') mod.resetIndex();
  });

  it('getDiskAnnIndex throws when neither diskann nor router is installed', async () => {
    const mod = await import('../src/ruvector/diskann-backend.js');
    await expect(mod.getDiskAnnIndex({ dim: 384 })).rejects.toThrow();
  });

  it('thrown error from getDiskAnnIndex contains the literal ADR-0234 substring', async () => {
    const mod = await import('../src/ruvector/diskann-backend.js');
    let caught: unknown;
    try {
      await mod.getDiskAnnIndex({ dim: 384 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('ADR-0234');
    // F-06-002 typed-error shape (mirror of RvfBackend.ts:1129 template).
    expect((caught as { adr?: string }).adr).toBe('ADR-0234');
    expect(typeof (caught as { code?: string }).code).toBe('string');
    // The code MUST be one of the three labelled tier-failure codes so
    // sync agents can match mechanically.
    expect([
      'DISKANN_TIER_UNAVAILABLE',
      'HNSW_TIER_UNAVAILABLE',
      'PURE_JS_DISALLOWED',
    ]).toContain((caught as { code?: string }).code);
  });
});
