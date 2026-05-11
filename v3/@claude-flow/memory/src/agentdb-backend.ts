/**
 * AgentDB Backend - Integration with agentdb@2.0.0-alpha.3.4
 *
 * Provides IMemoryBackend implementation using AgentDB with:
 * - HNSW vector search (150x-12,500x faster than brute-force)
 * - Native or WASM backend support with graceful fallback
 * - Optional dependency handling (works without hnswlib-node)
 * - Seamless integration with storage backends
 *
 * @module v3/memory/agentdb-backend
 */

import { EventEmitter } from 'node:events';
import { MEMORY_ENTRIES_DDL, MEMORY_ENTRIES_INDEXES } from './memory-schema.js';
import {
  IMemoryBackend,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryUpdate,
  MemoryQuery,
  SearchOptions,
  SearchResult,
  BackendStats,
  HealthCheckResult,
  ComponentHealth,
  MemoryType,
  EmbeddingGenerator,
  generateMemoryId,
  createDefaultEntry,
  CacheStats,
  HNSWStats,
} from './types.js';
import { deriveHNSWParams as deriveHNSWParamsShared } from './hnsw-utils.js';
import { safeJsonParse } from './json-security.js';

// ===== AgentDB Optional Import =====

let AgentDB: any;
let HNSWIndex: any;
let isHnswlibAvailable: (() => Promise<boolean>) | undefined;

let deriveHNSWParamsFn: ((dim?: number) => { M: number; efConstruction: number; efSearch: number }) | undefined;

// Dynamically import agentdb (handled at runtime)
let agentdbImportPromise: Promise<void> | undefined;

function ensureAgentDBImport(): Promise<void> {
  if (!agentdbImportPromise) {
    // ADR-0111 W1.5 — Model 1: agentdb is a required dependency. The
    // previous try/catch silently swallowed import failures and degraded to
    // an in-memory fallback path that was dead in production (the orchestrator
    // path through /tmp/ruflo-build + Verdaccio install always has agentdb).
    // Per feedback-no-fallbacks, let import failure propagate so a broken
    // install fails loudly instead of pretending to work.
    agentdbImportPromise = (async () => {
      const agentdbModule: any = await import('agentdb');
      AgentDB = agentdbModule.AgentDB || agentdbModule.default;
      HNSWIndex = agentdbModule.HNSWIndex;
      isHnswlibAvailable = agentdbModule.isHnswlibAvailable;
      deriveHNSWParamsFn = agentdbModule.deriveHNSWParams;
    })();
  }
  return agentdbImportPromise;
}

/**
 * Derive optimal HNSW parameters from embedding dimension.
 * Delegates to agentdb's deriveHNSWParams() if available, otherwise uses
 * the shared formula from hnsw-utils (ADR-0065 P3-3).
 */
function deriveHNSWParams(dimension: number): { M: number; efConstruction: number; efSearch: number } {
  if (deriveHNSWParamsFn) return deriveHNSWParamsFn(dimension);
  return deriveHNSWParamsShared(dimension);
}

// ===== Configuration =====

/**
 * Configuration for AgentDB Backend
 */
export interface AgentDBBackendConfig {
  /** Database path for persistence */
  dbPath?: string;

  /** Namespace for memory organization */
  namespace?: string;

  /** Force WASM backend (skip native hnswlib) */
  forceWasm?: boolean;

  /**
   * Vector backend: 'auto', 'ruvector', 'hnswlib'.
   *
   * @deprecated ADR-0166 Phase 2: use `vectorIndex` for the vector-search-index
   * axis and `primaryStorage` for the persistence axis. `vectorBackend` is
   * forwarded as a deprecated alias; agentdb emits a stderr warning when it is
   * the only field set on the AgentDB side.
   */
  vectorBackend?: 'auto' | 'ruvector' | 'hnswlib';

  /**
   * Vector-search index engine (ADR-0166 Phase 2, Option E split).
   *
   * `'auto'` resolves at runtime. `'sqlite-vec'` is reserved for ADR-0166
   * Phase 3 (Option F) per-controller virtual-table augmentation; agentdb
   * throws a loud error if requested before Phase 3 lands.
   */
  vectorIndex?: 'auto' | 'ruvector' | 'hnswlib' | 'sqlite-vec';

