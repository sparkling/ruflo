/**
 * memory-router.ts -- Single entry point for all memory operations (ADR-0077 Phase 5)
 *
 * Data flow: MCP tool -> routeMemoryOp() -> storage functions
 * Controller access: getController() -> controller-intercept pool (Phase 4)
 * Embedding: EmbeddingPipeline (Phase 3) for vector operations
 * Config: ResolvedConfig singleton (Phase 1) for dimension/model
 *
 * Bypasses memory-bridge.ts entirely. Uses memory-initializer.ts internally
 * for actual storage operations (not deleted, not modified -- just wrapped).
 *
 * @module @claude-flow/cli/memory/memory-router
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryOpType =
  | 'store'
  | 'search'
  | 'get'
  | 'delete'
  | 'list'
  | 'stats'
  | 'count'
  | 'listNamespaces';

export interface MemoryOp {
  type: MemoryOpType;
  key?: string;
  value?: string;
  namespace?: string;
  tags?: string[];
  ttl?: number;
  upsert?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
  threshold?: number;
  generateEmbedding?: boolean;
}

export interface MemoryResult {
  success: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface StorageFns {
  storeEntry: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  searchEntries: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listEntries: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getEntry: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteEntry: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  initializeMemoryDatabase: (opts: Record<string, unknown>) => Promise<void>;
  checkMemoryInitialization: () => Promise<Record<string, unknown>>;
}

let _fns: StorageFns | null = null;
let _initialized = false;
let _initPromise: Promise<void> | null = null;

// Lazy-cached Phase 4 controller-intercept module
let _interceptMod: typeof import('../../../memory/src/controller-intercept.js') | null = null;

// ---------------------------------------------------------------------------
// Lazy loaders
// ---------------------------------------------------------------------------

async function loadStorageFns(): Promise<StorageFns> {
  if (_fns) return _fns;
  const mod = await import('./memory-initializer.js');
  _fns = {
    storeEntry: mod.storeEntry,
    searchEntries: mod.searchEntries,
    listEntries: mod.listEntries,
    getEntry: mod.getEntry,
    deleteEntry: mod.deleteEntry,
    initializeMemoryDatabase: mod.initializeMemoryDatabase,
    checkMemoryInitialization: mod.checkMemoryInitialization,
  };
  return _fns;
}

async function loadIntercept() {
  if (_interceptMod) return _interceptMod;
  try {
    _interceptMod = await import('@claude-flow/memory/controller-intercept.js' as string);
  } catch {
    try {
      _interceptMod = await import('../../../memory/src/controller-intercept.js');
    } catch {
      // controller-intercept not available
    }
  }
  return _interceptMod;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function _doInit(): Promise<void> {
  if (_initialized) return;

  // Phase 1: Resolve config (best-effort -- non-fatal if unavailable)
  try {
    const configMod = await import('@claude-flow/memory/resolve-config.js' as string)
      .catch(() => import('../../../memory/src/resolve-config.js'));
    const config = configMod.getConfig();

    // Phase 3: Initialize embedding pipeline (best-effort)
    try {
      const pipelineMod = await import('@claude-flow/memory/embedding-pipeline.js' as string)
        .catch(() => import('../../../memory/src/embedding-pipeline.js'));
      if (pipelineMod?.initPipeline) {
        await pipelineMod.initPipeline(config.embedding);
      }
    } catch {
      // Embedding pipeline init failed -- hash fallback will be used
    }
  } catch {
    // Config resolution unavailable -- storage will use its own defaults
  }

  // Initialize storage
  const fns = await loadStorageFns();
  const status = await fns.checkMemoryInitialization();
  if (!(status as { initialized?: boolean }).initialized) {
    await fns.initializeMemoryDatabase({ force: false, verbose: false });
  }

  _initialized = true;
}

/** Ensure the router (storage + pipeline) is initialized. */
export async function ensureRouter(): Promise<void> {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = _doInit().finally(() => { _initPromise = null; });
  return _initPromise;
}

// ---------------------------------------------------------------------------
// Core: routeMemoryOp
// ---------------------------------------------------------------------------

/**
 * Single entry point for CRUD memory operations.
 *
 * Replaces the dual-path pattern where memory-tools.ts imported from
 * memory-initializer.ts and memory-bridge.ts simultaneously.
 */
