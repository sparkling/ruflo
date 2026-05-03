/**
 * ADR-0100 §5 / ADR-0097 paired-test contract: findProjectRoot() resolution.
 *
 * Locks the marker priority chain implemented in
 * src/mcp-tools/types.ts::findProjectRoot:
 *
 *   1. `.ruflo-project` sentinel — explicit contract (highest priority)
 *   2. `CLAUDE.md` AND sibling `.claude/` — init'd project (BOTH required)
 *   3. `.git/` — generic repo fallback
 *   4. No marker within MAX_WALK_DEPTH (32) → warn + return startDir
 *
 * The resolver MUST be hermetic per call (no module-load caching) and MUST
 * NOT throw — even when starting outside any project, it falls back to the
 * supplied startDir and logs a warning.
 *
 * Tests use real temp dirs (no fs mocking) so the actual existsSync /
 * dirname walk is exercised. console.warn is silenced for scenarios that
 * exercise the no-marker fallback to keep test output clean.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot } from '../src/mcp-tools/types.js';

/** Mirror of MAX_WALK_DEPTH in types.ts — adjust here only if ADR-0100 changes the cap. */
const MAX_WALK_DEPTH = 32;

describe('ADR-0100: findProjectRoot()', () => {
  let tmpRoot: string;
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // realpathSync resolves macOS /var → /private/var so equality assertions
    // against project-root paths don't fail on the symlinked tmpdir prefix.
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'find-project-root-')));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  it('returns the root when cwd === project root with .ruflo-project (scenario 1)', () => {
    writeFileSync(join(tmpRoot, '.ruflo-project'), '{"name":"ruflo"}\n', 'utf-8');

    expect(findProjectRoot(tmpRoot)).toBe(tmpRoot);
  });

  it('walks up from a subdirectory to find .ruflo-project (scenario 2)', () => {
    writeFileSync(join(tmpRoot, '.ruflo-project'), '{"name":"ruflo"}\n', 'utf-8');
    const sub = join(tmpRoot, 'src', 'modules', 'auth');
    mkdirSync(sub, { recursive: true });

    expect(findProjectRoot(sub)).toBe(tmpRoot);
  });

  it('falls back to CLAUDE.md + .claude/ pair when sentinel is absent (scenario 3)', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# project\n', 'utf-8');
    mkdirSync(join(tmpRoot, '.claude'));
    const sub = join(tmpRoot, 'pkg', 'inner');
    mkdirSync(sub, { recursive: true });

    expect(findProjectRoot(sub)).toBe(tmpRoot);
  });

  it('does NOT match CLAUDE.md alone — both CLAUDE.md and .claude/ are required (scenario 3 negative)', () => {
    // Documents the false-positive guard described in types.ts:42 — repos
    // shipping a docs/CLAUDE.md without a sibling .claude/ MUST NOT match.
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# docs only\n', 'utf-8');
    // No .claude/ directory, no .git, no sentinel.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Walk falls through to the no-marker branch and returns startDir.
    expect(findProjectRoot(tmpRoot)).toBe(tmpRoot);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to .git/ when no sentinel and no CLAUDE.md+.claude pair (scenario 4)', () => {
    mkdirSync(join(tmpRoot, '.git'));
    const sub = join(tmpRoot, 'src');
    mkdirSync(sub);

    expect(findProjectRoot(sub)).toBe(tmpRoot);
  });

  it('returns startDir and warns when no marker is found (scenario 5)', () => {
    // tmpRoot is a fresh temp dir with no sentinel, no CLAUDE.md, no .git.
    // The walk reaches the filesystem root without matching anything.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = findProjectRoot(tmpRoot);

    // Per types.ts:73 the resolver returns the startDir as a last resort.
    expect(result).toBe(tmpRoot);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/No project root marker found/);
  });

  it('respects MAX_WALK_DEPTH and bails out without infinite loop (scenario 6)', () => {
    // Build a path 33 segments deep with NO markers anywhere on the chain,
    // then call findProjectRoot from the leaf. The resolver MUST terminate
    // (returning startDir) without scanning beyond MAX_WALK_DEPTH parents.
    const segments = Array.from({ length: MAX_WALK_DEPTH + 1 }, (_, i) => `lvl${i}`);
    const deepPath = join(tmpRoot, ...segments);
    mkdirSync(deepPath, { recursive: true });

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Bound execution time as a defensive guard against an infinite loop
    // regression — should complete in well under 1s on any host.
    const started = Date.now();
    const result = findProjectRoot(deepPath);
    const elapsedMs = Date.now() - started;

    expect(result).toBe(deepPath);
    expect(elapsedMs).toBeLessThan(1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
