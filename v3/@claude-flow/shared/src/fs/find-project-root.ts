/**
 * Project-root resolution + write-path anchoring guard (ADR-0100 / ADR-0137).
 *
 * This is the canonical home for `findProjectRoot()`. It was relocated here
 * from `@claude-flow/cli/src/mcp-tools/types.ts` by ADR-0137 so that BOTH the
 * cli AND the memory package can consume the same primitive (memory cannot
 * import from cli — that would invert the dependency graph; both depend on
 * `@claude-flow/shared`, which has zero claude-flow deps).
 *
 * `@module @claude-flow/shared/fs/find-project-root`
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/**
 * Maximum parent-directory walk depth. 32 covers any real-world repo layout;
 * monorepos top out at ~12, deeply nested monorepos at ~20.
 */
const MAX_WALK_DEPTH = 32;

/**
 * Per-process memoization keyed on the resolved start directory (ADR-0137
 * Open Q2). Walks are cheap (~ms) but add up across the ~94 fixed sites if
 * each recomputes independently.
 *
 * Keying on the *resolved* start string (not "no key") preserves the
 * drift-safety contract from ADR-0100: the original doc warned that caching
 * a single module-level root goes stale when Claude Code's CWD drifts
 * mid-session. By caching per start-dir, a drifted CWD simply produces a
 * different key and re-walks — never returning a stale answer for the new
 * location. Same start dir → deterministic walk → safe to cache.
 */
const _rootCache = new Map<string, string>();

/**
 * Reset the per-process root cache. Test-only; production never needs this.
 */
export function resetProjectRootCache(): void {
  _rootCache.clear();
}

/**
 * ADR-0100: find the nearest project root by walking upward from `startDir`
 * (or process.cwd()/CLAUDE_FLOW_CWD if omitted).
 *
 * Marker priority (first match wins):
 *   1. `.ruflo-project` sentinel — explicit contract
 *   2. `CLAUDE.md` AND sibling `.claude/` — init'd project (BOTH required to
 *      skip docs/CLAUDE.md false-positives)
 *   3. `.git/` — generic repo fallback
 *   4. No marker → warn (stderr AND persistent log) + return startDir
 *
 * Memoized per resolved start dir (ADR-0137 Open Q2). The walk is hermetic
 * for a given start dir, so caching cannot return a stale answer — a drifted
 * CWD produces a different key. See docs/adr/ADR-0100-project-root-resolution.md
 * for the marker rationale and docs/adr/ADR-0137 for the relocation + caching.
 */
export function findProjectRoot(startDir?: string): string {
  const start = startDir ?? process.env.CLAUDE_FLOW_CWD ?? process.cwd();

  const cached = _rootCache.get(start);
  if (cached !== undefined) return cached;

  let dir = start;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    if (existsSync(join(dir, '.ruflo-project'))) {
      _rootCache.set(start, dir);
      return dir;
    }
    if (existsSync(join(dir, 'CLAUDE.md')) && existsSync(join(dir, '.claude'))) {
      _rootCache.set(start, dir);
      return dir;
    }
    if (existsSync(join(dir, '.git'))) {
      _rootCache.set(start, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const msg = `[ruflo] No project root marker found from ${start}; falling back to CWD. Consider 'ruflo init' or creating '.ruflo-project'.`;
  console.warn(msg);
  try {
    const logPath = join(homedir(), '.ruflo', 'resolver-warnings.log');
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // best-effort — resolver MUST NOT throw
  }
  // Do NOT cache the no-marker fallback: a marker may appear later in the
  // same process (e.g. `ruflo init` creates one), and the warn side-effect
  // should re-fire to keep surfacing the misconfiguration.
  return start;
}

/**
 * ADR-0137 Part 2 — runtime write-path guard.
 *
 * Assert that `targetPath` is anchored at the project root. Throws a fail-loud
 * error (per `feedback-no-fallbacks.md`) when a storage write targets a path
 * outside the resolved root — the signature of a cwd-anchoring regression that
 * would create a stray `.claude-flow/` / `.swarm/` / `.claude/` directory.
 *
 * Escape hatch: set `RUFLO_ADR0137_ENFORCE=0` to downgrade the throw to a
 * `console.warn` (emergency disable only — leaves the bug uncaught).
 *
 * @param targetPath  The path about to be written (absolute or relative).
 * @param root        Resolved project root (defaults to `findProjectRoot()`).
 */
export function assertProjectRootAnchored(
  targetPath: string,
  root: string = findProjectRoot(),
): void {
  const abs = resolve(targetPath);
  const resolvedRoot = resolve(root);
  if (abs === resolvedRoot || abs.startsWith(resolvedRoot + sep)) {
    return;
  }

  const message =
    `[adr-0137] storage write to '${abs}' is not anchored at project root ` +
    `'${resolvedRoot}'. This indicates a cwd-anchoring violation. See ADR-0137.`;

  if (process.env.RUFLO_ADR0137_ENFORCE === '0') {
    console.warn(`${message} (enforcement disabled via RUFLO_ADR0137_ENFORCE=0)`);
    return;
  }

  throw new Error(message);
}
