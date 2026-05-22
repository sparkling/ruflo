/**
 * Canonical accessor for `.claude-flow/config.json` (ADR-0224).
 *
 * Replaces the ~17 hand-rolled `JSON.parse(readFileSync(config.json))` callsites
 * across the substrate that previously used a `try { … } catch { return <fallback> }`
 * pattern — the same shape as a silent fallback at the configuration layer.
 *
 * Behaviour:
 *  - Missing `.claude-flow/config.json` → returns an empty validated config
 *    (substrate falls back to its own defaults; embedded/test use stays
 *    working without an init'd project).
 *  - Present-but-malformed JSON → throws with the file path in the message.
 *  - Present-but-wrong-type at a substrate-consumed leaf (e.g. string where
 *    `memory.similarityThreshold: number` is expected) → throws a Zod error
 *    citing the failing key path. This is the "fails loud at the first access,
 *    not silently five layers down" guarantee.
 *
 * Sync API by design: the previous substrate callsites were module-init
 * top-level eager reads (no `await` available). Async migration would be a
 * separate cross-cutting refactor.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { RuntimeConfigSchema, type RuntimeConfig } from './schema.js';

interface CacheEntry {
  readonly cwd: string;
  readonly config: RuntimeConfig;
}

let _cached: CacheEntry | null = null;

export interface ValidatedConfigOptions {
  /**
   * Starting directory for the walk-up search. Defaults to `process.cwd()`.
   * Walks parents until `.claude-flow/config.json` is found or root is reached.
   */
  cwd?: string;
}

/**
 * Walk up from `start` looking for `.claude-flow/config.json`.
 * Returns the absolute path or `null` if not found.
 */
function findConfigJson(start: string): string | null {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, '.claude-flow', 'config.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Format a Zod error into a single multi-line message that names the failing
 * key path(s). Substrate callers see this in stack traces.
 */
function formatZodError(error: z.ZodError, configPath: string): string {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
  return `Invalid config at ${configPath}:\n${issues}`;
}

/**
 * Get the validated runtime configuration from `.claude-flow/config.json`.
 *
 * @param options.cwd - Starting directory (default `process.cwd()`).
 * @returns The parsed and Zod-validated runtime config. Returns an empty
 *          config object when the file is absent.
 * @throws  When the file exists but is malformed JSON, or when a
 *          substrate-consumed leaf has the wrong type.
 */
export function getValidatedConfig(options?: ValidatedConfigOptions): RuntimeConfig {
  const cwd = options?.cwd ?? process.cwd();

  if (_cached && _cached.cwd === cwd) {
    return _cached.config;
  }

  const configPath = findConfigJson(cwd);
  if (!configPath) {
    const empty = RuntimeConfigSchema.parse({});
    _cached = { cwd, config: empty };
    return empty;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config.json at ${configPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config.json at ${configPath}: ${(err as Error).message}`);
  }

  const result = RuntimeConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(result.error, configPath));
  }

  _cached = { cwd, config: result.data };
  return result.data;
}

/**
 * Drop the cached config. Tests + runtime-reconfigure callers use this.
 */
export function resetConfigCache(): void {
  _cached = null;
}

export type { RuntimeConfig } from './schema.js';
