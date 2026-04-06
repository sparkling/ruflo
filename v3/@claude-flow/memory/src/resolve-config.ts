/**
 * Unified config resolution -- single source of truth (ADR-0076 Phase 1).
 *
 * Replaces 5 independent config chains (database-provider, controller-registry,
 * agentdb-service, memory-initializer, shared/config/loader) with one function
 * that runs once at startup and returns an immutable ResolvedConfig.
 *
 * Priority (highest wins):
 *   1. Explicit args passed to resolveConfig()
 *   2. embeddings.json from .claude-flow/ (walk up from cwd)
 *   3. getEmbeddingConfig() from @claude-flow/agentdb (dynamic import)
 *   4. Hardcoded defaults (model: Xenova/all-mpnet-base-v2, dim: 768)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deriveHNSWParams } from './hnsw-utils.js';
import type { HNSWParams } from './hnsw-utils.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  readonly embedding: {
    readonly model: string;
    readonly dimension: number;
    readonly provider: string;
  };
  readonly storage: {
    readonly provider: 'rvf' | 'better-sqlite3';
    readonly databasePath: string;
    readonly walMode: boolean;
    readonly autoPersistInterval: number;
  };
  readonly hnsw: {
    readonly M: number;
    readonly efConstruction: number;
    readonly efSearch: number;
  };
  readonly memory: {
    readonly maxEntries: number;
    readonly defaultNamespace: string;
    readonly dedupThreshold: number;
  };
}

/** Partial overrides accepted by resolveConfig(). */
export interface ConfigOverrides {
  model?: string;
  dimension?: number;
  provider?: string;
  storageProvider?: 'rvf' | 'better-sqlite3';
  databasePath?: string;
  walMode?: boolean;
  autoPersistInterval?: number;
  maxEntries?: number;
  defaultNamespace?: string;
  dedupThreshold?: number;
}

