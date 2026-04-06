/**
 * IStorage — Unified storage abstraction for the V3 memory system (ADR-0076 Phase 3)
 *
 * Reduces 7 backend types to a single interface.  Two implementations:
 *   - NativeStorage  (RvfBackend with native Rust HNSW when binaries exist)
 *   - PureTsStorage  (RvfBackend falling back to HnswLite + JSON)
 *
 * IStorage starts as a type alias for IMemoryBackend so existing call-sites
 * keep compiling.  IStorageContract documents the 10 methods controllers
 * actually call and will replace IMemoryBackend once all consumers migrate.
 *
 * @module @claude-flow/memory/storage
 */

import type {
  IMemoryBackend,
  MemoryEntry,
  MemoryEntryUpdate,
  MemoryQuery,
  SearchOptions,
  SearchResult,
} from './types.js';

/**
 * IStorage — drop-in alias for IMemoryBackend.
 *
 * Using a type alias (not a new interface) lets every existing backend
 * satisfy IStorage without changes.  When consumers are migrated, the
 * alias can be replaced with IStorageContract directly.
 */
export type IStorage = IMemoryBackend;

/**
 * IStorageContract — the 10 methods controllers actually call.
 *
 * This is the narrow interface that all future storage implementations
 * must satisfy.  It is a strict subset of IMemoryBackend.
 */
export interface IStorageContract {
  /** Initialize the storage backend */
  initialize(): Promise<void>;

  /** Gracefully shut down the storage backend */
  shutdown(): Promise<void>;

  /** Persist a memory entry */
  store(entry: MemoryEntry): Promise<void>;

  /** Retrieve a memory entry by its unique id */
  get(id: string): Promise<MemoryEntry | null>;

  /** Retrieve a memory entry by namespace + key */
  getByKey(namespace: string, key: string): Promise<MemoryEntry | null>;

  /** Apply a partial update to an existing entry */
  update(id: string, update: MemoryEntryUpdate): Promise<MemoryEntry | null>;

  /** Delete an entry by id, returning true if it existed */
  delete(id: string): Promise<boolean>;

  /** Semantic vector search using a pre-computed embedding */
  search(embedding: Float32Array, options: SearchOptions): Promise<SearchResult[]>;

  /** Structured query with filters */
  query(query: MemoryQuery): Promise<MemoryEntry[]>;

  /** Count entries, optionally scoped to a namespace */
  count(namespace?: string): Promise<number>;
}
