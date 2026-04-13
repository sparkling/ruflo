/**
 * memory-router.ts -- Single entry point for ALL memory operations (ADR-0083 Phase 5)
 *
 * Data flow: MCP tool -> routeMemoryOp() / routeEmbeddingOp() -> storage functions
 * Controller access: getController() -> controller-intercept pool (Phase 4)
 * Embedding: EmbeddingPipeline (Phase 3) for vector operations
 * Config: ResolvedConfig singleton (Phase 1) for dimension/model
 * ADR-0085: JSON sidecar eliminated — intelligence reads from SQLite directly
 *
 * ADR-0084 Phase 4: Route methods use controller-direct (getController) instead of bridge.
 * Uses memory-initializer.ts internally
 * for actual storage operations (not deleted, not modified -- just wrapped).
 *
 * @module @claude-flow/cli/memory/memory-router
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

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

// ADR-0084 Phase 4: bridge module cache removed — route methods use controller-direct

// ---------------------------------------------------------------------------
// ADR-0085: ControllerRegistry bootstrap (moved from memory-bridge.ts)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _registryInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _registryPromise: Promise<any> | null = null;
let _registryAvailable: boolean | null = null;
let _exitHookRegistered = false;
let _embeddingsJsonWarned = false;

function _findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude-flow'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function _readProjectConfig(): Record<string, unknown> {
  try {
    const cfgPath = path.join(process.cwd(), '.claude-flow', 'config.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    }
  } catch { /* config.json may not exist or may be malformed — use defaults */ }
  return {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _readJsonFile(filePath: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    if (!_embeddingsJsonWarned && filePath.endsWith('embeddings.json')) {
      _embeddingsJsonWarned = true;
      console.warn('[config-chain] embeddings.json not found — using fallback defaults. Run "claude-flow init" to generate.');
    }
    return {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _getProjectConfig(): { config: Record<string, any>; embeddings: Record<string, any> } {
  const root = _findProjectRoot();
  return {
    config: _readJsonFile(path.join(root, '.claude-flow', 'config.json')),
    embeddings: _readJsonFile(path.join(root, '.claude-flow', 'embeddings.json')),
  };
}

function _getConfigSwarmDir(): string {
  try {
    const root = _findProjectRoot();
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude-flow', 'config.json'), 'utf-8'));
    return cfg?.memory?.swarmDir ?? '.swarm';
  } catch { return '.swarm'; }
}

function _getDbPath(customPath?: string): string {
  const swarmDir = path.resolve(process.cwd(), _getConfigSwarmDir());
  if (!customPath) return path.join(swarmDir, 'memory.db');
  if (customPath === ':memory:') return ':memory:';
  const resolved = path.resolve(customPath);
  const cwd = process.cwd();
  if (!resolved.startsWith(cwd)) {
    return path.join(swarmDir, 'memory.db');
  }
  return resolved;
}

function _ensureExitHook(): void {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;
  process.on('beforeExit', async () => {
    try { await shutdownRouter(); } catch { /* best effort */ }
  });
}

/**
 * Initialize the ControllerRegistry singleton (ADR-0085).
 * Extracted from memory-bridge.ts getRegistry().
 * Returns null if @claude-flow/memory is not available.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initControllerRegistry(dbPath?: string): Promise<any | null> {
  if (_registryAvailable === false) return null;
  if (_registryInstance) return _registryInstance;

  // Respect neural.enabled from config.json
  const _neuralCfg = (_readProjectConfig() as Record<string, unknown>).neural as Record<string, unknown> || {};
  if (_neuralCfg.enabled === false) {
    _registryAvailable = false;
    return null;
  }

  if (!_registryPromise) {
    _registryPromise = (async () => {
      try {
        const { ControllerRegistry } = await import('@claude-flow/memory');
        const registry = new ControllerRegistry();

        // Suppress console during registry init to prevent controller
        // logs (GNN, Sona, WASM, LearningSystem) from polluting MCP tool output.
        const origLog = console.log;
        const origWarn = console.warn;
        let _consoleRestored = false;
        const _restoreConsole = () => {
          if (_consoleRestored) return;
          _consoleRestored = true;
          console.log = origLog;
          console.warn = origWarn;
        };
        console.log = (..._args: unknown[]) => { /* suppress all during init */ };
        console.warn = (..._args: unknown[]) => { /* suppress all during init */ };

        // Get dimension + model from agentdb embedding config
        let _embDimension = 768;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const _agentdbCfg: any = await import('agentdb');
          if (_agentdbCfg.getEmbeddingConfig) {
            const _ec = _agentdbCfg.getEmbeddingConfig();
            _embDimension = _ec.dimension;
          }
        } catch { /* agentdb not available, use default */ }

        try {
          const { config: cfgJson, embeddings: embJson } = _getProjectConfig();

          // Listen for deferred init completion to restore console
          const _deferredTimeout = setTimeout(_restoreConsole, 120_000);
          (registry as unknown as { once: (event: string, cb: () => void) => void }).once('deferred:initialized', () => {
            clearTimeout(_deferredTimeout);
            _restoreConsole();
          });

          await registry.initialize({
            dbPath: dbPath || _getDbPath(),
            dimension: embJson.dimension ?? 768,
            embeddingModel: embJson.model ?? 'Xenova/all-mpnet-base-v2',
            hnswM: embJson.hnsw?.m ?? 23,
            hnswEfConstruction: embJson.hnsw?.efConstruction ?? 100,
            hnswEfSearch: embJson.hnsw?.efSearch ?? 50,
            maxElements: cfgJson.memory?.maxElements ?? 100000,
            maxEntries: cfgJson.memory?.maxEntries ?? cfgJson.memory?.storage?.maxEntries ?? 100000,
            similarityThreshold: cfgJson.memory?.similarityThreshold ?? 0.7,
            swarmDir: cfgJson.memory?.swarmDir ?? '.swarm',
            sqlite: cfgJson.memory?.sqlite ?? { cacheSize: -64000, busyTimeoutMs: 5000, journalMode: 'WAL', synchronous: 'NORMAL' },
            memory: {
              learningBridge: cfgJson.memory?.learningBridge,
              memoryGraph: cfgJson.memory?.memoryGraph,
              tieredCache: cfgJson.controllers?.tieredCache,
            },
            attentionService: cfgJson.controllers?.attentionService,
            multiHeadAttention: cfgJson.controllers?.multiHeadAttention,
            selfAttention: cfgJson.controllers?.selfAttention,
            rateLimiter: cfgJson.rateLimiter?.default ?? cfgJson.controllers?.rateLimiter ?? { maxRequests: 100, windowMs: 60000 },
            rateLimiterPresets: cfgJson.rateLimiter ?? null,
            circuitBreaker: cfgJson.controllers?.circuitBreaker,
            solverBandit: cfgJson.controllers?.solverBandit,
            controllers: {
              reasoningBank: true,
              learningBridge: cfgJson.memory?.learningBridge?.enabled === true,
              tieredCache: true,
              hierarchicalMemory: true,
              memoryConsolidation: true,
              enhancedEmbedding: true,
              memoryGraph: true,
              mutationGuard: true,
              attestationLog: true,
              learningSystem: true,
              explainableRecall: true,
              nightlyLearner: true,
              semanticRouter: true,
              ...(cfgJson.controllers?.enabled ?? {}),
            },
            nightlyLearner: cfgJson.controllers?.nightlyLearner,
            causalRecall: cfgJson.controllers?.causalRecall,
            queryOptimizer: cfgJson.controllers?.queryOptimizer,
            selfLearningRvfBackend: cfgJson.controllers?.selfLearningRvfBackend,
            mutationGuard: cfgJson.controllers?.mutationGuard,
            ports: {
              mcp: parseInt(process.env.MCP_PORT || '', 10) || (cfgJson.ports?.mcp ?? 3000),
              mcpWebSocket: parseInt(process.env.MCP_WS_PORT || '', 10) || (cfgJson.ports?.mcpWebSocket ?? 3001),
              quic: parseInt(process.env.QUIC_PORT || '', 10) || (cfgJson.ports?.quic ?? 4433),
              federation: parseInt(process.env.FEDERATION_PORT || '', 10) || (cfgJson.ports?.federation ?? 8443),
              health: parseInt(process.env.HEALTH_PORT || '', 10) || (cfgJson.ports?.health ?? 8080),
            },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);

          void Promise.resolve().then(() => {
            setTimeout(_restoreConsole, 500);
          });
        } catch {
          _restoreConsole();
          throw new Error('registry init failed');
        }

        _registryInstance = registry;
        _registryAvailable = true;

        // Instantiate WASMVectorSearch (JS fallback)
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const agentdbMod: any = await import('agentdb');
          const WASMVectorSearch = agentdbMod.WASMVectorSearch || agentdbMod.default?.WASMVectorSearch;
          if (WASMVectorSearch) {
            const wasmSearch = new WASMVectorSearch({
              dimension: _embDimension,
              wasmAvailable: false,
            });
            registry.register('wasmVectorSearch', wasmSearch);
          }
        } catch {
          // WASMVectorSearch instantiation failed — non-fatal
        }
        _ensureExitHook();
        return registry;
      } catch {
        _registryAvailable = false;
        _registryPromise = null;
        return null;
      }
    })();
  }

  return _registryPromise;
}

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
// Phase 4 helpers — controller-direct (replaces loadBridge)
// ---------------------------------------------------------------------------