export async function routeMemoryOp(op: MemoryOp): Promise<MemoryResult> {
  await ensureRouter();
  const fns = _fns!;

  switch (op.type) {
    case 'store': {
      const result = await fns.storeEntry({
        key: op.key,
        value: op.value,
        namespace: op.namespace || 'default',
        generateEmbeddingFlag: op.generateEmbedding !== false,
        tags: op.tags,
        ttl: op.ttl,
        upsert: op.upsert,
      });
      return {
        success: !!(result as { success?: boolean }).success,
        key: op.key,
        stored: !!(result as { success?: boolean }).success,
        storedAt: new Date().toISOString(),
        hasEmbedding: !!(result as { embedding?: unknown }).embedding,
        embeddingDimensions: (result as { embedding?: { dimensions?: number } }).embedding?.dimensions || null,
        error: (result as { error?: string }).error,
      };
    }

    case 'search': {
      const result = await fns.searchEntries({
        query: op.query,
        namespace: op.namespace || 'all',
        limit: op.limit || 10,
        threshold: op.threshold || 0.3,
      });
      const results = (result as { results?: unknown[] }).results || [];
      return { success: true, results, total: results.length };
    }

    case 'get': {
      const result = await fns.getEntry({
        key: op.key,
        namespace: op.namespace || 'default',
      });
      return {
        success: true,
        found: !!(result as { found?: boolean }).found,
        entry: (result as { entry?: unknown }).entry || null,
      };
    }

    case 'delete': {
      const result = await fns.deleteEntry({
        key: op.key,
        namespace: op.namespace || 'default',
      });
      return {
        success: true,
        deleted: !!(result as { deleted?: boolean }).deleted,
      };
    }

    case 'list': {
      const result = await fns.listEntries({
        namespace: op.namespace || 'all',
        limit: op.limit || 50,
        offset: op.offset || 0,
      });
      return {
        success: true,
        entries: (result as { entries?: unknown[] }).entries || [],
        total: (result as { total?: number }).total || 0,
      };
    }

    case 'stats': {
      const status = await fns.checkMemoryInitialization();
      const all = await fns.listEntries({ limit: 100_000 });
      const entries = (all as { entries?: Array<{ namespace: string; hasEmbedding: boolean }> }).entries || [];
      const namespaces: Record<string, number> = {};
      let withEmbeddings = 0;
      for (const entry of entries) {
        namespaces[entry.namespace] = (namespaces[entry.namespace] || 0) + 1;
        if (entry.hasEmbedding) withEmbeddings++;
      }
      return {
        success: true,
        initialized: (status as { initialized?: boolean }).initialized,
        totalEntries: (all as { total?: number }).total || 0,
        entriesWithEmbeddings: withEmbeddings,
        namespaces,
      };
    }

    case 'count': {
      const result = await fns.listEntries({
        namespace: op.namespace || 'all',
        limit: 1,
      });
      return { success: true, count: (result as { total?: number }).total || 0 };
    }

    case 'listNamespaces': {
      const result = await fns.listEntries({ limit: 100_000 });
      const entries = (result as { entries?: Array<{ namespace: string }> }).entries || [];
      const namespaces = [...new Set(entries.map(e => e.namespace))];
      return { success: true, namespaces };
    }

    default:
      return { success: false, error: `Unknown operation: ${(op as { type: string }).type}` };
  }
}

// ---------------------------------------------------------------------------
// Controller access (replaces bridgeGetController)
// ---------------------------------------------------------------------------

/**
 * Get a controller by name from the singleton pool (Phase 4 controller-intercept).
 * Falls back to memory-bridge if controller-intercept is not available.
 */
export async function getController<T = unknown>(name: string): Promise<T | undefined> {
  const intercept = await loadIntercept();
  if (intercept?.getExisting) {
    const ctrl = intercept.getExisting<T>(name);
    if (ctrl !== undefined) return ctrl;
  }
  // Fallback: try memory-bridge (will be removed once controller-intercept is fully wired)
  try {
    const bridge = await import('./memory-bridge.js');
    return await bridge.bridgeGetController(name) as T;
  } catch {
    return undefined;
  }
}

/**
 * Check if a controller exists in the pool.
 */
export async function hasController(name: string): Promise<boolean> {
  const intercept = await loadIntercept();
  if (intercept?.has) return intercept.has(name);
  try {
    const bridge = await import('./memory-bridge.js');
    return !!(await bridge.bridgeHasController(name));
  } catch {
    return false;
  }
}

/**
 * List all registered controller names and info.
 */
export async function listControllerInfo(): Promise<unknown[]> {
  // Try controller-intercept first (Phase 4), then bridge fallback
  const intercept = await loadIntercept();
  if (intercept?.listControllers) {
    const names = intercept.listControllers();
    if (names.length > 0) {
      return names.map(name => ({ name, enabled: true }));
    }
  }
  try {
    const bridge = await import('./memory-bridge.js');
    return (await bridge.bridgeListControllers()) || [];
  } catch {
    return [];
  }
}

/**
 * Wait for deferred (Level 2+) controller initialization.
 */
export async function waitForDeferred(): Promise<void> {
  try {
    const bridge = await import('./memory-bridge.js');
    await bridge.bridgeWaitForDeferred?.();
  } catch {
    // No deferred controllers to wait for
  }
}

/**
 * Controller health check.
 */
export async function healthCheck(): Promise<unknown> {
  try {
    const bridge = await import('./memory-bridge.js');
    return await bridge.bridgeHealthCheck();
  } catch {
    return { available: false, error: 'Bridge not available' };
  }
}

// ---------------------------------------------------------------------------
// Reset (testing only)
// ---------------------------------------------------------------------------

export function resetRouter(): void {
  _fns = null;
  _interceptMod = null;
  _initialized = false;
  _initPromise = null;
}