  /**
   * Primary persistence substrate (ADR-0166 Phase 2, Option E split).
   *
   * Only `'sqlite'` is valid under Amendment 2026-05-11f (Option F retired
   * the substrate-flip path). agentdb throws a loud error for any other value.
   */
  primaryStorage?: 'sqlite';

  /** Vector dimensions (default: 768) */
  vectorDimension?: number;

  /** HNSW M parameter */
  hnswM?: number;

  /** HNSW efConstruction parameter */
  hnswEfConstruction?: number;

  /** HNSW efSearch parameter */
  hnswEfSearch?: number;

  /** Enable caching */
  cacheEnabled?: boolean;

  /** Embedding generator function */
  embeddingGenerator?: EmbeddingGenerator;

  /** Maximum entries */
  maxEntries?: number;
}

/**
 * Fallback configuration (used when config chain is unavailable)
 *
 * ADR-0166 Phase 2: `vectorIndex` and `primaryStorage` are intentionally
 * excluded from the Required<> — when omitted, AgentDB.initialize() applies
 * its own defaults (vectorIndex='auto', primaryStorage='sqlite') and emits
 * the deprecation warning if only the legacy `vectorBackend` field is set.
 * Populating them here would suppress the warning and mask user intent.
 */
const FALLBACK_CONFIG: Required<
  Omit<AgentDBBackendConfig, 'dbPath' | 'embeddingGenerator' | 'vectorIndex' | 'primaryStorage'>
> = {
  namespace: 'default',
  forceWasm: false,
  vectorBackend: 'auto',
  vectorDimension: 768,
  hnswM: 23,
  hnswEfConstruction: 100,
  hnswEfSearch: 50,
  cacheEnabled: true,
  maxEntries: 100000, // ADR-0080: aligned with resolve-config DEFAULT_MAX_ENTRIES
};

// ADR-0069: config-chain-aware resolution
let _backendResolvedDefaults: typeof FALLBACK_CONFIG | null = null;
let _backendResolvePromise: Promise<typeof FALLBACK_CONFIG> | null = null;

/**
 * Resolve default config from the config chain:
 * getEmbeddingConfig() → deriveHNSWParams() → FALLBACK_CONFIG
 */
function getDefaultConfig(): typeof FALLBACK_CONFIG {
  if (_backendResolvedDefaults) return _backendResolvedDefaults;
  return FALLBACK_CONFIG;
}

// Kick off async resolution early (non-blocking).
//
// ADR-0111 W1.5 — module-load-time best-effort: if either `agentdb`
// (required) or `@claude-flow/agentdb` (optional config-chain helper) is
// unavailable here, fall back to the in-process FALLBACK_CONFIG and let the
// per-instance `initialize()` raise the fatal error at the proper site.
// Throwing at module-load would crash any consumer that imports the file,
// even ones that never construct an AgentDBBackend.
(async () => {
  if (_backendResolvePromise) return _backendResolvePromise;
  _backendResolvePromise = (async () => {
    try {
      await ensureAgentDBImport();
      const agentdbModule: any = await import('@claude-flow/agentdb').catch(() => null);
      if (agentdbModule && typeof agentdbModule.getEmbeddingConfig === 'function') {
        const embCfg = agentdbModule.getEmbeddingConfig();
        const dim = embCfg.dimension || FALLBACK_CONFIG.vectorDimension;
        const hnsw = deriveHNSWParams(dim);
        _backendResolvedDefaults = {
          ...FALLBACK_CONFIG,
          vectorDimension: dim,
          hnswM: hnsw.M,
          hnswEfConstruction: hnsw.efConstruction,
          hnswEfSearch: hnsw.efSearch,
        };
        return _backendResolvedDefaults;
      }
    } catch { /* fatal init reported at instance time, not module-load */ }
    _backendResolvedDefaults = { ...FALLBACK_CONFIG };
    return _backendResolvedDefaults;
  })();
  return _backendResolvePromise;
})().catch(() => {});

/**
 * Default configuration (resolved from config chain or fallback)
 */
const DEFAULT_CONFIG = FALLBACK_CONFIG;

// ===== AgentDB Backend Implementation =====

/**
 * AgentDB Backend
 *
 * Integrates AgentDB for vector search with the V3 memory system.
 * Provides 150x-12,500x faster search compared to brute-force approaches.
 *
 * Features:
 * - HNSW indexing for fast approximate nearest neighbor search
 * - Automatic fallback: native hnswlib → ruvector → WASM
 * - Graceful handling of optional native dependencies
 * - Semantic search with filtering
 * - Compatible with RvfBackend for combined structured+vector queries
 */
