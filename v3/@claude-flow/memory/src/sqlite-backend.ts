/**
 * SQLite Memory Backend
 *
 * Provides structured storage for memory entries using SQLite.
 * Optimized for ACID transactions, exact matches, and complex queries.
 * Part of ADR-009: Hybrid Memory Backend (SQLite + AgentDB)
 *
 * @module v3/memory/sqlite-backend
 */

import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { MEMORY_ENTRIES_DDL, MEMORY_ENTRIES_INDEXES, MEMORY_EMBEDDINGS_DDL } from './memory-schema.js';
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
} from './types.js';

/**
 * Configuration for SQLite Backend
 */
export interface SQLiteBackendConfig {
  /** Path to SQLite database file (:memory: for in-memory) */
  databasePath: string;

  /** Enable WAL mode for better concurrency */
  walMode: boolean;

  /** Enable query optimization */
  optimize: boolean;

  /** Default namespace */
  defaultNamespace: string;

  /** Embedding generator (for compatibility with hybrid mode) */
  embeddingGenerator?: EmbeddingGenerator;

  /** Maximum entries before auto-cleanup */
  maxEntries: number;

  /** Enable verbose logging */
  verbose: boolean;

  /** ADR-0069 A1: config-chain SQLite pragmas */
  sqlitePragmas?: {
    cacheSize?: number;      // default: -64000 (64MB)
    busyTimeoutMs?: number;  // default: 5000
    journalMode?: string;    // default: 'WAL'
    synchronous?: string;    // default: 'NORMAL'
  };
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: SQLiteBackendConfig = {
  databasePath: ':memory:',
  walMode: true,
  optimize: true,
  defaultNamespace: 'default',
  maxEntries: 1000000,
  verbose: false,
};

/**
 * SQLite Backend for Structured Memory Storage
 *
 * Provides:
 * - ACID transactions for data consistency
 * - Efficient indexing for exact matches and prefix queries
 * - Full-text search capabilities
 * - Complex SQL queries with joins and aggregations
 * - Persistent storage with WAL mode
 */
export class SQLiteBackend extends EventEmitter implements IMemoryBackend {
  private config: SQLiteBackendConfig;
  private db: Database.Database | null = null;
  private initialized: boolean = false;

  // Performance tracking
  private stats = {
    queryCount: 0,
    totalQueryTime: 0,
    writeCount: 0,
    totalWriteTime: 0,
  };

  constructor(config: Partial<SQLiteBackendConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the SQLite backend
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Open database connection
    this.db = new Database(this.config.databasePath, {
      verbose: this.config.verbose ? console.log : undefined,
    });

    // ADR-0069 A1: config-chain SQLite pragmas (values from config, with backward-compat defaults)
    const pragmas = this.config.sqlitePragmas;

    // Enable WAL mode for better concurrency
    if (this.config.walMode) {
      this.db.pragma(`journal_mode = ${pragmas?.journalMode ?? 'WAL'}`);
    }

    // Prevent SQLITE_BUSY under concurrent CLI+daemon access (ADR-0063 M1)
    this.db.pragma(`busy_timeout = ${pragmas?.busyTimeoutMs ?? 5000}`);

    // Performance optimizations
    if (this.config.optimize) {
      this.db.pragma(`synchronous = ${pragmas?.synchronous ?? 'NORMAL'}`);
      this.db.pragma(`cache_size = ${pragmas?.cacheSize ?? -64000}`);
      this.db.pragma('temp_store = MEMORY');
    }

    // Create schema
    this.createSchema();

    this.initialized = true;
    this.emit('initialized');
  }

  /**
   * Shutdown the backend
   */
  async shutdown(): Promise<void> {
    if (!this.initialized || !this.db) return;

    // Optimize database before closing
    if (this.config.optimize) {
      this.db.pragma('optimize');
    }

    this.db.close();
    this.db = null;
    this.initialized = false;
    this.emit('shutdown');
  }

  /**
   * Store a memory entry
   */
  async store(entry: MemoryEntry): Promise<void> {
    this.ensureInitialized();
    const startTime = performance.now();

    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO memory_entries (
        id, key, content, type, namespace, tags, metadata,
        owner_id, access_level, created_at, updated_at, expires_at,
        version, "references", access_count, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.key,
      entry.content,
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
      entry.lastAccessedAt
    );

    // Store embedding separately (as BLOB)
    if (entry.embedding) {
      const embeddingStmt = this.db!.prepare(`
        INSERT OR REPLACE INTO memory_embeddings (entry_id, embedding)
        VALUES (?, ?)
      `);
      embeddingStmt.run(entry.id, Buffer.from(entry.embedding.buffer));
    }

    const duration = performance.now() - startTime;
    this.stats.writeCount++;
    this.stats.totalWriteTime += duration;

    this.emit('entry:stored', { id: entry.id, duration });
  }

