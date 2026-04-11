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

/**
 * Available database provider types
 */
export type DatabaseProvider = 'better-sqlite3' | 'rvf' | 'auto';

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
    maxEntries = 1000000, // ADR-0069: config-chain capacity — callers pass from RuntimeConfig.maxEntries
    autoPersistInterval = 5000,
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