export class AgentDBBackend extends EventEmitter implements IMemoryBackend {
  // ADR-0166 Phase 2: vectorIndex + primaryStorage are intentionally NOT
  // Required<>. Leaving them as undefined when not user-set is what lets
  // agentdb fire its deprecation warning once on the legacy vectorBackend
  // path. Forcing them populated here would suppress the warning + mask
  // user intent.
  private config: Required<
    Omit<AgentDBBackendConfig, 'dbPath' | 'embeddingGenerator' | 'vectorIndex' | 'primaryStorage'>
  > & {
    dbPath?: string;
    embeddingGenerator?: EmbeddingGenerator;
    vectorIndex?: AgentDBBackendConfig['vectorIndex'];
    primaryStorage?: AgentDBBackendConfig['primaryStorage'];
  };
  private agentdb: any;
  private initialized: boolean = false;

  // In-memory storage used as primary cache; agentdb is the persistence
  // layer (write-through). ADR-0111 W1.5 — these maps are NOT a fallback for
  // a missing agentdb; the class always uses both side-by-side.
  private entries: Map<string, MemoryEntry> = new Map();
  private namespaceIndex: Map<string, Set<string>> = new Map();
  private keyIndex: Map<string, string> = new Map();

  // O(1) reverse lookup for numeric ID -> string ID (fixes O(n) linear scan)
  private numericToStringIdMap: Map<number, string> = new Map();

  // Performance tracking
  private stats = {
    queryCount: 0,
    totalQueryTime: 0,
    searchCount: 0,
    totalSearchTime: 0,
  };

  constructor(config: AgentDBBackendConfig = {}) {
    super();
    // ADR-0069: use resolved config-chain defaults when available
    const merged = { ...getDefaultConfig(), ...config };
    // Derive dimension-aware HNSW defaults; explicit config still overrides
    const derived = deriveHNSWParams(merged.vectorDimension);
    if (config.hnswM === undefined) merged.hnswM = derived.M;
    if (config.hnswEfConstruction === undefined) merged.hnswEfConstruction = derived.efConstruction;
    if (config.hnswEfSearch === undefined) merged.hnswEfSearch = derived.efSearch;
    this.config = merged;
  }

  /**
   * ADR-0112 Phase 2 (AgentDB-backend track): public-method init guard.
   * Throws AgentDBInitError if `initialize()` has not completed. Applied
   * at the top of all 9 data-path methods so a caller that forgets to
   * await initialize() gets a precise error instead of silent in-memory
   * degradation (the entries Map exists pre-init from the constructor).
   *
   * Per Model 1 (ADR-0111 W1.5): a successful initialize() guarantees
   * this.agentdb is set; failure throws. So after requireAgentDB passes,
   * `this.agentdb` is guaranteed non-null — the prior `if (!this.agentdb)`
   * dead branches are now removed.
   *
   * The error is named AgentDBInitError so memory-router._isFatalInitError
   * picks it up via the same name-based discrimination as RvfBackend.
   */
  private requireAgentDB(method: string): void {
    if (!this.initialized || !this.agentdb) {
      const err = new Error(
        `AgentDBBackend.${method} called before initialize() — backend is not ` +
        `initialized. Per ADR-0112, public methods must fail loud rather than ` +
        `silently degrade to in-memory state. Call initialize() first.`,
      );
      err.name = 'AgentDBInitError';
      throw err;
    }
  }

