/**
 * memory-router.ts -- Single entry point for ALL memory operations (ADR-0083 Phase 5)
 *
 * Data flow: MCP tool -> routeMemoryOp() / routeEmbeddingOp() -> storage functions
 * Controller access: getController() -> controller-intercept pool (Phase 4)
 * Embedding: EmbeddingPipeline (Phase 3) for vector operations
 * Config: ResolvedConfig singleton (Phase 1) for dimension/model
 * JSON sidecar: writeJsonSidecar() -> .claude-flow/data/auto-memory-store.json (CJS contract)
 *
 * Bypasses memory-bridge.ts entirely. Uses memory-initializer.ts internally
 * for actual storage operations (not deleted, not modified -- just wrapped).
 *
 * @module @claude-flow/cli/memory/memory-router
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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

export type EmbeddingOpType =
  | 'generate' | 'generateBatch' | 'loadModel' | 'getThreshold'
  | 'hnswGet' | 'hnswAdd' | 'hnswSearch' | 'hnswStatus' | 'hnswClear' | 'hnswRebuild'
  | 'quantize' | 'dequantize' | 'quantizedSim' | 'quantizationStats'
  | 'batchSim' | 'softmax' | 'topK' | 'flashSearch';

export interface EmbeddingOp {
  type: EmbeddingOpType;
  text?: string;
  texts?: string[];
  vector?: number[] | Float32Array;
  vectors?: Array<number[] | Float32Array>;
  id?: string;
  key?: string;
  query?: string;
  limit?: number;
  k?: number;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Phase 2 op types (ADR-0084) — bridge caller migration
// ---------------------------------------------------------------------------

export type PatternOpType = 'store' | 'search';

export interface PatternOp {
  type: PatternOpType;
  pattern?: string;
  patternType?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
  query?: string;
  topK?: number;
  minConfidence?: number;
  dbPath?: string;
}

export type FeedbackOpType = 'record';

export interface FeedbackOp {
  type: FeedbackOpType;
  taskId: string;
  success: boolean;
  quality: number;
  agent?: string;
  duration?: number;
  patterns?: string[];
  dbPath?: string;
}

export type SessionOpType = 'start' | 'end';

export interface SessionOp {
  type: SessionOpType;
  sessionId: string;
  context?: string;
  summary?: string;
  tasksCompleted?: number;
  patternsLearned?: number;
  dbPath?: string;
}

export type LearningOpType = 'search' | 'consolidate';

export interface LearningOp {
  type: LearningOpType;
  query?: string;
  limit?: number;
  namespace?: string;
  threshold?: number;
  minAge?: number;
  maxEntries?: number;
  dbPath?: string;
}

export type ReflexionOpType = 'store' | 'retrieve';

export interface ReflexionOp {
  type: ReflexionOpType;
  task?: string;
  input?: string;
  output?: string;
  reward?: number;
  success?: boolean;
  sessionId?: string;
  k?: number;
}

export type CausalOpType = 'edge' | 'recall';

export interface CausalOp {
  type: CausalOpType;
  sourceId?: string;
  targetId?: string;
  relation?: string;
  weight?: number;
  query?: string;
  k?: number;
  includeEvidence?: boolean;
  dbPath?: string;
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

// Lazy-cached embedding functions for routeEmbeddingOp
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _embeddingFns: Record<string, (...args: any[]) => any> | null = null;

// Lazy-cached full module for individual named-export wrappers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _allFns: Record<string, (...args: any[]) => any> | null = null;

// Lazy-cached Phase 4 controller-intercept module
let _interceptMod: typeof import('../../../memory/src/controller-intercept.js') | null = null;

// Lazy-cached bridge module for Phase 2 router methods (ADR-0084)
let _bridgeMod: typeof import('./memory-bridge.js') | null = null;

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

async function loadBridge(): Promise<typeof import('./memory-bridge.js')> {
  if (_bridgeMod) return _bridgeMod;
  _bridgeMod = await import('./memory-bridge.js');
  return _bridgeMod;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadEmbeddingFns(): Promise<Record<string, (...args: any[]) => any>> {
  if (_embeddingFns) return _embeddingFns;
  const mod = await import('./memory-initializer.js');
  _embeddingFns = mod as unknown as Record<string, (...args: any[]) => any>;
  return _embeddingFns;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAllFns(): Promise<Record<string, (...args: any[]) => any>> {
  if (_allFns) return _allFns;
  const mod = await import('./memory-initializer.js');
  _allFns = mod as unknown as Record<string, (...args: any[]) => any>;
  return _allFns;
}

// ---------------------------------------------------------------------------
// JSON sidecar (intelligence.cjs CJS contract)
// ---------------------------------------------------------------------------

const AUTO_MEMORY_STORE_MAX = 1000;

/**
 * Write an entry to .claude-flow/data/auto-memory-store.json so intelligence.cjs
 * can see CLI-stored memory. Best-effort — never throws.
 */