/** Generate a secure random ID (inlined from memory-bridge). */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Probe a controller for a callable method across binding patterns.
 * Controllers may be wrapped as module objects, class instances, or nested objects.
 * Inlined from memory-bridge getCallableMethod (OPT-001/OPT-002).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCallableMethod(obj: any, ...names: string[]): ((...args: any[]) => any) | null {
  if (!obj) return null;
  for (const name of names) {
    if (typeof obj[name] === 'function') return obj[name].bind(obj);
    if (obj.default && typeof obj.default[name] === 'function') return obj.default[name].bind(obj.default);
    if (obj.instance && typeof obj.instance[name] === 'function') return obj.instance[name].bind(obj.instance);
    if (obj.controller && typeof obj.controller[name] === 'function') return obj.controller[name].bind(obj.controller);
  }
  return null;
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

// ADR-0085: writeJsonSidecar removed — intelligence.cjs reads from SQLite directly

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

  // ADR-0085: Bootstrap ControllerRegistry (best-effort — non-fatal)
  try {
    await initControllerRegistry();
  } catch {
    // Registry init is best-effort — storage still works without it
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
 * Routes all CRUD through memory-initializer.ts storage functions.
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
      // ADR-0085: writeJsonSidecar removed — intelligence reads from SQLite directly
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
 * Get a controller by name.
 * ADR-0085: Try local registry first (single-instance guarantee), fall back to intercept pool.
 */
export async function getController<T = unknown>(name: string): Promise<T | undefined> {
  // ADR-0085: Local registry is the primary source
  if (_registryInstance && typeof _registryInstance.get === 'function') {
    try {
      const ctrl = _registryInstance.get(name);
      if (ctrl) return ctrl as T;
    } catch { /* fall through to intercept */ }
  }
  // Fallback: controller-intercept pool (pre-ADR-0085 path)
  const intercept = await loadIntercept();
  if (intercept?.getExisting) {
    return intercept.getExisting<T>(name);
  }
  return undefined;
}

/**
 * Check if a controller exists in the pool.
 * ADR-0085: Local registry first, intercept fallback.
 */
export async function hasController(name: string): Promise<boolean> {
  if (_registryInstance && typeof _registryInstance.has === 'function') {
    try { if (_registryInstance.has(name)) return true; } catch { /* fall through */ }
  }
  const intercept = await loadIntercept();
  if (intercept?.has) return intercept.has(name);
  return false;
}

/**
 * List all registered controller names and info.
 * ADR-0085: Local registry first, intercept fallback.
 */
export async function listControllerInfo(): Promise<unknown[]> {
  if (_registryInstance && typeof _registryInstance.listControllers === 'function') {
    try {
      const controllers = _registryInstance.listControllers();
      if (Array.isArray(controllers)) {
        return controllers.map((c: { name: string; enabled?: boolean }) => ({ name: c.name ?? c, enabled: c.enabled ?? true }));
      }
    } catch { /* fall through */ }
  }
  const intercept = await loadIntercept();
  if (intercept?.listControllers) {
    const names = intercept.listControllers();
    return names.map(name => ({ name, enabled: true }));
  }
  return [];
}

/**
 * Wait for deferred (Level 2+) controller initialization.
 * ADR-0084 Phase 3: bridge fallback removed — controller-intercept handles deferred init.
 */
export async function waitForDeferred(): Promise<void> {
  const intercept = await loadIntercept();
  if (intercept && typeof (intercept as Record<string, unknown>).waitForDeferred === 'function') {
    await (intercept as Record<string, (...args: unknown[]) => Promise<void>>).waitForDeferred();
  }
}

/**
 * Controller health check.
 * ADR-0085: Check local registry first, then intercept.
 */
export async function healthCheck(): Promise<unknown> {
  if (_registryInstance && typeof _registryInstance.listControllers === 'function') {
    try {
      const controllers = _registryInstance.listControllers();
      const names = Array.isArray(controllers)
        ? controllers.map((c: { name: string }) => c.name ?? c)
        : [];
      return { available: true, controllers: names.length, controllerNames: names, source: 'registry' };
    } catch { /* fall through */ }
  }
  const intercept = await loadIntercept();
  if (intercept?.listControllers) {
    const names = intercept.listControllers();
    return { available: true, controllers: names.length, controllerNames: names, source: 'intercept' };
  }
  return { available: false, error: 'No controller source loaded' };
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
 * ADR-0084 Phase 4: controller-direct — uses getController('reasoningBank') instead of bridge.
 */
export async function routePatternOp(op: PatternOp): Promise<MemoryResult> {
  await ensureRouter();

  switch (op.type) {
    case 'store': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reasoningBank = await getController<any>('reasoningBank');
      const patternId = generateId('pattern');

      // OPT-001: Probe for callable store method across binding patterns
      const storeFn = getCallableMethod(reasoningBank, 'store', 'storePattern', 'add');
      if (storeFn) {
        try {
          await storeFn({
            id: patternId,
            content: op.pattern || '',
            type: op.patternType || 'general',
            confidence: op.confidence ?? 1.0,
            metadata: op.metadata,
            timestamp: Date.now(),
          });
          return { success: true, patternId, controller: 'reasoningBank' };
        } catch (e: unknown) {
          return { success: false, patternId: '', controller: '', error: e instanceof Error ? e.message : String(e) };
        }
      }

      // Fallback: store via routeMemoryOp
      const result = await routeMemoryOp({
        type: 'store',
        key: patternId,
        value: JSON.stringify({ pattern: op.pattern, type: op.patternType, confidence: op.confidence, metadata: op.metadata }),
        namespace: 'pattern',
        generateEmbedding: true,
        tags: [op.patternType || 'general', 'reasoning-pattern'],
      });
      return result.success
        ? { success: true, patternId, controller: 'router-fallback' }
        : { success: false, patternId: '', controller: '', error: 'Pattern store unavailable' };
    }
    case 'search': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reasoningBank = await getController<any>('reasoningBank');

      // OPT-001: Probe for callable search method across binding patterns
      const searchFn = getCallableMethod(reasoningBank, 'searchPatterns', 'search');
      if (searchFn) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let results: any;
          // Prefer searchPatterns (agentdb API) over search (legacy API) for arg format
          const searchPatternsFn = getCallableMethod(reasoningBank, 'searchPatterns');
          if (searchPatternsFn) {
            results = await searchPatternsFn({ task: op.query || '', k: op.topK || 5, threshold: op.minConfidence || 0.3 });
          } else {
            results = await searchFn(op.query || '', { topK: op.topK || 5, minScore: op.minConfidence || 0.3 });
          }
          return {
            success: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            results: Array.isArray(results) ? results.map((r: any) => ({
              id: r.id || r.patternId || '',
              content: r.content || r.pattern || '',
              score: r.score ?? r.confidence ?? 0,
            })) : [],
            controller: 'reasoningBank',
          };
        } catch {
          // Fall through to routeMemoryOp fallback
        }
      }

      // Fallback: search via routeMemoryOp
      const fallback = await routeMemoryOp({
        type: 'search',
        query: op.query || '',
        namespace: 'pattern',
        limit: op.topK || 5,
        threshold: op.minConfidence || 0.3,
      });
      return fallback.success
        ? { success: true, results: (fallback as { results?: unknown[] }).results || [], controller: 'router-fallback' }
        : { success: false, error: 'Pattern search unavailable' };
    }
    default:
      return { success: false, error: `Unknown pattern operation: ${(op as { type: string }).type}` };
  }
}