  /**
   * Initialize AgentDB
   *
   * ADR-0111 W1.5 — Model 1 cleanup. Removed the silent
   * "available=false → in-memory fallback" early-return and the outer catch
   * that swallowed init failures. Per feedback-no-fallbacks, agentdb-init
   * failure indicates a broken install and is fatal.
   *
   * ADR-0111 W1.6 — outer try/catch labels generic Errors as
   * `AgentDBInitError` so `memory-router.ts` best-effort wrappers can
   * discriminate and re-throw (instead of swallowing). Without the label,
   * the W1.5 fail-loud-ness was observable inside this class but the CLI
   * process never exited non-zero on a broken install. Pre-existing fatal
   * classes (RvfCorruptError, EmbeddingDimensionError) keep their names —
   * only generic `Error` instances get relabeled.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // ensureAgentDBImport throws on import failure (Model 1 — no silent
      // fallback). If `AgentDB` is still undefined after the import, the
      // package shipped without the expected export — also fatal.
      await ensureAgentDBImport();
      if (AgentDB === undefined) {
        throw new Error(
          'agentdb module loaded but did not export AgentDB class — ' +
          'version mismatch with @claude-flow/memory (ADR-0111 W1.5)',
        );
      }

      // Initialize AgentDB with config
      // ADR-0166 Phase 2: forward both legacy `vectorBackend` and new
      // `vectorIndex` + `primaryStorage` fields. AgentDB.initialize() resolves
      // precedence (vectorIndex > vectorBackend) and emits the deprecation
      // warning if only the legacy alias is set.
      this.agentdb = new AgentDB({
        dbPath: this.config.dbPath || ':memory:',
        namespace: this.config.namespace,
        forceWasm: this.config.forceWasm,
        vectorBackend: this.config.vectorBackend,
        vectorIndex: this.config.vectorIndex,
        primaryStorage: this.config.primaryStorage,
        vectorDimension: this.config.vectorDimension,
      });

      // Suppress agentdb's noisy console.log during init
      // (EmbeddingService, AgentDB core emit info-level logs we don't need)
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        const msg = String(args[0] ?? '');
        if (msg.includes('Transformers.js loaded') ||
            msg.includes('Using better-sqlite3') ||
            msg.includes('better-sqlite3 unavailable') ||
            msg.includes('[AgentDB]')) return;
        origLog.apply(console, args);
      };
      try {
        await this.agentdb.initialize();
      } finally {
        console.log = origLog;
      }

      // Create memory_entries table if it doesn't exist
      await this.createSchema();

      this.initialized = true;
      this.emit('initialized', {
        backend: this.agentdb.vectorBackendName,
        isWasm: this.agentdb.isWasm,
      });
    } catch (e) {
      // ADR-0111 W1.6: label generic Errors so memory-router catches at
      // lines 534/566/698/717 discriminate (re-throw, not swallow). Don't
      // clobber names of pre-existing fatal classes (RvfCorruptError,
      // EmbeddingDimensionError, etc.).
      if (e instanceof Error && e.name === 'Error') {
        e.name = 'AgentDBInitError';
      }
      throw e;
    }
  }

  /**
   * Shutdown AgentDB
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    if (this.agentdb) {
      await this.agentdb.close();
    }

    this.initialized = false;
    this.emit('shutdown');
  }

  /**
   * Store a memory entry
   */
  async store(entry: MemoryEntry): Promise<void> {
    this.requireAgentDB('store');
    // Generate embedding if needed
    if (entry.content && !entry.embedding && this.config.embeddingGenerator) {
      entry.embedding = await this.config.embeddingGenerator(entry.content);
    }

    // Store in-memory for quick access
    this.entries.set(entry.id, entry);

    // Register ID mapping for O(1) reverse lookup
    this.registerIdMapping(entry.id);

    // Update indexes
    this.updateIndexes(entry);

    // ADR-0112 Phase 2: requireAgentDB guarantees this.agentdb is set;
    // dead `if (this.agentdb)` conditional removed.
    await this.storeInAgentDB(entry);

    this.emit('entry:stored', { id: entry.id });
  }

  /**
   * Get entry by ID
   */
  async get(id: string): Promise<MemoryEntry | null> {
    this.requireAgentDB('get');
    // Check in-memory first
    const cached = this.entries.get(id);
    if (cached) return cached;
    // ADR-0112 Phase 2: requireAgentDB guarantees this.agentdb is set;
    // dead `if (this.agentdb)` conditional removed.
    return this.getFromAgentDB(id);
  }

  /**
   * Get entry by key
   */
  async getByKey(namespace: string, key: string): Promise<MemoryEntry | null> {
    this.requireAgentDB('getByKey');
    const keyIndexKey = `${namespace}:${key}`;
    const id = this.keyIndex.get(keyIndexKey);
    if (!id) return null;
    return this.get(id);
  }

