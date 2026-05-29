/**
 * ADR-0137 Part 2 — runtime write-path guard tests (OPT-IN semantics).
 *
 * The guard only enforces when `RUFLO_ADR0137_ENFORCE=1` (see the soundness
 * note on assertProjectRootAnchored: the storage layer cannot distinguish a
 * legitimate out-of-root write from a cwd-anchoring bug, so the hard guard is
 * opt-in and the real enforcement is the Part-1 grep gate + Part-3 acceptance
 * tree-walk). Covers:
 *   - DEFAULT (unset / != '1'): no-op even for an out-of-root path.
 *   - ENFORCE=1 THROW path: out-of-root write fails loud with an `[adr-0137]`
 *     error naming the bad path AND the resolved root.
 *   - ENFORCE=1 PASS path: a write anchored at (or under) the root is allowed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, sep } from 'node:path';
import { assertProjectRootAnchored } from '../src/fs/find-project-root.js';

describe('ADR-0137: assertProjectRootAnchored() (opt-in)', () => {
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
  });

  it('is a no-op by default (enforcement off) — even for an out-of-root path', () => {
    const stray = join(sep, 'tmp', 'somewhere-else', '.claude-flow', 'memory.rvf');
    expect(() => assertProjectRootAnchored(stray, root)).not.toThrow();
  });

  it('is a no-op when RUFLO_ADR0137_ENFORCE is set to anything other than "1"', () => {
    process.env.RUFLO_ADR0137_ENFORCE = '0';
    const stray = join(sep, 'tmp', 'elsewhere', '.swarm', 'memory.db');
    expect(() => assertProjectRootAnchored(stray, root)).not.toThrow();
  });

  it('ENFORCE=1: throws a fail-loud [adr-0137] error naming the bad path and the root', () => {
    process.env.RUFLO_ADR0137_ENFORCE = '1';
    const stray = join(sep, 'tmp', 'somewhere-else', '.claude-flow', 'memory.rvf');

    expect(() => assertProjectRootAnchored(stray, root)).toThrow(/adr-0137/);
    expect(() => assertProjectRootAnchored(stray, root)).toThrow(stray);
    expect(() => assertProjectRootAnchored(stray, root)).toThrow(root);
  });

  it('ENFORCE=1: does not throw for a path anchored under the project root', () => {
    process.env.RUFLO_ADR0137_ENFORCE = '1';
    const anchored = join(root, '.claude-flow', 'memory.rvf');
    expect(() => assertProjectRootAnchored(anchored, root)).not.toThrow();
  });

  it('ENFORCE=1: does not throw when the target IS the project root itself', () => {
    process.env.RUFLO_ADR0137_ENFORCE = '1';
    expect(() => assertProjectRootAnchored(root, root)).not.toThrow();
  });

  it('ENFORCE=1: does NOT treat a sibling-prefix dir as anchored (path-separator boundary)', () => {
    process.env.RUFLO_ADR0137_ENFORCE = '1';
    // `/workspaces/my-project-evil` shares the `my-project` string prefix but is
    // NOT under the root — the guard must use a path-separator boundary.
    const sibling = `${root}-evil/.claude-flow/memory.rvf`;
    expect(() => assertProjectRootAnchored(sibling, root)).toThrow(/adr-0137/);
  });
});
