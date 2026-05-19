/**
 * DatabaseProvider - Platform-aware database selection
 *
 * Automatically selects best backend:
 * - RVF (always available via pure-TS, HNSW-Lite vector search)
 * - better-sqlite3 (native, fast on Linux/macOS)
 *
 * @module v3/memory/database-provider
 */

import { platform } from 'node:os';
import {
  IMemoryBackend,
} from './types.js';
import { SQLiteBackend, SQLiteBackendConfig } from './sqlite-backend.js';
import { getConfig } from './resolve-config.js';
import type { EmbeddingGenerator } from './types.js';
// TODO(adr-125-phase2-fork): upstream's sql.js fallback backend is not vendored
// in fork — see ADR-0177 carve-out. (fork uses better-sqlite3 native path.)

/**
 * Available database provider types.
 *
 * ADR-125 Phase 2 added `'hybrid'` and `'agentdb'` so the package can deliver
 * ADR-009's hybrid-tier promise through `createDatabase`.
 */
// Fork keeps narrow provider union (sqljs / json / hybrid-tier / agentdb backends
// not vendored). TODO(adr-125-phase2-fork): re-expand to upstream union when
// those backend modules land in fork.
export type DatabaseProvider = 'better-sqlite3' | 'rvf' | 'hybrid' | 'agentdb' | 'auto';

/**
 * Database creation options
 */
export interface DatabaseOptions {
  /** Preferred provider (auto = platform-aware selection) */
  provider?: DatabaseProvider;

  /** Enable verbose logging */
  verbose?: boolean;

  /** Enable WAL mode (better-sqlite3 only) */
  walMode?: boolean;

  /** Enable query optimization */
  optimize?: boolean;

  /** Default namespace */
  defaultNamespace?: string;

  /** Maximum entries before auto-cleanup */
  maxEntries?: number;

  /** Auto-persist interval (milliseconds) */
  autoPersistInterval?: number;

  /**
   * Embedding generator. Required for `'hybrid'` and `'agentdb'` providers
   * (and recommended for semantic search on any provider).
   */
  embeddingGenerator?: EmbeddingGenerator;

  /** Vector dimensions for `'hybrid'` and `'agentdb'` providers (fork default 768 — ADR-0068 mpnet) */
  dimensions?: number;
}

/**
 * Platform detection result
 */
interface PlatformInfo {
  os: string;
  isWindows: boolean;
  isMacOS: boolean;
  isLinux: boolean;
  recommendedProvider: DatabaseProvider;
}

/**
 * Detect platform and recommend provider
 */
function detectPlatform(): PlatformInfo {
  const os = platform();
  const isWindows = os === 'win32';
  const isMacOS = os === 'darwin';
  const isLinux = os === 'linux';

  // Recommend better-sqlite3 for Unix-like systems; RVF pure-TS fallback everywhere
  const recommendedProvider: DatabaseProvider = 'better-sqlite3';

  return {
    os,
    isWindows,
    isMacOS,
    isLinux,
    recommendedProvider,
  };
}

/**
 * Test if RVF backend is available (always true — pure-TS fallback)
 */
async function testRvf(): Promise<boolean> {
  return true;
}

/**
 * Test if better-sqlite3 is available and working
 */
