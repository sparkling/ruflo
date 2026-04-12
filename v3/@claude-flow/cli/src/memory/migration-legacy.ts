/**
 * migration-legacy.ts -- Standalone legacy JSON-to-RVF migration (ADR-0077 Phase 5)
 *
 * Extracted from memory-tools.ts. Run once during upgrade, not at every startup.
 * Converts old JSON store format to the current sql.js + HNSW backend.
 *
 * @module @claude-flow/cli/memory/migration-legacy
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LegacyMemoryEntry {
  key: string;
  value: unknown;
  metadata?: Record<string, unknown>;
  storedAt: string;
  accessCount: number;
  lastAccessed: string;
}

interface LegacyMemoryStore {
  entries: Record<string, LegacyMemoryEntry>;
  version: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MEMORY_DIR = '.claude-flow/memory';
const LEGACY_MEMORY_FILE = 'store.json';
const MIGRATION_MARKER = '.migrated-to-sqlite';

function getMemoryDir(): string {
  return resolve(MEMORY_DIR);
}

function getLegacyPath(): string {
  return resolve(join(MEMORY_DIR, LEGACY_MEMORY_FILE));
}

function getMigrationMarkerPath(): string {
  return resolve(join(MEMORY_DIR, MIGRATION_MARKER));
}

function ensureMemoryDir(): void {
  const dir = getMemoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if legacy JSON store exists and needs migration.
 */
export function hasLegacyStore(): boolean {
  const legacyPath = getLegacyPath();
  const migrationMarker = getMigrationMarkerPath();
  return existsSync(legacyPath) && !existsSync(migrationMarker);
}

/**
 * Load legacy JSON store for migration.
 */
export function loadLegacyStore(): LegacyMemoryStore | null {
  try {
    const path = getLegacyPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.entries === 'object') {
        return parsed as LegacyMemoryStore;
      }
      return null;
    }
  } catch {
    // Return null on error
  }
  return null;
}

/**
 * Mark migration as complete.
 */
export function markMigrationComplete(): void {
  ensureMemoryDir();
  writeFileSync(getMigrationMarkerPath(), JSON.stringify({
    migratedAt: new Date().toISOString(),
    version: '3.0.0',
  }), 'utf-8');
}

/**
 * Run the full legacy migration.
 *
 * @param storeEntry  The storage function to persist each migrated entry.
 * @returns           Number of entries migrated.
 */
export async function migrateLegacyStore(
  storeEntry: (opts: { key: string; value: string; namespace: string; generateEmbeddingFlag: boolean }) => Promise<unknown>,
): Promise<{ migrated: number; total: number }> {
  if (!hasLegacyStore()) {
    return { migrated: 0, total: 0 };
  }

  const legacyStore = loadLegacyStore();
  if (!legacyStore || Object.keys(legacyStore.entries).length === 0) {
    return { migrated: 0, total: 0 };
  }

  const keys = Object.keys(legacyStore.entries);
  let migrated = 0;

  console.error(`[migration-legacy] Migrating ${keys.length} entries from JSON to sql.js...`);

  for (const key of keys) {
    const entry = legacyStore.entries[key];
    try {
      const value = typeof entry.value === 'string'
        ? entry.value
        : JSON.stringify(entry.value);
      await storeEntry({
        key,
        value,
        namespace: 'default',
        generateEmbeddingFlag: true,
      });
      migrated++;
    } catch (e) {
      console.error(`[migration-legacy] Failed to migrate key "${key}":`, e);
    }
  }

  console.error(`[migration-legacy] Migrated ${migrated}/${keys.length} entries`);
  if (migrated === keys.length) {
    markMigrationComplete();
  } else {
    console.error(`[migration-legacy] Partial migration (${migrated}/${keys.length}) -- NOT marking complete, will retry next startup.`);
  }

  return { migrated, total: keys.length };
}
