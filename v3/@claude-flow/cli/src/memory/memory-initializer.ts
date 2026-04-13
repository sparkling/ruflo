/**
 * V3 Memory Initializer
 * Initializes the memory database via better-sqlite3 (WAL mode).
 * Includes pattern tables, vector embeddings, migration state tracking.
 *
 * ADR-053: Routes through ControllerRegistry → AgentDB v3 when available,
 * falls back to direct better-sqlite3 for raw SQL access.
 *
 * ADR-0083: Removed openDatabase wrapper and the WASM SQLite layer;
 * all DB access is now direct better-sqlite3 via _getDb().
 *
 * @module v3/cli/memory-initializer
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '@claude-flow/memory';

// ADR-0083: Direct better-sqlite3 (replaces open-database.ts wrapper)
let _bsqlMod: any = null;
async function _getDb(dbPath: string, opts?: { readonly?: boolean }): Promise<any> {
  if (!_bsqlMod) {
    const mod = await import('better-sqlite3');
    _bsqlMod = mod.default ?? mod;
  }
  const isReadonly = opts?.readonly === true;
  const db = new _bsqlMod(dbPath, { readonly: isReadonly });
  if (!isReadonly) {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

// ADR-0085: memory-bridge dependency removed — all operations use direct SQLite + router

// ADR-0069: config-chain swarmDir
function getSwarmDir(): string {
  try {
    let dir = process.cwd();
    while (dir !== path.dirname(dir)) {
      const cfgPath = path.join(dir, '.claude-flow', 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        return cfg?.memory?.swarmDir ?? '.swarm';
      }
      dir = path.dirname(dir);
    }
  } catch { /* fall through */ }
  return '.swarm';
}

// ADR-065: Read embedding dimension & model from project embeddings.json
// ADR-068 W2-5: Also reads HNSW tuning params (m, efConstruction, efSearch)
// Fail-loud: warn once per process when embeddings.json is missing
let _embeddingsJsonWarned = false;

function readEmbeddingsConfig(): {
  dimension: number;
  model: string;
  hnsw: { m: number; efConstruction: number; efSearch: number };
} {
  try {
    let dir = process.cwd();
    while (dir !== path.dirname(dir)) {
      const cfgPath = path.join(dir, '.claude-flow', 'embeddings.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        return {
          dimension: cfg.dimension ?? 768,
          model: cfg.model ?? 'Xenova/all-mpnet-base-v2',
          hnsw: {
            m: cfg.hnsw?.m ?? 23,
            efConstruction: cfg.hnsw?.efConstruction ?? 100,
            efSearch: cfg.hnsw?.efSearch ?? 50,
          },
        };
      }
      dir = path.dirname(dir);
    }
  } catch { /* fall through */ }
  if (!_embeddingsJsonWarned) {
    _embeddingsJsonWarned = true;
    console.warn('[config-chain] embeddings.json not found — using fallback defaults. Run "claude-flow init" to generate.');
  }
  return {
    dimension: 768,
    model: 'Xenova/all-mpnet-base-v2',
    hnsw: { m: 23, efConstruction: 100, efSearch: 50 },
  };
}

/**
 * Enhanced schema with pattern confidence, temporal decay, versioning
 * Vector embeddings enabled for semantic search
 */