// ---------------------------------------------------------------------------
// Hardcoded defaults (Layer 4 -- lowest priority)
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'Xenova/all-mpnet-base-v2';
const DEFAULT_DIMENSION = 768;
const DEFAULT_PROVIDER = 'transformers.js';
const DEFAULT_STORAGE_PROVIDER: 'rvf' | 'better-sqlite3' = 'rvf';
const DEFAULT_DATABASE_PATH = '.claude-flow/memory.rvf';
const DEFAULT_WAL_MODE = true;
const DEFAULT_AUTO_PERSIST_INTERVAL = 30_000;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_NAMESPACE = 'default';
const DEFAULT_DEDUP_THRESHOLD = 0.95;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Walk up from cwd looking for `.claude-flow/embeddings.json`. */
function readEmbeddingsJson(): Record<string, unknown> | null {
  let dir = process.cwd();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, '.claude-flow', 'embeddings.json');
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf-8')) as Record<string, unknown>;
      } catch {
        return null; // malformed JSON -- skip
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/** Try to import @claude-flow/agentdb and call getEmbeddingConfig(). */
function tryAgentdbConfig(): { model?: string; dimension?: number; provider?: string } | null {
  try {
    // Dynamic require -- agentdb may not be installed in every context
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const agentdb = require('@claude-flow/agentdb');
    if (typeof agentdb.getEmbeddingConfig === 'function') {
      const cfg = agentdb.getEmbeddingConfig();
      return {
        model: cfg.model ?? undefined,
        dimension: cfg.dimension ?? undefined,
        provider: cfg.provider ?? undefined,
      };
    }
  } catch {
    // agentdb not available -- that is fine
  }
  return null;
}

/** Deep-freeze an object and all nested objects (recursive). */
function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _singleton: ResolvedConfig | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve configuration from all sources. First call computes and caches the
 * result; subsequent calls return the cached singleton.
 *
 * @param overrides  Explicit values (highest priority -- Layer 1).
 */
export function resolveConfig(overrides?: ConfigOverrides): ResolvedConfig {
  if (_singleton && !overrides) return _singleton;
  if (_singleton && overrides) {
    // Overrides after singleton is already cached — warn and re-resolve
    console.warn('[resolve-config] resolveConfig() called with overrides after singleton was cached. Re-resolving.');
    _singleton = null;
  }

  // Layer 4: start with hardcoded defaults
  let model: string = DEFAULT_MODEL;
  let dimension: number = DEFAULT_DIMENSION;
  let provider: string = DEFAULT_PROVIDER;
  let storageProvider: 'rvf' | 'better-sqlite3' = DEFAULT_STORAGE_PROVIDER;
  let databasePath: string = DEFAULT_DATABASE_PATH;
  let walMode: boolean = DEFAULT_WAL_MODE;
  let autoPersistInterval: number = DEFAULT_AUTO_PERSIST_INTERVAL;
  let maxEntries: number = DEFAULT_MAX_ENTRIES;
  let defaultNamespace: string = DEFAULT_NAMESPACE;
  let dedupThreshold: number = DEFAULT_DEDUP_THRESHOLD;

  // Layer 3: agentdb getEmbeddingConfig() (if available)
  const agentdbCfg = tryAgentdbConfig();
  if (agentdbCfg) {
    if (agentdbCfg.model) model = agentdbCfg.model;
    if (agentdbCfg.dimension && agentdbCfg.dimension !== 384) dimension = agentdbCfg.dimension;
    if (agentdbCfg.provider) provider = agentdbCfg.provider;
  }

  // Layer 2: embeddings.json from .claude-flow/
  const fileConfig = readEmbeddingsJson();
  if (fileConfig) {
    if (typeof fileConfig.model === 'string') model = fileConfig.model;
    if (typeof fileConfig.dimension === 'number' && fileConfig.dimension !== 384) {
      dimension = fileConfig.dimension;
    }
    if (typeof fileConfig.provider === 'string') provider = fileConfig.provider;
    if (typeof fileConfig.storageProvider === 'string') {
      storageProvider = fileConfig.storageProvider as 'rvf' | 'better-sqlite3';
    }
    if (typeof fileConfig.databasePath === 'string') databasePath = fileConfig.databasePath;
    if (typeof fileConfig.walMode === 'boolean') walMode = fileConfig.walMode;
    if (typeof fileConfig.autoPersistInterval === 'number') {
      autoPersistInterval = fileConfig.autoPersistInterval;
    }
    if (typeof fileConfig.maxEntries === 'number') maxEntries = fileConfig.maxEntries;
    if (typeof fileConfig.defaultNamespace === 'string') {
      defaultNamespace = fileConfig.defaultNamespace;
    }
    if (typeof fileConfig.dedupThreshold === 'number') {
      dedupThreshold = fileConfig.dedupThreshold;
    }
    // Support nested memory.dedupThreshold (agentdb-service style)
    const mem = fileConfig.memory as Record<string, unknown> | undefined;
    if (mem && typeof mem.dedupThreshold === 'number') {
      dedupThreshold = mem.dedupThreshold;
    }
  }

  // Layer 1: explicit overrides (highest priority)
  if (overrides) {
    if (overrides.model !== undefined) model = overrides.model;
    if (overrides.dimension !== undefined) dimension = overrides.dimension;
    if (overrides.provider !== undefined) provider = overrides.provider;
    if (overrides.storageProvider !== undefined) storageProvider = overrides.storageProvider;
    if (overrides.databasePath !== undefined) databasePath = overrides.databasePath;
    if (overrides.walMode !== undefined) walMode = overrides.walMode;
    if (overrides.autoPersistInterval !== undefined) {
      autoPersistInterval = overrides.autoPersistInterval;
    }
    if (overrides.maxEntries !== undefined) maxEntries = overrides.maxEntries;
    if (overrides.defaultNamespace !== undefined) defaultNamespace = overrides.defaultNamespace;
    if (overrides.dedupThreshold !== undefined) dedupThreshold = overrides.dedupThreshold;
  }

  // Safety net: never resolve to 384 -- always 768 (ADR-0069)
  if (dimension === 384) dimension = 768;

  // Derive HNSW params from resolved dimension via shared derivation function
  const hnswParams: HNSWParams = deriveHNSWParams(dimension, maxEntries);

  const resolved: ResolvedConfig = deepFreeze({
    embedding: { model, dimension, provider },
    storage: { provider: storageProvider, databasePath, walMode, autoPersistInterval },
    hnsw: { M: hnswParams.M, efConstruction: hnswParams.efConstruction, efSearch: hnswParams.efSearch },
    memory: { maxEntries, defaultNamespace, dedupThreshold },
  });

  _singleton = resolved;
  return resolved;
}

/** Return the cached config, calling resolveConfig() if not yet initialized. */
export function getConfig(): ResolvedConfig {
  return _singleton ?? resolveConfig();
}

/** Reset the singleton (for testing only). */
export function resetConfig(): void {
  _singleton = null;
}
