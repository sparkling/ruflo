/**
 * Shared memory_entries schema -- single source of truth for all SQL-based backends.
 * Used by SQLiteBackend and AgentDBBackend to avoid schema duplication (ADR-0065 P3-2).
 *
 * @module v3/memory/memory-schema
 */

/**
 * DDL for the main memory_entries table.
 * Columns: id, key, content, type, namespace, tags, metadata, owner_id,
 * access_level, created_at, updated_at, expires_at, version, references,
 * access_count, last_accessed_at.
 */
export const MEMORY_ENTRIES_DDL = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  namespace TEXT NOT NULL,
  tags TEXT NOT NULL,
  metadata TEXT NOT NULL,
  owner_id TEXT,
  access_level TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  version INTEGER NOT NULL,
  "references" TEXT NOT NULL,
  access_count INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
)`;

/** Indexes for memory_entries, each as a standalone SQL statement. */
export const MEMORY_ENTRIES_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_namespace ON memory_entries(namespace)',
  'CREATE INDEX IF NOT EXISTS idx_key ON memory_entries(key)',
  'CREATE INDEX IF NOT EXISTS idx_namespace_key ON memory_entries(namespace, key)',
  'CREATE INDEX IF NOT EXISTS idx_type ON memory_entries(type)',
  'CREATE INDEX IF NOT EXISTS idx_owner_id ON memory_entries(owner_id)',
  'CREATE INDEX IF NOT EXISTS idx_created_at ON memory_entries(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_updated_at ON memory_entries(updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_expires_at ON memory_entries(expires_at)',
];

/**
 * DDL for the separate embeddings table used by SQLiteBackend.
 * Stores vector embeddings separately from the main entries table.
 */
export const MEMORY_EMBEDDINGS_DDL = `
CREATE TABLE IF NOT EXISTS memory_embeddings (
  entry_id TEXT PRIMARY KEY,
  embedding BLOB,
  FOREIGN KEY (entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE
)`;
