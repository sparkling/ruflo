/**
 * ADR-0137 Part 2 — runtime write-path guard tests.
 *
 * Covers:
 *   - THROW path: a write outside the project root fails loud with an
 *     `[adr-0137]` error naming the bad path AND the resolved root.
 *   - PASS path: a write anchored at (or under) the project root does not throw.
 *   - ESCAPE-HATCH path: RUFLO_ADR0137_ENFORCE=0 downgrades the throw to a
 *     console.warn (emergency disable) instead of failing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, sep } from 'node:path';
import { assertProjectRootAnchored } from '../src/fs/find-project-root.js';

describe('ADR-0137: assertProjectRootAnchored()', () => {
  const root = join(sep, 'workspaces', 'my-project');
  const originalEnforce = process.env.RUFLO_ADR0137_ENFORCE;

  beforeEach(() => {
    delete process.env.RUFLO_ADR0137_ENFORCE;
  });

  afterEach(() => {
    if (originalEnforce === undefined) {
      delete process.env.RUFLO_ADR0137_ENFORCE;
    } else {
      process.env.RUFLO_ADR0137_ENFORCE = originalEnforce;
    }
    vi.restoreAllMocks();
  });

  it('throws a fail-loud [adr-0137] error naming the bad path and the root', () => {
    const stray = join(sep, 'tmp', 'somewhere-else', '.claude-flow', 'memory.rvf');

    expect(() => assertProjectRootAnchored(stray, root)).toThrow(/adr-0137/);
    expect(() => assertProjectRootAnchored(stray, root)).toThrow(stray);
    expect(() => assertProjectRootAnchored(stray, root)).toThrow(root);
  });

  it('does not throw for a path anchored under the project root', () => {
    const anchored = join(root, '.claude-flow', 'memory.rvf');
    expect(() => assertProjectRootAnchored(anchored, root)).not.toThrow();
  });

  it('does not throw when the target IS the project root itself', () => {
    expect(() => assertProjectRootAnchored(root, root)).not.toThrow();
  });

  it('does NOT treat a sibling-prefix dir as anchored (no false positive)', () => {
    // `/workspaces/my-project-evil` shares the `my-project` string prefix but is
    // NOT under the root — the guard must use a path-separator boundary.
    const sibling = `${root}-evil/.claude-flow/memory.rvf`;
    expect(() => assertProjectRootAnchored(sibling, root)).toThrow(/adr-0137/);
  });

  it('downgrades the throw to console.warn when RUFLO_ADR0137_ENFORCE=0', () => {
    process.env.RUFLO_ADR0137_ENFORCE = '0';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stray = join(sep, 'tmp', 'elsewhere', '.swarm', 'memory.db');

    expect(() => assertProjectRootAnchored(stray, root)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/adr-0137/);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('enforcement disabled');
  });
});
