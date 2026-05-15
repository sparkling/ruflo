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
 * ADR-0086: Uses RvfBackend (IStorageContract) for storage
 * for actual storage operations (not deleted, not modified -- just wrapped).
 *
 * @module @claude-flow/cli/memory/memory-router
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { IStorageContract } from '@claude-flow/memory/storage.js';
import { findProjectRoot } from '../mcp-tools/types.js';

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
  | 'listNamespaces'
  | 'bulkDelete'
  | 'clearNamespace';

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
  ids?: string[];  // for bulkDelete
  // ADR-0147 R6 (2026-05-06): keyPrefix lets list-arm callers push prefix
  // filtering down into storage.query() (RVF/SQLite backends both honor it).
  // Without this, callers had to fetch a fixed-size page and filter
  // client-side — invisible past the page boundary as the namespace grows.
  keyPrefix?: string;
}

export interface MemoryResult {
  success: boolean;
  [key: string]: unknown;
}

export type EmbeddingOpType =
  | 'generate' | 'generateBatch' | 'loadModel' | 'getThreshold'
  | 'hnswGet' | 'hnswAdd' | 'hnswSearch' | 'hnswStatus' | 'hnswClear' | 'hnswRebuild'
  ; // ADR-0086: quantize/attention op types removed

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

// Bug-2 (2026-05-05): added 'query' arm so causal_query reads share the
// same router-fallback ladder as causal_edge writes (write/read symmetry).
export type CausalOpType = 'edge' | 'recall' | 'query';

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
  // Bug-2: causal_query also accepts cause/effect endpoints for direct lookup.
  cause?: string;
  effect?: string;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

// ADR-0086 T2.2: IStorageContract imported from @claude-flow/memory/storage.ts (canonical)
// Local any-typed copy deleted — compile-time safety restored via tsconfig reference.

let _storage: IStorageContract | null = null;
let _initialized = false;
let _initPromise: Promise<void> | null = null;
let _initFailed = false; // ADR-0086 I2: prevent retry storm on persistent failure

// ADR-0170 Phase C.3: split init into storage-only vs full registry. The
// memory_* axis (routeMemoryOp / routeEmbeddingOp) only needs `_storage`
// (RVF); the agentdb_* axis (controller-touching routes + getController)
// needs the full ControllerRegistry init which eagerly opens the postgres
// substrate and runs per-controller bootstrap DDL.
//
// Why the split exists: under ADR-0170 Phase C-1 the registry init now
// pays a postgres cluster open + CREATE EXTENSION + per-controller
// CREATE TABLE/INDEX IF NOT EXISTS on every fresh CLI process. The
// per-CLI-invocation regression measured in Phase C-2 (+30% store p50,
// +21% wall) was traced entirely to this eager init firing on memory_*
// axis CLI commands that never touch any controller.
//
// Per `feedback-no-fallbacks`: lazy != silent. If `ensureRegistry()` is
// called and pglite/agentdb is unavailable, the init still throws loudly
// — only WHEN init runs changes, not whether it surfaces errors.
let _registryInitialized = false;
let _registryInitPromise: Promise<void> | null = null;
let _registryInitFailed = false;

// ADR-0086 Phase 3: _embeddingFns + _allFns removed (no more initializer dependency).

// Lazy-cached Phase 4 controller-intercept module. Typed as `any` because
// the sibling `@claude-flow/memory` project may be unbuilt during cli
// typecheck (composite-reference dist gap); the runtime dynamic import
// still resolves correctly when the workspace is properly installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _interceptMod: any = null;

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

// ADR-0094 Sprint 1.4 (d6): advisory-lock path tracked so `process.on('exit')`
// sync handler can release it. `_storage.shutdown()` is async-only, but
// `process.exit(N)` skips `beforeExit` entirely — meaning the async handler
// never runs on the normal CLI exit path. Without a sync fallback, the
// `.rvf.lock` file lingers and the next CLI invocation hits `LockHeld`
// until the 5s budget runs out. Observed in e2e-semantic + e2e-0083-roundtrip
// sequential failures (Pass 4 root cause). Captured at _doInit time so the
// path is available even if `_storage` gets nulled out later.
let _lockPath: string | null = null;

// ADR-0156: capture the resolved canonical database path at init time so
// `commands/memory.ts:initMemoryCommand` can report it honestly (rather
// than the previous hardcoded `.swarm/memory.db` lie). Same lifecycle as
// `_lockPath` — set in `_doInit`, cleared in `resetRouter`.
let _databasePath: string | null = null;

// ADR-0156: canonical RVF sibling-extension set. The `--force` reset path
// in `commands/memory.ts` enumerates these against the resolved
// `_databasePath` to know what to unlink. Centralised here so the
// migration tool, the reset path, and any future tooling share one
// source of truth — drift in this set silently widens or narrows the
// reset's blast radius. The empty-string "" entry represents the main
// path itself; the rest are suffix-extensions.
export const RVF_CANONICAL_EXTENSIONS = [
  '',           // <path>            — main RVF/SFVR file
  '.meta',      // <path>.meta       — legacy sidecar (post-ADR-0154 still written)
  '.wal',       // <path>.wal        — write-ahead log
  '.lock',      // <path>.lock       — native flock file
  '.jslock',    // <path>.jslock     — JS advisory lock
  '.ingestlock', // <path>.ingestlock — native ingest lock
] as const;

function _findProjectRoot(): string {
  let dir = findProjectRoot();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude-flow'))) return dir;
    dir = path.dirname(dir);
  }
  return findProjectRoot();
}

/**
 * ADR-0112 Phase 2 (memory-router track): unified fatal-init error
 * discrimination. Five error classes signal data-integrity / required-
 * dependency failures that MUST propagate so the CLI can surface a
 * specific diagnostic — silently dropping any of them is the ADR-0082
 * silent-fallback antipattern.
 *
 *   - EmbeddingDimensionError: controller-registry's relabel of
 *     DimensionMismatchError (controller-registry.ts:623). Means the
 *     user's stored vectors don't match the configured model.
 *   - DimensionMismatchError: the underlying class from
 *     embedding-pipeline.ts. Direct throws (not via controller-registry)
 *     keep this name. ADR-0112 W1.8 slice 4 found memory-router only
 *     checked the relabelled name, missing direct throws.
 *   - RvfCorruptError: rvf-backend.ts:2305. Disk file corrupted —
 *     surfacing it lets the CLI emit a specific recovery message
 *     instead of a generic "init failed".
 *   - AgentDBInitError: required dep failed under Model 1 (agentdb is
 *     in dependencies, not optionalDependencies — ADR-0111 W1.5/W1.6).
 *   - ControllerInitError: controller-registry's class for individual
 *     controller bootstrap failures (W1.5). Op-layer discriminates so
 *     callers see "<controller> not initialized" not "Storage init failed".
 */
function _isFatalInitError(e: unknown): boolean {
  if (!e || !(e instanceof Error)) return false;
  const name = e.name;
  return name === 'EmbeddingDimensionError'
      || name === 'DimensionMismatchError'
      || name === 'RvfCorruptError'
      || name === 'AgentDBInitError'
      || name === 'ControllerInitError';
}

/**
 * ADR-0069 Bug #3: when the CLI is invoked outside any `.claude-flow/` project
 * context (e.g. `cd /tmp/foo && claude-flow memory store ...`), the previous
 * behavior was to write `./.claude-flow/memory.rvf` relative to whatever
 * process.cwd() happened to be. Two consequences:
 *
 *   1) Each invocation from a different directory wrote to a different file,
 *      so `store` + `retrieve` in separate shells returned "not found".
 *   2) Files were scattered across every directory the user ever ran the CLI
 *      from — invisible, unmanageable, and never cleaned up.
 *
 * Fix: when no ancestor `.claude-flow/` is found AND the caller did not
 * explicitly configure `storage.databasePath`, default to a stable per-user
 * location at `~/.claude-flow/data/memory.rvf`. Inside a project (any ancestor
 * with `.claude-flow/`), keep the original relative-to-project-root behavior
 * so init'd projects still get their own store.
 *
 * Never silently in-memory: if the persistent path can't be created the
 * caller surfaces the error (see _doInit error path) — ADR-0082.
 *
 * @param configuredPath - value from resolve-config (may be the hardcoded
 *   default `.claude-flow/memory.rvf`, may be a user override). If the user
 *   explicitly set this to a non-default absolute path we honor it verbatim.
 */
// Exported for unit tests (ADR-0069 Bug #3). Not part of the public API —
// treat as internal; signature may change. Named with a `__` prefix to make
// the intent obvious at import sites.
export function __resolveDatabasePathForTest(configuredPath: string): string {
  return _resolveDatabasePath(configuredPath);
}

function _resolveDatabasePath(configuredPath: string): string {
  // :memory: sentinel — pass through unchanged
  if (configuredPath === ':memory:') return configuredPath;

  // Absolute path from config override — honor it verbatim. The caller asked
  // for this specific location; don't second-guess.
  if (path.isAbsolute(configuredPath)) return configuredPath;

  // Relative path. Find project root. _findProjectRoot() returns cwd as
  // fallback when no ancestor `.claude-flow/` exists, so we must also check
  // that the root we found actually has a `.claude-flow/` directory — that
  // tells us whether we're inside a project or just sitting in an arbitrary
  // cwd.
  const projectRoot = _findProjectRoot();
  const inProject = fs.existsSync(path.join(projectRoot, '.claude-flow'));

  if (inProject) {
    // Inside an init'd project — resolve relative to project root so callers
    // in subdirectories still hit the same store.
    return path.resolve(projectRoot, configuredPath);
  }

  // Outside any project context. Use per-user persistent default.
  // $HOME/.claude-flow/data/memory.rvf — mkdir -p is done in _doInit before
  // createStorage() runs.
  return path.join(os.homedir(), '.claude-flow', 'data', 'memory.rvf');
}