async function testBetterSqlite3(): Promise<boolean> {
  try {
    const Database = (await import('better-sqlite3')).default;
    const testDb = new Database(':memory:');
    testDb.close();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Select best available provider
 */
async function selectProvider(
  preferred?: DatabaseProvider,
  verbose: boolean = false
): Promise<DatabaseProvider> {
  if (preferred && preferred !== 'auto') {
    if (verbose) {
      console.log(`[DatabaseProvider] Using explicitly specified provider: ${preferred}`);
    }
    return preferred;
  }

  if (verbose) {
    const platformInfo = detectPlatform();
    console.log(`[DatabaseProvider] Platform detected: ${platformInfo.os}`);
  }

  // Try RVF first (always available via pure-TS fallback)
  if (await testRvf()) {
    if (verbose) {
      console.log('[DatabaseProvider] RVF backend available');
    }
    return 'rvf';
  }

  // Try better-sqlite3
  if (await testBetterSqlite3()) {
    if (verbose) {
      console.log('[DatabaseProvider] better-sqlite3 available and working');
    }
    return 'better-sqlite3';
  } else if (verbose) {
    console.log('[DatabaseProvider] better-sqlite3 not available, falling back to RVF');
  }

  // Final fallback to RVF (guaranteed available via pure-TS)
  return 'rvf';
}

/**
 * Create a database instance with platform-aware provider selection
 *
 * @param path - Database file path (:memory: for in-memory)
 * @param options - Database configuration options
 * @returns Initialized database backend
 *
 * @example
 * ```typescript
 * // Auto-select best provider for platform
 * const db = await createDatabase('./data/memory.db');
 *
 * // Force specific provider
 * const db = await createDatabase('./data/memory.db', {
 *   provider: 'rvf'
 * });
 *
 * // With custom options
 * const db = await createDatabase('./data/memory.db', {
 *   verbose: true,
 *   optimize: true,
 *   autoPersistInterval: 10000
 * });
 * ```
 */
export async function createDatabase(
  path: string,
  options: DatabaseOptions = {}
): Promise<IMemoryBackend> {
  const {
    provider = 'auto',
    verbose = false,
    walMode = true,
    optimize = true,
    defaultNamespace = 'default',
    maxEntries = 100000, // ADR-0080: aligned with resolve-config DEFAULT_MAX_ENTRIES
    autoPersistInterval = 5000,
    embeddingGenerator,
    // ADR-0068 fork standard: 768-dim (mpnet model). Upstream defaults to
    // 1536; fork's unified embedding model is `Xenova/all-mpnet-base-v2`.
    dimensions = 768,
  } = options;

  // Select provider
  const selectedProvider = await selectProvider(provider, verbose);

  if (verbose) {
    console.log(`[DatabaseProvider] Creating database with provider: ${selectedProvider}`);
    console.log(`[DatabaseProvider] Database path: ${path}`);
  }

  let backend: IMemoryBackend;

  switch (selectedProvider) {
    case 'better-sqlite3': {
      const config: Partial<SQLiteBackendConfig> = {
        databasePath: path,
        walMode,
        optimize,
        defaultNamespace,
        maxEntries,
        verbose,
      };

      backend = new SQLiteBackend(config);
      break;
    }

    case 'rvf': {
      // Fork uses storage-factory wrapper (post-ADR-0177 SQLite restoration path).
      const { createStorageFromConfig } = await import('./storage-factory.js');
      backend = await createStorageFromConfig(getConfig(), {
        databasePath: path,
        defaultNamespace,
        autoPersistInterval,
        maxElements: maxEntries,
        verbose,
      });
      break;
    }

    case 'hybrid': {
      // ADR-009 / ADR-125 Phase 2 — SQLite for structured queries + AgentDB
      // for semantic search. Wires fork's vendored hybrid-tier backend
      // through the same constructor shape upstream uses.
      const { HybridBackend } = await import('./hybrid-backend.js');
      backend = new HybridBackend({
        sqlite: {
          databasePath: path,
          walMode,
          optimize,
          defaultNamespace,
          maxEntries,
          verbose,
        },
        agentdb: {
          dbPath: path.replace(/\.(db|json|rvf)$/, '.agentdb'),
          namespace: defaultNamespace,
          vectorDimension: dimensions,
          embeddingGenerator,
          maxEntries,
        },
        defaultNamespace,
        embeddingGenerator,
      });
      break;
    }

    case 'agentdb': {
      // ADR-125 Phase 2 — vector-tier-only path. Uses the same
      // AgentDBBackend module that hybrid-tier consumes.
      const { AgentDBBackend } = await import('./agentdb-backend.js');
      backend = new AgentDBBackend({
        dbPath: path,
        namespace: defaultNamespace,
        vectorDimension: dimensions,
        embeddingGenerator,
        maxEntries,
      });
      break;
    }

    default:
      throw new Error(`Unknown database provider: ${selectedProvider}`);
  }

  // Initialize the backend
  await backend.initialize();

  if (verbose) {
    console.log(`[DatabaseProvider] Database initialized successfully`);
  }

  return backend;
}

/**
 * Get platform information
 */
export function getPlatformInfo(): PlatformInfo {
  return detectPlatform();
}

/**
 * Check which providers are available
 */
export async function getAvailableProviders(): Promise<{
  rvf: boolean;
  betterSqlite3: boolean;
}> {
  return {
    rvf: true,
    betterSqlite3: await testBetterSqlite3(),
  };
}
