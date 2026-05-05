/**
 * Storage Factory — selects the best available storage backend (ADR-0076 Phase 3)
 *
 * Strategy:
 *   1. Try RvfBackend (native Rust HNSW when binaries present, pure-TS fallback).
 *   2. If RvfBackend fails entirely, throw with a clear diagnostic message.
 *
 * The factory NEVER silently falls back to InMemoryStore — a failed
 * initialization is always surfaced to the caller.
 *
 * @module @claude-flow/memory/storage-factory
 */

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { IStorage } from './storage.js';
import type { ResolvedConfig } from './resolve-config.js';

// ADR-0095 amendment (ruflo-patch 2d12bb1): module-scope cache keyed by
// `path.resolve(dbPath)`. Investigator observed `tryNativeInit` ran 2× per
// CLI invocation because two separate RvfBackend instances were being
// constructed for the same resolved path. Deduping at the factory pinches
// that redundant init off for every caller that routes through
// createStorage / createStorageFromConfig — which is all production callers
// today (controller-registry, memory-router, etc.).
//
// Keyed on the RESOLVED path (absolute, normalized) because two callers
// may pass different relative paths that resolve to the same file.
// `:memory:` is NEVER cached — it's a per-instance sentinel.
//
// Invalidation: if the cached backend's file is deleted out from under us
// (ENOENT at lookup), drop the entry so the next caller gets a fresh
// backend.
const backendCache = new Map<string, IStorage>();

/**
 * Configuration accepted by createStorage().
 *
 * This is intentionally a plain object (not ResolvedConfig) so the factory
 * can be used from tests and low-level callers without pulling in the
 * full resolve-config dependency graph.
 */
export interface StorageConfig {
  /** Path to the database file.  Use ':memory:' for in-memory storage. */
  databasePath: string;

  /** Vector dimensions (default: 768 for all-mpnet-base-v2) */
  dimensions?: number;

  /** HNSW M — max bi-directional links per node (default: derived from dimensions) */
  hnswM?: number;

  /** HNSW efConstruction — search width during index build */
  hnswEfConstruction?: number;

  /** HNSW efSearch — search width at query time (runtime-tunable) */
  hnswEfSearch?: number;

  /** Max elements the HNSW index can hold (default: 100000) */
  maxElements?: number;

  /** Default namespace for entries without an explicit namespace */
  defaultNamespace?: string;

