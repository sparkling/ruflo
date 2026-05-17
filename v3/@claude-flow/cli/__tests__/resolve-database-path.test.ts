/**
 * ADR-0183 A0: _resolveDatabasePath canonical project-marker check.
 *
 * Before A0, `_resolveDatabasePath` used `fs.existsSync('<projectRoot>/.claude-flow')`
 * as the "are we in a project?" signal. The archivist's audit-writer
 * (forks/agentdb src/archivist/audit-writer.ts:93) mkdir's
 * `<cwd>/.claude-flow/data/` on its first audit-write as a side-effect,
 * which post-ADR-0183 A1 fires on every memory store. The next cold-start
 * cli process in a markerless cwd then saw `.claude-flow/` and false-
 * positived "in project" → resolved memory to `<cwd>/.claude-flow/memory.rvf`
 * (a fresh empty file), losing the previous process's writes to the
 * per-user `$HOME/.claude-flow/data/memory.rvf`. That regression broke
 * `adr0069-bug3-persist` post-A1.
 *
 * A0 fix: the membership check uses canonical project markers
 * (.ruflo-project | CLAUDE.md+.claude/ | .git/) — the same set
 * findProjectRoot() and archivist-init's pre-flight already use.
 * `.claude-flow/` (runtime-produced) is explicitly NOT a marker.
 *
 * Tests use real temp dirs (no fs mocking) and route cwd via
 * CLAUDE_FLOW_CWD (honoured by findProjectRoot() at types.ts:51) — vitest
 * workers don't allow process.chdir(). $HOME is overridden via vi.stubEnv
 * so the per-user fallback path is deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resolveDatabasePathForTest } from '../src/memory/memory-router.ts';

describe('ADR-0183 A0: _resolveDatabasePath canonical markers', () => {
  let tmpRoot: string;
  let fakeHome: string;

  beforeEach(() => {
    // realpathSync resolves macOS /var → /private/var so equality assertions
    // against project-root paths don't trip on the symlinked tmpdir prefix.
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-db-path-')));
    fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'resolve-db-home-')));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('CLAUDE_FLOW_CWD', tmpRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('markerless cwd with runtime-created .claude-flow/ resolves to per-user path (ADR-0069 Bug #3 regression guard)', () => {
    // Simulate the audit-writer's side-effect: mkdir <cwd>/.claude-flow/data/
    // on first dispatch. Pre-A0 this would false-positive "in project".
    mkdirSync(join(tmpRoot, '.claude-flow', 'data'), { recursive: true });

    const resolved = __resolveDatabasePathForTest('.claude-flow/memory.rvf');

    // Per-user fallback uses os.homedir(), which honours $HOME on POSIX.
    expect(resolved).toBe(join(homedir(), '.claude-flow', 'data', 'memory.rvf'));
    // Negative assertion: must NOT have resolved to <cwd>/.claude-flow/memory.rvf
    expect(resolved).not.toBe(join(tmpRoot, '.claude-flow', 'memory.rvf'));
  });

  it('in-project via CLAUDE.md + .claude/ resolves to project-relative path', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# project\n', 'utf-8');
    mkdirSync(join(tmpRoot, '.claude'));

    const resolved = __resolveDatabasePathForTest('.claude-flow/memory.rvf');

    expect(resolved).toBe(join(tmpRoot, '.claude-flow', 'memory.rvf'));
  });

  it('in-project via .ruflo-project marker resolves to project-relative path', () => {
    writeFileSync(join(tmpRoot, '.ruflo-project'), '{"name":"ruflo"}\n', 'utf-8');

    const resolved = __resolveDatabasePathForTest('.claude-flow/memory.rvf');

    expect(resolved).toBe(join(tmpRoot, '.claude-flow', 'memory.rvf'));
  });

  it('in-project via .git/ marker resolves to project-relative path', () => {
    mkdirSync(join(tmpRoot, '.git'));

    const resolved = __resolveDatabasePathForTest('.claude-flow/memory.rvf');

    expect(resolved).toBe(join(tmpRoot, '.claude-flow', 'memory.rvf'));
  });

  it('absolute configuredPath is returned verbatim regardless of markers', () => {
    const abs = join(tmpRoot, 'custom', 'memory.rvf');

    expect(__resolveDatabasePathForTest(abs)).toBe(abs);
  });

  it(':memory: sentinel passes through unchanged', () => {
    expect(__resolveDatabasePathForTest(':memory:')).toBe(':memory:');
  });
});