  /**
   * Get a memory entry by ID
   */
  async get(id: string): Promise<MemoryEntry | null> {
    this.ensureInitialized();

    const stmt = this.db!.prepare('SELECT * FROM memory_entries WHERE id = ?');
    const row = stmt.get(id) as any;

    if (!row) return null;

    return this.rowToEntry(row);
  }

  /**
   * Get a memory entry by key within a namespace
   */
  async getByKey(namespace: string, key: string): Promise<MemoryEntry | null> {
    this.ensureInitialized();

    const stmt = this.db!.prepare(`
      SELECT * FROM memory_entries
      WHERE namespace = ? AND key = ?
    `);
    const row = stmt.get(namespace, key) as any;

    if (!row) return null;

    return this.rowToEntry(row);
  }

  /**
   * Update a memory entry
   */
  async update(id: string, update: MemoryEntryUpdate): Promise<MemoryEntry | null> {
    this.ensureInitialized();

    const entry = await this.get(id);
    if (!entry) return null;

    // Apply updates
    if (update.content !== undefined) entry.content = update.content;
    if (update.tags !== undefined) entry.tags = update.tags;
    if (update.metadata !== undefined) {
      entry.metadata = { ...entry.metadata, ...update.metadata };
    }
    if (update.accessLevel !== undefined) entry.accessLevel = update.accessLevel;
    if (update.expiresAt !== undefined) entry.expiresAt = update.expiresAt;
    if (update.references !== undefined) entry.references = update.references;

    entry.updatedAt = Date.now();
    entry.version++;

    // Store updated entry
    await this.store(entry);

    this.emit('entry:updated', { id });
    return entry;
  }

  /**
   * Delete a memory entry
   */
  async delete(id: string): Promise<boolean> {
    this.ensureInitialized();

    const deleteEntry = this.db!.prepare('DELETE FROM memory_entries WHERE id = ?');
    const deleteEmbedding = this.db!.prepare('DELETE FROM memory_embeddings WHERE entry_id = ?');

    const result = deleteEntry.run(id);
    deleteEmbedding.run(id);

    if (result.changes > 0) {
      this.emit('entry:deleted', { id });
      return true;
    }

    return false;
  }

  /**
   * Query memory entries with filters
   */
  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    this.ensureInitialized();
    const startTime = performance.now();

    let sql = 'SELECT * FROM memory_entries WHERE 1=1';
    const params: any[] = [];

    // Build WHERE clauses
    if (query.namespace) {
      sql += ' AND namespace = ?';
      params.push(query.namespace);
    }

    if (query.key) {
      sql += ' AND key = ?';
      params.push(query.key);
    }

    if (query.keyPrefix) {
      sql += ' AND key LIKE ?';
      params.push(`${query.keyPrefix}%`);
    }

    if (query.memoryType) {
      sql += ' AND type = ?';
      params.push(query.memoryType);
    }

    if (query.accessLevel) {
      sql += ' AND access_level = ?';
      params.push(query.accessLevel);
    }

    if (query.ownerId) {
      sql += ' AND owner_id = ?';
      params.push(query.ownerId);
    }

    if (query.createdAfter) {
      sql += ' AND created_at >= ?';
      params.push(query.createdAfter);
    }

    if (query.createdBefore) {
      sql += ' AND created_at <= ?';
      params.push(query.createdBefore);
    }

    if (query.updatedAfter) {
      sql += ' AND updated_at >= ?';
      params.push(query.updatedAfter);
    }

    if (query.updatedBefore) {
      sql += ' AND updated_at <= ?';
      params.push(query.updatedBefore);
    }

    if (!query.includeExpired) {
      sql += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(Date.now());
    }

    // Tag filtering (safe parameterized query)
    if (query.tags && query.tags.length > 0) {
      // Validate tags before using in query
      for (const tag of query.tags) {
        if (typeof tag !== 'string' || !/^[a-zA-Z0-9_\-.:]+$/.test(tag)) {
          throw new Error(`Invalid tag format: ${tag}`);
        }
      }
      // Use parameterized query with JSON functions
      const tagPlaceholders = query.tags.map(() => '?').join(', ');
      sql += ` AND EXISTS (
        SELECT 1 FROM json_each(tags) AS t
        WHERE t.value IN (${tagPlaceholders})
      )`;
      params.push(...query.tags);
    }