export const MEMORY_SCHEMA_V3 = `
-- RuFlo V3 Memory Database
-- Version: 3.0.0
-- Features: Pattern learning, vector embeddings, temporal decay, migration tracking

-- ADR-0069 A1: journal_mode and synchronous are now applied at runtime
-- via the config chain (sqlite-backend / controller-registry), not here.
PRAGMA foreign_keys = ON;

-- ============================================
-- CORE MEMORY TABLES
-- ============================================

-- Memory entries (main storage)
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  namespace TEXT DEFAULT 'default',
  content TEXT NOT NULL,
  type TEXT DEFAULT 'semantic' CHECK(type IN ('semantic', 'episodic', 'procedural', 'working', 'pattern')),

  -- Vector embedding for semantic search (stored as JSON array)
  embedding TEXT,
  embedding_model TEXT DEFAULT 'local',
  embedding_dimensions INTEGER,

  -- Metadata
  tags TEXT, -- JSON array
  metadata TEXT, -- JSON object
  owner_id TEXT,

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  expires_at INTEGER,
  last_accessed_at INTEGER,

  -- Access tracking for hot/cold detection
  access_count INTEGER DEFAULT 0,

  -- Status
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted')),

  UNIQUE(namespace, key)
);

-- Indexes for memory entries
CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace);
CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_entries(key);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_accessed ON memory_entries(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_memory_owner ON memory_entries(owner_id);

-- ============================================
-- PATTERN LEARNING TABLES
-- ============================================

-- Learned patterns with confidence scoring and versioning
CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,

  -- Pattern identification
  name TEXT NOT NULL,
  pattern_type TEXT NOT NULL CHECK(pattern_type IN (
    'task-routing', 'error-recovery', 'optimization', 'learning',
    'coordination', 'prediction', 'code-pattern', 'workflow'
  )),

  -- Pattern definition
  condition TEXT NOT NULL, -- Regex or semantic match
  action TEXT NOT NULL, -- What to do when pattern matches
  description TEXT,

  -- Confidence scoring (0.0 - 1.0)
  confidence REAL DEFAULT 0.5,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,

  -- Temporal decay
  decay_rate REAL DEFAULT 0.01, -- How fast confidence decays
  half_life_days INTEGER DEFAULT 30, -- Days until confidence halves without use

  -- Vector embedding for semantic pattern matching
  embedding TEXT,
  embedding_dimensions INTEGER,

  -- Versioning
  version INTEGER DEFAULT 1,
  parent_id TEXT REFERENCES patterns(id),

  -- Metadata
  tags TEXT, -- JSON array
  metadata TEXT, -- JSON object
  source TEXT, -- Where the pattern was learned from

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  last_matched_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,

  -- Status
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deprecated', 'experimental'))
);

-- Indexes for patterns
CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_status ON patterns(status);
CREATE INDEX IF NOT EXISTS idx_patterns_last_matched ON patterns(last_matched_at);

-- Pattern evolution history (for versioning)
CREATE TABLE IF NOT EXISTS pattern_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id TEXT NOT NULL REFERENCES patterns(id),
  version INTEGER NOT NULL,

  -- Snapshot of pattern state
  confidence REAL,
  success_count INTEGER,
  failure_count INTEGER,
  condition TEXT,
  action TEXT,

  -- What changed
  change_type TEXT CHECK(change_type IN ('created', 'updated', 'success', 'failure', 'decay', 'merged', 'split')),
  change_reason TEXT,

  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_pattern_history_pattern ON pattern_history(pattern_id);

-- ============================================
-- LEARNING & TRAJECTORY TABLES
-- ============================================

-- Learning trajectories (SONA integration)
CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  session_id TEXT,

  -- Trajectory state
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed', 'abandoned')),
  verdict TEXT CHECK(verdict IN ('success', 'failure', 'partial', NULL)),

  -- Context
  task TEXT,
  context TEXT, -- JSON object

  -- Metrics
  total_steps INTEGER DEFAULT 0,
  total_reward REAL DEFAULT 0,

  -- Timestamps
  started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  ended_at INTEGER,

  -- Reference to extracted pattern (if any)
  extracted_pattern_id TEXT REFERENCES patterns(id)
);

-- Trajectory steps
CREATE TABLE IF NOT EXISTS trajectory_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trajectory_id TEXT NOT NULL REFERENCES trajectories(id),
  step_number INTEGER NOT NULL,

  -- Step data
  action TEXT NOT NULL,
  observation TEXT,
  reward REAL DEFAULT 0,

  -- Metadata
  metadata TEXT, -- JSON object

  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_steps_trajectory ON trajectory_steps(trajectory_id);

-- ============================================
-- MIGRATION STATE TRACKING
-- ============================================

-- Migration state (for resume capability)
CREATE TABLE IF NOT EXISTS migration_state (
  id TEXT PRIMARY KEY,
  migration_type TEXT NOT NULL, -- 'v2-to-v3', 'pattern', 'memory', etc.

  -- Progress tracking
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'rolled_back')),
  total_items INTEGER DEFAULT 0,
  processed_items INTEGER DEFAULT 0,
  failed_items INTEGER DEFAULT 0,
  skipped_items INTEGER DEFAULT 0,

  -- Current position (for resume)
  current_batch INTEGER DEFAULT 0,
  last_processed_id TEXT,

  -- Source/destination info
  source_path TEXT,
  source_type TEXT,
  destination_path TEXT,

  -- Backup info
  backup_path TEXT,
  backup_created_at INTEGER,

  -- Error tracking
  last_error TEXT,
  errors TEXT, -- JSON array of errors

  -- Timestamps
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- ============================================
-- SESSION MANAGEMENT
-- ============================================

-- Sessions for context persistence
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,

  -- Session state
  state TEXT NOT NULL, -- JSON object with full session state
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'expired')),

  -- Context
  project_path TEXT,
  branch TEXT,

  -- Metrics
  tasks_completed INTEGER DEFAULT 0,
  patterns_learned INTEGER DEFAULT 0,

  -- Timestamps
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  expires_at INTEGER
);

-- ============================================
-- VECTOR INDEX METADATA (for HNSW)
-- ============================================

-- Track HNSW index state
CREATE TABLE IF NOT EXISTS vector_indexes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,

  -- Index configuration
  dimensions INTEGER NOT NULL,
  metric TEXT DEFAULT 'cosine' CHECK(metric IN ('cosine', 'euclidean', 'dot')),

  -- HNSW parameters
  hnsw_m INTEGER DEFAULT 16,
  hnsw_ef_construction INTEGER DEFAULT 200,
  hnsw_ef_search INTEGER DEFAULT 100,

  -- Quantization
  quantization_type TEXT CHECK(quantization_type IN ('none', 'scalar', 'product')),
  quantization_bits INTEGER DEFAULT 8,

  -- Statistics
  total_vectors INTEGER DEFAULT 0,
  last_rebuild_at INTEGER,

  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- ============================================
-- SYSTEM METADATA
-- ============================================

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);
`;

// ============================================================================
// HNSW INDEX SINGLETON (150x faster vector search)
// Uses @ruvector/core from agentic-flow for WASM-accelerated HNSW
// ============================================================================

interface HNSWEntry {
  id: string;
  key: string;
  namespace: string;
  content: string;
}

interface HNSWIndex {
  db: any;
  entries: Map<string, HNSWEntry>;
  dimensions: number;
  initialized: boolean;
}

let hnswIndex: HNSWIndex | null = null;
let hnswInitializing = false;

/**
 * Get or create the HNSW index singleton
 * Lazily initializes from SQLite data on first use
 */