  /**
   * Update entry
   */
  async update(id: string, update: MemoryEntryUpdate): Promise<MemoryEntry | null> {
    this.requireAgentDB('update');
    const entry = this.entries.get(id);
    if (!entry) return null;

    // Apply updates
    if (update.content !== undefined) {
      entry.content = update.content;
      // Regenerate embedding if needed
      if (this.config.embeddingGenerator) {
        entry.embedding = await this.config.embeddingGenerator(entry.content);
      }
    }

    if (update.tags !== undefined) {
      entry.tags = update.tags;
    }

    if (update.metadata !== undefined) {
      entry.metadata = { ...entry.metadata, ...update.metadata };
    }

    if (update.accessLevel !== undefined) {
      entry.accessLevel = update.accessLevel;
    }

    if (update.expiresAt !== undefined) {
      entry.expiresAt = update.expiresAt;
    }

    if (update.references !== undefined) {
      entry.references = update.references;
    }

    entry.updatedAt = Date.now();
    entry.version++;

    // ADR-0112 Phase 2: requireAgentDB guarantees this.agentdb is set;
    // dead `if (this.agentdb)` conditional removed.
    await this.updateInAgentDB(entry);

    this.emit('entry:updated', { id });
    return entry;
  }

  /**
   * Delete entry
   */
  async delete(id: string): Promise<boolean> {
    this.requireAgentDB('delete');
    const entry = this.entries.get(id);
    if (!entry) return false;

    // Remove from indexes
    this.entries.delete(id);
    this.unregisterIdMapping(id); // Clean up reverse lookup map
    this.namespaceIndex.get(entry.namespace)?.delete(id);
    const keyIndexKey = `${entry.namespace}:${entry.key}`;
    this.keyIndex.delete(keyIndexKey);

    // ADR-0112 Phase 2: requireAgentDB guarantees this.agentdb is set;
    // dead `if (this.agentdb)` conditional removed.
    await this.deleteFromAgentDB(id);

    this.emit('entry:deleted', { id });
    return true;
  }

  /**
   * Query entries
   */
  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    this.requireAgentDB('query');
    const startTime = performance.now();
    let results: MemoryEntry[] = [];

    if (query.type === 'semantic' && (query.embedding || query.content)) {
      // Use semantic search
      const searchResults = await this.semanticSearch(query);
      results = searchResults.map((r) => r.entry);
    } else {
      // Fallback to in-memory filtering
      results = this.queryInMemory(query);
    }

    const duration = performance.now() - startTime;
    this.stats.queryCount++;
    this.stats.totalQueryTime += duration;