/**
 * Route feedback recording operations.
 * ADR-0084 Phase 4: controller-direct — uses getController('learningSystem') + getController('reasoningBank').
 */
export async function routeFeedbackOp(op: FeedbackOp): Promise<MemoryResult> {
  await ensureRouter();

  switch (op.type) {
    case 'record': {
      let controller = 'none';
      let updated = 0;

      // Try LearningSystem first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const learningSystem = await getController<any>('learningSystem');
      if (learningSystem) {
        try {
          if (typeof learningSystem.recordFeedback === 'function') {
            await learningSystem.recordFeedback({
              taskId: op.taskId, success: op.success, quality: op.quality,
              agent: op.agent, duration: op.duration, timestamp: Date.now(),
            });
            controller = 'learningSystem';
            updated++;
          }
        } catch { /* LearningSystem feedback non-fatal */ }
      }

      // Also record in ReasoningBank if available
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reasoningBank = await getController<any>('reasoningBank');
      const rbStoreFn = getCallableMethod(reasoningBank, 'store', 'storePattern');
      if (rbStoreFn) {
        try {
          await rbStoreFn({
            id: generateId('feedback'),
            content: JSON.stringify({ taskId: op.taskId, success: op.success, quality: op.quality }),
            type: 'feedback',
            confidence: op.quality,
            metadata: { agent: op.agent, duration: op.duration, patterns: op.patterns },
            timestamp: Date.now(),
          });
          controller = controller === 'none' ? 'reasoningBank' : `${controller}+reasoningBank`;
          updated++;
        } catch { /* ReasoningBank feedback non-fatal */ }
      }

      // Guaranteed persistence: always write a feedback entry via router
      // (mirrors bridge's unconditional bridgeStoreEntry for feedback-{taskId})
      try {
        await routeMemoryOp({
          type: 'store',
          key: `feedback-${op.taskId}`,
          value: JSON.stringify({ taskId: op.taskId, success: op.success, quality: op.quality, agent: op.agent, duration: op.duration }),
          namespace: 'feedback',
          tags: ['feedback', op.success ? 'success' : 'failure'],
          upsert: true,
        });
        if (controller === 'none') controller = 'router-store';
        updated = Math.max(updated, 1);
      } catch { /* persistence non-fatal */ }

      return { success: updated > 0, controller, updated };
    }
    default:
      return { success: false, error: `Unknown feedback operation: ${(op as { type: string }).type}` };
  }
}

