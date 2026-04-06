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

import type { IStorage } from './storage.js';
import type { ResolvedConfig } from './resolve-config.js';

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
    maxElements,
    defaultNamespace = 'default',
    autoPersistInterval = 30_000,
    verbose = false,
  } = config;

  // Normalize path: strip .db/.json extensions for RVF files
  const rvfPath = databasePath === ':memory:'
    ? ':memory:'
    : databasePath.replace(/\.(db|json)$/, '.rvf');

  try {
    const { RvfBackend } = await import('./rvf-backend.js');

    const backend = new RvfBackend({
      databasePath: rvfPath,
      dimensions,
      ...(hnswM !== undefined && { hnswM }),
      ...(hnswEfConstruction !== undefined && { hnswEfConstruction }),
      ...(maxElements !== undefined && { maxElements }),
      defaultNamespace,
      autoPersistInterval,
      verbose,
    });

    await backend.initialize();

    if (verbose) {
      console.log(
        `[StorageFactory] Storage initialized: RvfBackend (path=${rvfPath}, dim=${dimensions})`,
      );
    }

    return backend;
  } catch (primaryError: unknown) {
    // RvfBackend failed — do NOT silently fall back to InMemoryStore.
    // Surface the error so the caller can diagnose and fix.
    const msg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    throw new Error(
      `[StorageFactory] Failed to create storage backend.\n` +
      `  Path: ${rvfPath}\n` +
      `  Dimensions: ${dimensions}\n` +
      `  Cause: ${msg}\n` +
      `\n` +
      `Both native Rust HNSW and pure-TS fallback failed.  ` +
      `Verify the database path is writable and dependencies are installed.`,
    );
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
    defaultNamespace: resolved.memory.defaultNamespace,
    autoPersistInterval: resolved.storage.autoPersistInterval,
    ...overrides,
  });
}
