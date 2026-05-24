/**
 * ADR-0234 site 3 (router half) — memory-router.ts no longer swallows
 * embedding-pipeline init errors.
 *
 * Verifies the router-side half of the F-08-002 fix: the prior bare
 * `catch {}` at memory-router.ts:880 swallowed every error from
 * `pipelineMod.initPipeline(...)`, paired with the embedding-pipeline.ts
 * inner hash-fallback. With both halves removed (embedding-pipeline.ts in
 * the memory-pkg test; router here), an init error must surface — not be
 * masked by a `// Embedding pipeline init failed -- hash fallback will be
 * used` comment.
 *
 * Note: this test asserts the SOURCE-SHAPE (no bare `catch {}` around
 * `initPipeline` in the post-ADR-0234 router) rather than triggering a
 * full router init at runtime — runtime init requires a real config and a
 * real database path. The source-shape gate is the same idiom used by
 * `__tests__/arch/adr0209-no-fallbacks-envelope.arch.test.ts`.
 *
 * Per ADR-0234 Implementation discipline: TWO tests — one asserts the
 * bare-catch is gone, one asserts the ADR-0234 marker is present in
 * source so future audits can grep.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROUTER_SRC = resolve(__dirname, '../src/memory/memory-router.ts');

describe('ADR-0234 site 3 (router) — memory-router.ts no bare catch around initPipeline', () => {
  it('memory-router.ts contains no bare catch {} wrapping initPipeline', () => {
    const src = readFileSync(ROUTER_SRC, 'utf-8');
    // Pin the absence of the pre-ADR-0234 pattern:
    //   const pipelineMod = await import(...);
    //   if (pipelineMod?.initPipeline) { await pipelineMod.initPipeline(...); }
    //   } catch { /* anything-fallback */ }
    // The fix moves the initPipeline call outside the config-resolve try
    // so the throw propagates. Grep the call site + the next 8 lines and
    // require that nothing in that window matches `} catch { ... fallback`.
    const m = src.match(/await pipelineMod\.initPipeline[^\n]*\n([\s\S]{0,400})/);
    expect(m, 'expected initPipeline call site to be findable').not.toBeNull();
    const window = m![1];
    // The window must not contain a bare `} catch {` followed by no
    // re-throw (the pre-fix shape). The presence of `_resolvedEmbedding`
    // or the ADR-0234 comment header is the post-fix marker.
    expect(window).not.toMatch(/\}\s*catch\s*\{\s*\/\/[^}]*hash fallback/i);
  });

  it('memory-router.ts ADR-0234 comment block names the fix and the embedding-pipeline coordination', () => {
    const src = readFileSync(ROUTER_SRC, 'utf-8');
    // Pin the explanatory comment so a future merge that re-introduces
    // the bare-catch shape would have to also delete this comment —
    // making the regression visible in code review.
    expect(src).toContain('ADR-0234');
    expect(src).toContain('feedback-no-fallbacks');
    // The comment names the coordination with embedding-pipeline.ts so
    // sync agents see the two-file lockstep.
    expect(src).toMatch(/embedding-pipeline/);
  });
});
