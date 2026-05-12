/**
 * Unified config resolution -- single source of truth (ADR-0076 Phase 1).
 *
 * Replaces 5 independent config chains (database-provider, controller-registry,
 * agentdb-service, memory-initializer, shared/config/loader) with one function
 * that runs once at startup and returns an immutable ResolvedConfig.
 *
 * Priority (highest wins):
 *   1. Explicit args passed to resolveConfig()
 *   2. embeddings.json from .claude-flow/ (walk up from cwd) for storage / HNSW /
 *      memory / learning / graph keys
 *   3. @claude-flow/config-chain.getEmbeddingConfig() for the embedding triple
 *      (model / dimension / provider). Same .claude-flow/embeddings.json file,
 *      shared walk-up algorithm, shared defaults — extracted in ADR-0177 Phase
 *      1.6 refactor so memory and agentdb stop duplicating the same logic.
 *   4. Hardcoded defaults (model: Xenova/all-mpnet-base-v2, dim: 768)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getEmbeddingConfig, resetConfig as resetChainConfig } from '@claude-flow/config-chain';
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
  readonly learning: {
    readonly sonaMode: string;
    readonly confidenceDecayRate: number;
    readonly accessBoostAmount: number;
    readonly consolidationThreshold: number;
    readonly ewcLambda: number;
  };
  readonly graph: {
    readonly pageRankDamping: number;
    readonly maxNodes: number;
    readonly similarityThreshold: number;
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
  sonaMode?: string;
  confidenceDecayRate?: number;
  accessBoostAmount?: number;
  consolidationThreshold?: number;
  ewcLambda?: number;
  pageRankDamping?: number;
  maxNodes?: number;
  graphSimilarityThreshold?: number;
}

// ---------------------------------------------------------------------------
// Hardcoded defaults (Layer 4 -- lowest priority)
// ---------------------------------------------------------------------------

// Embedding triple defaults (model / dimension / provider) live in
// @claude-flow/config-chain — single source of truth shared with agentdb.
// Memory-side fallback only for the model field, in the unlikely case the
// shared accessor returns model=undefined (file present with model:"" — which
// validateBoot rejects, but resolveConfig may be called pre-validation).
const DEFAULT_MODEL = 'Xenova/all-mpnet-base-v2';
const DEFAULT_STORAGE_PROVIDER: 'rvf' | 'better-sqlite3' = 'rvf';
const DEFAULT_DATABASE_PATH = '.claude-flow/memory.rvf';
const DEFAULT_WAL_MODE = true;
const DEFAULT_AUTO_PERSIST_INTERVAL = 30_000;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_NAMESPACE = 'default';
const DEFAULT_DEDUP_THRESHOLD = 0.95;
const DEFAULT_SONA_MODE = 'balanced';
const DEFAULT_CONFIDENCE_DECAY_RATE = 0.0008;
const DEFAULT_ACCESS_BOOST_AMOUNT = 0.05;
const DEFAULT_CONSOLIDATION_THRESHOLD = 8;
const DEFAULT_EWC_LAMBDA = 2000;
const DEFAULT_PAGE_RANK_DAMPING = 0.85;
const DEFAULT_MAX_NODES = 10000;
const DEFAULT_GRAPH_SIMILARITY_THRESHOLD = 0.25;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Walk up from cwd looking for `.claude-flow/embeddings.json`. */
function readEmbeddingsJson(): Record<string, unknown> | null {
  let dir = process.cwd(); // adr-0100-allow: tracked in ADR-0118 hive-mind-runtime-gaps-tracker
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
    // Overrides after singleton is already cached — warn and re-resolve.
    // Reset the shared chain too so the re-resolve picks up any test-time
    // mutations to .claude-flow/embeddings.json (the shared chain caches
    // independently per its own singleton).
    console.warn('[resolve-config] resolveConfig() called with overrides after singleton was cached. Re-resolving.');
    _singleton = null;
    resetChainConfig();
  }

  // Layers 4/3/2 for the embedding triple (model / dimension / provider) come
  // from @claude-flow/config-chain.getEmbeddingConfig(), which reads the same
  // .claude-flow/embeddings.json file with the same walk-up + defaults. Shared
  // package eliminates the dual-implementation drift risk that this function
  // previously carried (ADR-0177 Phase 1.6 refactor).
  const embChain = getEmbeddingConfig();
  let model: string = embChain.model ?? DEFAULT_MODEL;
  let dimension: number = embChain.dimension;
  let provider: string = embChain.provider;

  // Layer 4: hardcoded defaults for the non-embedding keys
  let storageProvider: 'rvf' | 'better-sqlite3' = DEFAULT_STORAGE_PROVIDER;
  let databasePath: string = DEFAULT_DATABASE_PATH;
  let walMode: boolean = DEFAULT_WAL_MODE;
  let autoPersistInterval: number = DEFAULT_AUTO_PERSIST_INTERVAL;
  let maxEntries: number = DEFAULT_MAX_ENTRIES;
  let defaultNamespace: string = DEFAULT_NAMESPACE;
  let dedupThreshold: number = DEFAULT_DEDUP_THRESHOLD;
  let sonaMode: string = DEFAULT_SONA_MODE;
  let confidenceDecayRate: number = DEFAULT_CONFIDENCE_DECAY_RATE;
  let accessBoostAmount: number = DEFAULT_ACCESS_BOOST_AMOUNT;
  let consolidationThreshold: number = DEFAULT_CONSOLIDATION_THRESHOLD;
  let ewcLambda: number = DEFAULT_EWC_LAMBDA;
  let pageRankDamping: number = DEFAULT_PAGE_RANK_DAMPING;
  let maxNodes: number = DEFAULT_MAX_NODES;
  let graphSimilarityThreshold: number = DEFAULT_GRAPH_SIMILARITY_THRESHOLD;
  // HNSW user-overrides (filled from embeddings.json hnsw.{M,efConstruction,efSearch} if present)
  let hnswMOverride: number | undefined;
  let hnswEfConstructionOverride: number | undefined;
  let hnswEfSearchOverride: number | undefined;

  // Layer 2: embeddings.json from .claude-flow/ for the non-embedding keys
  // (storage / HNSW / memory / learning / graph). The embedding triple is
  // already resolved above via getEmbeddingConfig().
  const fileConfig = readEmbeddingsJson();
  if (fileConfig) {
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
    if (typeof fileConfig.sonaMode === 'string') sonaMode = fileConfig.sonaMode;
    if (typeof fileConfig.confidenceDecayRate === 'number') {
      confidenceDecayRate = fileConfig.confidenceDecayRate;
    }
    if (typeof fileConfig.accessBoostAmount === 'number') {
      accessBoostAmount = fileConfig.accessBoostAmount;
    }
    if (typeof fileConfig.consolidationThreshold === 'number') {
      consolidationThreshold = fileConfig.consolidationThreshold;
    }
    if (typeof fileConfig.ewcLambda === 'number') ewcLambda = fileConfig.ewcLambda;
    if (typeof fileConfig.pageRankDamping === 'number') {
      pageRankDamping = fileConfig.pageRankDamping;
    }
    if (typeof fileConfig.maxNodes === 'number') maxNodes = fileConfig.maxNodes;
    if (typeof fileConfig.graphSimilarityThreshold === 'number') {
      graphSimilarityThreshold = fileConfig.graphSimilarityThreshold;
    }
    // Support nested learning.* and graph.* (structured style)
    const lrn = fileConfig.learning as Record<string, unknown> | undefined;
    if (lrn) {
      if (typeof lrn.sonaMode === 'string') sonaMode = lrn.sonaMode;
      if (typeof lrn.confidenceDecayRate === 'number') confidenceDecayRate = lrn.confidenceDecayRate;
      if (typeof lrn.accessBoostAmount === 'number') accessBoostAmount = lrn.accessBoostAmount;
      if (typeof lrn.consolidationThreshold === 'number') consolidationThreshold = lrn.consolidationThreshold;
      if (typeof lrn.ewcLambda === 'number') ewcLambda = lrn.ewcLambda;
    }
    const grph = fileConfig.graph as Record<string, unknown> | undefined;
    if (grph) {
      if (typeof grph.pageRankDamping === 'number') pageRankDamping = grph.pageRankDamping;
      if (typeof grph.maxNodes === 'number') maxNodes = grph.maxNodes;
      if (typeof grph.similarityThreshold === 'number') graphSimilarityThreshold = grph.similarityThreshold;
    }
    const hnsw = fileConfig.hnsw as Record<string, unknown> | undefined;
    if (hnsw) {
      if (typeof hnsw.M === 'number') hnswMOverride = hnsw.M;
      if (typeof hnsw.efConstruction === 'number') hnswEfConstructionOverride = hnsw.efConstruction;
      if (typeof hnsw.efSearch === 'number') hnswEfSearchOverride = hnsw.efSearch;
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
    if (overrides.sonaMode !== undefined) sonaMode = overrides.sonaMode;
    if (overrides.confidenceDecayRate !== undefined) confidenceDecayRate = overrides.confidenceDecayRate;
    if (overrides.accessBoostAmount !== undefined) accessBoostAmount = overrides.accessBoostAmount;
    if (overrides.consolidationThreshold !== undefined) {
      consolidationThreshold = overrides.consolidationThreshold;
    }
    if (overrides.ewcLambda !== undefined) ewcLambda = overrides.ewcLambda;
    if (overrides.pageRankDamping !== undefined) pageRankDamping = overrides.pageRankDamping;
    if (overrides.maxNodes !== undefined) maxNodes = overrides.maxNodes;
    if (overrides.graphSimilarityThreshold !== undefined) {
      graphSimilarityThreshold = overrides.graphSimilarityThreshold;
    }
  }

  // Safety net: never resolve to 384 -- always 768 (ADR-0069). When the gate
  // fires, drop any file-set HNSW overrides too — they were geometrically tied
  // to the rejected dimension and would mismatch the rewritten 768-dim index.
  if (dimension === 384) {
    dimension = 768;
    hnswMOverride = undefined;
    hnswEfConstructionOverride = undefined;
    hnswEfSearchOverride = undefined;
  }

  // Derive HNSW params from resolved dimension via shared derivation function;
  // user-set values from embeddings.json (hnsw.{M,efConstruction,efSearch}) win.
  const hnswParams: HNSWParams = deriveHNSWParams(dimension, maxEntries);
  const hnswM = hnswMOverride ?? hnswParams.M;
  const hnswEfConstruction = hnswEfConstructionOverride ?? hnswParams.efConstruction;
  const hnswEfSearch = hnswEfSearchOverride ?? hnswParams.efSearch;

  const resolved: ResolvedConfig = deepFreeze({
    embedding: { model, dimension, provider },
    storage: { provider: storageProvider, databasePath, walMode, autoPersistInterval },
    hnsw: { M: hnswM, efConstruction: hnswEfConstruction, efSearch: hnswEfSearch },
    memory: { maxEntries, defaultNamespace, dedupThreshold },
    learning: { sonaMode, confidenceDecayRate, accessBoostAmount, consolidationThreshold, ewcLambda },
    graph: { pageRankDamping, maxNodes, similarityThreshold: graphSimilarityThreshold },
  });

  _singleton = resolved;
  return resolved;
}

/** Return the cached config, calling resolveConfig() if not yet initialized. */
export function getConfig(): ResolvedConfig {
  return _singleton ?? resolveConfig();
}

/** Reset the singleton (for testing only). Also resets the shared
 * @claude-flow/config-chain singleton so the next resolveConfig() picks up
 * any test mutations to .claude-flow/embeddings.json. */
export function resetConfig(): void {
  _singleton = null;
  resetChainConfig();
}