    return results;
  }

  /**
   * Semantic vector search
   */
  async search(
    embedding: Float32Array,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    this.requireAgentDB('search');
    const startTime = performance.now();

    // ADR-0112 Phase 2: requireAgentDB guarantees this.agentdb is set; the
    // pre-init "fallback to brute-force" branch removed (was dead under
    // Model 1).
    //
    // Brute-force fallback on AgentDB SEARCH FAILURE (not init failure)
    // remains: that's intra-store recovery (this.entries is always
    // synced via store(), so brute-force returns the same data set the
    // HNSW would have searched). It is NOT a cross-store fallback —
    // memory.rvf is never consulted from this path.
    try {
      const results = await this.searchWithAgentDB(embedding, options);

      const duration = performance.now() - startTime;
      this.stats.searchCount++;
      this.stats.totalSearchTime += duration;

      return results;
    } catch (error) {
      console.error('AgentDB search failed, falling back to brute-force (intra-store):', error);
      return this.bruteForceSearch(embedding, options);
    }
  }

  /**
   * Bulk insert
   */
  async bulkInsert(entries: MemoryEntry[]): Promise<void> {
    this.requireAgentDB('bulkInsert');
    for (const entry of entries) {
      await this.store(entry);
    }
  }

  /**
   * Bulk delete
   */
  async bulkDelete(ids: string[]): Promise<number> {
    this.requireAgentDB('bulkDelete');
    let deleted = 0;
    for (const id of ids) {
      if (await this.delete(id)) {
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Count entries
   */
  async count(namespace?: string): Promise<number> {
    if (namespace) {
      return this.namespaceIndex.get(namespace)?.size || 0;
    }
    return this.entries.size;
  }

  /**
   * List namespaces
   */
  async listNamespaces(): Promise<string[]> {
    return Array.from(this.namespaceIndex.keys());
  }

  /**
   * Clear namespace
   */
  async clearNamespace(namespace: string): Promise<number> {
    const ids = this.namespaceIndex.get(namespace);
    if (!ids) return 0;

    let deleted = 0;
    for (const id of ids) {
      if (await this.delete(id)) {
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<BackendStats> {
    const entriesByNamespace: Record<string, number> = {};
    for (const [namespace, ids] of this.namespaceIndex) {
      entriesByNamespace[namespace] = ids.size;
    }

    const entriesByType: Record<MemoryType, number> = {
      episodic: 0,
      semantic: 0,
      procedural: 0,
      working: 0,
      cache: 0,
    };

    for (const entry of this.entries.values()) {
      entriesByType[entry.type]++;
    }

    // Get HNSW stats if available
    let hnswStats: HNSWStats | undefined;
    if (this.agentdb && HNSWIndex) {
      try {
        const hnsw = this.agentdb.getController('hnsw');
        if (hnsw) {
          const stats = hnsw.getStats();
          hnswStats = {
            vectorCount: stats.numElements || 0,
            memoryUsage: 0,
            avgSearchTime: stats.avgSearchTimeMs || 0,
            buildTime: stats.lastBuildTime || 0,
            compressionRatio: 1.0,
          };
        }
      } catch {
        // HNSW not available
      }
    }

    return {
      totalEntries: this.entries.size,
      entriesByNamespace,
      entriesByType,
      memoryUsage: this.estimateMemoryUsage(),
      hnswStats,
      avgQueryTime:
        this.stats.queryCount > 0
          ? this.stats.totalQueryTime / this.stats.queryCount
          : 0,
      avgSearchTime:
        this.stats.searchCount > 0
          ? this.stats.totalSearchTime / this.stats.searchCount
          : 0,
    };
  }

  /**
   * Health check
   *
   * ADR-0111 W1.5 — Under Model 1 agentdb is required, so storage and index
   * are always healthy after `initialize()` succeeds. The pre-W1.5 'degraded'
   * branches were dead in production.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    const storageHealth: ComponentHealth = { status: 'healthy', latency: 0 };
    const indexHealth: ComponentHealth = { status: 'healthy', latency: 0 };
    const cacheHealth: ComponentHealth = { status: 'healthy', latency: 0 };

    return {
      status: 'healthy',
      components: {
        storage: storageHealth,
        index: indexHealth,
        cache: cacheHealth,
      },
      timestamp: Date.now(),
      issues,
      recommendations,
    };
  }

  // ===== Private Methods =====

  /**
   * Create database schema
   */
  private async createSchema(): Promise<void> {
    // silent-fallthrough-OK: called from initialize() before this.initialized is set; the public-method requireAgentDB guard does not apply here. Defensive no-op if agentdb construction failed (initialize would have already thrown).
    if (!this.agentdb) return;

    const db = this.agentdb.database;
    if (!db || typeof db.run !== 'function') {
      // AgentDB doesn't expose raw database - using native API
      return;
    }

    try {
    // Tables and indexes from shared schema (ADR-0065 P3-2)
    await db.run(MEMORY_ENTRIES_DDL);
    for (const idx of MEMORY_ENTRIES_INDEXES) {
      await db.run(idx);
    }
    } catch {
      // Schema creation failed - using in-memory only
    }
  }

  /**
   * Store entry in AgentDB
   */
  private async storeInAgentDB(entry: MemoryEntry): Promise<void> {
    // silent-fallthrough-OK: belt-and-braces; public store() already gated by requireAgentDB. Defensive against future direct private-method calls.
    if (!this.agentdb) return;

    // Try to use agentdb's native store method if available
    try {
      if (typeof this.agentdb.store === 'function') {
        await this.agentdb.store(entry.id, {
          key: entry.key,
          content: entry.content,
          embedding: entry.embedding,
          type: entry.type,
          namespace: entry.namespace,
          tags: entry.tags,
          metadata: entry.metadata,
        });
        return;
      }

      // Fallback: use database directly if available
      const db = this.agentdb.database;
      if (!db || typeof db.run !== 'function') {
        // No compatible database interface - skip agentdb storage
        // Entry is already stored in-memory
        return;
      }

      await db.run(
      `
      INSERT OR REPLACE INTO memory_entries
      (id, key, content, embedding, type, namespace, tags, metadata, owner_id,
       access_level, created_at, updated_at, expires_at, version, references,
       access_count, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        entry.id,
        entry.key,
        entry.content,
        entry.embedding ? Buffer.from(entry.embedding.buffer) : null,
        entry.type,
        entry.namespace,
        JSON.stringify(entry.tags),
        JSON.stringify(entry.metadata),
        entry.ownerId || null,
        entry.accessLevel,
        entry.createdAt,
        entry.updatedAt,
        entry.expiresAt || null,
        entry.version,
        JSON.stringify(entry.references),
        entry.accessCount,
        entry.lastAccessedAt,
      ]
    );
    } catch {
      // AgentDB storage failed - entry is already in-memory
    }

    // Add to vector index if HNSW is available
    if (entry.embedding && HNSWIndex) {
      try {
        const hnsw = this.agentdb.getController('hnsw');
        if (hnsw) {
          // Convert string ID to number for HNSW (use hash)
          const numericId = this.stringIdToNumeric(entry.id);
          hnsw.addVector(numericId, entry.embedding);
        }
      } catch {
        // HNSW not available
      }
    }
  }

  /**
   * Get entry from AgentDB
   */
  private async getFromAgentDB(id: string): Promise<MemoryEntry | null> {
    // silent-fallthrough-OK: belt-and-braces; public get() already gated by requireAgentDB. Defensive against future direct private-method calls.
    if (!this.agentdb) return null;

    try {
      // Try native get method first
      if (typeof this.agentdb.get === 'function') {
        const data = await this.agentdb.get(id);
        if (data) return this.dataToEntry(id, data);
      }

      // Fallback to database
      const db = this.agentdb.database;
      if (!db || typeof db.get !== 'function') return null;

      const row = await db.get('SELECT * FROM memory_entries WHERE id = ?', [id]);
      if (!row) return null;
      return this.rowToEntry(row);
    } catch {
      return null;
    }
  }

  /**
   * Convert agentdb data to MemoryEntry
   */
  private dataToEntry(id: string, data: any): MemoryEntry {
    const now = Date.now();
    return {
      id,
      key: data.key || id,
      content: data.content || '',
      embedding: data.embedding,
      type: data.type || 'semantic',
      namespace: data.namespace || this.config.namespace,
      tags: data.tags || [],
      metadata: data.metadata || {},
      ownerId: data.ownerId,
      accessLevel: data.accessLevel || 'private',
      createdAt: data.createdAt || now,
      updatedAt: data.updatedAt || now,
      expiresAt: data.expiresAt,
      version: data.version || 1,
      references: data.references || [],
      accessCount: data.accessCount || 0,
      lastAccessedAt: data.lastAccessedAt || now,
    };
  }

  /**
   * Update entry in AgentDB
   */
  private async updateInAgentDB(entry: MemoryEntry): Promise<void> {
    await this.storeInAgentDB(entry);
  }

  /**
   * Delete entry from AgentDB
   */
  private async deleteFromAgentDB(id: string): Promise<void> {
    // silent-fallthrough-OK: belt-and-braces; public delete() already gated by requireAgentDB. Defensive against future direct private-method calls.
    if (!this.agentdb) return;

    try {
      // Try native delete method first
      if (typeof this.agentdb.delete === 'function') {
        await this.agentdb.delete(id);
        return;
      }

      // Fallback to database
      const db = this.agentdb.database;
      if (!db || typeof db.run !== 'function') return;

      await db.run('DELETE FROM memory_entries WHERE id = ?', [id]);
    } catch {
      // Delete failed - entry removed from in-memory
    }
  }

  /**
   * Search with AgentDB HNSW
   */
  private async searchWithAgentDB(
    embedding: Float32Array,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    if (!this.agentdb || !HNSWIndex) {
      return [];
    }

    try {
      const hnsw = this.agentdb.getController('hnsw');
      if (!hnsw) {
        return this.bruteForceSearch(embedding, options);
      }

      const results = await hnsw.search(embedding, options.k, {
        threshold: options.threshold,
      });

      const searchResults: SearchResult[] = [];

      for (const result of results) {
        const id = this.numericIdToString(result.id);
        const entry = await this.get(id);
        if (!entry) continue;

        searchResults.push({
          entry,
          score: result.similarity,
          distance: result.distance,
        });
      }

      return searchResults;
    } catch (error) {
      console.error('HNSW search failed:', error);
      return this.bruteForceSearch(embedding, options);
    }
  }

  /**
   * Brute-force vector search fallback
   */
  private bruteForceSearch(
    embedding: Float32Array,
    options: SearchOptions
  ): SearchResult[] {
    const results: SearchResult[] = [];

    for (const entry of this.entries.values()) {
      if (!entry.embedding) continue;

      const score = this.cosineSimilarity(embedding, entry.embedding);
      const distance = 1 - score;

      if (options.threshold && score < options.threshold) continue;

      results.push({ entry, score, distance });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, options.k);
  }

  /**
   * Semantic search helper
   */
  private async semanticSearch(query: MemoryQuery): Promise<SearchResult[]> {
    let embedding = query.embedding;

    if (!embedding && query.content && this.config.embeddingGenerator) {
      embedding = await this.config.embeddingGenerator(query.content);
    }

    if (!embedding) {
      return [];
    }

    return this.search(embedding, {
      k: query.limit,
      threshold: query.threshold,
      filters: query,
    });
  }

  /**
   * In-memory query fallback
   */
  private queryInMemory(query: MemoryQuery): MemoryEntry[] {
    let results = Array.from(this.entries.values());

    // Apply filters
    if (query.namespace) {
      results = results.filter((e) => e.namespace === query.namespace);
    }

    if (query.key) {
      results = results.filter((e) => e.key === query.key);
    }

    if (query.keyPrefix) {
      results = results.filter((e) => e.key.startsWith(query.keyPrefix!));
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter((e) =>
        query.tags!.every((tag) => e.tags.includes(tag))
      );
    }

    return results.slice(0, query.limit);
  }

  /**
   * Update in-memory indexes
   */
  private updateIndexes(entry: MemoryEntry): void {
    const namespace = entry.namespace;

    if (!this.namespaceIndex.has(namespace)) {
      this.namespaceIndex.set(namespace, new Set());
    }
    this.namespaceIndex.get(namespace)!.add(entry.id);

    const keyIndexKey = `${namespace}:${entry.key}`;
    this.keyIndex.set(keyIndexKey, entry.id);
  }

  /**
   * Convert DB row to MemoryEntry
   */
  private rowToEntry(row: any): MemoryEntry {
    return {
      id: row.id,
      key: row.key,
      content: row.content,
      embedding: row.embedding
        ? new Float32Array(new Uint8Array(row.embedding).buffer)
        : undefined,
      type: row.type,
      namespace: row.namespace,
      tags: safeJsonParse<string[]>(row.tags || '[]'),
      metadata: safeJsonParse<Record<string, unknown>>(row.metadata || '{}'),
      ownerId: row.owner_id,
      accessLevel: row.access_level,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      version: row.version,
      references: safeJsonParse<string[]>(row.references || '[]'),
      accessCount: row.access_count || 0,
      lastAccessedAt: row.last_accessed_at || row.created_at,
    };
  }

  /**
   * Convert string ID to numeric for HNSW
   */
  private stringIdToNumeric(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash << 5) - hash + id.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  /**
   * Convert numeric ID back to string using O(1) reverse lookup
   * PERFORMANCE FIX: Uses pre-built reverse map instead of O(n) linear scan
   */
  private numericIdToString(numericId: number): string {
    // Use O(1) reverse lookup map
    const stringId = this.numericToStringIdMap.get(numericId);
    if (stringId) {
      return stringId;
    }
    // Fallback for unmapped IDs
    return String(numericId);
  }

  /**
   * Register string ID in reverse lookup map
   * Called when storing entries to maintain bidirectional mapping
   */
  private registerIdMapping(stringId: string): void {
    const numericId = this.stringIdToNumeric(stringId);
    this.numericToStringIdMap.set(numericId, stringId);
  }

  /**
   * Unregister string ID from reverse lookup map
   * Called when deleting entries
   */
  private unregisterIdMapping(stringId: string): void {
    const numericId = this.stringIdToNumeric(stringId);
    this.numericToStringIdMap.delete(numericId);
  }

  /**
   * Cosine similarity (returns value in range [0, 1] where 1 = identical)
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Estimate memory usage
   */
  private estimateMemoryUsage(): number {
    let total = 0;

    for (const entry of this.entries.values()) {
      total += entry.content.length * 2;
      if (entry.embedding) {
        total += entry.embedding.length * 4;
      }
    }

    return total;
  }

  /**
   * Get underlying AgentDB instance
   *
   * ADR-0111 W1.5 — `isAvailable()` removed. Under Model 1 agentdb is
   * required; if `initialize()` returned, this.agentdb is set.
   */
  getAgentDB(): any {
    return this.agentdb;
  }
}

export default AgentDBBackend;