export function writeJsonSidecar(entry: {
  id: string; key: string; value: string; namespace: string;
}): void {
  try {
    const dataDir = path.join(process.cwd(), '.claude-flow', 'data');
    const storePath = path.join(dataDir, 'auto-memory-store.json');
    const tmpPath = storePath + '.tmp';

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    let store: Array<Record<string, unknown>> = [];
    if (fs.existsSync(storePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
        store = Array.isArray(raw) ? raw : (raw?.entries ?? []);
      } catch { /* corrupt file — start fresh */ }
    }

    store = store.filter((e) => e.id !== entry.id);

    store.push({
      id: entry.id,
      key: entry.key,
      value: entry.value,
      content: entry.value,
      namespace: entry.namespace,
      metadata: { source: 'cli-memory-store' },
      created_at: new Date().toISOString(),
    });

    if (store.length > AUTO_MEMORY_STORE_MAX) {
      store = store.slice(store.length - AUTO_MEMORY_STORE_MAX);
    }

    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
    fs.renameSync(tmpPath, storePath);
  } catch {
    // Best-effort — intelligence.cjs visibility is non-critical
  }
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
      const storeSuccess = !!(result as { success?: boolean }).success;
      if (storeSuccess && op.key && op.value) {
        writeJsonSidecar({
          id: op.key,
          key: op.key,
          value: op.value,
          namespace: op.namespace || 'default',
        });
      }
      return {
        success: storeSuccess,
        key: op.key,
        stored: storeSuccess,
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
// routeEmbeddingOp — embedding/HNSW operation router (ADR-0083 Phase 5)
// ---------------------------------------------------------------------------

/**
 * Single entry point for embedding and HNSW operations.
 * Mirrors routeMemoryOp but for vector/index operations.
 */
export async function routeEmbeddingOp(op: EmbeddingOp): Promise<MemoryResult> {
  await ensureRouter();
  const fns = await loadEmbeddingFns();

  switch (op.type) {
    case 'generate':
      return { success: true, ...(await fns.generateEmbedding(op.text, op.data)) };
    case 'generateBatch':
      return { success: true, ...(await fns.generateBatchEmbeddings(op.texts, op.data)) };
    case 'loadModel':
      return { success: true, ...(await fns.loadEmbeddingModel(op.data)) };
    case 'getThreshold':
      return { success: true, threshold: await fns.getAdaptiveThreshold(op.data as number | undefined) };
    case 'hnswGet':
      return { success: true, index: await fns.getHNSWIndex(op.data) };
    case 'hnswAdd':
      return { success: true, ...(await fns.addToHNSWIndex(op.id || op.key, op.vector, op.data)) };
    case 'hnswSearch':
      return { success: true, ...(await fns.searchHNSWIndex(op.vector || op.query, op.k || op.limit || 10, op.data)) };
    case 'hnswStatus':
      return { success: true, ...fns.getHNSWStatus() };
    case 'hnswClear':
      fns.clearHNSWIndex();
      return { success: true };
    case 'hnswRebuild':
      fns.rebuildSearchIndex();
      return { success: true };
    case 'quantize':
      return { success: true, ...fns.quantizeInt8(op.vector as number[] | Float32Array) };
    case 'dequantize':
      return { success: true, vector: fns.dequantizeInt8(op.data) };
    case 'quantizedSim':
      return { success: true, similarity: fns.quantizedCosineSim(op.vectors?.[0], op.vectors?.[1]) };
    case 'quantizationStats':
      return { success: true, ...fns.getQuantizationStats(op.vector as number[] | Float32Array) };
    case 'batchSim':
      return { success: true, similarities: fns.batchCosineSim(op.vector, op.vectors) };
    case 'softmax':
      return { success: true, scores: fns.softmaxAttention(op.data as Float32Array, op.k) };
    case 'topK':
      return { success: true, indices: fns.topKIndices(op.data as Float32Array, op.k || 10) };
    case 'flashSearch':
      return { success: true, ...fns.flashAttentionSearch(op.vector, op.vectors, op.k || 10, op.data) };
    default:
      return { success: false, error: `Unknown embedding operation: ${(op as { type: string }).type}` };
  }
}

// ---------------------------------------------------------------------------
// Phase 2 route methods (ADR-0084) — bridge caller migration
// ---------------------------------------------------------------------------

/**
 * Route pattern store/search operations.
 * Wraps bridgeStorePattern / bridgeSearchPatterns from memory-bridge.ts.
 */
export async function routePatternOp(op: PatternOp): Promise<MemoryResult> {
  await ensureRouter();
  const bridge = await loadBridge();

  switch (op.type) {
    case 'store': {
      const result = await bridge.bridgeStorePattern({
        pattern: op.pattern || '',
        type: op.patternType || 'general',
        confidence: op.confidence ?? 1.0,
        metadata: op.metadata,
        dbPath: op.dbPath,
      });
      return result
        ? { success: result.success, patternId: result.patternId, controller: result.controller, error: result.error }
        : { success: false, error: 'Pattern store unavailable' };
    }
    case 'search': {
      const result = await bridge.bridgeSearchPatterns({
        query: op.query || '',
        topK: op.topK,
        minConfidence: op.minConfidence,
        dbPath: op.dbPath,
      });
      return result
        ? { success: true, results: result.results, controller: result.controller }
        : { success: false, error: 'Pattern search unavailable' };
    }
    default:
      return { success: false, error: `Unknown pattern operation: ${(op as { type: string }).type}` };
  }
}

/**
 * Route feedback recording operations.
 * Wraps bridgeRecordFeedback from memory-bridge.ts.
 */
export async function routeFeedbackOp(op: FeedbackOp): Promise<MemoryResult> {
  await ensureRouter();
  const bridge = await loadBridge();

  switch (op.type) {
    case 'record': {
      const result = await bridge.bridgeRecordFeedback({
        taskId: op.taskId,
        success: op.success,
        quality: op.quality,
        agent: op.agent,
        duration: op.duration,
        patterns: op.patterns,
        dbPath: op.dbPath,
      });
      return result
        ? { success: result.success, controller: result.controller, updated: result.updated }
        : { success: false, error: 'Feedback recording unavailable' };
    }
    default:
      return { success: false, error: `Unknown feedback operation: ${(op as { type: string }).type}` };
  }
}

/**
 * Route session lifecycle operations.
 * Wraps bridgeSessionStart / bridgeSessionEnd from memory-bridge.ts.
 */
export async function routeSessionOp(op: SessionOp): Promise<MemoryResult> {
  await ensureRouter();
  const bridge = await loadBridge();

  switch (op.type) {
    case 'start': {
      const result = await bridge.bridgeSessionStart({
        sessionId: op.sessionId,
        context: op.context,
        dbPath: op.dbPath,
      });
      return result
        ? { success: result.success, controller: result.controller, restoredPatterns: result.restoredPatterns, sessionId: result.sessionId }
        : { success: false, error: 'Session start unavailable' };
    }
    case 'end': {
      const result = await bridge.bridgeSessionEnd({
        sessionId: op.sessionId,
        summary: op.summary,
        tasksCompleted: op.tasksCompleted,
        patternsLearned: op.patternsLearned,
        dbPath: op.dbPath,
      });
      return result
        ? { success: result.success, controller: result.controller, persisted: result.persisted }
        : { success: false, error: 'Session end unavailable' };
    }
    default:
      return { success: false, error: `Unknown session operation: ${(op as { type: string }).type}` };
  }
}

/**
 * Route self-learning search and memory consolidation.
 * Wraps bridgeSelfLearningSearch / bridgeConsolidate from memory-bridge.ts.
 */
export async function routeLearningOp(op: LearningOp): Promise<MemoryResult> {
  await ensureRouter();
  const bridge = await loadBridge();

  switch (op.type) {
    case 'search': {
      const result = await bridge.bridgeSelfLearningSearch({
        query: op.query || '',
        limit: op.limit,
        namespace: op.namespace,
        threshold: op.threshold,
        dbPath: op.dbPath,
      });
      return result
        ? { success: result.success, results: result.results, routed: result.routed, controller: result.controller, stats: result.stats }
        : { success: false, error: 'Self-learning search unavailable' };
    }
    case 'consolidate': {
      const result = await bridge.bridgeConsolidate({
        minAge: op.minAge,
        maxEntries: op.maxEntries,
      });
      return result
        ? { success: result.success, consolidated: result.consolidated, error: result.error }
        : { success: false, error: 'Consolidation unavailable' };
    }
    default:
      return { success: false, error: `Unknown learning operation: ${(op as { type: string }).type}` };
  }
}

/**
 * Route reflexion store/retrieve operations.
 * Uses reflexion controller directly (no bridge functions exist for reflexion).
 */
export async function routeReflexionOp(op: ReflexionOp): Promise<MemoryResult> {
  await ensureRouter();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reflexion = await getController<any>('reflexion');

  switch (op.type) {
    case 'store': {
      if (!reflexion || typeof reflexion.store !== 'function') {
        return { success: false, error: 'Reflexion controller not available' };
      }
      try {
        const result = await Promise.race([
          reflexion.store({
            session_id: op.sessionId,
            task: op.task,
            input: op.input,
            output: op.output,
            reward: op.reward ?? 0,
            success: op.success ?? false,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('reflexion store timeout (2s)')), 2000)
          ),
        ]);
        return { success: true, stored: result };
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case 'retrieve': {
      if (!reflexion || typeof reflexion.retrieve !== 'function') {
        return { success: false, error: 'Reflexion controller not available' };
      }
      try {
        const results = await Promise.race([
          reflexion.retrieve(op.task, op.k || 5),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('reflexion retrieve timeout (2s)')), 2000)
          ),
        ]);
        return { success: true, results: Array.isArray(results) ? results : [] };
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    default:
      return { success: false, error: `Unknown reflexion operation: ${(op as { type: string }).type}` };
  }
}

/**
 * Route causal graph operations.
 * Wraps bridgeRecordCausalEdge / bridgeCausalRecall from memory-bridge.ts.
 */
export async function routeCausalOp(op: CausalOp): Promise<MemoryResult> {
  await ensureRouter();
  const bridge = await loadBridge();

  switch (op.type) {
    case 'edge': {
      const result = await bridge.bridgeRecordCausalEdge({
        sourceId: op.sourceId || '',
        targetId: op.targetId || '',
        relation: op.relation || '',
        weight: op.weight,
        dbPath: op.dbPath,
      });
      return result
        ? { success: result.success, controller: result.controller }
        : { success: false, error: 'Causal edge recording unavailable' };
    }
    case 'recall': {
      const result = await bridge.bridgeCausalRecall({
        query: op.query || '',
        k: op.k,
        includeEvidence: op.includeEvidence,
      });
      return { success: result.success, results: result.results, warning: result.warning, error: result.error };
    }
    default:
      return { success: false, error: `Unknown causal operation: ${(op as { type: string }).type}` };
  }
}

// ---------------------------------------------------------------------------
// Lazy wrappers — 23 named exports from memory-initializer (ADR-0083 Phase 5)
// Each wraps a single memory-initializer function via loadAllFns().
// ---------------------------------------------------------------------------

// Helper: create a lazy-delegating wrapper
function _wrap(name: string) {
  return async (...args: unknown[]) => {
    const fns = await loadAllFns();
    return fns[name](...args);
  };
}

// HNSW (6)
export const getHNSWIndex = _wrap('getHNSWIndex');
export const addToHNSWIndex = _wrap('addToHNSWIndex');
export const searchHNSWIndex = _wrap('searchHNSWIndex');
export const getHNSWStatus = _wrap('getHNSWStatus');
export const clearHNSWIndex = _wrap('clearHNSWIndex');
export const rebuildSearchIndex = _wrap('rebuildSearchIndex');
// Quantization (4)
export const quantizeInt8 = _wrap('quantizeInt8');
export const dequantizeInt8 = _wrap('dequantizeInt8');
export const quantizedCosineSim = _wrap('quantizedCosineSim');
export const getQuantizationStats = _wrap('getQuantizationStats');
// Attention (3+1)
export const batchCosineSim = _wrap('batchCosineSim');
export const softmaxAttention = _wrap('softmaxAttention');
export const topKIndices = _wrap('topKIndices');
export const flashAttentionSearch = _wrap('flashAttentionSearch');
// DB lifecycle (3)
export const getInitialMetadata = _wrap('getInitialMetadata');
export const ensureSchemaColumns = _wrap('ensureSchemaColumns');
export const checkAndMigrateLegacy = _wrap('checkAndMigrateLegacy');
// Embedding (4)
export const loadEmbeddingModel = _wrap('loadEmbeddingModel');
export const generateEmbedding = _wrap('generateEmbedding');
export const generateBatchEmbeddings = _wrap('generateBatchEmbeddings');
export const getAdaptiveThreshold = _wrap('getAdaptiveThreshold');
// Decay/verify (2)
export const applyTemporalDecay = _wrap('applyTemporalDecay');
export const verifyMemoryInit = _wrap('verifyMemoryInit');

// ---------------------------------------------------------------------------
// Reset (testing only)
// ---------------------------------------------------------------------------

export function resetRouter(): void {
  _fns = null;
  _embeddingFns = null;
  _allFns = null;
  _interceptMod = null;
  _bridgeMod = null;
  _initialized = false;
  _initPromise = null;
}