export async function getHNSWIndex(options?: {
  dbPath?: string;
  dimensions?: number;
  forceRebuild?: boolean;
}): Promise<HNSWIndex | null> {
  const dimensions = options?.dimensions ?? readEmbeddingsConfig().dimension;

  // Return existing index if already initialized
  if (hnswIndex?.initialized && !options?.forceRebuild) {
    return hnswIndex;
  }

  // Prevent concurrent initialization
  if (hnswInitializing) {
    // Wait for initialization to complete
    while (hnswInitializing) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return hnswIndex;
  }

  hnswInitializing = true;

  try {
    // Import @ruvector/core dynamically
    // Handle both ESM (default export) and CJS patterns
    const ruvectorModule = await import('@ruvector/core').catch(() => null);
    if (!ruvectorModule) {
      hnswInitializing = false;
      return null; // HNSW not available
    }

    // ESM returns { default: { VectorDb, ... } }, CJS returns { VectorDb, ... }
    const ruvectorCore = (ruvectorModule as any).default || ruvectorModule;
    if (!ruvectorCore?.VectorDb) {
      hnswInitializing = false;
      return null; // VectorDb not found
    }

    const { VectorDb } = ruvectorCore;

    // Persistent storage paths — resolve to absolute to survive CWD changes
    const swarmDir = path.resolve(process.cwd(), getSwarmDir());
    if (!fs.existsSync(swarmDir)) {
      fs.mkdirSync(swarmDir, { recursive: true });
    }
    const hnswPath = path.join(swarmDir, 'hnsw.index');
    const metadataPath = path.join(swarmDir, 'hnsw.metadata.json');
    const dbPath = options?.dbPath ? path.resolve(options.dbPath) : path.join(swarmDir, 'memory.db');
    // EM-001: delete stale persistent files on forceRebuild
    if (options?.forceRebuild) {
        try {
            if (fs.existsSync(hnswPath)) fs.unlinkSync(hnswPath);
        } catch { /* EM-001: file cleanup */ }
        try {
            if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
        } catch { /* EM-001: file cleanup */ }
    }

    // Create HNSW index with persistent storage
    // @ruvector/core uses string enum for distanceMetric: 'Cosine', 'Euclidean', 'DotProduct', 'Manhattan'
    const db = new VectorDb({
      dimensions,
      distanceMetric: 'Cosine',
      storagePath: hnswPath  // Persistent storage!
    } as any);

    // Load metadata (entry info) if exists
    const entries = new Map<string, HNSWEntry>();
    if (!options?.forceRebuild && fs.existsSync(metadataPath)) {
      try {
        const metadataJson = fs.readFileSync(metadataPath, 'utf-8');
        const metadata = JSON.parse(metadataJson) as Array<[string, HNSWEntry]>;
        for (const [key, value] of metadata) {
          entries.set(key, value);
        }
      } catch {
        // Metadata load failed, will rebuild
      }
    }

    hnswIndex = {
      db,
      entries,
      dimensions,
      initialized: false
    };

    // Check if index already has data (from persistent storage)
    const existingLen = await db.len();
    if (existingLen > 0 && entries.size > 0 && !options?.forceRebuild) {
      // Index loaded from disk, skip SQLite sync
      hnswIndex.initialized = true;
      hnswInitializing = false;
      return hnswIndex;
    }

    // ADR-0076 Phase 3: try createStorage() to load entries before SQLite fallback
    let loadedFromStorage = false;
    try {
      const { createStorage } = await import('@claude-flow/memory');
      const storage = await createStorage({
        databasePath: dbPath,
        dimensions,
        autoPersistInterval: 0, // read-only index build — never write back
      });
      // Query all entries (RVF backend only stores active entries)
      const storageEntries = await storage.query({ type: 'prefix', keyPrefix: '', limit: 10000 });
      for (const entry of storageEntries) {
        if (entry.embedding) {
          try {
            await db.insert({
              id: entry.id,
              vector: entry.embedding,
            });
            hnswIndex.entries.set(entry.id, {
              id: entry.id,
              key: entry.key || entry.id,
              namespace: entry.namespace || 'default',
              content: entry.content || '',
            });
          } catch {
            // Skip entries that fail to insert
          }
        }
      }
      loadedFromStorage = true;
    } catch { /* createStorage failed — fall through to direct SQLite */ }

    if (!loadedFromStorage && fs.existsSync(dbPath)) {
      try {
        const sqlDb = await _getDb(dbPath, { readonly: true });

        // Load all entries with embeddings
        const rows = sqlDb.prepare(`
          SELECT id, key, namespace, content, embedding
          FROM memory_entries
          WHERE status = 'active' AND embedding IS NOT NULL
          LIMIT 10000
        `).all() as Array<{ id: string; key: string; namespace: string; content: string; embedding: string }>;

        for (const row of rows) {
          if (row.embedding) {
            try {
              const embedding = JSON.parse(row.embedding) as number[];
              const vector = new Float32Array(embedding);

              await db.insert({
                id: String(row.id),
                vector
              });

              hnswIndex.entries.set(String(row.id), {
                id: String(row.id),
                key: row.key || String(row.id),
                namespace: row.namespace || 'default',
                content: row.content || ''
              });
            } catch {
              // Skip invalid embeddings
            }
          }
        }

        sqlDb.close();
      } catch {
        // SQLite load failed, start with empty index
      }
    }

    hnswIndex.initialized = true;
    hnswInitializing = false;
    return hnswIndex;
  } catch {
    hnswInitializing = false;
    return null;
  }
}

// ADR-0086: saveHNSWMetadata deleted (no callers)
// ADR-0086: addToHNSWIndex deleted (no callers)

/**
 * Search HNSW index (150x faster than brute-force)
 * Returns results sorted by similarity (highest first)
 */
export async function searchHNSWIndex(
  queryEmbedding: number[],
  options?: {
    k?: number;
    namespace?: string;
  }
): Promise<Array<{ id: string; key: string; content: string; score: number; namespace: string }> | null> {
  // ADR-0085: Bridge removed — direct HNSW only
  const index = await getHNSWIndex({ dimensions: queryEmbedding.length });
  if (!index) return null;

  try {
    const vector = new Float32Array(queryEmbedding);
    const k = options?.k ?? 10;

    // HNSW search returns results with cosine distance (lower = more similar)
    const results = await index.db.search({ vector, k: k * 2 }); // Get extra for filtering

    const filtered: Array<{ id: string; key: string; content: string; score: number; namespace: string }> = [];

    for (const result of results) {
      const entry = index.entries.get(result.id);
      if (!entry) continue;

      // Filter by namespace if specified
      if (options?.namespace && options.namespace !== 'all' && entry.namespace !== options.namespace) {
        continue;
      }

      // Convert cosine distance to similarity score (1 - distance)
      // Cosine distance from @ruvector/core: 0 = identical, 2 = opposite
      const score = 1 - (result.score / 2);

      filtered.push({
        id: entry.id.substring(0, 12),
        key: entry.key || entry.id.substring(0, 15),
        content: entry.content.substring(0, 60) + (entry.content.length > 60 ? '...' : ''),
        score,
        namespace: entry.namespace
      });

      if (filtered.length >= k) break;
    }

    // Sort by score descending (highest similarity first)
    filtered.sort((a, b) => b.score - a.score);

    return filtered;
  } catch {
    return null;
  }
}

