/**
 * Arch-test: ADR-0209 — no-fallbacks (envelope honesty at known site).
 *
 * Per ADR-0209 Option E: bulk-fix the genuine dishonest-success /
 * data-loss subset (item #2), enforce by behavior + a fixed-site
 * regression assertion (item #4). NO promotable build-time gate — the
 * lexical "success:true inside a catch" rule is undecidable cli/src-wide
 * (~6-7 false positives, including honest `{enabled:false, reason}`
 * discriminators at `:630/:656/:686/:727`). See ADR-0209's second
 * council 2026-05-22 re-validation.
 *
 * This test pins the ONE site the ADR identifies as a genuine
 * empty-envelope violation: `embeddings-tools.ts:525`'s database-failure
 * catch must return `success: false` (not `success: true` with empty
 * results), so a caller can tell failure from absence-with-no-results.
 *
 * The pin operates on the resolved source text (zero deps; matches the
 * existing `arch/` family idiom — daemon-ipc-server-removed,
 * hooks-dead-package, env-var-theatrical-gate). It MUST NOT be promoted
 * to a `cli/src`-wide lexical scan (per ADR-0209's settled conclusion);
 * the honest `{enabled:false, reason:'...'}` discriminator sites would
 * false-positive.
 *
 * What an honest catch looks like at the embeddings_search dispatch
 * site: either `success: false` (this site's correct disposition; the
 * caller can branch on `success === false`), OR an explicit non-empty
 * discriminator at the payload (which the four sister sites use; not
 * applicable here because `results: []` is identical to "real empty
 * results" — no discriminator possible).
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EMBEDDINGS_TOOLS = resolve(__dirname, '../../src/mcp-tools/embeddings-tools.ts');

describe('ADR-0209 — embeddings_search empty-envelope honesty', () => {
  // Helper: locate the ADR-0209-marked catch block's return-object body.
  // The bulk-fix pinned an `// ADR-0209 ... — Database not available:`
  // comment inside the catch; the return immediately follows it. We slice
  // the file to the comment + the next `}` so the per-field assertions
  // below operate on that block alone (not on sibling sites elsewhere in
  // the file that also use `success:` / `error:` keys).
  function getAdr0209CatchReturnBody(src: string): string {
    const m = src.match(/ADR-0209[\s\S]*?Database not available[\s\S]*?return\s*\{([\s\S]*?)\n\s*\}\;/);
    if (!m) throw new Error('expected to find ADR-0209 Database-not-available catch return block');
    return m[1];
  }

  it('embeddings-tools.ts embeddings_search catch returns success:false on database failure', () => {
    const src = readFileSync(EMBEDDINGS_TOOLS, 'utf8');
    const body = getAdr0209CatchReturnBody(src);
    // Pin the `success:` literal to `false`. Asserts that no regression
    // restores the dishonest `success: true, results: []` envelope.
    const m = body.match(/success:\s*(true|false)/);
    expect(m, 'expected `success:` key in ADR-0209 catch return body').not.toBeNull();
    expect(m![1]).toBe('false');
  });

  it('embeddings-tools.ts embeddings_search catch sets an honest error field', () => {
    const src = readFileSync(EMBEDDINGS_TOOLS, 'utf8');
    const body = getAdr0209CatchReturnBody(src);
    // The honest-disposition return must include an `error` (or
    // discriminated `reason`) field so callers can tell empty-by-failure
    // apart from empty-by-no-data. Pin its presence in the catch return.
    expect(body).toMatch(/\berror:\s*[`'"]/);
  });
});