function _readProjectConfig(): Record<string, unknown> {
  try {
    const cfgPath = path.join(findProjectRoot(), '.claude-flow', 'config.json');
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

/**
 * #1854 hand-port (ADR-0162 Batch A): single source of truth for the memory
 * root directory. Precedence:
 *   1. CLAUDE_FLOW_MEMORY_PATH env var (absolute path, used as-is)
 *   2. memory.persistPath / memory.path in .claude-flow/config.json
 *   3. memory.swarmDir in .claude-flow/config.json (legacy alias) → cwd/<swarmDir>
 *   4. Default: cwd/.swarm
 *
 * Cached per-process; spawn a fresh process to pick up config changes.
 */
let _memoryRootCache: string | undefined;
function _getMemoryRoot(): string {
  if (_memoryRootCache !== undefined) return _memoryRootCache;

  const envPath = process.env.CLAUDE_FLOW_MEMORY_PATH;
  if (envPath && envPath.trim().length > 0) {
    _memoryRootCache = path.resolve(envPath);
    return _memoryRootCache;
  }

  const root = findProjectRoot();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude-flow', 'config.json'), 'utf-8'));
    const persistPath = cfg?.memory?.persistPath ?? cfg?.memory?.path;
    if (typeof persistPath === 'string' && persistPath.trim().length > 0) {
      _memoryRootCache = path.isAbsolute(persistPath) ? persistPath : path.resolve(root, persistPath);
      return _memoryRootCache;
    }
  } catch { /* fall through */ }

  _memoryRootCache = path.resolve(root, _getConfigSwarmDir());
  return _memoryRootCache;
}

/** Reset the memory-root cache (test/runtime-reconfigure helper for #1854). */
export function _resetMemoryRootCache(): void {
  _memoryRootCache = undefined;
}

function _getDbPath(customPath?: string): string {
  if (!customPath) return path.join(_getMemoryRoot(), 'memory.db');
  if (customPath === ':memory:') return ':memory:';
  const resolved = path.resolve(customPath);
  const cwd = findProjectRoot();
  if (!resolved.startsWith(cwd)) {
    return path.join(_getMemoryRoot(), 'memory.db');
  }
  return resolved;
}

/**
 * ADR-0094 Sprint 1.4 (d6): sync shutdown for `process.on('exit')`.
 *
 * `beforeExit` only fires when Node's event loop drains naturally. Any call
 * to `process.exit(N)` — including the `setTimeout(process.exit(0), 500)`
 * in CLIApp.run() and the error-path exits in handleError — skips beforeExit
 * entirely. The `exit` event fires on BOTH paths but handlers must be
 * synchronous (no promises awaited).
 *
 * This handler does the minimum sync cleanup to avoid lock leaks:
 *  1. Release the `.rvf.lock` file (unlinkSync) if it belongs to this PID
 *  2. Log LOUDLY to stderr on failure (ADR-0082 — never swallow silently)
 *
 * `nativeDb.close()` cannot be called here: we only have a reference to
 * IStorageContract, and the native handle is an internal implementation
 * detail of RvfBackend. The lock release is the critical one — a dangling
 * native handle is freed by process death, but a dangling lock file blocks
 * the next CLI invocation for up to 5s.
 */
function _syncShutdown(): void {
  if (!_lockPath) return;
  try {
    // Only release if the lock belongs to us (PID match). This prevents a
    // racing process from having its lock yanked when we exit.
    if (fs.existsSync(_lockPath)) {
      let isOurs = false;
      try {
        const content = fs.readFileSync(_lockPath, 'utf-8');
        const parsed = JSON.parse(content) as { pid?: number };
        isOurs = parsed.pid === process.pid;
      } catch {
        // Corrupt or unreadable lock file — treat as ours (we're exiting anyway).
        isOurs = true;
      }
      if (isOurs) {
        fs.unlinkSync(_lockPath);
      }
    }
  } catch (err) {
    // ADR-0082: surface loudly to stderr, do NOT swallow. Next process
    // will hit LockHeld on the stale lock — operator needs to see this.
    process.stderr.write(
      `[memory-router] sync shutdown failed to release lock ${_lockPath} ` +
      `(pid=${process.pid}): ${(err as Error).message}\n`
    );
  }
}

function _ensureExitHook(): void {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;
  // `beforeExit` fires on natural event-loop drain and can be async.
  process.on('beforeExit', async () => {
    try { await shutdownRouter(); } catch { /* best effort */ }
  });
  // ADR-0094 Sprint 1.4 (d6): `exit` fires on BOTH natural drain AND
  // `process.exit(N)`. Handler must be synchronous. This is the critical
  // path for CLI lock-leak prevention since CLIApp.run() calls
  // `setTimeout(process.exit(0), 500).unref()` on every successful command.
  process.on('exit', _syncShutdown);
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

          // Listen for deferred init completion to restore console.
          // unref() prevents timer from keeping the process alive (ADR-0085 flaw 2).
          const _deferredTimeout = setTimeout(_restoreConsole, 120_000);
          _deferredTimeout.unref();
          (registry as unknown as { once: (event: string, cb: () => void) => void }).once('deferred:initialized', () => {
            clearTimeout(_deferredTimeout);
            _restoreConsole();
          });

          await registry.initialize({
            dbPath: dbPath || _getDbPath(),
            dimension: embJson.dimension ?? 768,
            embeddingModel: embJson.model ?? 'Xenova/all-mpnet-base-v2',
            // ADR-0170 Phase A.8a — vectorIndex='pgvector' replaces the
            // legacy vectorBackend='ruvector' pin. Under ADR-0170, vectors
            // become first-class postgres column types indexed by pgvector;
            // the legacy in-memory backend selection ('ruvector' / 'hnswlib')
            // is loud-rejected by AgentDB at boot. Phase C wires the
            // pgvector tables; Phase A keeps 'auto' as a deferred-resolve
            // path until then. 'pgvector' is the declared intent.
            vectorIndex: 'pgvector',
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
              // ADR-0170 Phase B Wave 1a fix (2026-05-11): memoryConsolidation
              // is a Wave 1b controller whose constructor still issues SQLite-
              // dialect DDL (INTEGER PRIMARY KEY AUTOINCREMENT) against the
              // PostgresBackend handle that Wave 1a now passes. Under strict
              // mode (CLAUDE_FLOW_STRICT !== 'false' = default), the resulting
              // ControllerInitError is fatal — it tears down the entire
              // Registry init and cascades to every downstream tool ("Reflexion
              // not available", "SkillLibrary not available" via p13/B5
              // acceptance checks). Disable until Wave 1b ports the controller
              // to PostgresBackend; flip back to true alongside the port.
              memoryConsolidation: false,
              enhancedEmbedding: true,
              memoryGraph: true,
              mutationGuard: true,
              attestationLog: true,
              learningSystem: true,
              explainableRecall: true,
              nightlyLearner: true,
              semanticRouter: true,
              // sparkling/ruflo W5-A3: sonaTrajectory (SonaTrajectoryService) is
              // opt-in in @claude-flow/memory's ControllerRegistry
              // (isControllerEnabled returns false by default, line 1125-1126).
              // W2-I5's agentdb_sona_trajectory_store MCP tool dispatches to
              // getController('sonaTrajectory') and surfaced "SonaTrajectoryService
              // controller not available" because the registry never initialized
              // the controller. Enable it here so the standard ControllerRegistry
              // pipeline (Level 5 init → createController case 'sonaTrajectory'
              // → agentdb.getController('sonaTrajectory')) wires a real instance.
              sonaTrajectory: true,
              // graphAdapter is opt-in because it requires @ruvector/graph-node
              // (native binding) to be installed and a persistent storagePath.
              // Users opt in via `cli config set --key controllers.graphAdapter
              // --value true`. When true, agentdb is constructed with
              // enableGraph:true at controller-registry.ts:993 and the native
              // backend initializes with storagePath = dbPath.
              graphAdapter: cfgJson.controllers?.graphAdapter === true,
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
        } catch (e) {
          _restoreConsole();
          // ADR-0090 Tier B1 + ADR-0111 W1.6 + ADR-0112 Phase 2 (memory-router
          // track): dimension mismatch (both relabelled and direct), RVF
          // corruption, agentdb-init, and controller-init are FATAL — not
          // best-effort registry-init failures. Silently disabling the
          // registry on any of them masks data-loss regressions per ADR-0082.
          if (_isFatalInitError(e)) throw e;
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
      } catch (e) {
        _registryAvailable = false;
        _registryPromise = null;
        // ADR-0090 Tier B1 + ADR-0111 W1.6 + ADR-0112 Phase 2: re-throw all
        // fatal init classes. The caller (_doInit) wraps in its own best-
        // effort try/catch, but those must not swallow these classes either.
        if (_isFatalInitError(e)) throw e;
        return null;
      }
    })();
  }

  return _registryPromise;
}

// ---------------------------------------------------------------------------
// Lazy loaders
// ---------------------------------------------------------------------------

