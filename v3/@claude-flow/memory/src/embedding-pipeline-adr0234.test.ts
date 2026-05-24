/**
 * ADR-0234 site 3 — embedding-pipeline.ts fail-loud throw.
 *
 * Verifies that `EmbeddingPipeline.initialize()` throws a labelled
 * ADR-0234 error when neither @xenova/transformers nor ruvector is
 * available, instead of falling through to the hash-fallback provider
 * that returned ~0.05-0.28 similarities on mpnet-related queries (per
 * ADR-0227 / ADR-0233 §CT-A F-08-002).
 *
 * Per ADR-0234 Implementation discipline: TWO tests — one asserts throw,
 * one asserts the error message contains the literal `'ADR-0234'`
 * substring.
 *
 * Memory pkg has a vitest config that scans `src/**\/*.test.ts` (see
 * `forks/ruflo/v3/@claude-flow/memory/vitest.config.ts`) so this lands
 * under `memory/src/` rather than `__tests__/`.
 */

import { describe, it, expect } from 'vitest';
import { EmbeddingPipeline } from './embedding-pipeline.js';

describe('ADR-0234 site 3 — embedding-pipeline fail-loud throw', () => {
  it('initialize() throws when no embedding provider is available', async () => {
    // Use a model spec that is highly unlikely to be locally cached so
    // the @xenova/transformers branch fails AND, with no `ruvector` peer
    // installed in this test env, the second-tier import also fails.
    // The result must be a throw rather than silent hash degradation.
    const pipeline = new EmbeddingPipeline({
      model: 'Xenova/all-mpnet-base-v2-adr0234-does-not-exist',
      dimension: 768,
      provider: 'transformers.js',
    });
    await expect(pipeline.initialize()).rejects.toThrow();
  });

  it('thrown init error contains the literal ADR-0234 substring', async () => {
    const pipeline = new EmbeddingPipeline({
      model: 'Xenova/all-mpnet-base-v2-adr0234-does-not-exist',
      dimension: 768,
      provider: 'transformers.js',
    });
    let caught: unknown;
    try {
      await pipeline.initialize();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('ADR-0234');
    // Also expect the message to surface the underlying causes (transformers
    // + ruvector) so operators see WHICH binding to install.
    expect((caught as Error).message).toMatch(/transformers/i);
    expect((caught as Error).message).toMatch(/ruvector/i);
  });
});