/**
 * Get HNSW index status
 */
export function getHNSWStatus(): {
  available: boolean;
  initialized: boolean;
  entryCount: number;
  dimensions: number;
} {
  // ADR-0085: Bridge removed — report local HNSW state only
  return {
    available: hnswIndex !== null,
    initialized: hnswIndex?.initialized ?? false,
    entryCount: hnswIndex?.entries.size ?? 0,
    dimensions: hnswIndex?.dimensions ?? readEmbeddingsConfig().dimension
  };
}

/**
 * Clear the HNSW index (for rebuilding)
 */
export function clearHNSWIndex(): void {
  hnswIndex = null;
}

/**
 * Invalidate the in-memory HNSW cache so the next search rebuilds from DB.
 * Call this after deleting entries that had embeddings to prevent ghost
 * vectors from appearing in search results.
 */
export function rebuildSearchIndex(): void {
  hnswIndex = null;
  hnswInitializing = false;
}

// ADR-0086 T1.1+T1.2: Quantization (4) and attention (4) functions deleted.
// No second consumer exists — RvfBackend has its own HNSW vector search.

// ============================================================================
// METADATA AND INITIALIZATION
// ============================================================================

/**
 * Initial metadata to insert after schema creation
 */
export function getInitialMetadata(backend: string): string {
  return `
INSERT OR REPLACE INTO metadata (key, value) VALUES
  ('schema_version', '3.0.0'),
  ('backend', '${backend}'),
  ('created_at', '${new Date().toISOString()}'),
  ('sql_js', 'true'),
  ('vector_embeddings', 'enabled'),
  ('pattern_learning', 'enabled'),
  ('temporal_decay', 'enabled'),
  ('hnsw_indexing', 'enabled');

-- Create default vector index configuration
INSERT OR IGNORE INTO vector_indexes (id, name, dimensions) VALUES
  ('default', 'default', 768),
  ('patterns', 'patterns', 768);
`;
}

/**
 * Memory initialization result
 */
export interface MemoryInitResult {
  success: boolean;
  backend: string;
  dbPath: string;
  schemaVersion: string;
  tablesCreated: string[];
  indexesCreated: string[];
  features: {
    vectorEmbeddings: boolean;
    patternLearning: boolean;
    temporalDecay: boolean;
    hnswIndexing: boolean;
    migrationTracking: boolean;
  };
  /** ADR-053: Controllers activated via ControllerRegistry */
  controllers?: {
    activated: string[];
    failed: string[];
    initTimeMs: number;
  };
  error?: string;
}

// ADR-0086: ensureSchemaColumns deleted (no callers)

/**
 * Check for legacy database installations and migrate if needed
 */
export async function checkAndMigrateLegacy(options: {
  dbPath: string;
  verbose?: boolean;
}): Promise<{
  needsMigration: boolean;
  legacyVersion?: string;
  legacyEntries?: number;
  migrated?: boolean;
  migratedCount?: number;
}> {
  const { dbPath, verbose = false } = options;

  // Check for legacy locations
  const legacyPaths = [
    path.join(process.cwd(), 'memory.db'),
    path.join(process.cwd(), '.claude/memory.db'),
    path.join(process.cwd(), 'data/memory.db'),
    path.join(process.cwd(), '.claude-flow/memory.db')
  ];

  for (const legacyPath of legacyPaths) {
    if (fs.existsSync(legacyPath) && legacyPath !== dbPath) {
      try {
        const legacyDb = await _getDb(legacyPath, { readonly: true });

        // Check if it has data
        const countRow = legacyDb.prepare('SELECT COUNT(*) as cnt FROM memory_entries').get() as { cnt: number } | undefined;
        const count = countRow?.cnt || 0;

        // Get version if available
        let version = 'unknown';
        try {
          const versionRow = legacyDb.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as { value: string } | undefined;
          version = versionRow?.value || 'unknown';
        } catch { /* no metadata table */ }

        legacyDb.close();

        if (count > 0) {
          return {
            needsMigration: true,
            legacyVersion: version,
            legacyEntries: count
          };
        }
      } catch {
        // Not a valid SQLite database, skip
      }
    }
  }

  return { needsMigration: false };
}

// ADR-0085: activateControllerRegistry removed — router handles registry bootstrap via initControllerRegistry()

/**
 * Initialize the memory database properly using better-sqlite3
 */