/**
 * Route session lifecycle operations.
 * ADR-0084 Phase 4: controller-direct — uses getController('reflexion') + getController('nightlyLearner').
 */
export async function routeSessionOp(op: SessionOp): Promise<MemoryResult> {
  await ensureRouter();

  switch (op.type) {
    case 'start': {
      let controller = 'none';
      let restoredPatterns = 0;

      // Try ReflexionMemory for episodic session replay
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reflexion = await getController<any>('reflexion');
      if (reflexion && typeof reflexion.startEpisode === 'function') {
        try {
          await reflexion.startEpisode(op.sessionId, { context: op.context });
          controller = 'reflexion';
        } catch { /* non-fatal */ }
      }

      // Load recent patterns from past sessions via router
      try {
        const searchResult = await routeMemoryOp({
          type: 'search',
          query: op.context || 'session patterns',
          namespace: 'session',
          limit: 10,
        });
        if (searchResult.success) {
          restoredPatterns = ((searchResult as { results?: unknown[] }).results || []).length;
        }
      } catch { /* search non-fatal */ }

      return {
        success: true,
        controller: controller === 'none' ? 'router-search' : controller,
        restoredPatterns,
        sessionId: op.sessionId,
      };
    }
    case 'end': {
      let controller = 'none';
      let persisted = false;

      // End episode in ReflexionMemory
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reflexion = await getController<any>('reflexion');
      if (reflexion && typeof reflexion.endEpisode === 'function') {
        try {
          await reflexion.endEpisode(op.sessionId, {
            summary: op.summary,
            tasksCompleted: op.tasksCompleted,
            patternsLearned: op.patternsLearned,
          });
          controller = 'reflexion';
          persisted = true;
        } catch { /* non-fatal */ }
      }

      // Persist session summary as memory entry via router
      try {
        await routeMemoryOp({
          type: 'store',
          key: `session-${op.sessionId}`,
          value: JSON.stringify({
            sessionId: op.sessionId,
            summary: op.summary || 'Session ended',
            tasksCompleted: op.tasksCompleted ?? 0,
            patternsLearned: op.patternsLearned ?? 0,
            endedAt: new Date().toISOString(),
          }),
          namespace: 'session',
          tags: ['session-end'],
          upsert: true,
        });
        if (controller === 'none') controller = 'router-store';
        persisted = true;
      } catch { /* session persistence non-fatal */ }

      // Trigger NightlyLearner consolidation if available
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nightlyLearner = await getController<any>('nightlyLearner');
      if (nightlyLearner && typeof nightlyLearner.consolidate === 'function') {
        try {
          await nightlyLearner.consolidate({ sessionId: op.sessionId });
          controller += '+nightlyLearner';
        } catch { /* non-fatal */ }
      }

      return { success: true, controller, persisted };
    }
    default:
      return { success: false, error: `Unknown session operation: ${(op as { type: string }).type}` };
  }
}