    // Pagination
    sql += ' ORDER BY created_at DESC';
    if (query.limit) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }
    if (query.offset) {
      sql += ' OFFSET ?';
      params.push(query.offset);
    }

    const stmt = this.db!.prepare(sql);
    const rows = stmt.all(...params) as any[];

    const results = rows.map((row) => this.rowToEntry(row));

    const duration = performance.now() - startTime;
    this.stats.queryCount++;
    this.stats.totalQueryTime += duration;

    return results;
  }

  /**
   * Semantic vector search (not optimized for SQLite, returns empty)
   * Vector search not optimized in SQLite backend
   */
  async search(
    embedding: Float32Array,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    // SQLite is not optimized for vector search
    // SQLite is a structured backend; use RvfBackend for vector search
    console.warn(
      'SQLiteBackend.search(): Vector search not optimized. Use RvfBackend for semantic search.'
    );
    return [];
  }

  /**
   * Bulk insert entries
   */
  async bulkInsert(entries: MemoryEntry[]): Promise<void> {
    this.ensureInitialized();

    const transaction = this.db!.transaction((entries: MemoryEntry[]) => {
      for (const entry of entries) {
        this.storeSync(entry);
      }
    });

    transaction(entries);
    this.emit('bulk:inserted', { count: entries.length });
  }

  /**
   * Bulk delete entries
   */
  async bulkDelete(ids: string[]): Promise<number> {
    this.ensureInitialized();

    const deleteEntry = this.db!.prepare('DELETE FROM memory_entries WHERE id = ?');
    const deleteEmbedding = this.db!.prepare('DELETE FROM memory_embeddings WHERE entry_id = ?');

    const transaction = this.db!.transaction((ids: string[]) => {
      let deleted = 0;
      for (const id of ids) {
        const result = deleteEntry.run(id);
        deleteEmbedding.run(id);
        if (result.changes > 0) deleted++;
      }
      return deleted;
    });

    return transaction(ids);
  }

  /**
   * Get entry count
   */
  async count(namespace?: string): Promise<number> {
    this.ensureInitialized();

    let sql = 'SELECT COUNT(*) as count FROM memory_entries';
    const params: any[] = [];

    if (namespace) {
      sql += ' WHERE namespace = ?';
      params.push(namespace);
    }

    const stmt = this.db!.prepare(sql);
    const result = stmt.get(...params) as any;
    return result.count;
  }

  /**
   * List all namespaces
   */
  async listNamespaces(): Promise<string[]> {
    this.ensureInitialized();

    const stmt = this.db!.prepare('SELECT DISTINCT namespace FROM memory_entries');
    const rows = stmt.all() as any[];
    return rows.map((row) => row.namespace);
  }

  /**
   * Clear all entries in a namespace
   */
  async clearNamespace(namespace: string): Promise<number> {
    this.ensureInitialized();

    const deleteEntries = this.db!.prepare('DELETE FROM memory_entries WHERE namespace = ?');
    const result = deleteEntries.run(namespace);

    // Clean up orphaned embeddings
    this.db!.prepare(`
      DELETE FROM memory_embeddings
      WHERE entry_id NOT IN (SELECT id FROM memory_entries)
    `).run();

    return result.changes;
  }

  /**
   * Get backend statistics
   */
  async getStats(): Promise<BackendStats> {
    this.ensureInitialized();

    // Count by namespace
    const namespaceStmt = this.db!.prepare(`
      SELECT namespace, COUNT(*) as count
      FROM memory_entries
      GROUP BY namespace
    `);
    const namespaceRows = namespaceStmt.all() as any[];
    const entriesByNamespace: Record<string, number> = {};
    for (const row of namespaceRows) {
      entriesByNamespace[row.namespace] = row.count;
    }

    // Count by type
    const typeStmt = this.db!.prepare(`
      SELECT type, COUNT(*) as count
      FROM memory_entries
      GROUP BY type
    `);
    const typeRows = typeStmt.all() as any[];
    const entriesByType: Record<MemoryType, number> = {
      episodic: 0,
      semantic: 0,
      procedural: 0,
      working: 0,
      cache: 0,
    };
    for (const row of typeRows) {
      entriesByType[row.type as MemoryType] = row.count;
    }

    // Get database size
    const pageCount = this.db!.pragma('page_count', { simple: true }) as number;
    const pageSize = this.db!.pragma('page_size', { simple: true }) as number;
    const memoryUsage = pageCount * pageSize;

    const totalEntries = await this.count();

    return {
      totalEntries,
      entriesByNamespace,
      entriesByType,
      memoryUsage,
      avgQueryTime:
        this.stats.queryCount > 0
          ? this.stats.totalQueryTime / this.stats.queryCount
          : 0,
      avgSearchTime: 0, // Not applicable for SQLite
    };
  }

  /**
   * Perform health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    if (!this.initialized || !this.db) {
      return {
        status: 'unhealthy',
        components: {
          storage: { status: 'unhealthy', latency: 0, message: 'Not initialized' },
          index: { status: 'healthy', latency: 0 },
          cache: { status: 'healthy', latency: 0 },
        },
        timestamp: Date.now(),
        issues: ['Backend not initialized'],
        recommendations: ['Call initialize() before using'],
      };
    }

    // Check database integrity
    let storageHealth: ComponentHealth;
    try {
      const integrityCheck = this.db.pragma('integrity_check', { simple: true });
      if (integrityCheck === 'ok') {
        storageHealth = { status: 'healthy', latency: 0 };
      } else {
        issues.push('Database integrity check failed');
        recommendations.push('Run VACUUM to repair database');
        storageHealth = { status: 'unhealthy', latency: 0, message: 'Integrity check failed' };
      }
    } catch (error) {
      issues.push('Failed to check database integrity');
      storageHealth = { status: 'unhealthy', latency: 0, message: String(error) };
    }

    // Check utilization
    const totalEntries = await this.count();
    const utilizationPercent = (totalEntries / this.config.maxEntries) * 100;

    if (utilizationPercent > 95) {
      issues.push('Storage utilization critical (>95%)');
      recommendations.push('Cleanup old data or increase maxEntries');
      storageHealth = { status: 'unhealthy', latency: 0, message: 'Near capacity' };
    } else if (utilizationPercent > 80) {
      issues.push('Storage utilization high (>80%)');
      recommendations.push('Consider cleanup');
      if (storageHealth.status === 'healthy') {
        storageHealth = { status: 'degraded', latency: 0, message: 'High utilization' };
      }
    }

    const status =
      storageHealth.status === 'unhealthy'
        ? 'unhealthy'
        : storageHealth.status === 'degraded'
          ? 'degraded'
          : 'healthy';

    return {
      status,
      components: {
        storage: storageHealth,
        index: { status: 'healthy', latency: 0 },
        cache: { status: 'healthy', latency: 0 },
      },
      timestamp: Date.now(),
      issues,
      recommendations,
    };
  }

  // ===== Private Methods =====

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('SQLiteBackend not initialized. Call initialize() first.');
    }
  }

  private createSchema(): void {
    if (!this.db) return;

    // Tables and indexes from shared schema (ADR-0065 P3-2)
    this.db.exec(`${MEMORY_ENTRIES_DDL};`);
    for (const idx of MEMORY_ENTRIES_INDEXES) {
      this.db.exec(`${idx};`);
    }
    this.db.exec(`${MEMORY_EMBEDDINGS_DDL};`);
  }

  private rowToEntry(row: any): MemoryEntry {
    // Get embedding if exists
    let embedding: Float32Array | undefined;
    const embeddingStmt = this.db!.prepare(
      'SELECT embedding FROM memory_embeddings WHERE entry_id = ?'
    );
    const embeddingRow = embeddingStmt.get(row.id) as any;
    if (embeddingRow && embeddingRow.embedding) {
      embedding = new Float32Array(embeddingRow.embedding.buffer);
    }

    return {
      id: row.id,
      key: row.key,
      content: row.content,
      embedding,
      type: row.type as MemoryType,
      namespace: row.namespace,
      tags: JSON.parse(row.tags),
      metadata: JSON.parse(row.metadata),
      ownerId: row.owner_id,
      accessLevel: row.access_level,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      version: row.version,
      references: JSON.parse(row.references),
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
    };
  }

  /**
   * Synchronous store for use in transactions
   */
  private storeSync(entry: MemoryEntry): void {
    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO memory_entries (
        id, key, content, type, namespace, tags, metadata,
        owner_id, access_level, created_at, updated_at, expires_at,
        version, "references", access_count, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.key,
      entry.content,
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
      entry.lastAccessedAt
    );

    if (entry.embedding) {
      const embeddingStmt = this.db!.prepare(`
        INSERT OR REPLACE INTO memory_embeddings (entry_id, embedding)
        VALUES (?, ?)
      `);
      embeddingStmt.run(entry.id, Buffer.from(entry.embedding.buffer));
    }
  }
}

export default SQLiteBackend;