export async function initializeMemoryDatabase(options: {
  backend?: string;
  dbPath?: string;
  force?: boolean;
  verbose?: boolean;
  migrate?: boolean;
}): Promise<MemoryInitResult> {
  const {
    backend = 'hybrid',
    dbPath: customPath,
    force = false,
    verbose = false,
    migrate = true
  } = options;

  const swarmDir = path.join(process.cwd(), getSwarmDir());
  const dbPath = customPath || path.join(swarmDir, 'memory.db');
  const dbDir = path.dirname(dbPath);

  try {
    // Create directory if needed
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Check for legacy installations
    if (migrate) {
      const legacyCheck = await checkAndMigrateLegacy({ dbPath, verbose });
      if (legacyCheck.needsMigration && verbose) {
        console.log(`Found legacy database (v${legacyCheck.legacyVersion}) with ${legacyCheck.legacyEntries} entries`);
      }
    }

    // Check existing database
    if (fs.existsSync(dbPath) && !force) {
      return {
        success: false,
        backend,
        dbPath,
        schemaVersion: '3.0.0',
        tablesCreated: [],
        indexesCreated: [],
        features: {
          vectorEmbeddings: false,
          patternLearning: false,
          temporalDecay: false,
          hnswIndexing: false,
          migrationTracking: false
        },
        error: 'Database already exists. Use --force to reinitialize.'
      };
    }

    // ADR-0076 Phase 3: try createStorage() before SQLite fallback
    try {
      const { createStorage } = await import('@claude-flow/memory');
      const embCfg = readEmbeddingsConfig();
      const storage = await createStorage({
        databasePath: dbPath,
        dimensions: embCfg.dimension,
        hnswM: embCfg.hnsw.m,
        hnswEfConstruction: embCfg.hnsw.efConstruction,
        verbose,
      });

      // ADR-0080: create memory_entries BEFORE controller activation (which is slow).
      // Only create if the .db doesn't exist yet — if it exists, AgentDB (better-sqlite3)
      // created it in WAL mode and we should not re-create it.
      try {
        const sqlitePath = dbPath.replace(/\.rvf$/, '.db');
        if (!fs.existsSync(sqlitePath)) {
          const sqlDb = await _getDb(sqlitePath);
          sqlDb.exec(`
            CREATE TABLE IF NOT EXISTS memory_entries (
              id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT DEFAULT 'default',
              content TEXT NOT NULL DEFAULT '', type TEXT DEFAULT 'semantic',
              embedding TEXT, embedding_model TEXT DEFAULT 'local', embedding_dimensions INTEGER,
              tags TEXT, metadata TEXT, owner_id TEXT,
              created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
              updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
              expires_at INTEGER, last_accessed_at INTEGER, access_count INTEGER DEFAULT 0,
              status TEXT DEFAULT 'active', UNIQUE(namespace, key)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace);
            CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_entries(key);
            CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);
          `);
          sqlDb.close();
        }
      } catch { /* better-sqlite3 unavailable — controller activation will create .db */ }

      // ADR-0085: ControllerRegistry bootstrap moved to router (initControllerRegistry)
      const controllerResult = { activated: [] as string[], failed: [] as string[], initTimeMs: 0 };

      // ADR-0080: ensure full schema after controller activation adds its tables
      // AgentDB creates memory.db with its own schema but not memory_entries
      try {
        const sqlitePath = dbPath.replace(/\.rvf$/, '.db');
        if (fs.existsSync(sqlitePath)) {
          const sqlDb = await _getDb(sqlitePath);
          // Only create memory_entries table + indexes — NOT the full MEMORY_SCHEMA_V3
          // which conflicts with AgentDB's pre-existing tables/indexes
          sqlDb.exec(`
            CREATE TABLE IF NOT EXISTS memory_entries (
              id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT DEFAULT 'default',
              content TEXT NOT NULL, type TEXT DEFAULT 'semantic',
              embedding TEXT, embedding_model TEXT DEFAULT 'local', embedding_dimensions INTEGER,
              tags TEXT, metadata TEXT, owner_id TEXT,
              created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
              updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
              expires_at INTEGER, last_accessed_at INTEGER, access_count INTEGER DEFAULT 0,
              status TEXT DEFAULT 'active', UNIQUE(namespace, key)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace);
            CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_entries(key);
            CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);
            CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_entries(status);
            CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at);
            CREATE INDEX IF NOT EXISTS idx_memory_accessed ON memory_entries(last_accessed_at);
            CREATE INDEX IF NOT EXISTS idx_memory_owner ON memory_entries(owner_id);
          `);
          sqlDb.close();
        }
      } catch { /* better-sqlite3 unavailable or DB locked — non-fatal */ }

      return {
        success: true,
        backend: 'rvf',
        dbPath,
        schemaVersion: '3.0.0',
        tablesCreated: [
          'memory_entries',
          'patterns',
          'pattern_history',
          'trajectories',
          'trajectory_steps',
          'migration_state',
          'sessions',
          'vector_indexes',
          'metadata'
        ],
        indexesCreated: [
          'idx_memory_namespace',
          'idx_memory_key',
          'idx_memory_type',
          'idx_memory_status',
          'idx_memory_created',
          'idx_memory_accessed',
          'idx_memory_owner',
          'idx_patterns_type',
          'idx_patterns_confidence',
          'idx_patterns_status',
          'idx_patterns_last_matched',
          'idx_pattern_history_pattern',
          'idx_steps_trajectory'
        ],
        features: {
          vectorEmbeddings: true,
          patternLearning: true,
          temporalDecay: true,
          hnswIndexing: true,
          migrationTracking: true
        },
        controllers: controllerResult,
      };
    } catch { /* createStorage failed — fall through to direct SQLite */ }

    // Try to initialize memory database via better-sqlite3
    let usedOpenDb = false;

    try {
      // Load existing database or create new
      if (fs.existsSync(dbPath) && force) {
        fs.unlinkSync(dbPath);
      }

      const db = await _getDb(dbPath);

      // Execute schema
      db.exec(MEMORY_SCHEMA_V3);

      // Insert initial metadata
      db.exec(getInitialMetadata(backend));

      // Close database
      db.close();

      usedOpenDb = true;
    } catch (e) {
      // better-sqlite3 not available, fall back to writing schema file
      if (verbose) {
        console.log('better-sqlite3 not available, writing schema file for later initialization');
      }
    }

    if (usedOpenDb) {
      // Also create schema file for reference
      const schemaPath = path.join(dbDir, 'schema.sql');
      fs.writeFileSync(schemaPath, MEMORY_SCHEMA_V3 + '\n' + getInitialMetadata(backend));

      // ADR-0085: ControllerRegistry bootstrap moved to router (initControllerRegistry)
      const controllerResult = { activated: [] as string[], failed: [] as string[], initTimeMs: 0 };

      return {
        success: true,
        backend,
        dbPath,
        schemaVersion: '3.0.0',
        tablesCreated: [
          'memory_entries',
          'patterns',
          'pattern_history',
          'trajectories',
          'trajectory_steps',
          'migration_state',
          'sessions',
          'vector_indexes',
          'metadata'
        ],
        indexesCreated: [
          'idx_memory_namespace',
          'idx_memory_key',
          'idx_memory_type',
          'idx_memory_status',
          'idx_memory_created',
          'idx_memory_accessed',
          'idx_memory_owner',
          'idx_patterns_type',
          'idx_patterns_confidence',
          'idx_patterns_status',
          'idx_patterns_last_matched',
          'idx_pattern_history_pattern',
          'idx_steps_trajectory'
        ],
        features: {
          vectorEmbeddings: true,
          patternLearning: true,
          temporalDecay: true,
          hnswIndexing: true,
          migrationTracking: true
        },
        controllers: controllerResult,
      };
    } else {
      // Fall back to schema file approach
      const schemaPath = path.join(dbDir, 'schema.sql');
      fs.writeFileSync(schemaPath, MEMORY_SCHEMA_V3 + '\n' + getInitialMetadata(backend));

      // Create minimal valid SQLite file
      const sqliteHeader = Buffer.alloc(4096, 0);
      // SQLite format 3 header
      Buffer.from('SQLite format 3\0').copy(sqliteHeader, 0);
      sqliteHeader[16] = 0x10; // page size high byte (4096)
      sqliteHeader[17] = 0x00; // page size low byte
      sqliteHeader[18] = 0x01; // file format write version
      sqliteHeader[19] = 0x01; // file format read version
      sqliteHeader[24] = 0x00; // max embedded payload
      sqliteHeader[25] = 0x40;
      sqliteHeader[26] = 0x20; // min embedded payload
      sqliteHeader[27] = 0x20; // leaf payload

      fs.writeFileSync(dbPath, sqliteHeader);

      // ADR-0085: ControllerRegistry bootstrap moved to router (initControllerRegistry)
      const controllerResult = { activated: [] as string[], failed: [] as string[], initTimeMs: 0 };

      return {
        success: true,
        backend,
        dbPath,
        schemaVersion: '3.0.0',
        tablesCreated: [
          'memory_entries (pending)',
          'patterns (pending)',
          'pattern_history (pending)',
          'trajectories (pending)',
          'trajectory_steps (pending)',
          'migration_state (pending)',
          'sessions (pending)',
          'vector_indexes (pending)',
          'metadata (pending)'
        ],
        indexesCreated: [],
        features: {
          vectorEmbeddings: true,
          patternLearning: true,
          temporalDecay: true,
          hnswIndexing: true,
          migrationTracking: true
        },
        controllers: controllerResult,
      };
    }
  } catch (error) {
    return {
      success: false,
      backend,
      dbPath,
      schemaVersion: '3.0.0',
      tablesCreated: [],
      indexesCreated: [],
      features: {
        vectorEmbeddings: false,
        patternLearning: false,
        temporalDecay: false,
        hnswIndexing: false,
        migrationTracking: false
      },
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Check if memory database is properly initialized
 *
 * // TODO(ADR-0086): Replace with RvfBackend health check
 */
export async function checkMemoryInitialization(dbPath?: string): Promise<{
  initialized: boolean;
  version?: string;
  backend?: string;
  features?: {
    vectorEmbeddings: boolean;
    patternLearning: boolean;
    temporalDecay: boolean;
  };
  tables?: string[];
}> {
  const swarmDir = path.join(process.cwd(), getSwarmDir());
  const path_ = dbPath || path.join(swarmDir, 'memory.db');

  if (!fs.existsSync(path_)) {
    return { initialized: false };
  }

  try {
    const db = await _getDb(path_, { readonly: true });

    // Check for metadata table
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tableRows.map(r => r.name);

    // Get version
    let version = 'unknown';
    let backend = 'unknown';
    try {
      const vRow = db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as { value: string } | undefined;
      if (vRow) version = vRow.value || 'unknown';

      const bRow = db.prepare("SELECT value FROM metadata WHERE key='backend'").get() as { value: string } | undefined;
      if (bRow) backend = bRow.value || 'unknown';
    } catch {
      // Metadata table might not exist
    }

    db.close();

    return {
      initialized: true,
      version,
      backend,
      features: {
        vectorEmbeddings: tableNames.includes('vector_indexes'),
        patternLearning: tableNames.includes('patterns'),
        temporalDecay: tableNames.includes('pattern_history')
      },
      tables: tableNames
    };
  } catch {
    // Could not read database
    return { initialized: false };
  }
}

/**
 * Apply temporal decay to patterns
 * Reduces confidence of patterns that haven't been used recently
 *
 * // TODO(ADR-0086): Dead — temporal decay not implemented in RvfBackend yet
 */
export async function applyTemporalDecay(dbPath?: string): Promise<{
  success: boolean;
  patternsDecayed: number;
  error?: string;
}> {
  const swarmDir = path.join(process.cwd(), getSwarmDir());
  const path_ = dbPath || path.join(swarmDir, 'memory.db');

  try {
    const db = await _getDb(path_);

    // Apply decay: confidence *= exp(-decay_rate * days_since_last_use)
    const now = Date.now();
    const decayQuery = `
      UPDATE patterns
      SET
        confidence = confidence * (1.0 - decay_rate * ((? - COALESCE(last_matched_at, created_at)) / 86400000.0)),
        updated_at = ?
      WHERE status = 'active'
        AND confidence > 0.1
        AND (? - COALESCE(last_matched_at, created_at)) > 86400000
    `;

    const result = db.prepare(decayQuery).run(now, now, now);
    const changes = result.changes;

    db.close();

    return {
      success: true,
      patternsDecayed: changes
    };
  } catch (error) {
    return {
      success: false,
      patternsDecayed: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// ADR-0086 T1.3: Embedding function bodies relocated to
// @claude-flow/memory/src/embedding-adapter.ts. Thin stubs below keep
// exports alive for direct importers until Phase 2 rewires them.

let _embAdapter: typeof import('@claude-flow/memory/embedding-adapter.js') | null = null;
async function _loadAdapter() {
  if (!_embAdapter) {
    _embAdapter = await import('@claude-flow/memory/embedding-adapter.js' as string);
  }
  return _embAdapter;
}

let _routerMod: typeof import('./memory-router.js') | null = null;
// Safe: routeMemoryOp calls ensureRouter() internally
async function _loadRouter() {
  if (!_routerMod) {
    _routerMod = await import('./memory-router.js');
  }
  return _routerMod;
}

export async function loadEmbeddingModel(options?: {
  modelPath?: string;
  verbose?: boolean;
}): Promise<{
  success: boolean;
  dimensions: number;
  modelName: string;
  loadTime?: number;
  error?: string;
}> {
  return (await _loadAdapter()).loadEmbeddingModel(options);
}

export async function generateEmbedding(
  text: string,
  options?: { intent?: 'query' | 'document' },
): Promise<{ embedding: number[]; dimensions: number; model: string }> {
  return (await _loadAdapter()).generateEmbedding(text, options);
}

export async function generateBatchEmbeddings(
  texts: string[],
  options?: { concurrency?: number; onProgress?: (completed: number, total: number) => void },
): Promise<{
  results: Array<{ text: string; embedding: number[]; dimensions: number; model: string }>;
  totalTime: number;
  avgTime: number;
}> {
  return (await _loadAdapter()).generateBatchEmbeddings(texts, options);
}

export async function getAdaptiveThreshold(explicitThreshold?: number): Promise<number> {
  return (await _loadAdapter()).getAdaptiveThreshold(explicitThreshold);
}

/**
 * Verify memory initialization works correctly
 * Tests: write, read, search, patterns
 *
 * // TODO(ADR-0086): Replace with RvfBackend verification — this still uses SQLite directly
 */
export async function verifyMemoryInit(dbPath: string, options?: {
  verbose?: boolean;
}): Promise<{
  success: boolean;
  tests: {
    name: string;
    passed: boolean;
    details?: string;
    duration?: number;
  }[];
  summary: {
    passed: number;
    failed: number;
    total: number;
  };
}> {
  const { verbose = false } = options || {};
  const tests: { name: string; passed: boolean; details?: string; duration?: number }[] = [];

  try {
    const db = await _getDb(dbPath);

    // Test 1: Schema verification
    const schemaStart = Date.now();
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tableRows.map(r => r.name);
    const expectedTables = ['memory_entries', 'patterns', 'metadata', 'vector_indexes'];
    const missingTables = expectedTables.filter(t => !tableNames.includes(t));

    tests.push({
      name: 'Schema verification',
      passed: missingTables.length === 0,
      details: missingTables.length > 0 ? `Missing: ${missingTables.join(', ')}` : `${tableNames.length} tables found`,
      duration: Date.now() - schemaStart
    });

    // Test 2: Write entry
    const writeStart = Date.now();
    const testId = `test_${Date.now()}`;
    const testKey = 'verification_test';
    const testValue = 'This is a verification test entry for memory initialization';

    try {
      db.prepare(`
        INSERT INTO memory_entries (id, key, namespace, content, type, created_at, updated_at)
        VALUES (?, ?, 'test', ?, 'semantic', ?, ?)
      `).run(testId, testKey, testValue, Date.now(), Date.now());

      tests.push({
        name: 'Write entry',
        passed: true,
        details: 'Entry written successfully',
        duration: Date.now() - writeStart
      });
    } catch (e) {
      tests.push({
        name: 'Write entry',
        passed: false,
        details: e instanceof Error ? e.message : 'Write failed',
        duration: Date.now() - writeStart
      });
    }

    // Test 3: Read entry
    const readStart = Date.now();
    try {
      const rRow = db.prepare(`SELECT content FROM memory_entries WHERE id = ?`).get(testId) as { content: string } | undefined;
      const content = rRow?.content;

      tests.push({
        name: 'Read entry',
        passed: content === testValue,
        details: content === testValue ? 'Content matches' : 'Content mismatch',
        duration: Date.now() - readStart
      });
    } catch (e) {
      tests.push({
        name: 'Read entry',
        passed: false,
        details: e instanceof Error ? e.message : 'Read failed',
        duration: Date.now() - readStart
      });
    }

    // Test 4: Write with embedding
    const embeddingStart = Date.now();
    try {
      const { embedding, dimensions, model } = await generateEmbedding(testValue);
      const embeddingJson = JSON.stringify(embedding);

      db.prepare(`
        UPDATE memory_entries
        SET embedding = ?, embedding_dimensions = ?, embedding_model = ?
        WHERE id = ?
      `).run(embeddingJson, dimensions, model, testId);

      tests.push({
        name: 'Generate embedding',
        passed: true,
        details: `${dimensions}-dim vector (${model})`,
        duration: Date.now() - embeddingStart
      });
    } catch (e) {
      tests.push({
        name: 'Generate embedding',
        passed: false,
        details: e instanceof Error ? e.message : 'Embedding failed',
        duration: Date.now() - embeddingStart
      });
    }

    // Test 5: Pattern storage
    const patternStart = Date.now();
    try {
      const patternId = `pattern_${Date.now()}`;
      db.prepare(`
        INSERT INTO patterns (id, name, pattern_type, condition, action, confidence, created_at, updated_at)
        VALUES (?, 'test-pattern', 'task-routing', 'test condition', 'test action', 0.5, ?, ?)
      `).run(patternId, Date.now(), Date.now());

      tests.push({
        name: 'Pattern storage',
        passed: true,
        details: 'Pattern stored with confidence scoring',
        duration: Date.now() - patternStart
      });

      // Cleanup test pattern
      db.prepare(`DELETE FROM patterns WHERE id = ?`).run(patternId);
    } catch (e) {
      tests.push({
        name: 'Pattern storage',
        passed: false,
        details: e instanceof Error ? e.message : 'Pattern storage failed',
        duration: Date.now() - patternStart
      });
    }

    // Test 6: Vector index configuration
    const indexStart = Date.now();
    try {
      const indexes = db.prepare(`SELECT name, dimensions, hnsw_m, hnsw_ef_construction FROM vector_indexes`).all();

      tests.push({
        name: 'Vector index config',
        passed: indexes.length > 0,
        details: `${indexes.length} indexes configured (HNSW M=16, ef=200)`,
        duration: Date.now() - indexStart
      });
    } catch (e) {
      tests.push({
        name: 'Vector index config',
        passed: false,
        details: e instanceof Error ? e.message : 'Index check failed',
        duration: Date.now() - indexStart
      });
    }

    // Cleanup test entry
    db.prepare(`DELETE FROM memory_entries WHERE id = ?`).run(testId);

    db.close();

    const passed = tests.filter(t => t.passed).length;
    const failed = tests.filter(t => !t.passed).length;

    return {
      success: failed === 0,
      tests,
      summary: {
        passed,
        failed,
        total: tests.length
      }
    };
  } catch (error) {
    return {
      success: false,
      tests: [{
        name: 'Database access',
        passed: false,
        details: error instanceof Error ? error.message : 'Unknown error'
      }],
      summary: { passed: 0, failed: 1, total: 1 }
    };
  }
}

/**
 * Store an entry directly using SQLite
 * This bypasses MCP and writes directly to the database
 */
export async function storeEntry(options: {
  key: string;
  value: string;
  namespace?: string;
  generateEmbeddingFlag?: boolean;
  tags?: string[];
  ttl?: number;
  dbPath?: string;
  upsert?: boolean;
}): Promise<{
  success: boolean;
  id: string;
  embedding?: { dimensions: number; model: string };
  error?: string;
}> {
  // ADR-0086 T2.6: delegates to routeMemoryOp (RvfBackend)
  const router = await _loadRouter();
  const result = await router.routeMemoryOp({
    type: 'store', key: options.key, value: options.value,
    namespace: options.namespace, generateEmbedding: options.generateEmbeddingFlag,
    tags: options.tags, ttl: options.ttl, upsert: options.upsert,
  });
  return { success: result.success, id: (result as any).key || '', embedding: (result as any).hasEmbedding ? { dimensions: (result as any).embeddingDimensions || 0, model: 'rvf' } : undefined, error: (result as any).error };
}

/**
 * Search entries using SQLite with vector similarity
 * Uses HNSW index for 150x faster search when available
 */
export async function searchEntries(options: {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  results: {
    id: string;
    key: string;
    content: string;
    score: number;
    namespace: string;
  }[];
  searchTime: number;
  error?: string;
}> {
  // ADR-0086 T2.6: delegates to routeMemoryOp (RvfBackend)
  const startTime = Date.now();
  const router = await _loadRouter();
  const result = await router.routeMemoryOp({
    type: 'search', query: options.query,
    namespace: options.namespace, limit: options.limit, threshold: options.threshold,
  });
  return {
    success: result.success,
    results: (result as any).results || [],
    searchTime: Date.now() - startTime,
    error: (result as any).error,
  };
}

// ADR-0086: cosineSim deleted (no callers)

/**
 * List all entries from the memory database
 */
export async function listEntries(options: {
  namespace?: string;
  limit?: number;
  offset?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  entries: {
    id: string;
    key: string;
    namespace: string;
    size: number;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
  }[];
  total: number;
  error?: string;
}> {
  // ADR-0086 T2.6: delegates to routeMemoryOp (RvfBackend)
  const router = await _loadRouter();
  const result = await router.routeMemoryOp({
    type: 'list', namespace: options.namespace,
    limit: options.limit, offset: options.offset,
  });
  return {
    success: result.success,
    entries: (result as any).entries || [],
    total: (result as any).total || 0,
    error: (result as any).error,
  };
}

/**
 * Get a specific entry from the memory database
 */
export async function getEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  found: boolean;
  entry?: {
    id: string;
    key: string;
    namespace: string;
    content: string;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
    tags: string[];
  };
  error?: string;
}> {
  // ADR-0086 T2.6: delegates to routeMemoryOp (RvfBackend)
  const router = await _loadRouter();
  const result = await router.routeMemoryOp({
    type: 'get', key: options.key, namespace: options.namespace,
  });
  return {
    success: result.success,
    found: (result as any).found ?? false,
    entry: (result as any).entry,
    error: (result as any).error,
  };
}

/**
 * Delete a memory entry by key and namespace
 * Issue #980: Properly supports namespaced entries
 */
export async function deleteEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  deleted: boolean;
  key: string;
  namespace: string;
  remainingEntries: number;
  error?: string;
}> {
  // ADR-0086 T2.6: delegates to routeMemoryOp (RvfBackend)
  const router = await _loadRouter();
  const result = await router.routeMemoryOp({
    type: 'delete', key: options.key, namespace: options.namespace,
  });
  return {
    success: result.success,
    deleted: (result as any).deleted ?? false,
    key: options.key,
    namespace: options.namespace || 'default',
    remainingEntries: (result as any).remainingEntries || 0,
    error: (result as any).error,
  };
}

export default {
  initializeMemoryDatabase,
  checkMemoryInitialization,
  checkAndMigrateLegacy,
  applyTemporalDecay,
  loadEmbeddingModel,
  generateEmbedding,
  verifyMemoryInit,
  storeEntry,
  searchEntries,
  listEntries,
  getEntry,
  deleteEntry,
  rebuildSearchIndex,
  MEMORY_SCHEMA_V3,
  getInitialMetadata
};