/**
 * Route self-learning search and memory consolidation.
 * ADR-0084 Phase 4: controller-direct — uses getController('selfLearningRvfBackend') + getController('memoryConsolidation').
 */
export async function routeLearningOp(op: LearningOp): Promise<MemoryResult> {
  await ensureRouter();

  switch (op.type) {
    case 'search': {
      // Try A6 SelfLearningRvfBackend first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a6 = await getController<any>('selfLearningRvfBackend');
      if (a6 && typeof a6.search === 'function') {
        try {
          const results = await a6.search({
            query: op.query || '',
            limit: op.limit || 10,
            namespace: op.namespace,
            threshold: op.threshold,
          });
          const stats = typeof a6.getStats === 'function' ? a6.getStats() : undefined;
          return { success: true, results: results || [], routed: true, controller: 'selfLearningRvfBackend', stats };
        } catch { /* fall through to router fallback */ }
      }

      // Fallback to standard search via router
      try {
        const fallback = await routeMemoryOp({
          type: 'search',
          query: op.query || '',
          limit: op.limit || 10,
          namespace: op.namespace,
          threshold: op.threshold,
        });
        return {
          success: fallback.success,
          results: (fallback as { results?: unknown[] }).results || [],
          routed: false,
          controller: 'routeMemoryOp',
        };
      } catch {
        return { success: false, results: [], routed: false, controller: 'routeMemoryOp', error: 'Search fallback failed' };
      }
    }
    case 'consolidate': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mc = await getController<any>('memoryConsolidation');
      if (!mc) return { success: false, error: 'MemoryConsolidation not available' };
      try {
        const result = await mc.consolidate();
        return { success: true, consolidated: result };
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
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
 * ADR-0084 Phase 4: controller-direct — uses getController('causalGraph') + getController('causalRecall').
 */
export async function routeCausalOp(op: CausalOp): Promise<MemoryResult> {
  await ensureRouter();

  switch (op.type) {
    case 'edge': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const causalGraph = await getController<any>('causalGraph');
      if (causalGraph && typeof causalGraph.addEdge === 'function') {
        try {
          causalGraph.addEdge(op.sourceId || '', op.targetId || '', {
            relation: op.relation || '',
            weight: op.weight ?? 1.0,
            timestamp: Date.now(),
          });
          return { success: true, controller: 'causalGraph' };
        } catch { /* fall through to fallback */ }
      }

      // Fallback: store edge as memory entry via router
      try {
        const result = await routeMemoryOp({
          type: 'store',
          key: `${op.sourceId}\u2192${op.targetId}`,
          value: JSON.stringify({ sourceId: op.sourceId, targetId: op.targetId, relation: op.relation, weight: op.weight }),
          namespace: 'causal-edges',
        });
        return result.success
          ? { success: true, controller: 'router-fallback' }
          : { success: false, error: 'Causal edge recording unavailable' };
      } catch {
        return { success: false, error: 'Causal edge recording unavailable' };
      }
    }
    case 'recall': {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cr = await getController<any>('causalRecall');
        if (!cr || typeof cr.search !== 'function') {
          return { success: false, error: 'CausalRecall not available' };
        }
        // Cold-start guard: check if causal graph has enough edges
        if (typeof cr.getStats === 'function') {
          const stats = cr.getStats();
          if (stats && (stats.totalCausalEdges || 0) < 5) {
            return { success: true, results: [], warning: 'Cold start: fewer than 5 causal edges' };
          }
        }
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('CausalRecall timeout (2s)')), 2000)
        );
        const results = await Promise.race([
          cr.search({ query: op.query || '', k: op.k || 10, includeEvidence: op.includeEvidence }),
          timeoutPromise,
        ]);
        return { success: true, results: Array.isArray(results) ? results : [] };
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
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
// Shutdown + Reset
// ---------------------------------------------------------------------------

/**
 * Shutdown the router and release resources.
 * ADR-0085: Shuts down local ControllerRegistry + controller-intercept pool.
 */
export async function shutdownRouter(): Promise<void> {
  // ADR-0085: Shutdown ControllerRegistry
  if (_registryInstance) {
    try {
      await _registryInstance.shutdown();
    } catch { /* best-effort */ }
  }
  // Shutdown controller-intercept if available
  const intercept = _interceptMod;
  if (intercept) {
    try {
      if (typeof (intercept as Record<string, unknown>).shutdown === 'function') {
        await (intercept as Record<string, (...args: unknown[]) => Promise<void>>).shutdown();
      }
    } catch { /* best-effort */ }
  }
  resetRouter();
}

/** Reset all cached modules (testing only). */
export function resetRouter(): void {
  _fns = null;
  _embeddingFns = null;
  _allFns = null;
  _interceptMod = null;
  _initialized = false;
  _initPromise = null;
  // ADR-0085: Reset registry state
  _registryInstance = null;
  _registryPromise = null;
  _registryAvailable = null;
  _exitHookRegistered = false;
}