  /** Auto-persist interval in milliseconds (default: 30000) */
  autoPersistInterval?: number;

  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

/**
 * Create a storage backend.
 *
 * Attempts RvfBackend (which uses native HNSW if available, otherwise
 * pure-TS HnswLite).  If RvfBackend itself fails to instantiate or
 * initialize, throws an error — no silent data-loss fallback.
 *
 * @param config - Storage configuration
 * @returns An initialized IStorage instance
 * @throws {Error} When no backend can be initialized
 */
export async function createStorage(config: StorageConfig): Promise<IStorage> {
  const {
    databasePath,
    dimensions = 768,
    hnswM,
    hnswEfConstruction,
    hnswEfSearch,
    maxElements,
    defaultNamespace = 'default',
    autoPersistInterval = 30_000,
    verbose = false,
  } = config;

  // Normalize path: strip .db/.json extensions for RVF files
  const rvfPath = databasePath === ':memory:'
    ? ':memory:'
    : databasePath.replace(/\.(db|json)$/, '.rvf');

  // ADR-0095 amendment (ruflo-patch 2d12bb1): dedupe by resolved path.
  // :memory: is NEVER cached (per-instance sentinel; two callers asking for
  // ':memory:' expect two independent stores).
  const cacheKey = rvfPath === ':memory:' ? null : resolvePath(rvfPath);
  if (cacheKey !== null) {
    const cached = backendCache.get(cacheKey);
    if (cached !== undefined) {
      if ((cached as any).initialized === false) {
        // Previous owner called shutdown(). The RvfBackend drops all state
        // and flips `initialized` back to false. Do NOT hand out a closed
        // instance — re-create.
        backendCache.delete(cacheKey);
      } else if (!existsSync(cacheKey) && (cached as any).dirty === true) {
        // Backing file was deleted out-of-band AND the cached instance had
        // pending writes that should have produced it. This is a real
        // data-loss situation; drop the cache and recreate so the next
        // caller fails loud at write time rather than silently re-using a
        // stale handle.
        //
        // ADR-0140 dedupe-test bug fix (2026-05-04): the previous unconditional
        // `existsSync` check evicted any never-written backend (empty hive,
        // autoPersistInterval=0, nothing flushed yet) on the second
        // createStorage call — breaking dedupe for fresh instances. The
        // `dirty===true` qualifier confines the eviction to the rare
        // genuine "file deleted out from under us" case while letting
        // empty-but-cached backends survive across createStorage calls.
        backendCache.delete(cacheKey);
      } else {
        if (verbose) {
          console.log(
            `[StorageFactory] Reusing cached RvfBackend for ${cacheKey} (ADR-0095 dedup)`,
          );
        }
        return cached;
      }
    }
  }

  // Bug-4 (2026-05-05) parallel-wave thread-safety: at most ONE retry on
  // lock-acquisition timeout. RvfBackend.initialize() now runs with a 180s
  // budget; if even that times out, the contender likely finished mid-flight
  // and a fresh attempt has a clean path. Retrying once with a small jitter
  // covers the rare wave-saturation case without papering over real failures.
  // Non-lock errors (ENOENT, EACCES, RvfCorruptError, etc.) are NOT retried.
  let retryAttempt = 0;
  const tryInit = async (): Promise<IStorage> => {
    const { RvfBackend } = await import('./rvf-backend.js');
    const backend = new RvfBackend({
      databasePath: rvfPath,
      dimensions,
      ...(hnswM !== undefined && { hnswM }),
      ...(hnswEfConstruction !== undefined && { hnswEfConstruction }),
      ...(hnswEfSearch !== undefined && { hnswEfSearch }),
      ...(maxElements !== undefined && { maxElements }),
      defaultNamespace,
      autoPersistInterval,
      verbose,
    });
    await backend.initialize();
    return backend;
  };
  try {
    let backend: IStorage;
    try {
      backend = await tryInit();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== 'ELOCKACQUIRE' || retryAttempt >= 1) throw err;
      retryAttempt++;
      if (verbose) {
        console.warn(
          `[StorageFactory] Lock-timeout on init (attempt 1); retrying once after 500ms jitter (path=${rvfPath})`,
        );
      }
      await new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 500)));
      backend = await tryInit();
    }

    if (verbose) {
      console.log(
        `[StorageFactory] Storage initialized: RvfBackend (path=${rvfPath}, dim=${dimensions})`,
      );
    }

    if (cacheKey !== null) {
      backendCache.set(cacheKey, backend);
    }
    return backend;
  } catch (primaryError: unknown) {
    // RvfBackend failed — do NOT silently fall back to InMemoryStore.
    // Surface the error so the caller can diagnose and fix.
    //
    // ADR-0095 Pass 3 (H9): preserve err.cause + err.code on the wrapped
    // error. The original rewrap dropped `.cause` and `.code`, which made
    // upstream catchers unable to discriminate ENOENT-on-parent-dir from
    // EACCES-on-permissions from a genuine data-integrity refusal. Now the
    // wrapped error carries both the human-readable chain AND the
    // structured fields so callers can branch on `.code` / walk `.cause`.
    const errCode = (primaryError as any)?.code;
    const errMsg = primaryError instanceof Error
      ? primaryError.message
      : String(primaryError);
    const wrapped: Error & { code?: string } = new Error(
      `[StorageFactory] Failed to create storage backend ` +
      `(${errCode ?? 'unknown'}).\n` +
      `  Path: ${rvfPath}\n` +
      `  Dimensions: ${dimensions}\n` +
      `  Underlying: ${errMsg}\n` +
      `\n` +
      `Both native Rust HNSW and pure-TS fallback failed.  ` +
      `Verify the database path is writable and dependencies are installed.`,
    );
    wrapped.cause = primaryError;
    if (errCode !== undefined) wrapped.code = errCode;
    throw wrapped;
  }
}

/**
 * Create storage from a ResolvedConfig (as produced by resolve-config.ts).
 *
 * This is a convenience wrapper that maps ResolvedConfig fields to StorageConfig
 * so production callers can pass `getConfig()` directly.
 */
export async function createStorageFromConfig(
  resolved: ResolvedConfig,
  overrides: Partial<StorageConfig> = {},
): Promise<IStorage> {
  return createStorage({
    databasePath: resolved.storage.databasePath,
    dimensions: resolved.embedding.dimension,
    hnswM: resolved.hnsw.M,
    hnswEfConstruction: resolved.hnsw.efConstruction,
    hnswEfSearch: resolved.hnsw.efSearch,
    maxElements: resolved.memory.maxEntries,
    defaultNamespace: resolved.memory.defaultNamespace,
    autoPersistInterval: resolved.storage.autoPersistInterval,
    ...overrides,
  });
}