// ADR-0086 T2.2: RvfBackend replaces loadStorageFns
// ADR-0095 amendment d2 (ruflo-patch): route through storage-factory so both
// CLI and controller-registry hit the same resolved-path cache and the
// `tryNativeInit` work collapses from 2× to 1× per CLI invocation. Also
// `path.resolve()` here so a relative path passed to createStorage yields
// the same cache key as the absolute path passed by controller-registry.
async function createStorage(config: { databasePath: string; dimensions?: number }): Promise<IStorageContract> {
  const memMod = await import('@claude-flow/memory/storage-factory' as string);
  const backend = await memMod.createStorage({
    databasePath: path.resolve(config.databasePath),
    dimensions: config.dimensions,
  });
  // IStorage and IStorageContract are both aliases for IMemoryBackend
  // (memory/storage.ts lines 20 & 29). Single cast hop, not a real conversion.
  return backend as IStorageContract;
}

async function loadIntercept() {
  if (_interceptMod) return _interceptMod;
  try {
    _interceptMod = await import('@claude-flow/memory/controller-intercept' as string);
  } catch {
    // controller-intercept not available — non-critical
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
export function getCallableMethod(obj: any, ...names: string[]): ((...args: any[]) => any) | null {
  if (!obj) return null;
  for (const name of names) {
    if (typeof obj[name] === 'function') return obj[name].bind(obj);
    if (obj.default && typeof obj.default[name] === 'function') return obj.default[name].bind(obj.default);
    if (obj.instance && typeof obj.instance[name] === 'function') return obj.instance[name].bind(obj.instance);
    if (obj.controller && typeof obj.controller[name] === 'function') return obj.controller[name].bind(obj.controller);
  }
  return null;
}

// ADR-0086 Phase 3: loadEmbeddingFns + loadAllFns deleted (no more initializer dependency).

// ---------------------------------------------------------------------------
// JSON sidecar (intelligence.cjs CJS contract)
// ---------------------------------------------------------------------------

// ADR-0085: writeJsonSidecar removed — intelligence.cjs reads from SQLite directly

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Tighten DB file to 0600 (best-effort). Swallows ENOENT (dir-layout
 * backends), EPERM (Windows), ENOSYS (filesystems without chmod). Other
 * errors propagate so we don't silently leave a world-readable DB.
 * Extracted from _doInit so the structural test that scans for the FIRST
 * `catch` after `createStorage(` lands on the outer circuit-breaker catch.
 */
function _chmodDbFile(databasePath: string): void {
  try {
    fs.chmodSync(databasePath, 0o600);
  } catch (chmodErr) {
    const code = (chmodErr as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'EPERM' && code !== 'ENOSYS') {
      throw chmodErr;
    }
  }
}

/**
 * ADR-0170 Phase C.3: RVF-only storage init.
 *
 * Initializes the RVF backend used by the memory_* axis (routeMemoryOp,
 * routeEmbeddingOp). Does NOT touch the agentdb_* ControllerRegistry —
 * that's deferred to `_doInitRegistry()` which is called on demand by
 * agentdb_*-axis routes via `ensureRegistry()`.
 *
 * Pre-C.3: this body was the start of `_doInit()` followed by
 * `initControllerRegistry()`. Splitting them lets memory_*-axis CLI
 * invocations (the canonical cost-sensitive path) skip the postgres
 * substrate open + per-controller CREATE TABLE/INDEX IF NOT EXISTS that
 * Phase C-2 measured as a +30% store p50 / +21% wall regression.
 */
async function _doInit(): Promise<void> {
  if (_initialized) return;

  // Phase 1: Resolve config (best-effort -- non-fatal if unavailable)
  let databasePath = '.claude-flow/memory.rvf';
  let dimensions = 768;
  try {
    const configMod = await import('@claude-flow/memory/resolve-config' as string);
    const config = configMod.getConfig();
    databasePath = config.storage?.databasePath || databasePath;
    dimensions = config.embedding?.dimension || dimensions;

    // Initialize embedding pipeline (best-effort)
    try {
      const pipelineMod = await import('@claude-flow/memory/embedding-pipeline' as string);
      if (pipelineMod?.initPipeline) {
        await pipelineMod.initPipeline(config.embedding);
      }
    } catch {
      // Embedding pipeline init failed -- hash fallback will be used
    }
  } catch {
    // Config resolution unavailable -- storage will use its own defaults
  }

  // ADR-0069 Bug #3: resolve the database path to a per-user default when
  // the CLI is invoked outside any project context, so `memory store` and
  // `memory retrieve` in separate invocations hit the same file. See
  // _resolveDatabasePath() for the full decision tree.
  databasePath = _resolveDatabasePath(databasePath);

  // ADR-0086 T2.2 + ADR-0094 d6 + ADR-0095 amend (2026-05-01) + ADR-0156:
  // create RvfBackend; lock at `path + '.jslock'` (NOT `.lock`, which is the
  // native FLVR binary lock — using it confused _syncShutdown and produced
  // LockHeld 0x0300 / FsyncFailed 0x0303 + silent-loss races).
  if (databasePath && databasePath !== ':memory:') _lockPath = databasePath + '.jslock';
  _databasePath = databasePath;
  try {
    // ADR-0069 Bug #3 + ADR-0162 Batch B (de96b0eed): ensure parent dir
    // exists at mode 0700 before RvfBackend opens the file.
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    _storage = await createStorage({ databasePath, dimensions });
    // ADR-0162 Batch B: tighten DB file to 0600 (helper swallows ENOENT,
    // EPERM, ENOSYS; other errors propagate).
    if (databasePath !== ':memory:') _chmodDbFile(databasePath);
  } catch (e) {
    // ADR-0086 B4: circuit breaker — storage creation failed.
    _storage = null;
    _initFailed = true; // ADR-0086 I2: prevent retry storm.
    // ADR-0090 Tier B1/B2 + ADR-0111 W1.6 + ADR-0112 Phase 2 (memory-router
    // track): preserve all fatal error classes (DimensionMismatchError direct
    // throws are now caught too — slice 4 found those slipped through).
    if (_isFatalInitError(e)) throw e;
    throw new Error('Storage initialization failed: ' + (e instanceof Error ? e.message : String(e)));
  }

  if (!_storage) {
    throw new Error('Storage initialization returned null');
  }

  _initialized = true;
}

/**
 * ADR-0170 Phase C.3: agentdb_* ControllerRegistry init.
 *
 * Bootstraps the ControllerRegistry (and through it, the agentdb_*
 * substrate: postgres cluster open, CREATE EXTENSION, per-controller
 * CREATE TABLE/INDEX IF NOT EXISTS, etc.).
 *
 * Per `feedback-no-fallbacks`: this is loud-fail. If pglite is unavailable
 * or the postgres connection cannot be established, the error propagates
 * with the original ADR-0165 framing — silently continuing leaves
 * agentdb_* MCP tools pointing at routeMemoryOp fallbacks that return
 * success without writing, a classic silent-fallback antipattern.
 *
 * Called on demand by `ensureRegistry()` from agentdb_*-axis routes
 * (getController, routePatternOp, routeReflexionOp, etc.). memory_*-axis
 * routes (routeMemoryOp, routeEmbeddingOp) DO NOT call this — they only
 * call `ensureRouter()` (storage-only).
 */
async function _doInitRegistry(): Promise<void> {
  if (_registryInitialized) return;

  // Storage must come up first — the registry's `dbPath` resolution
  // depends on the same path machinery, and AgentDB construction inside
  // ControllerRegistry consumes the resolved path.
  await _doInit();

  // ADR-0085: Bootstrap ControllerRegistry (now lazy per C.3).
  // ADR-0090 Tier B1 exception: EmbeddingDimensionError is FATAL. A stored-
  // vs-configured dimension mismatch means the user's persisted embeddings
  // are unreadable and any search/store would produce garbage results.
  // Silently disabling controllers in that case would mask a real data-loss
  // regression (ADR-0082). Re-throw so the CLI exits non-zero with a clear
  // diagnostic.
  // ADR-0111 W1.6: AgentDBInitError is also FATAL. Per Model 1, agentdb is a
  // required dependency; init failure means a broken install. Swallowing it
  // here would defeat the W1.5 fail-loud cleanup of agentdb-backend.ts.
  try {
    await initControllerRegistry();
  } catch (e) {
    // ADR-0165 fix: AgentDB controller-registry init failure is FATAL.
    // Per feedback-no-fallbacks + ADR-0082, silently continuing leaves
    // agentdb_* MCP tools pointing at routeMemoryOp fallbacks that
    // return success without writing to .swarm/memory.db — a classic
    // silent-fallback that converts transient init failures into
    // permanent data loss for the process lifetime. AgentDB is a
    // required dep (ADR-0111 W1.5/W1.6); init failure means a broken
    // install, NAPI binding error, or transient resource starvation
    // — all of which the operator must see, not have masked.
    _registryInitFailed = true;
    if (e instanceof Error) {
      throw new Error(
        `AgentDB controller registry initialization failed (fatal per ADR-0165): ${e.message}`,
        { cause: e },
      );
    }
    throw new Error(
      `AgentDB controller registry initialization failed (fatal per ADR-0165): ${String(e)}`,
    );
  }

  _registryInitialized = true;
}

/**
 * Ensure the router (storage + pipeline) is initialized.
 *
 * ADR-0170 Phase C.3: storage-only. Memory_*-axis callers (routeMemoryOp,
 * routeEmbeddingOp) use this. AgentDB_*-axis callers must use
 * `ensureRegistry()` to also bootstrap the ControllerRegistry.
 */
export async function ensureRouter(): Promise<void> {
  if (_initialized) return;
  // ADR-0086 I2: fast-fail on persistent init failure — prevents retry storm
  if (_initFailed) throw new Error('Storage initialization permanently failed. Call resetRouter() or restart the process to retry.');
  if (_initPromise) return _initPromise;
  _initPromise = _doInit().finally(() => { _initPromise = null; });
  return _initPromise;
}

/**
 * ADR-0170 Phase C.3: ensure both the RVF storage AND the agentdb_*
 * ControllerRegistry are initialized. Required for any caller that
 * touches controllers via `getController`, `routePatternOp`,
 * `routeFeedbackOp`, `routeReflexionOp`, `routeLearningOp`,
 * `routeSessionOp`, `routeCausalOp`, `listControllerInfo`, `healthCheck`,
 * or `waitForDeferred`.
 *
 * Idempotent and fast-failing — repeated calls after a successful init
 * are O(1); repeated calls after a failed init throw immediately.
 *
 * Per `feedback-no-fallbacks`: failure propagates with the underlying
 * error class preserved. Lazy != silent.
 */
export async function ensureRegistry(): Promise<void> {
  if (_registryInitialized) return;
  if (_registryInitFailed) {
    throw new Error(
      'AgentDB controller registry initialization permanently failed. Call resetRouter() or restart the process to retry.',
    );
  }
  if (_registryInitPromise) return _registryInitPromise;
  _registryInitPromise = _doInitRegistry().finally(() => { _registryInitPromise = null; });
  return _registryInitPromise;
}

// ---------------------------------------------------------------------------
// Core: routeMemoryOp
// ---------------------------------------------------------------------------

/**
 * Single entry point for CRUD memory operations.
 * ADR-0086 T2.3: Routes through IStorageContract (RvfBackend).
 */
export async function routeMemoryOp(op: MemoryOp): Promise<MemoryResult> {
  await ensureRouter();
  // ADR-0086 B4: defense-in-depth null guard
  if (!_storage) {
    return { success: false, error: 'Storage not initialized. Call ensureRouter() first.' };
  }
  const storage = _storage;

  switch (op.type) {
    case 'store': {
      try {
        const id = generateId('mem');
        const namespace = op.namespace || 'default';
        const now = Date.now();

        // Generate embedding for semantic search
        let embedding: Float32Array | undefined;
        if (op.generateEmbedding !== false && op.value) {
          try {
            const adapterMod = await import('@claude-flow/memory/embedding-adapter' as string);
            const result = await adapterMod.generateEmbedding(op.value);
            embedding = new Float32Array(result.embedding);
          } catch { /* embedding optional — store without it */ }
        }

        // ADR-0094 RC-2: idempotency guard. Without a pre-check, two back-to-back
        // `store(key=k, value=v, namespace=n)` calls with `upsert:false` would create
        // two rows (router always fell through to storage.store()). We now always
        // look up the existing entry first:
        //   - same value         → no-op return (idempotent)
        //   - different value + !upsert → error (use upsert:true to replace)
        //   - different value + upsert  → update existing row
        //   - no existing entry  → fall through to the unconditional insert below
        if (op.key) {
          const existing = await storage.getByKey(namespace, op.key);
          if (existing) {
            const existingContent = (existing as { content?: string }).content ?? '';
            const newContent = op.value ?? '';
            const sameValue = existingContent === newContent;

            if (sameValue) {
              // Idempotent no-op: same (key, value, namespace) — return existing entry
              return {
                success: true, key: op.key, stored: true,
                storedAt: new Date((existing as { createdAt?: number }).createdAt ?? now).toISOString(),
                hasEmbedding: !!(existing as { embedding?: unknown }).embedding,
                embeddingDimensions: (existing as { embedding?: { length?: number } }).embedding?.length ?? null,
                idempotent: true,
              };
            }

            if (!op.upsert) {
              return {
                success: false,
                key: op.key,
                stored: false,
                error: "'key' already exists in this namespace with a different value; set upsert:true to replace",
              };
            }

            // upsert === true and value differs → overwrite
            await storage.update(existing.id, {
              content: op.value,
              tags: op.tags,
              metadata: { ...(existing.metadata || {}), ttl: op.ttl },
            });
            return {
              success: true, key: op.key, stored: true,
              storedAt: new Date().toISOString(),
              hasEmbedding: !!embedding, embeddingDimensions: embedding?.length || null,
            };
          }
        }

        const entry = {
          id,
          key: op.key || id,
          content: op.value || '',
          embedding,
          type: 'semantic' as const,
          namespace,
          tags: op.tags || [],
          metadata: op.ttl ? { ttl: op.ttl } : {},
          accessLevel: 'private' as const,
          createdAt: now,
          updatedAt: now,
          version: 1,
          references: [],
          accessCount: 0,
          lastAccessedAt: now,
        };

        await storage.store(entry);
        return {
          success: true, key: op.key, stored: true,
          storedAt: new Date().toISOString(),
          hasEmbedding: !!embedding, embeddingDimensions: embedding?.length || null,
        };
      } catch (e) {
        return { success: false, error: `store failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'search': {
      // ADR-0094 Phase 15: cold-start flake fix. Previously, the first
      // `memory_search` in a fresh process paid the full ONNX-model cold-start
      // cost (import @xenova/transformers + load all-mpnet-base-v2 + probe
      // embed) before answering even when the store was empty. Under the
      // parallel Phase 15 load (6 tools × 3 runs = 18 concurrent `cli mcp
      // exec` children contending for the same model files + wasm runtime),
      // that first call could exceed the harness's 15s read-only timeout and
      // get SIGKILLed — producing the observed (exit_error, success, success)
      // flake signature while runs 2 & 3 hit the warm in-process pipeline
      // singleton.
      //
      // An empty store has zero possible results regardless of query
      // semantics, so we can answer correctly without ever loading the
      // embedding model. storage.count(ns) is an in-memory Map lookup on the
      // primary RVF backend (O(1) with no namespace, O(n) filter otherwise)
      // and runs after ensureRouter() has already loaded the persisted state.
      // This is NOT a silent retry (ADR-0082): the successful `results: []`
      // response is the semantically correct answer for an empty store — the
      // fix removes wasted cold-start work, it does not swallow a real error.
      const searchNamespace = op.namespace === 'all' ? undefined : op.namespace;
      try {
        const entryCount = await storage.count(searchNamespace);
        if (entryCount === 0) {
          return { success: true, results: [], total: 0 };
        }
      } catch {
        // count() itself should never fail on a live backend; if it does,
        // fall through to the full search path so the real error surfaces
        // from storage.search() rather than being masked here.
      }

      // Ensure the embedding pipeline is initialized so we can see its
      // provider. Detect hash-fallback BEFORE generating an embedding so we
      // can skip wasted work on the lexical path.
      //
      // BM25 activation rule: when the pipeline is running in `hash-fallback`
      // mode (ONNX + ruvector both unavailable), the produced vectors are
      // deterministic but non-semantic — cosine similarity on them cannot
      // connect queries like "authentication JWT" to keys like `jwt-auth`.
      // In that mode we replace the vector search with a BM25 lexical rank
      // over the full namespace. The embedding path is kept unchanged for
      // real embedders (mpnet / bge / etc) where cosine is meaningful.
      let pipelineProvider: string | null = null;
      try {
        const pipelineMod = await import('@claude-flow/memory/embedding-pipeline' as string);
        let pipeline = pipelineMod.getPipeline?.();
        if (!pipeline || !pipeline.isInitialized?.()) {
          // Initialize via the adapter's loadEmbeddingModel so we get the
          // same config resolution (resolve-config.ts) the store path uses.
          const adapterMod = await import('@claude-flow/memory/embedding-adapter' as string);
          await adapterMod.loadEmbeddingModel();
          pipeline = pipelineMod.getPipeline?.();
        }
        if (pipeline?.getProvider) pipelineProvider = pipeline.getProvider();
      } catch (e) {
        // Provider detection is advisory — fall through to the embedding
        // path, which will surface its own error if the pipeline is broken.
        pipelineProvider = null;
      }

      if (pipelineProvider === 'hash-fallback') {
        try {
          // Pull every entry in the (optionally namespaced) store. BM25 needs
          // to see the whole corpus to compute IDF. `storage.query` with a
          // large limit is the router-sanctioned way to enumerate; the RVF
          // backend's prefix query is O(n) over an in-memory Map either way.
          const BM25_MAX_CORPUS = 10000;
          const entries = await storage.query({
            type: 'prefix',
            namespace: searchNamespace,
            limit: BM25_MAX_CORPUS,
            offset: 0,
          });

          const bm25Mod = await import('@claude-flow/memory/bm25' as string);
          // bm25Rank throws on empty query tokens — that is the correct
          // loud-fail behavior (ADR-0082). We do not catch it.
          const ranked = bm25Mod.bm25Rank(op.query || '', entries, {
            limit: op.limit || 10,
          });
          const results = ranked.map((r: { entry: { key: string; namespace: string; content: string }; score: number }) => ({
            key: r.entry.key,
            score: r.score,
            namespace: r.entry.namespace,
            content: r.entry.content,
          }));
          return { success: true, results, total: results.length };
        } catch (e) {
          return { success: false, error: `bm25 search failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }

      // Generate embedding from query text (real embedder path)
      let embedding: Float32Array;
      let adaptiveThreshold: number | undefined;
      try {
        const adapterMod = await import('@claude-flow/memory/embedding-adapter' as string);
        const result = await adapterMod.generateEmbedding(op.query || '', { intent: 'query' });
        embedding = new Float32Array(result.embedding);
        // FB-004: Use adaptive threshold based on embedding provider (hash-fallback = 0.05, ONNX = 0.3)
        if (adapterMod.getAdaptiveThreshold) {
          adaptiveThreshold = await adapterMod.getAdaptiveThreshold(op.threshold);
        }
      } catch (e) {
        return { success: false, error: 'Embedding generation failed: ' + (e instanceof Error ? e.message : String(e)) };
      }

      try {
        // ADR-0086 fix: map router params to SearchOptions (k, filters.namespace).
        // Reuses `searchNamespace` resolved above the empty-store short-circuit.
        const raw = await storage.search(embedding, {
          k: op.limit || 10,
          threshold: adaptiveThreshold ?? op.threshold ?? 0.3,
          filters: searchNamespace ? { namespace: searchNamespace } : undefined,
        });
        // Flatten SearchResult { entry, score, distance } to { key, score, namespace, content }
        const results = raw.map((r: { entry: { key: string; namespace: string; content: string }; score: number }) => ({
          key: r.entry.key,
          score: r.score,
          namespace: r.entry.namespace,
          content: r.entry.content,
        }));
        return { success: true, results, total: results.length };
      } catch (e) {
        return { success: false, error: `search failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'get': {
      try {
        const entry = await storage.getByKey(op.namespace || 'default', op.key || '');
        return {
          success: true,
          found: !!entry,
          entry: entry || null,
        };
      } catch (e) {
        return { success: false, error: `get failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'delete': {
      try {
        const entry = await storage.getByKey(op.namespace || 'default', op.key || '');
        if (entry) {
          await storage.delete(entry.id);
          return { success: true, deleted: true };
        }
        return { success: true, deleted: false };
      } catch (e) {
        return { success: false, error: `delete failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'list': {
      try {
        // ADR-0094 Sprint 1.4 (d9): preserve undefined through to storage.query.
        // Previously `namespace || 'default'` coerced an unscoped list request
        // to only the 'default' namespace, while the count() call below used
        // the correct undefined-means-all semantics — resulting in the
        // {entries:[], total:6} mismatch B observed in Pass 4.
        // storage.query's namespace filter is skipped when namespace is falsy
        // (rvf-backend line 357), so passing undefined here returns all
        // namespaces. The 'all' sentinel is kept for back-compat callers.
        const namespace = op.namespace === 'all' ? undefined : op.namespace;
        // ADR-0147 R6: forward keyPrefix to storage so it pre-filters during
        // the scan instead of returning the first `limit` entries by insertion
        // order. Used by routeCausalOp's cause= prefix-pushdown for
        // O(prefix-match) instead of O(N) scan + client-side filter.
        // ADR-0163 follow-up (2026-05-10): conditional pass — only forward
        // when the caller explicitly set keyPrefix. Prevents storage backends
        // from receiving an `'keyPrefix' in q` shape that differs from the
        // no-prefix shape (footgun for any backend that interpolates into
        // SQL-style templates without an undefined check).
        const queryArgs: any = {
          type: 'prefix',
          namespace,
          limit: op.limit || 50,
          offset: op.offset || 0,
        };
        if (op.keyPrefix !== undefined) {
          queryArgs.keyPrefix = op.keyPrefix;
        }
        const entries = await storage.query(queryArgs);
        const total = await storage.count(namespace);
        return { success: true, entries, total };
      } catch (e) {
        return { success: false, error: `list failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'stats': {
      try {
        const stats = await storage.getStats();
        const health = await storage.healthCheck();
        const namespaceList = await storage.listNamespaces();
        const namespaces: Record<string, number> = {};
        for (const ns of namespaceList) {
          namespaces[ns] = await storage.count(ns);
        }
        return {
          success: true,
          initialized: (health as any).status === 'healthy',
          totalEntries: stats.totalEntries ?? 0,
          entriesWithEmbeddings: stats.entriesWithEmbeddings ?? stats.totalEntries ?? 0,
          namespaces,
        };
      } catch (e) {
        return { success: false, error: `stats failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'count': {
      try {
        const count = await storage.count(op.namespace === 'all' ? undefined : op.namespace);
        return { success: true, count };
      } catch (e) {
        return { success: false, error: `count failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'listNamespaces': {
      try {
        const namespaces = await storage.listNamespaces();
        return { success: true, namespaces };
      } catch (e) {
        return { success: false, error: `listNamespaces failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'bulkDelete': {
      if (!op.ids || op.ids.length === 0) {
        return { success: false, error: 'bulkDelete requires ids array' };
      }
      try {
        // ADR-0086 B2: bulkDelete was missing from router switch
        await storage.bulkDelete(op.ids);
        return { success: true, deleted: op.ids.length };
      } catch (e) {
        return { success: false, error: `bulkDelete failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case 'clearNamespace': {
      const ns = op.namespace;
      if (!ns) {
        return { success: false, error: 'clearNamespace requires namespace' };
      }
      try {
        // ADR-0086 B2: clearNamespace was missing from router switch
        await storage.clearNamespace(ns);
        return { success: true, cleared: true, namespace: ns };
      } catch (e) {
        return { success: false, error: `clearNamespace failed: ${e instanceof Error ? e.message : String(e)}` };
      }
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
 * ADR-0085: Try local registry first, fall back to intercept pool.
 *
 * Both paths read from the same ControllerRegistry singleton instantiated by
 * initControllerRegistry(). controller-intercept does NOT create its own
 * registry — it accesses the one the router bootstrapped. The fallback exists
 * only for the case where initControllerRegistry() failed or hasn't run yet
 * (e.g. neural.enabled=false), not as an independent controller source.
 */
export async function getController<T = unknown>(name: string): Promise<T | undefined> {
  // ADR-0090 Tier B5 fix + ADR-0170 Phase C.3: MCP tool handlers
  // (agentdb_reflexion_store, agentdb_skill_create, etc.) call
  // `getController` as the first memory-router touch-point in a fresh
  // CLI process. Without `ensureRegistry()`, `_registryInstance` is null
  // and we fall straight through to `intercept.getExisting`, which
  // returns undefined because nothing has populated the pool yet. Every
  // controller-specific tool would return `"<Controller> not available"`
  // — observed across all 15 Tier B5 verifiers before this fix.
  //
  // ADR-0170 Phase C.3 upgrades this from `ensureRouter()` (storage-only)
  // to `ensureRegistry()` because `getController` is the canonical
  // agentdb_* axis touch-point — memory_*-axis routes don't reach this
  // function. `ensureRegistry` is idempotent (short-circuits on
  // `_registryInitialized`) and inexpensive after first init.
  try { await ensureRegistry(); } catch { /* init failed; falls through below */ }
  // Primary: router-local registry (populated by initControllerRegistry)
  if (_registryInstance && typeof _registryInstance.get === 'function') {
    try {
      const ctrl = _registryInstance.get(name);
      if (ctrl) return ctrl as T;
    } catch { /* fall through to intercept */ }
  }
  // ADR-0090 Tier B5 fix: if the registry is up but doesn't have this
  // name yet, wait for deferred init to finish. Level 2+ controllers
  // (reflexion, skills, causalGraph, etc. — 13 of 15 B5 targets)
  // register lazily in the background; MCP tool handlers that resolve
  // them directly (agentdb_reflexion_store, agentdb_skill_create, etc.)
  // would otherwise race the deferred init and get undefined.
  if (_registryInstance && typeof _registryInstance.waitForDeferred === 'function') {
    try {
      await _registryInstance.waitForDeferred();
      if (typeof _registryInstance.get === 'function') {
        const ctrl = _registryInstance.get(name);
        if (ctrl) return ctrl as T;
      }
    } catch { /* deferred init failed; fall through to intercept */ }
  }
  // Fallback: controller-intercept reads from the same shared registry.
  // Only reached when _registryInstance is null (init failed / neural disabled).
  const intercept = await loadIntercept();
  if (intercept?.getExisting) {
    return intercept.getExisting(name) as T | undefined;
  }
  return undefined;
}

/**
 * ADR-0181 Phase 7 r2: live BetterSqlite3.Database handle from the
 * cli's ControllerRegistry-owned AgentDB instance.
 *
 * Forces lazy `ensureRegistry()` init (which constructs AgentDB and runs
 * `loadSchemas()`, creating `<projectRoot>/.swarm/memory.db`), then
 * returns the same `database` handle the carve-out controllers
 * (ReflexionMemory, SkillLibrary, HierarchicalMemory) write to.
 *
 * Used by `archivist-init.ts` `ensureSqliteWired()` to share ONE handle
 * with the controllers — eliminates the startup-ordering bug from the r1
 * path-repoint, where ensureSqliteWired ran before AgentDB.initialize had
 * created the file. Sharing the handle also avoids a second
 * file-descriptor + prepared-statement cache + cross-handle
 * BEGIN-IMMEDIATE serialization risk.
 *
 * Throws loud (`feedback-no-fallbacks`) if registry init failed, if no
 * AgentDB instance exists on the registry, or if the AgentDB instance
 * has no `database` field (which would mean AgentDB chose a backend
 * other than better-sqlite3 — a config bug, not a recoverable state).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getControllerRegistryAgentDb(): Promise<any> {
  await ensureRegistry();
  if (!_registryInstance) {
    throw new Error(
      'memory-router: getControllerRegistryAgentDb — ControllerRegistry is not ' +
        'initialized after ensureRegistry() returned. Either neural is disabled ' +
        '(config.neural.enabled === false) or registry init silently bailed. ' +
        '(ADR-0181 Phase 7)',
    );
  }
  if (typeof _registryInstance.getAgentDB !== 'function') {
    throw new Error(
      'memory-router: getControllerRegistryAgentDb — _registryInstance.getAgentDB ' +
        'is not a function. ControllerRegistry public surface changed; update this ' +
        'accessor to match. (ADR-0181 Phase 7)',
    );
  }
  const agentdb = _registryInstance.getAgentDB();
  if (!agentdb) {
    throw new Error(
      'memory-router: getControllerRegistryAgentDb — ControllerRegistry.getAgentDB() ' +
        'returned null/undefined. AgentDB.initialize() may have failed silently inside ' +
        'the registry init path. (ADR-0181 Phase 7)',
    );
  }
  if (!agentdb.database) {
    throw new Error(
      'memory-router: getControllerRegistryAgentDb — registry.getAgentDB().database ' +
        'is missing. AgentDB chose a backend other than better-sqlite3 (e.g. WASM-SQLite, ' +
        'postgres) — that is a config bug, not a recoverable state. (ADR-0181 Phase 7)',
    );
  }
  return agentdb.database;
}

/**
 * Check if a controller exists in the pool.
 * Same shared-singleton contract as getController — see its JSDoc.
 */
export async function hasController(name: string): Promise<boolean> {
  if (_registryInstance && typeof _registryInstance.has === 'function') {
    try { if (_registryInstance.has(name)) return true; } catch { /* fall through */ }
  }
  // Shared registry fallback (init failed / neural disabled)
  const intercept = await loadIntercept();
  if (intercept?.has) return intercept.has(name);
  return false;
}

/**
 * List all registered controller names and info.
 * Same shared-singleton contract as getController — see its JSDoc.
 *
 * ADR-0090 Tier B5 fix: ensure the router is initialized before querying
 * the registry. Previously this function was called directly by the
 * `agentdb_controllers` / `agentdb_health` MCP handlers, which don't
 * themselves touch `ensureRouter()` — so on a cold `cli mcp exec
 * --tool agentdb_controllers` invocation, `_registryInstance` was null
 * and the intercept pool was empty, returning `[]` even though the
 * controllers had been initialized on a prior memory op. The 12-agent
 * B5 swarm (2026-04-16) observed `controllers: 0, active: 0` for every
 * controller across every cold invocation and traced the gap here.
 * Calling `ensureRouter()` is idempotent and inexpensive after first
 * init (short-circuits on `_initialized`).
 */
export async function listControllerInfo(): Promise<unknown[]> {
  // ADR-0170 Phase C.3: agentdb_*-axis route — needs full registry init,
  // not just storage. `agentdb_controllers` MCP tool calls this directly.
  try { await ensureRegistry(); } catch { /* surface via empty list below */ }
  if (_registryInstance && typeof _registryInstance.listControllers === 'function') {
    try {
      const controllers = _registryInstance.listControllers();
      if (Array.isArray(controllers)) {
        return controllers.map((c: { name: string; enabled?: boolean }) => ({ name: c.name ?? c, enabled: c.enabled ?? true }));
      }
    } catch { /* fall through */ }
  }
  // Shared registry fallback (init failed / neural disabled)
  const intercept = await loadIntercept();
  if (intercept?.listControllers) {
    const names = intercept.listControllers();
    return names.map(name => ({ name, enabled: true }));
  }
  return [];
}

/**
 * Wait for deferred (Level 2+) controller initialization.
 *
 * ADR-0090 Tier B5 fix (2026-04-16): the prior implementation only
 * delegated to `controller-intercept.waitForDeferred()` which does NOT
 * exist on the intercept module (it only exposes the singleton pool
 * — getOrCreate / getExisting / listControllers). The net effect was
 * a silent no-op: callers assumed Level 2+ controllers (reflexion,
 * skills, causalGraph, causalRecall, learningSystem, memoryConsolidation,
 * attentionService, gnnService, semanticRouter, graphAdapter,
 * sonaTrajectory, nightlyLearner, explainableRecall — 13 of 15 B5
 * controllers) were init'd, but only Level 0-1 had actually landed.
 * The B5 swarm verifiers observed `"<Controller> not available"` for
 * every Level 2+ tool invocation because deferred init never completed
 * by the time the MCP handler tried to resolve the controller.
 *
 * Correct behavior: ensure the router is up (to instantiate the
 * registry), then await the registry instance's own `waitForDeferred()`.
 * That promise resolves when ALL deferred levels (2-6) finish
 * initController() calls — at which point `getController('reflexion')`
 * etc. will return the real controller via the agentdb fallback in
 * ControllerRegistry.get.
 */
export async function waitForDeferred(): Promise<void> {
  // ADR-0170 Phase C.3: agentdb_*-axis route — needs full registry init.
  try { await ensureRegistry(); } catch { /* registry will stay null; fall through */ }
  if (_registryInstance && typeof _registryInstance.waitForDeferred === 'function') {
    try {
      await _registryInstance.waitForDeferred();
    } catch { /* deferred init failed — controllers that depend on it will surface via getController falling back to intercept.getExisting → null */ }
    return;
  }
  // Legacy fallback: if a future intercept module grows a waitForDeferred
  // export, honor it. Current controller-intercept.ts does not expose
  // one — kept for forward compatibility.
  const intercept = await loadIntercept();
  if (intercept && typeof (intercept as Record<string, unknown>).waitForDeferred === 'function') {
    await (intercept as Record<string, (...args: unknown[]) => Promise<void>>).waitForDeferred();
  }
}

/**
 * Controller health check.
 * Same shared-singleton contract as getController — see its JSDoc.
 *
 * ADR-0090 Tier B5 fix: call `ensureRouter()` so the registry is
 * populated even on a cold `cli mcp exec --tool agentdb_health`
 * invocation. See listControllerInfo() for the full rationale.
 */
export async function healthCheck(): Promise<unknown> {
  // ADR-0170 Phase C.3: agentdb_*-axis route — `agentdb_health` MCP tool.
  try { await ensureRegistry(); } catch { /* surface via "available: false" below */ }
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

  switch (op.type) {
    // ADR-0086 T2.4: Embedding ops route through adapter directly
    case 'generate': {
      try {
        const adapter = await import('@claude-flow/memory/embedding-adapter' as string);
        return { success: true, ...(await adapter.generateEmbedding(op.text, op.data)) };
      } catch (e) {
        return { success: false, error: `generate failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'generateBatch': {
      try {
        const adapter = await import('@claude-flow/memory/embedding-adapter' as string);
        return { success: true, ...(await adapter.generateBatchEmbeddings(op.texts, op.data)) };
      } catch (e) {
        return { success: false, error: `generateBatch failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'loadModel': {
      try {
        const adapter = await import('@claude-flow/memory/embedding-adapter' as string);
        return { success: true, ...(await adapter.loadEmbeddingModel(op.data)) };
      } catch (e) {
        return { success: false, error: `loadModel failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'getThreshold': {
      try {
        const adapter = await import('@claude-flow/memory/embedding-adapter' as string);
        return { success: true, threshold: await adapter.getAdaptiveThreshold(op.data as number | undefined) };
      } catch (e) {
        return { success: false, error: `getThreshold failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    // ADR-0086 Phase 3: HNSW ops via RvfBackend (IStorageContract)
    case 'hnswSearch': {
      if (!_storage) return { success: false, error: 'Storage not initialized' };
      try {
        const vec = op.vector instanceof Float32Array ? op.vector
          : new Float32Array(op.vector as number[]);
        const results = await _storage.search(vec, { k: op.k || op.limit || 10 });
        return { success: true, results, total: results.length };
      } catch (e) {
        return { success: false, error: `hnswSearch failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'hnswStatus': {
      if (!_storage) return { success: false, error: 'Storage not initialized' };
      try {
        const stats = await _storage.getStats();
        return { success: true, ...stats };
      } catch (e) {
        return { success: false, error: `hnswStatus failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'hnswAdd': {
      return { success: false, error: 'Direct HNSW add not supported — entries are indexed automatically on store()' };
    }
    case 'hnswGet': case 'hnswClear': case 'hnswRebuild': {
      return { success: false, error: 'Direct HNSW manipulation not supported — index is managed by RvfBackend. Use routeMemoryOp for data operations.' };
    }
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
  // ADR-0170 Phase C.3: pattern ops touch reasoningBank controller —
  // requires the full registry init, not just storage.
  await ensureRegistry();

  switch (op.type) {
    case 'store': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reasoningBank = await getController<any>('reasoningBank');
      const patternId = generateId('pattern');

      // OPT-001: Probe for callable store method across binding patterns.
      // Prefer `storePattern` over `store`/`add` — the agentdb v3
      // ReasoningBank controller exposes only `storePattern`, and its
      // schema shape (`{taskType, approach, successRate, ...}`) does
      // NOT match the legacy `{content, type, confidence}` shape. ADR-0090
      // Tier B5 verifier (reasoningBank) traced a NOT-NULL constraint
      // failure on `reasoning_patterns.task_type` to this exact mismatch:
      // every call was silently failing, 0 rows landed. Map the fields
      // when we hit `storePattern` so the write actually lands in
      // `reasoning_patterns`. If a future controller re-introduces a
      // legacy `store(obj)` or `add(obj)` shape, those paths still get
      // the unchanged legacy payload.
      const storePatternFn = getCallableMethod(reasoningBank, 'storePattern');
      if (storePatternFn) {
        try {
          await storePatternFn({
            taskType: op.patternType || 'general',
            approach: op.pattern || '',
            successRate: op.confidence ?? 1.0,
            tags: op.patternType ? [op.patternType] : undefined,
            metadata: op.metadata,
          });
          return { success: true, patternId, controller: 'reasoningBank' };
        } catch (e: unknown) {
          return { success: false, patternId: '', controller: '', error: e instanceof Error ? e.message : String(e) };
        }
      }
      const storeFn = getCallableMethod(reasoningBank, 'store', 'add');
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

      // ADR-0112 Phase 1: no silent fallback to RVF when reasoningBank
      // lacks both `storePattern` and `store`/`add`. The caller invoked an
      // AgentDB pattern-store tool; routing that write to RVF's `pattern`
      // namespace violates the per-store partition (cross-store coordination
      // is forbidden — ADR-0086 §Debt 15 + ADR-0112 §Decision). Fail loud.
      return {
        success: false,
        patternId: '',
        controller: '',
        error: 'reasoningBank controller missing both storePattern and store/add methods — pattern store unavailable. Per ADR-0112, no silent fallback to RVF (cross-store coordination forbidden).',
      };
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
              // agentdb's ReasoningPattern carries the pattern text in `approach`
              // (schema: {taskType, approach, successRate, ...}); the legacy shape
              // used `content`/`pattern`. Probe all three so the marker text is
              // surfaced regardless of which controller version answered.
              content: r.content || r.pattern || r.approach || '',
              // Likewise the score field: agentdb returns `similarity` from the
              // SQL fallback path and `successRate` from the pattern row.
              score: r.score ?? r.confidence ?? r.similarity ?? r.successRate ?? 0,
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
  // ADR-0170 Phase C.3: feedback ops touch learningSystem/reasoningBank
  // controllers — requires the full registry init, not just storage.
  await ensureRegistry();

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
  // ADR-0170 Phase C.3: session ops touch reflexion/nightlyLearner
  // controllers — requires the full registry init, not just storage.
  await ensureRegistry();

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
  // ADR-0170 Phase C.3: learning ops touch selfLearningRvfBackend +
  // memoryConsolidation controllers — requires the full registry init,
  // not just storage.
  await ensureRegistry();

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
  // ADR-0170 Phase C.3: reflexion ops touch reflexion controller —
  // requires the full registry init, not just storage.
  await ensureRegistry();

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
  // ADR-0170 Phase C.3: causal ops touch causalGraph/causalRecall
  // controllers — requires the full registry init, not just storage.
  await ensureRegistry();

  switch (op.type) {
    case 'edge': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const causalGraph = await getController<any>('causalGraph');
      // TODO ADR-0147 R7: deferred — controller exposes addCausalEdge(edge:
      // CausalEdge) where CausalEdge requires NUMERIC fromMemoryId/toMemoryId
      // and a fixed memoryType enum ('episode'|'skill'|'note'|'fact'). The
      // router receives STRING ADR keys (e.g. "ADR-0147→ADR-0167") and has
      // no machinery to allocate, persist, or look up numeric IDs for them.
      // Wiring this requires:
      //   1. an ADR-key→numeric-id allocator with a durable mapping table,
      //   2. extending the memoryType enum (or registering ADRs as a new
      //      memory class) — agentic-flow side change, not just router,
      //   3. registering the mapping with NodeIdMapper at write time AND
      //      restoring it at read time (NodeIdMapper is in-process, not
      //      persisted).
      // That's substantial new infrastructure across two packages. Until
      // that lands, the addEdge() check below is intentionally false (the
      // controller has no addEdge method, only addCausalEdge with the
      // wrong-shape contract), and writes go through the namespace
      // fallback, which IS correct end-to-end with R6's read-arm fix.
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

      // Fallback: store edge as memory entry via router.
      // Bug-3 (2026-05-05): set upsert:true so re-recording shared (src,dst)
      // edges with different relation/weight succeeds via overwrite instead
      // of tripping the ADR-0094 RC-2 idempotency guard. Mid-batch failures
      // were caused by this guard rejecting later same-pair edges with a
      // different payload, then orchestration laundering the rejection into
      // the misleading "AgentDB not available" sentinel two layers up.
      try {
        const result = await routeMemoryOp({
          type: 'store',
          key: `${op.sourceId}\u2192${op.targetId}`,
          value: JSON.stringify({ sourceId: op.sourceId, targetId: op.targetId, relation: op.relation, weight: op.weight }),
          namespace: 'causal-edges',
          upsert: true,
        });
        return result.success
          ? { success: true, controller: 'router-fallback' }
          : { success: false, error: result.error || 'Causal edge recording unavailable' };
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : 'Causal edge recording unavailable' };
      }
    }
    case 'query': {
      // Bug-4 (ADR-0147 Refinement 3, 2026-05-06): always-merge controller +
      // namespace fallback. The earlier Bug-2 fix at 71b2ad33e returned
      // controller results immediately when controller.length > 0, falling
      // through only on empty. Probe in ADR-0147 §"Bug 4" found that the
      // agentic-flow CausalMemoryGraph controller is called with WRONG
      // argument shapes (string ADR keys instead of numeric memory IDs +
      // CausalQuery struct). queryCausalEffects("ADR-X", k) happens to match
      // 1 stale row by accident; getCausalChain("ADR-Y", k) returns [] and
      // falls through correctly. Asymmetry → cause= queries under-report.
      // Fix: always merge controller + fallback, dedupe by (src,dst,relation)
      // triple. Defense-in-depth: even if the controller is later corrected,
      // supplementing with the fallback protects against future asymmetric
      // breakage. Mirrors the supplement-instead-of-replace pattern from
      // Refinement 1 (rvf-backend orphan-numId).
      type ParsedEdge = { sourceId?: string; targetId?: string; relation?: string; weight?: number };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const causalGraph = await getController<any>('causalGraph');
      const k = op.k ?? 10;
      let controllerResults: ParsedEdge[] = [];
      if (causalGraph) {
        try {
          const getEffectsFn = typeof causalGraph.queryCausalEffects === 'function' ? causalGraph.queryCausalEffects.bind(causalGraph)
            : typeof causalGraph.getEffects === 'function' ? causalGraph.getEffects.bind(causalGraph) : null;
          const getCausesFn = typeof causalGraph.getCausalChain === 'function' ? causalGraph.getCausalChain.bind(causalGraph)
            : typeof causalGraph.getCauses === 'function' ? causalGraph.getCauses.bind(causalGraph) : null;
          let raw: unknown[] = [];
          if (op.cause && getEffectsFn) {
            raw = await getEffectsFn(op.cause, k) as unknown[];
          } else if (op.effect && getCausesFn) {
            raw = await getCausesFn(op.effect, k) as unknown[];
          }
          if (Array.isArray(raw)) {
            controllerResults = raw as ParsedEdge[];
          }
        } catch { /* fall through to namespace read */ }
      }
      // Always also run namespace-list fallback. Was conditional on controller
      // returning empty in Bug-2; ADR-0147 §"Bug 4" Refinement 3 makes this
      // unconditional so the controller can't short-circuit and hide outbound
      // edges that only the namespace path knows about.
      //
      // ADR-0147 R6 (2026-05-06): the previous fixed `Math.max(k * 4, 100)`
      // limit was invisible past the first 100 entries because rvf-backend's
      // query() iterates Map insertion order (not k-relative) and there was
      // no keyPrefix filter pushed into storage. Two-shape fix:
      //   - cause= queries: keys are `${sourceId}→${targetId}`, so source
      //     IS the key prefix. Push it down → O(matches), not O(namespace).
      //   - effect= queries: target is the key SUFFIX, so prefix-filtering
      //     can't help. Size the limit to the full namespace count so the
      //     scan covers every edge before client-side filtering.
      let fallbackResults: ParsedEdge[] = [];
      try {
        const listOp: MemoryOp = {
          type: 'list',
          namespace: 'causal-edges',
          limit: Math.max(k * 4, 100),
        };
        if (op.cause) {
          listOp.keyPrefix = `${op.cause}→`;
        } else if (op.effect) {
          // Suffix-encoded — must scan full namespace. count() returns the
          // exact size; cap modestly so a runaway namespace doesn't materialize
          // millions of entries in memory. The router's count op is O(N) on
          // the entries map but doesn't materialize them.
          const countResult = await routeMemoryOp({
            type: 'count',
            namespace: 'causal-edges',
          });
          const countShape = countResult as unknown as { count?: number };
          const nsSize = typeof countShape.count === 'number' ? countShape.count : 0;
          // Hard ceiling at 100k entries. Past that, the suffix-scan strategy
          // is itself the wrong shape — it's a separate, larger problem
          // (would need a reverse-key index in the storage layer).
          listOp.limit = Math.max(Math.min(nsSize, 100_000), Math.max(k * 4, 100));
        }
        const fallback = await routeMemoryOp(listOp);
        // Bug-2 follow-up: MemoryEntry storage shape uses `content`, not
        // `value`. Defense-in-depth: if value-parse yields no source/target
        // fields, fall back to parsing the arrow-encoded key
        // (`${sourceId}→${targetId}`).
        const entries = ((fallback as { entries?: Array<{ content?: string; key?: string }> }).entries
          ?? (fallback as { results?: Array<{ content?: string; key?: string }> }).results
          ?? []) as Array<{ content?: string; key?: string }>;
        fallbackResults = entries.map((e): ParsedEdge => {
          let edge: ParsedEdge | null = null;
          try { edge = typeof e.content === 'string' ? JSON.parse(e.content) : null; }
          catch { edge = null; }
          if (!edge || (!edge.sourceId && !edge.targetId)) {
            const ek = e.key ?? '';
            const arrowIdx = ek.indexOf('→');
            if (arrowIdx > 0) {
              edge = {
                sourceId: ek.slice(0, arrowIdx),
                targetId: ek.slice(arrowIdx + 1),
                ...(edge ?? {}),
              };
            }
          }
          return edge ?? {};
        });
      } catch { /* leave fallbackResults empty; both empty → return [] below */ }
      // Merge controller + fallback, then filter and dedupe by
      // (sourceId, targetId, relation) triple. Triple-keyed dedupe means two
      // edges with same endpoints but different relation labels both survive
      // (e.g. a "supersedes" and a "depends-on" between the same pair).
      const seen = new Set<string>();
      const merged: ParsedEdge[] = [];
      const tripleKey = (e: ParsedEdge): string => `${e.sourceId ?? ''}|${e.targetId ?? ''}|${e.relation ?? ''}`;
      for (const e of [...controllerResults, ...fallbackResults]) {
        if (!e.sourceId && !e.targetId) continue;
        if (op.cause && e.sourceId !== op.cause) continue;
        if (op.effect && e.targetId !== op.effect) continue;
        const tk = tripleKey(e);
        if (seen.has(tk)) continue;
        seen.add(tk);
        merged.push(e);
      }
      const controllerName = controllerResults.length > 0
        ? (fallbackResults.length > 0 ? 'causalGraph+fallback' : 'causalGraph')
        : 'router-fallback';
      return { success: true, results: merged.slice(0, k), controller: controllerName };
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
// ADR-0111 W1.5 — letter F prep: enumerate-embeddings primitive
// ---------------------------------------------------------------------------

/**
 * Enumerate all stored embeddings via the RVF backend.
 *
 * ADR-0111 W1.5 — replaces upstream's SQLite-shaped `bridgeGetAllEmbeddings`
 * with an RVF-primary primitive. Letter F's RaBitQ index construction will
 * call this to materialize a snapshot of every stored vector.
 *
 * Per project-rvf-primary, this reads directly from the RvfBackend's
 * in-memory `entries` map (the canonical source of truth) — NOT from any
 * SQLite `memory_entries` table. Bypasses the registry entirely; this is
 * the storage-layer surface, not a controller op.
 *
 * @param options.dimensions Filter to embeddings of this length (default
 *                           768, matching reference-embedding-model.md
 *                           `Xenova/all-mpnet-base-v2`).
 * @param options.limit      Max results (default 50000 — matches upstream
 *                           bridgeGetAllEmbeddings).
 * @param options.dbPath     Reserved for future per-DB targeting; currently
 *                           ignored — operations use the active router
 *                           storage.
 *
 * @returns Array of embeddings or `null` when storage is unavailable
 *          (genuinely fatal under Model 1, but kept nullable to preserve
 *          the upstream signature shape for letter F's adoption).
 */
export async function routerGetAllEmbeddings(options: {
  dimensions?: number;
  limit?: number;
  dbPath?: string;
} = {}): Promise<Array<{
  id: string;
  key: string;
  namespace: string;
  embedding: number[];
}> | null> {
  await ensureRouter();
  if (!_storage) {
    // Under ADR-0111 W1.5 Model 1 this should not happen — ensureRouter
    // either succeeds or throws. Returning null preserves the upstream
    // signature for letter F adoption; log so the regression is visible.
    console.error('[routerGetAllEmbeddings] storage unavailable after ensureRouter()');
    return null;
  }

  const dimensions = options.dimensions ?? 768;
  const limit = options.limit ?? 50_000;

  // RvfBackend exposes enumerateEmbeddings() as an extension method beyond
  // IStorageContract. Cast and feature-check so non-RVF backends (none
  // exist in production today, but the type allows for it) degrade safely.
  const storage = _storage as IStorageContract & {
    enumerateEmbeddings?: (opts: { dimensions?: number; limit?: number }) => Promise<Array<{
      id: string;
      key: string;
      namespace: string;
      embedding: number[];
    }>>;
  };

  if (typeof storage.enumerateEmbeddings !== 'function') {
    console.error('[routerGetAllEmbeddings] active storage does not implement enumerateEmbeddings');
    return null;
  }

  return storage.enumerateEmbeddings({ dimensions, limit });
}

// ---------------------------------------------------------------------------
// ADR-0086 Phase 3: _wrap delegates + loadAllFns deleted.
// Embedding functions re-exported from adapter.
// HNSW managed internally by RvfBackend.
// ---------------------------------------------------------------------------

// Embedding re-exports (ADR-0086 Phase 3: from adapter, not initializer)
async function _loadAdapter() {
  return import('@claude-flow/memory/embedding-adapter' as string);
}
export const loadEmbeddingModel = async (...args: unknown[]) => (await _loadAdapter()).loadEmbeddingModel(...(args as [any]));
export const generateEmbedding = async (...args: unknown[]) => (await _loadAdapter()).generateEmbedding(...(args as [any, any]));
export const generateBatchEmbeddings = async (...args: unknown[]) => (await _loadAdapter()).generateBatchEmbeddings(...(args as [any, any]));
export const getAdaptiveThreshold = async (...args: unknown[]) => (await _loadAdapter()).getAdaptiveThreshold(...(args as [any]));

// ---------------------------------------------------------------------------
// Shutdown + Reset
// ---------------------------------------------------------------------------

/**
 * Shutdown the router and release resources.
 * ADR-0085: Shuts down local ControllerRegistry + controller-intercept pool.
 */
export async function shutdownRouter(): Promise<void> {
  // ADR-0086 T2.5: Shutdown RvfBackend storage
  if (_storage) {
    try {
      await _storage.shutdown();
    } catch { /* best-effort */ }
  }
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
  _storage = null;
  _interceptMod = null;
  _initialized = false;
  _initPromise = null;
  _initFailed = false; // ADR-0086 I2: allow retry after reset
  // ADR-0085: Reset registry state
  _registryInstance = null;
  _registryPromise = null;
  _registryAvailable = null;
  _exitHookRegistered = false;
  // ADR-0170 Phase C.3: reset the new split-init flags so a subsequent
  // ensureRegistry() rebuilds the registry from scratch.
  _registryInitialized = false;
  _registryInitPromise = null;
  _registryInitFailed = false;
  // ADR-0094 Sprint 1.4 (d6): clear lockPath so a subsequent init
  // recaptures it from the (possibly new) storage config.
  _lockPath = null;
  // ADR-0156: clear captured databasePath so a subsequent init reports
  // the freshly-resolved path, not a stale one.
  _databasePath = null;
}

/**
 * ADR-0156: return the resolved canonical RVF database path that the
 * router opened during `_doInit`. Returns `null` if `ensureRouter()` has
 * not been called yet, OR if the router has been reset.
 *
 * Replaces the hardcoded `.swarm/memory.db` lie at
 * `commands/memory.ts:1299`. Honest source of truth: the path the
 * storage actually opened, not the user's `--backend` flag echo or a
 * compile-time default.
 */
export function getActiveBackendPath(): string | null {
  return _databasePath;
}

/**
 * ADR-0156: return the canonical sibling-file paths that `--force` would
 * unlink for the active backend. Useful for the pre-deletion print and
 * for tests that want to assert the enumerated set without re-deriving
 * it from the constant. Returns empty array for ephemeral backends
 * (`:memory:`) or before init.
 */
export function getActiveSiblingPaths(): string[] {
  if (!_databasePath || _databasePath === ':memory:') return [];
  return RVF_CANONICAL_EXTENSIONS.map((ext) => _databasePath + ext);
}

/**
 * ADR-0181 Phase 4: read access to the active RVF storage instance, for the
 * cli archivist init path's `MemoryRvfAdapter` construction
 * (`memory/archivist-init.ts`). At runtime `_storage` is the
 * `@claude-flow/memory` `RvfBackend` that the adapter's `IMemoryRvfBackend`
 * surface is structurally typed against — the cli's archivist `rvfBackend`
 * slot is wired by passing this instance directly into the adapter
 * constructor (no cast-lie, no double-open of the underlying `.rvf` file).
 *
 * Throws if called before `ensureRouter()` has completed — the caller
 * (`initProcessArchivist`) is responsible for awaiting `ensureRouter()`
 * first; an undefined-storage state here is a contract violation, not a
 * fallback case (`feedback-no-fallbacks`).
 */
export function getStorageInstance(): IStorageContract {
  if (!_storage) {
    throw new Error(
      'memory-router: getStorageInstance() called before ensureRouter() ' +
        'completed (storage is null). Await ensureRouter() first.',
    );
  }
  return _storage;
}
