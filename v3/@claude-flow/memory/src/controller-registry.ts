/**
 * ControllerRegistry - Central controller lifecycle management for AgentDB v3
 *
 * Wraps the AgentDB class and adds CLI-specific controllers from @claude-flow/memory.
 * Manages initialization (level-based ordering), health checks, and graceful shutdown.
 *
 * Per ADR-053: Replaces memory-initializer.js's raw sql.js usage with a unified
 * controller ecosystem routing all memory operations through AgentDB v3.
 *
 * @module @claude-flow/memory/controller-registry
 */

import { EventEmitter } from 'node:events';
import type {
  IMemoryBackend,
  HealthCheckResult,
  ComponentHealth,
  BackendStats,
  EmbeddingGenerator,
  SONAMode,
} from './types.js';
import { LearningBridge } from './learning-bridge.js';
import type { LearningBridgeConfig } from './learning-bridge.js';
import { MemoryGraph } from './memory-graph.js';
import type { MemoryGraphConfig } from './memory-graph.js';
import { TieredCacheManager } from './cache-manager.js';
import type { CacheConfig } from './types.js';
import { getConfig } from './resolve-config.js';
import { getPipeline } from './embedding-pipeline.js';
import { getOrCreate } from './controller-intercept.js';

// ===== ADR-0049: Fail-Loud Error Classes =====

/** Thrown when a controller factory fails during initialization (strict mode) */
export class ControllerInitError extends Error {
  controllerName: string;
  override cause: Error;
  constructor(controllerName: string, cause: Error) {
    super(`Controller '${controllerName}' failed to initialize: ${cause.message}`);
    this.name = 'ControllerInitError';
    this.controllerName = controllerName;
    this.cause = cause;
  }
}

/** ADR-0049: strict mode — throws on factory/bridge failures instead of returning null */
const STRICT_MODE = process.env.CLAUDE_FLOW_STRICT !== 'false';

// ===== Types =====

/**
 * Controllers accessible via AgentDB.getController()
 */
export type AgentDBControllerName =
  | 'reasoningBank'
  | 'skills'
  | 'reflexion'
  | 'causalGraph'
  | 'causalRecall'
  | 'learningSystem'
  | 'explainableRecall'
  | 'nightlyLearner'
  | 'mutationGuard'
  | 'attestationLog'
  | 'vectorBackend'
  | 'graphAdapter'
  | 'selfLearningRvfBackend'   // A6 - composite parent
  | 'nativeAccelerator'        // B4 - shared singleton
  | 'quantizedVectorStore'     // B9 - composite parent
  | 'selfAttention'            // A1 - ADR-0044
  | 'crossAttention'           // A2 - ADR-0044
  | 'multiHeadAttention'       // A3 - ADR-0044
  | 'attentionService'         // A5
  | 'enhancedEmbeddingService' // A9
  | 'federatedLearningManager' // A11
  | 'queryOptimizer'
  | 'auditLogger';

/**
 * CLI-layer controllers (from @claude-flow/memory or new)
 */
export type CLIControllerName =
  | 'learningBridge'
  | 'memoryGraph'
  | 'agentMemoryScope'
  | 'tieredCache'
  | 'semanticRouter'
  | 'sonaTrajectory'
  | 'hierarchicalMemory'
  | 'memoryConsolidation'
  | 'batchOperations'
  | 'contextSynthesizer'
  | 'gnnService'
  | 'rvfOptimizer'
  | 'mmrDiversityRanker'
  | 'guardedVectorBackend'
  | 'solverBandit'
  | 'attentionMetrics'
  | 'selfAttention'
  | 'crossAttention'
  | 'multiHeadAttention'
  | 'attentionService'
  | 'flashAttentionService'
  | 'moeAttentionService'
  | 'nativeAccelerator'
  | 'selfLearningRvfBackend'
  | 'federatedLearningManager'
  | 'enhancedEmbeddingService'
  | 'quantizedVectorStore'
  | 'resourceTracker'
  | 'rateLimiter'
  | 'metadataFilter'             // B5
  | 'queryOptimizer'             // B6
  | 'indexHealthMonitor'         // B3
  | 'auditLogger'               // D3
  | 'telemetryManager'           // D1
  | 'circuitBreaker';

/**
 * All controller names
 */
export type ControllerName = AgentDBControllerName | CLIControllerName;

/**
 * Initialization level for dependency ordering
 */
export interface InitLevel {
  level: number;
  controllers: ControllerName[];
}

// ===== ADR-0041: 7-step integration template helper =====

/**
 * Descriptor for a new controller integration. Used by {@link validateControllerIntegration}
 * to verify all 7 steps of the ADR-0041 wiring protocol are satisfied.
 */
export interface ControllerIntegrationDescriptor {
  /** Controller name (must be in AgentDBControllerName or CLIControllerName union) */
  name: string;
  /** Init level (0-6) where the controller should be registered */
  level: number;
  /** Whether isControllerEnabled() has a case for this name */
  hasEnableCheck: boolean;
  /** Whether createController() has a factory case for this name */
  hasFactory: boolean;
  /** Whether a bridge function exists in memory-bridge.ts */
  hasBridgeFunction: boolean;
  /** Whether an MCP tool is registered for this controller */
  hasMcpTool: boolean;
}

/**
 * ADR-0041 7-step integration checklist validator.
 *
 * Validates that a new controller follows all 7 required steps:
 *  1. Added to ControllerName type union
 *  2. Added to INIT_LEVELS at appropriate level
 *  3. Added to isControllerEnabled() switch
 *  4. Added to createController() factory
 *  5. Bridge function(s) in memory-bridge.ts
 *  6. MCP tool(s) in agentdb-tools.ts
 *  7. TypeScript check passes (caller responsibility)
 *
 * @returns Array of missing steps (empty = all steps complete)
 */
export function validateControllerIntegration(
  desc: ControllerIntegrationDescriptor,
): string[] {
  const missing: string[] = [];

  // Step 1: Name in type union (checked via INIT_LEVELS membership as proxy)
  const allRegistered = INIT_LEVELS.flatMap((l) => l.controllers);
  if (!allRegistered.includes(desc.name as ControllerName)) {
    missing.push(`Step 1: '${desc.name}' not in ControllerName type union`);
  }

  // Step 2: In INIT_LEVELS at declared level
  const levelEntry = INIT_LEVELS.find((l) => l.level === desc.level);
  if (!levelEntry || !levelEntry.controllers.includes(desc.name as ControllerName)) {
    missing.push(`Step 2: '${desc.name}' not in INIT_LEVELS at level ${desc.level}`);
  }

  // Step 3: Enable check
  if (!desc.hasEnableCheck) {
    missing.push(`Step 3: '${desc.name}' missing isControllerEnabled() case`);
  }

  // Step 4: Factory
  if (!desc.hasFactory) {
    missing.push(`Step 4: '${desc.name}' missing createController() factory case`);
  }

  // Step 5: Bridge function
  if (!desc.hasBridgeFunction) {
    missing.push(`Step 5: '${desc.name}' missing bridge function in memory-bridge.ts`);
  }

  // Step 6: MCP tool
  if (!desc.hasMcpTool) {
    missing.push(`Step 6: '${desc.name}' missing MCP tool registration`);
  }

  // Step 7: tsc --noEmit (caller responsibility, cannot check at runtime)

  return missing;
}

/**
 * Individual controller health status
 */
export interface ControllerHealth {
  name: ControllerName;
  status: 'healthy' | 'degraded' | 'unavailable';
  initTimeMs: number;
  error?: string;
}

/**
 * Aggregated health report for all controllers
 */
export interface RegistryHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  controllers: ControllerHealth[];
  agentdbAvailable: boolean;
  initTimeMs: number;
  timestamp: number;
  activeControllers: number;
  totalControllers: number;
}

/**
 * Runtime configuration for controller activation
 */
export interface RuntimeConfig {
  /** Database path for AgentDB */
  dbPath?: string;

  /** Vector dimension (default: resolved from getEmbeddingConfig(), fallback 768) */
  dimension?: number;

  /** Embedding generator function */
  embeddingGenerator?: EmbeddingGenerator;

  /** SQLite pragma configuration (ADR-0069 A1) */
  sqlite?: {
    cacheSize?: number;      // default: -64000 (64MB)
    busyTimeoutMs?: number;  // default: 5000
    journalMode?: string;    // default: 'WAL'
    synchronous?: string;    // default: 'NORMAL'
  };

  /** Memory backend config */
  memory?: {
    learningBridge?: Partial<LearningBridgeConfig>;
    memoryGraph?: Partial<MemoryGraphConfig>;
    tieredCache?: Partial<CacheConfig>;
  };

  /** Neural config */
  neural?: {
    enabled?: boolean;
    modelPath?: string;
    sonaMode?: SONAMode;
  };

  /** Controllers to explicitly enable/disable */
  controllers?: Partial<Record<ControllerName, boolean>>;

  /** AttentionService tuning (ADR-0062 P3-3) */
  attentionService?: {
    numHeads?: number;
    useFlash?: boolean;
    useMoE?: boolean;
    useHyperbolic?: boolean;
  };

  /** MultiHeadAttention tuning (ADR-0062 P3-3) */
  multiHeadAttention?: {
    numHeads?: number;
    topK?: number;
  };

  /** SelfAttention tuning (ADR-0062 P3-3) */
  selfAttention?: {
    topK?: number;
  };

  /** SolverBandit tuning (ADR-0062 P3-3) */
  solverBandit?: {
    costWeight?: number;
    costDecay?: number;
    explorationBonus?: number;
  };

  /** Agent ID for controllers that need one (default: auto-generated) */
  agentId?: string;

  /** RateLimiter tuning */
  rateLimiter?: { maxRequests?: number; windowMs?: number };

  // ADR-0069: wire rateLimiter presets consumer
  /** Per-endpoint rate-limiter presets (auth, tools, memory, files, etc.) */
  rateLimiterPresets?: Record<string, { maxRequests?: number; windowMs?: number }> | null;

  /** QuantizedVectorStore tuning (ADR-0065 P2) */
  quantizedVectorStore?: { type?: string };

  /** CircuitBreaker tuning */
  circuitBreaker?: { failureThreshold?: number; resetTimeoutMs?: number };

  /** Embedding model name (default: 'all-mpnet-base-v2') */
  embeddingModel?: string;

  /** HNSW M parameter — max bi-directional links per node (default: 23) */
  hnswM?: number;

  /** HNSW efConstruction — search width during index build (default: 100) */
  hnswEfConstruction?: number;

  /** HNSW efSearch — search width during query (default: 50) */
  hnswEfSearch?: number;

  /** Max HNSW elements (default: 100000; AgentDB falls back to 10000) */
  maxElements?: number;

  /** Max SQLite memory entries (default: 1000000) — ADR-0069: config-chain capacity */
  maxEntries?: number;

  /** ADR-0069: wire similarityThreshold consumer — vector search threshold (default: 0.7) */
  similarityThreshold?: number;

  /** Swarm data directory relative to project root (default: '.swarm') — ADR-0069: config-chain swarmDir */
  swarmDir?: string;

  /** Backend instance to use (if pre-created) */
  backend?: IMemoryBackend;

  /** ADR-0045: D1 TelemetryManager exporters (default: ['console']) */
  telemetryExporters?: string[];
  /** ADR-0045: A9 EnhancedEmbeddingService providers */
  embeddingProviders?: string[];
  /** ADR-0045: A9 LRU cache max entries */
  embeddingCacheSize?: number;
  /** ADR-0045: A9 batch concurrency limit */
  embeddingBatchConcurrency?: number;
  /** ADR-0045: D3 AuditLogger rotation size (e.g. '10MB') */
  auditRotationSize?: string;
  /** ADR-0045: D3 AuditLogger max rotation files */
  auditRotationFiles?: number;
  /** ADR-0045: D3 AuditLogger format (default: 'soc2') */
  auditFormat?: string;
  /** ADR-0048: Max eager init level (0-1 eager, 2+ deferred). Default: 1 */
  eagerMaxLevel?: number;

  /** NightlyLearner tuning (ADR-0068 W4-1) */
  nightlyLearner?: {
    /** Cron expression for scheduling (default: '0 3 * * *') */
    schedule?: string;
    /** Maximum patterns to consolidate per run (default: 500) */
    maxPatternsPerRun?: number;
    /** Minimum reward threshold to retain a pattern (default: 0.3) */
    rewardThreshold?: number;
    /** Enable EWC++ consolidation (default: true) */
    useEwcConsolidation?: boolean;
    /** EWC lambda importance weight (default: 0.5) */
    ewcLambda?: number;
  };

  /** CausalRecall tuning (ADR-0068 W4-1) */
  causalRecall?: {
    /** Maximum causal chain depth (default: 5) */
    maxDepth?: number;
    /** Minimum edge weight to follow (default: 0.1) */
    minEdgeWeight?: number;
    /** Enable temporal decay on edge weights (default: true) */
    temporalDecay?: boolean;
    /** Decay half-life in milliseconds (default: 86400000 = 1 day) */
    decayHalfLifeMs?: number;
  };

  /** QueryOptimizer tuning (ADR-0068 W4-1) */
  queryOptimizer?: {
    /** Enable query plan caching (default: true) */
    planCache?: boolean;
    /** Maximum cached plans (default: 256) */
    maxCachedPlans?: number;
    /** Enable automatic index hints (default: true) */
    autoIndexHints?: boolean;
    /** Cost model weight for vector vs text search (0-1, default: 0.6) */
    vectorCostWeight?: number;
  };

  /** SelfLearningRvfBackend tuning (ADR-0068 W4-1) */
  selfLearningRvfBackend?: {
    /** Learning rate for feedback-driven adaptation (default: 0.01) */
    learningRate?: number;
    /** Feedback window size for rolling stats (default: 100) */
    feedbackWindowSize?: number;
    /** Enable automatic reranking based on feedback (default: true) */
    autoRerank?: boolean;
    /** Minimum feedback count before adaptation kicks in (default: 10) */
    minFeedbackCount?: number;
  };

  // ADR-0069: wire ports consumer -- forward config.json ports so consumers
  // (MCP server, health endpoint, QUIC transport, federation) can read them.
  ports?: {
    mcp?: number;
    mcpWebSocket?: number;
    quic?: number;
    federation?: number;
    health?: number;
  };

  /** MutationGuard tuning (ADR-0068 W4-1) */
  mutationGuard?: {
    /** Enable write-ahead log (default: true) */
    walEnabled?: boolean;
    /** Maximum mutations per transaction (default: 1000) */
    maxMutationsPerTx?: number;
    /** Enable schema validation on write (default: true) */
    schemaValidation?: boolean;
    /** Allowed namespaces (empty = all allowed) */
    allowedNamespaces?: string[];
  };
}

/**
 * Controller instance wrapper
 */
interface ControllerEntry {
  name: ControllerName;
  instance: unknown;
  level: number;
  initTimeMs: number;
  enabled: boolean;
  error?: string;
}

// ===== Initialization Levels =====

/**
 * Level-based initialization order per ADR-053.
 * Controllers at each level can be initialized in parallel.
 * Each level must complete before the next begins.
 */
export const INIT_LEVELS: InitLevel[] = [
  // Level 0: Security infrastructure (ADR-0061 Phase 6)
  { level: 0, controllers: [
    'resourceTracker', 'rateLimiter', 'circuitBreaker', 'telemetryManager',
  ] as ControllerName[] },
  // Level 1: Core intelligence
  { level: 1, controllers: [
    'reasoningBank', 'hierarchicalMemory', 'learningBridge', 'hybridSearch', 'tieredCache',
    'solverBandit', 'attentionMetrics', 'metadataFilter',
  ] as ControllerName[] },
  // Level 2: Graph, security & attention
  { level: 2, controllers: [
    'memoryGraph', 'agentMemoryScope', 'vectorBackend', 'mutationGuard', 'gnnService',
    'selfAttention', 'crossAttention', 'multiHeadAttention', 'attentionService',
    'flashAttentionService', 'moeAttentionService', 'nativeAccelerator', 'queryOptimizer',
  ] as ControllerName[] },
  // Level 3: Specialization (causalGraph moved here from L4 -- ADR-0062 P0-1: nightlyLearner depends on it)
  { level: 3, controllers: [
    'skills', 'explainableRecall', 'reflexion', 'attestationLog', 'batchOperations',
    'memoryConsolidation',
    'enhancedEmbeddingService', 'auditLogger', 'causalGraph',
  ] as ControllerName[] },
  // Level 4: Routing & self-learning
  { level: 4, controllers: [
    'causalRecall', 'nightlyLearner', 'learningSystem', 'semanticRouter',
    'selfLearningRvfBackend', 'federatedLearningManager', 'indexHealthMonitor',
  ] as ControllerName[] },
  // Level 5: Advanced services
  { level: 5, controllers: [
    'graphTransformer', 'sonaTrajectory', 'contextSynthesizer', 'rvfOptimizer',
    'mmrDiversityRanker', 'guardedVectorBackend',
    'quantizedVectorStore',
  ] as ControllerName[] },
  // Level 6: Session management
  { level: 6, controllers: ['graphAdapter'] },
];

// ===== ControllerRegistry =====

/**
 * Central registry for AgentDB v3 controller lifecycle management.
 *
 * Handles:
 * - Level-based initialization ordering (levels 0-6)
 * - Graceful degradation (each controller fails independently)
 * - Config-driven activation (controllers only instantiate when enabled)
 * - Health check aggregation across all controllers
 * - Ordered shutdown (reverse initialization order)
 *
 * @example
 * ```typescript
 * const registry = new ControllerRegistry();
 * await registry.initialize({
 *   dbPath: './data/memory.db',
 *   dimension: 768,
 *   memory: {
 *     learningBridge: { sonaMode: 'balanced' },
 *     memoryGraph: { pageRankDamping: 0.85 },
 *   },
 * });
 *
 * const reasoning = registry.get<ReasoningBank>('reasoningBank');
 * const graph = registry.get<MemoryGraph>('memoryGraph');
 *
 * await registry.shutdown();
 * ```
 */
export class ControllerRegistry extends EventEmitter {
  private controllers: Map<ControllerName, ControllerEntry> = new Map();
  private agentdb: any = null;
  private realEmbedder: any = null;
  private backend: IMemoryBackend | null = null;
  private config: RuntimeConfig = {};
  private initialized = false;
  private initTimeMs = 0;
  /** Cached embedding dimension from getEmbeddingConfig() -- set in initAgentDB */
  private embeddingDimension = 0;
  /** ADR-0064: Resolved dimension from config -> getEmbeddingConfig() -> 768 fallback */
  private resolvedDimension = 768;
  /** ADR-0049: collected init errors for summary reporting */
  private initErrors: ControllerInitError[] = [];
  /** ADR-0049: strict mode flag */
  readonly strictMode = STRICT_MODE;

  /**
   * Initialize all controllers in level-based order.
   *
   * Each level's controllers are initialized in parallel within the level.
   * Failures are isolated: a controller that fails to init is marked as
   * unavailable but does not block other controllers.
   */
  async initialize(config: RuntimeConfig = {}): Promise<void> {
    if (this.initialized) return;
    this.initialized = true; // Set early to prevent concurrent re-entry

    this.config = config;
    const startTime = performance.now();

    // Step 1: Initialize AgentDB (the core)
    await this.initAgentDB(config);

    // Step 1b: Extract real embedder from AgentDB if available (ADR-0062 P1-1)
    if (this.agentdb) {
      try {
        this.realEmbedder = this.agentdb.getEmbeddingService?.() || null;
      } catch { /* use stub */ }
    }

    // Step 1c: Resolve embedding dimension (ADR-0076 Phase 1)
    // Priority: explicit config → resolveConfig() (embeddings.json → agentdb → 768)
    this.resolvedDimension = config.dimension ?? getConfig().embedding.dimension;

    // Step 2: Set up the backend (ADR-0076 Phase 3)
    // Must happen BEFORE dimension validation (Step 2b) — the validation reads this.backend.
    // Priority: explicit config.backend > createStorage() factory > null
    if (config.backend) {
      this.backend = config.backend;
    } else {
      try {
        const { createStorageFromConfig } = await import('./storage-factory.js');
        const resolved = getConfig();
        this.backend = await createStorageFromConfig(resolved, {
          databasePath: config.dbPath || resolved.storage.databasePath,
        });
      } catch {
        // Storage creation failed — controllers degrade gracefully with null backend
        this.backend = null;
      }
    }

    // Step 2b: ADR-0076 A3 — Validate stored dimension matches configured dimension
    if (this.backend && typeof (this.backend as any).getStoredDimension === 'function') {
      try {
        const storedDim = await (this.backend as any).getStoredDimension();
        if (storedDim > 0 && storedDim !== this.resolvedDimension) {
          const err = new Error(
            `Embedding dimension mismatch: stored vectors are ${storedDim}-dim but configured model produces ${this.resolvedDimension}-dim. ` +
            `Either change embeddings.model to match stored vectors, or run 'memory migrate --reembed' to regenerate all embeddings.`
          );
          err.name = 'EmbeddingDimensionError';
          this.initErrors.push(new ControllerInitError('dimensionValidation', err));
          this.emit('controller:init-error', { name: 'dimensionValidation', error: err });
          if (this.strictMode) throw err;
        }
      } catch (e) {
        // Only re-throw dimension errors, not probe failures
        if ((e as Error).name === 'EmbeddingDimensionError') throw e;
      }
    }

    // Step 3: Initialize controllers level by level
    // ADR-0048: Levels 0-1 are eager (fast, <200ms). Levels 2+ are deferred
    // to a background promise so initialize() returns quickly (~1s).
    const eagerMaxLevel = config.eagerMaxLevel ?? 1;

    for (const level of INIT_LEVELS) {
      if (level.level > eagerMaxLevel) break; // defer remaining levels

      const controllersToInit = level.controllers.filter(
        (name) => this.isControllerEnabled(name),
      );

      if (controllersToInit.length === 0) continue;

      const results = await Promise.allSettled(
        controllersToInit.map((name) => this.initController(name, level.level)),
      );

      // Process results
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const name = controllersToInit[i];

        if (result.status === 'rejected') {
          const errorMsg = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);

          this.controllers.set(name, {
            name,
            instance: null,
            level: level.level,
            initTimeMs: 0,
            enabled: false,
            error: errorMsg,
          });

          this.emit('controller:failed', { name, error: errorMsg, level: level.level });
        }
      }
    }

    this.initTimeMs = performance.now() - startTime;

    // ADR-0049: Report init errors
    if (this.initErrors.length > 0) {
      const summary = this.initErrors.map(e => `  ${e.controllerName}: ${e.cause.message}`).join('\n');
      this.emit('controller:init-summary', {
        failedCount: this.initErrors.length,
        errors: this.initErrors.map(e => ({ name: e.controllerName, error: e.cause.message })),
      });
      if (this.strictMode) {
        throw new Error(`${this.initErrors.length} controller(s) failed to initialize:\n${summary}`);
      }
    }

    this.emit('initialized', {
      initTimeMs: this.initTimeMs,
      activeControllers: this.getActiveCount(),
      totalControllers: this.controllers.size,
    });

    // ADR-0048: Initialize deferred levels (2+) in background.
    // This returns immediately so CLI tools can respond within ~1s.
    // Tools that need Level 2+ controllers will find them available
    // after the background init completes (~30-60s).
    const deferredLevels = INIT_LEVELS.filter(l => l.level > eagerMaxLevel);
    if (deferredLevels.length > 0) {
      this._deferredInitPromise = (async () => {
        for (const level of deferredLevels) {
          const controllersToInit = level.controllers.filter(
            (name) => this.isControllerEnabled(name),
          );
          if (controllersToInit.length === 0) continue;

          const results = await Promise.allSettled(
            controllersToInit.map((name) => this.initController(name, level.level)),
          );

          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const name = controllersToInit[i];
            if (result.status === 'rejected') {
              const errorMsg = result.reason instanceof Error
                ? result.reason.message : String(result.reason);
              this.controllers.set(name, {
                name, instance: null, level: level.level,
                initTimeMs: 0, enabled: false, error: errorMsg,
              });
              this.emit('controller:failed', { name, error: errorMsg, level: level.level });
            }
          }
        }
        this.emit('deferred:initialized', { activeControllers: this.getActiveCount() });
      })().catch((e) => {
        if (this.strictMode && e) {
          console.error('[ADR-0049] Deferred controller init failed:', e.message ?? e);
        }
      });
    }
  }

  /** Wait for deferred controllers to finish initializing (for tools that need them). */
  async waitForDeferred(): Promise<void> {
    if (this._deferredInitPromise) await this._deferredInitPromise;
  }

  private _deferredInitPromise: Promise<void> | null = null;

  /**
   * Shutdown all controllers in reverse initialization order.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    // Shutdown in reverse level order
    const reverseLevels = [...INIT_LEVELS].reverse();

    for (const level of reverseLevels) {
      const controllersToShutdown = level.controllers
        .filter((name) => {
          const entry = this.controllers.get(name);
          return entry?.enabled && entry?.instance;
        });

      await Promise.allSettled(
        controllersToShutdown.map((name) => this.shutdownController(name)),
      );
    }

    // Shutdown AgentDB
    if (this.agentdb) {
      try {
        if (typeof this.agentdb.close === 'function') {
          await this.agentdb.close();
        }
      } catch {
        // Best-effort cleanup
      }
      this.agentdb = null;
    }

    this.controllers.clear();
    this.initialized = false;
    this.emit('shutdown');
  }

  /**
   * Get a controller instance by name.
   * Returns null if the controller is not initialized or unavailable.
   */
  get<T>(name: ControllerName): T | null {
    // First check CLI-layer controllers
    const entry = this.controllers.get(name);
    if (entry?.enabled && entry?.instance) {
      return entry.instance as T;
    }

    // Fall back to AgentDB internal controllers
    if (this.agentdb && typeof this.agentdb.getController === 'function') {
      try {
        const controller = this.agentdb.getController(name);
        if (controller) return controller as T;
      } catch {
        // Controller not available in AgentDB
      }
    }

    return null;
  }

  /**
   * Check if a controller is enabled and initialized.
   */
  isEnabled(name: ControllerName): boolean {
    const entry = this.controllers.get(name);
    if (entry?.enabled) return true;

    // Check AgentDB internal controllers
    if (this.agentdb && typeof this.agentdb.getController === 'function') {
      try {
        return this.agentdb.getController(name) !== null;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * ADR-0069: wire similarityThreshold consumer — expose the stored config value.
   * Returns the threshold from RuntimeConfig, falling back to 0.7.
   */
  getSimilarityThreshold(): number {
    return this.config.similarityThreshold ?? 0.7;
  }

  /**
   * Aggregate health check across all controllers.
   */
  async healthCheck(): Promise<RegistryHealthReport> {
    const controllerHealth: ControllerHealth[] = [];

    for (const [name, entry] of this.controllers) {
      controllerHealth.push({
        name,
        status: entry.enabled
          ? 'healthy'
          : entry.error
            ? 'unavailable'
            : 'degraded',
        initTimeMs: entry.initTimeMs,
        error: entry.error,
      });
    }

    // Check AgentDB health
    let agentdbAvailable = false;
    if (this.agentdb) {
      try {
        agentdbAvailable = typeof this.agentdb.getController === 'function';
      } catch {
        agentdbAvailable = false;
      }
    }

    const active = controllerHealth.filter((c) => c.status === 'healthy').length;
    const unavailable = controllerHealth.filter((c) => c.status === 'unavailable').length;

    // ADR-0041: Count composite children managed by parent controllers
    let compositeChildren = 0;
    const a6 = this.controllers.get('selfLearningRvfBackend' as ControllerName);
    if (a6?.enabled && a6?.instance) {
      compositeChildren += 6; // B1, A8, A7, B2, FederatedSessionManager, RvfSolver
    }
    const b9 = this.controllers.get('quantizedVectorStore' as ControllerName);
    if (b9?.enabled && b9?.instance) {
      compositeChildren += 2; // B7 Scalar or B8 Product (one active) + inner state
    }

    // Report composite children as virtual health entries
    if (a6?.enabled && a6?.instance) {
      const childNames = ['semanticQueryRouter', 'sonaLearningBackend', 'contrastiveTrainer', 'temporalCompressor', 'federatedSessionManager', 'rvfSolver'] as const;
      for (const childName of childNames) {
        controllerHealth.push({
          name: childName as unknown as ControllerName,
          status: 'healthy',
          initTimeMs: 0,
          error: undefined,
        });
      }
    }
    if (b9?.enabled && b9?.instance) {
      controllerHealth.push({
        name: 'scalarQuantizer' as unknown as ControllerName,
        status: 'healthy',
        initTimeMs: 0,
      });
      controllerHealth.push({
        name: 'productQuantizer' as unknown as ControllerName,
        status: 'healthy',
        initTimeMs: 0,
      });
    }

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (unavailable > 0 && active === 0) {
      status = 'unhealthy';
    } else if (unavailable > 0) {
      status = 'degraded';
    }

    return {
      status,
      controllers: controllerHealth,
      agentdbAvailable,
      initTimeMs: this.initTimeMs,
      timestamp: Date.now(),
      activeControllers: active + compositeChildren,
      totalControllers: controllerHealth.length,
    };
  }

  /**
   * Get the underlying AgentDB instance.
   */
  getAgentDB(): any {
    return this.agentdb;
  }

  /**
   * Get the memory backend.
   */
  getBackend(): IMemoryBackend | null {
    return this.backend;
  }

  /**
   * Check if the registry is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the number of active (successfully initialized) controllers.
   */
  getActiveCount(): number {
    let count = 0;
    for (const entry of this.controllers.values()) {
      if (entry.enabled) count++;
    }
    return count;
  }

  /**
   * List all registered controller names and their status.
   */
  listControllers(): Array<{ name: ControllerName; enabled: boolean; level: number }> {
    return Array.from(this.controllers.entries()).map(([name, entry]) => ({
      name,
      enabled: entry.enabled,
      level: entry.level,
    }));
  }

  // ===== Private Methods =====

  /**
   * Initialize AgentDB instance with dynamic import and fallback chain.
   */
  private async initAgentDB(config: RuntimeConfig): Promise<void> {
    try {
      // Validate dbPath to prevent path traversal
      const dbPath = config.dbPath || ':memory:';
      if (dbPath !== ':memory:') {
        // Use dynamic import instead of require() — require() is not defined in ESM
        // context and silently kills initAgentDB(), disabling all 15+ controllers (#1492).
        const { resolve: resolvePath } = await import('node:path');
        const resolved = resolvePath(dbPath);
        if (resolved.includes('..')) {
          this.emit('agentdb:unavailable', { reason: 'Invalid dbPath' });
          return;
        }
      }

      const agentdbModule: any = await import('agentdb');
      const AgentDBClass = agentdbModule.AgentDB || agentdbModule.default;

      // Cache embedding config for createEmbeddingService() and other consumers
      if (typeof agentdbModule.getEmbeddingConfig === 'function') {
        const embCfg = agentdbModule.getEmbeddingConfig();
        this.embeddingDimension = embCfg.dimension || 0;
      }

      if (!AgentDBClass) {
        this.emit('agentdb:unavailable', { reason: 'No AgentDB class found' });
        return;
      }

      // ADR-0068 W2-4: Forward full config to AgentDB so it can wire
      // dimension, embedding model, and HNSW params into its own controllers.
      // All values read from RuntimeConfig (populated by memory-bridge from
      // embeddings.json). Fallbacks match the unified all-mpnet-base-v2 model.
      this.agentdb = new AgentDBClass({
        dbPath,
        maxElements: config.maxElements || 100000,
        maxEntries: config.maxEntries || 1000000, // ADR-0069: config-chain capacity
        dimension: config.dimension || 768,
        embeddingModel: config.embeddingModel || 'all-mpnet-base-v2',
        hnswM: config.hnswM || 23,
        hnswEfConstruction: config.hnswEfConstruction || 100,
        hnswEfSearch: config.hnswEfSearch || 50,
      });

      // Suppress agentdb's noisy info-level output during init
      // using stderr redirect instead of monkey-patching console.log
      const origLog = console.log;
      const suppressFilter = (args: unknown[]) => {
        const msg = String(args[0] ?? '');
        return msg.includes('Transformers.js') ||
               msg.includes('better-sqlite3') ||
               msg.includes('[AgentDB]');
      };
      console.log = (...args: unknown[]) => {
        if (!suppressFilter(args)) origLog.apply(console, args);
      };
      try {
        await this.agentdb.initialize();
      } finally {
        console.log = origLog;
      }
      this.emit('agentdb:initialized');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.emit('agentdb:unavailable', { reason: msg.substring(0, 200) });
      this.agentdb = null;
    }
  }

  /**
   * Check whether a controller should be initialized based on config.
   */
  private isControllerEnabled(name: ControllerName): boolean {
    // Explicit enable/disable from config
    if (this.config.controllers) {
      const explicit = this.config.controllers[name];
      if (explicit !== undefined) return explicit;
    }

    // Default behavior: enable based on category
    switch (name) {
      // Core intelligence — enabled by default
      case 'reasoningBank':
      case 'learningBridge':
      case 'solverBandit':
      case 'tieredCache':
      case 'hierarchicalMemory':
        return true;

      // Graph — enabled if backend available
      case 'memoryGraph':
        return !!(this.config.memory?.memoryGraph || this.backend);

      // Security — enabled if AgentDB available
      case 'mutationGuard':
      case 'attestationLog':
      case 'vectorBackend':
      case 'guardedVectorBackend':
        return this.agentdb !== null;

      // AgentDB-internal controllers — only if AgentDB available
      case 'skills':
      case 'reflexion':
      case 'causalGraph':
      case 'causalRecall':
      case 'learningSystem':
      case 'explainableRecall':
      case 'nightlyLearner':
      case 'graphAdapter':
      case 'gnnService':
      case 'memoryConsolidation':
      case 'batchOperations':
      case 'contextSynthesizer':
      case 'rvfOptimizer':
      case 'mmrDiversityRanker':
        return this.agentdb !== null;

      // SemanticRouter — auto-enable if agentdb available
      case 'semanticRouter':
        return this.agentdb !== null;

      // Pure JS, zero cost -- enabled by default (ADR-0061 Phase 2)
      case 'solverBandit':
      case 'attentionMetrics':
        return true;

      // Attention + optimization -- enabled if agentdb available (ADR-0061 Phase 3-4)
      case 'selfAttention':
      case 'crossAttention':
      case 'multiHeadAttention':
      case 'attentionService':
      case 'nativeAccelerator':
      case 'enhancedEmbeddingService':
      case 'auditLogger':
      case 'queryOptimizer':
      case 'metadataFilter':
      case 'indexHealthMonitor':
        return this.agentdb !== null;

      // Advanced controllers -- enabled if agentdb available (ADR-0061 Phase 5)
      case 'selfLearningRvfBackend':
      case 'quantizedVectorStore':
        return this.agentdb !== null;

      // Federated learning -- only useful in multi-agent swarms
      case 'federatedLearningManager':
        return false;

      // Security infrastructure -- always enabled (ADR-0061 Phase 6)
      case 'resourceTracker':
      case 'rateLimiter':
      case 'circuitBreaker':
      case 'telemetryManager':
        return true;

      // Optional controllers
      case 'hybridSearch':
      case 'agentMemoryScope':
        return this.agentdb !== null || this.backend !== null;

      // Optional controllers
      case 'sonaTrajectory':
        return false; // Require explicit enabling

      default:
        return false;
    }
  }

  /**
   * Initialize a single controller with error isolation.
   */
  private async initController(name: ControllerName, level: number): Promise<void> {
    const startTime = performance.now();

    try {
      const instance = await this.createController(name);

      const initTimeMs = performance.now() - startTime;

      this.controllers.set(name, {
        name,
        instance,
        level,
        initTimeMs,
        enabled: instance !== null,
        error: instance === null ? 'Controller returned null' : undefined,
      });

      if (instance !== null) {
        this.emit('controller:initialized', { name, level, initTimeMs });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const initTimeMs = performance.now() - startTime;

      this.controllers.set(name, {
        name,
        instance: null,
        level,
        initTimeMs,
        enabled: false,
        error: errorMsg,
      });

      throw error;
    }
  }

  /**
   * Factory method to create a controller instance.
   * Handles CLI-layer controllers; AgentDB-internal controllers are
   * accessed via agentdb.getController().
   */
  private async createController(name: ControllerName): Promise<unknown> {
    switch (name) {
      // ----- CLI-layer controllers -----

      case 'learningBridge': {
        // Backend is optional — provide no-op stub when not configured
        const noOpBackend: any = {
          async get() { return null; },
          async update() { return null; },
          async query() { return []; },
          async initialize() {},
          async shutdown() {},
        };
        const config = this.config.memory?.learningBridge || {};
        const bridge = new LearningBridge(this.backend || noOpBackend, {
          sonaMode: config.sonaMode || this.config.neural?.sonaMode || 'real-time',
          confidenceDecayRate: config.confidenceDecayRate,
          accessBoostAmount: config.accessBoostAmount,
          consolidationThreshold: config.consolidationThreshold,
          enabled: true,
        });
        return getOrCreate(name, () => bridge);
      }

      case 'solverBandit': {
        try {
          const agentdbModule = await import('agentdb');
          const SB = (agentdbModule as any).SolverBandit;
          if (!SB) return null;
          const bandit = new SB({
            costWeight: 0.01,
            costDecay: 0.1,
            explorationBonus: 0.1,
          });
          // Restore persisted state if available
          try {
            const stateEntry = await this.backend?.getByKey?.('default', '_solver_bandit_state');
            if (stateEntry?.content) {
              bandit.deserialize(JSON.parse(stateEntry.content));
            }
          } catch { /* cold start — no persisted state */ }
          return getOrCreate(name, () => bandit);
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'memoryGraph': {
        const config = this.config.memory?.memoryGraph || {};
        const graph = new MemoryGraph({
          pageRankDamping: config.pageRankDamping,
          maxNodes: config.maxNodes,
          ...config,
        });
        // Build from backend if available
        if (this.backend) {
          try {
            await graph.buildFromBackend(this.backend);
          } catch {
            // Graph build from backend failed — empty graph is still usable
          }
        }
        return getOrCreate(name, () => graph);
      }

      case 'tieredCache': {
        const config = this.config.memory?.tieredCache || {};
        const cache = new TieredCacheManager({
          maxSize: config.maxSize || 10000,
          ttl: config.ttl || 300000,
          lruEnabled: true,
          writeThrough: false,
          ...config,
        });
        return getOrCreate(name, () => cache);
      }

      case 'agentMemoryScope': {
        // P4-D: 3-scope isolation: agent, session, global
        // Each scope is a namespace prefix that isolates memory access
        try {
          const scopes = {
            agent: (agentId: string) => `agent:${agentId}:`,
            session: (sessionId: string) => `session:${sessionId}:`,
            global: () => 'global:',
          };

          const getScope = (type: 'agent' | 'session' | 'global', id?: string): string => {
            if (type === 'agent') return scopes.agent(id || 'default');
            if (type === 'session') return scopes.session(id || 'default');
            return scopes.global();
          };

          return getOrCreate(name, () => ({
            getScope,

            scopeKey(key: string, type: 'agent' | 'session' | 'global', id?: string): string {
              return getScope(type, id) + key;
            },

            unscopeKey(scopedKey: string): { key: string; scope: string; type: string } {
              for (const type of ['agent', 'session', 'global'] as const) {
                if (scopedKey.startsWith(`${type}:`)) {
                  const rest = scopedKey.slice(type.length + 1);
                  if (type === 'global') {
                    return { key: rest, scope: 'global:', type: 'global' };
                  }
                  const colonIdx = rest.indexOf(':');
                  if (colonIdx > 0) {
                    const id = rest.slice(0, colonIdx);
                    const key = rest.slice(colonIdx + 1);
                    return { key, scope: `${type}:${id}:`, type };
                  }
                }
              }
              return { key: scopedKey, scope: '', type: 'unscoped' };
            },

            filterByScope(entries: any[], type: 'agent' | 'session' | 'global', id?: string): any[] {
              const prefix = getScope(type, id);
              return entries.filter((e: any) => {
                const key = e.key || e.id || '';
                return key.startsWith(prefix);
              });
            },

            getStats(): { scopes: string[]; description: string } {
              return {
                scopes: ['agent', 'session', 'global'],
                description: '3-scope isolation: agent-local, session-local, global shared',
              };
            },
          }));
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'hybridSearch': {
        // BM25 + HNSW reciprocal rank fusion (ADR-0068 W4-3)
        try {
          const { HybridSearchController } = await import('./controllers/hybrid-search.js');
          const backend = this.get('vectorBackend') ?? this.agentdb;
          return getOrCreate(name, () => new HybridSearchController(backend));
        } catch { return null; }
      }

      case 'semanticRouter': {
        // SemanticRouter exported from agentdb 3.0.0-alpha.10 (ADR-062)
        // Constructor: () — requires initialize() after construction
        try {
          const agentdbModule: any = await import('agentdb');
          const SR = agentdbModule.SemanticRouter;
          if (!SR) return null;
          const router = new SR();
          await router.initialize();
          return getOrCreate(name, () => router);
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'sonaTrajectory':
        // SonaTrajectoryService — delegate to AgentDB, fallback to direct construction (ADR-0061 Bug #7)
        if (this.agentdb && typeof this.agentdb.getController === 'function') {
          try {
            const ctrl = this.agentdb.getController('sonaTrajectory');
            if (ctrl) return getOrCreate(name, () => ctrl);
          } catch { /* fall through to direct construction */ }
        }
        try {
          const agentdbModule: any = await import('agentdb');
          const STS = agentdbModule.SonaTrajectoryService;
          if (!STS) return null;
          const svc = new STS();
          if (typeof svc.initialize === 'function') await svc.initialize();
          return getOrCreate(name, () => svc);
        } catch { return null; }

      case 'hierarchicalMemory': {
        // HierarchicalMemory exported from agentdb 3.0.0-alpha.10 (ADR-066 Phase P2-3)
        // Constructor: (db, embedder, vectorBackend?, graphBackend?, config?)
        if (!this.agentdb) return this.createTieredMemoryStub();
        try {
          const agentdbModule: any = await import('agentdb');
          const HM = agentdbModule.HierarchicalMemory;
          if (!HM) return this.createTieredMemoryStub();
          const embedder = this.createEmbeddingService();
          const vb = this.get('vectorBackend');
          const hm = new HM(this.agentdb.database, embedder, vb || undefined);
          await hm.initializeDatabase();
          return getOrCreate(name, () => hm);
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return this.createTieredMemoryStub();
        }
      }

      case 'memoryConsolidation': {
        // MemoryConsolidation exported from agentdb 3.0.0-alpha.10 (ADR-066 Phase P2-3)
        // Constructor: (db, hierarchicalMemory, embedder, vectorBackend?, graphBackend?, config?)
        if (!this.agentdb) return this.createConsolidationStub();
        try {
          const agentdbModule: any = await import('agentdb');
          const MC = agentdbModule.MemoryConsolidation;
          if (!MC) return this.createConsolidationStub();
          // Get the HierarchicalMemory instance (must be initialized at level 1 before us at level 3)
          const hm: any = this.get('hierarchicalMemory');
          if (!hm || typeof hm.recall !== 'function' || typeof hm.store !== 'function') {
            return this.createConsolidationStub();
          }
          const embedder = this.createEmbeddingService();
          const mc = new MC(this.agentdb.database, hm, embedder);
          await mc.initializeDatabase();
          return getOrCreate(name, () => mc);
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return this.createConsolidationStub();
        }
      }

      // ----- AgentDB-internal controllers (via getController) -----
      // ADR-0068 W2-3: Delegate Tier 1 controller construction to AgentDB.
      // AgentDB manages its own controller lifecycle, embedder wiring, and
      // dimension configuration — direct `new X(db, ...)` is removed.
      case 'reasoningBank':
      case 'skills':
      case 'reflexion':
      case 'causalGraph':
      case 'causalRecall':
      case 'learningSystem':
      case 'explainableRecall':
      case 'graphTransformer': {
        if (!this.agentdb || typeof this.agentdb.getController !== 'function') return null;
        try {
          return getOrCreate(name, () => this.agentdb.getController(name) ?? null);
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'nightlyLearner': {
        // ADR-0068 W2-3: Delegate to AgentDB first, fall back to direct construction
        // only when AgentDB does not yet expose nightlyLearner.
        if (!this.agentdb) return null;
        if (typeof this.agentdb.getController === 'function') {
          try {
            const ctrl = this.agentdb.getController('nightlyLearner');
            if (ctrl) return getOrCreate(name, () => ctrl);
          } catch { /* fall through to direct construction */ }
        }
        // Fallback: direct construction (AgentDB < alpha.12 may not expose nightlyLearner)
        try {
          const agentdbModule: any = await import('agentdb');
          const NL = agentdbModule.NightlyLearner;
          if (!NL) return null;
          // ADR-0062 P3-4: Enable flash consolidation when AttentionService
          // was successfully initialized at Level 2
          const hasAttention = this.controllers.get('attentionService')?.enabled === true;
          // ADR-0040: pass pre-created singletons to avoid duplicate SQLite objects
          return getOrCreate(name, () => new NL(
            this.agentdb.database,
            this.createEmbeddingService(),
            { ENABLE_FLASH_CONSOLIDATION: hasAttention },
            this.get('causalGraph') || undefined,
            this.get('reflexion') || undefined,
            this.get('skills') || undefined,
          ));
        } catch { return null; }
      }

      // ----- Direct-instantiation controllers -----
      case 'batchOperations': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const BO = agentdbModule.BatchOperations;
          if (!BO) return null;
          // ADR-0064 P2: Use createEmbeddingService() like all other controllers
          const embedder = this.createEmbeddingService();
          return getOrCreate(name, () => new BO(this.agentdb.database, embedder));
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'contextSynthesizer': {
        // ContextSynthesizer.synthesize is static — return the class itself
        try {
          const agentdbModule: any = await import('agentdb');
          const cs = agentdbModule.ContextSynthesizer;
          return cs ? getOrCreate(name, () => cs) : null;
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'mmrDiversityRanker': {
        // MMRDiversityRanker is static-only — return class reference (ADR-0061 Bug #5)
        try {
          const agentdbModule: any = await import('agentdb');
          const mmr = agentdbModule.MMRDiversityRanker;
          return mmr ? getOrCreate(name, () => mmr) : null;
        } catch { return null; }
      }

      case 'mutationGuard': {
        // ADR-0068 W2-3: Delegate to AgentDB; fall back to direct construction
        if (!this.agentdb) return null;
        if (typeof this.agentdb.getController === 'function') {
          try {
            const ctrl = this.agentdb.getController('mutationGuard');
            if (ctrl) return getOrCreate(name, () => ctrl);
          } catch { /* fall through to direct construction */ }
        }
        // Fallback: direct construction (AgentDB < alpha.12)
        try {
          const agentdbModule: any = await import('agentdb');
          const MG = agentdbModule.MutationGuard;
          if (!MG) return null;
          const mg = new MG({ dimension: this.resolvedDimension });
          await mg.initialize();
          return getOrCreate(name, () => mg);
        } catch { return null; }
      }

      case 'attestationLog': {
        // AttestationLog exported from agentdb 3.0.0-alpha.10 (ADR-060)
        // Constructor: (db) — uses database for append-only audit log
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const AL = agentdbModule.AttestationLog;
          if (!AL) return null;
          return getOrCreate(name, () => new AL(this.agentdb.database));
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'gnnService': {
        // GNNService is exported from agentdb — use real class with JS fallbacks
        try {
          const agentdbModule: any = await import('agentdb');
          const GNN = agentdbModule.GNNService;
          if (!GNN) return null;
          const gnn = new GNN({ inputDim: this.resolvedDimension });
          await gnn.initialize();
          return getOrCreate(name, () => gnn);
        } catch { return null; }
      }

      case 'rvfOptimizer': {
        // ADR-0040: stats-only wrapper — backend optimization helper
        // RVFOptimizer class doesn't exist in agentdb — wrap backend optimization
        try {
          const _agentdbModule = await import('agentdb');
          const backend = this.backend;

          return getOrCreate(name, () => ({
            async optimize() {
              // Run WAL checkpoint + VACUUM on the backend if supported
              if (backend && typeof (backend as any).optimize === 'function') {
                return (backend as any).optimize();
              }
              return { success: false, reason: 'no backend optimize method' };
            },
            async getStats() {
              if (backend && typeof (backend as any).getStats === 'function') {
                return (backend as any).getStats();
              }
              return { type: 'rvf-optimizer', status: 'wrapper' };
            },
            isAvailable() {
              return !!backend;
            },
          }));
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'guardedVectorBackend': {
        // GuardedVectorBackend exported from agentdb 3.0.0-alpha.10 (ADR-060)
        // Constructor: (innerBackend, mutationGuard, attestationLog?)
        // Requires vectorBackend and mutationGuard to be initialized first (level 2)
        if (!this.agentdb) return null;
        try {
          const vb = this.get('vectorBackend');
          const guard = this.get('mutationGuard');
          if (!vb || !guard) return null;
          const agentdbModule: any = await import('agentdb');
          const GVB = agentdbModule.GuardedVectorBackend;
          if (!GVB) return null;
          const log = this.get('attestationLog');
          return getOrCreate(name, () => new GVB(vb, guard, log || undefined));
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'vectorBackend': {
        // ADR-0040: vectorBackend is a property on AgentDB, not a controller name
        if (!this.agentdb) return null;
        return getOrCreate(name, () => this.agentdb.vectorBackend ?? null);
      }

      case 'graphAdapter': {
        // graphAdapter accessed via getController fallback
        if (!this.agentdb) return null;
        try {
          if (typeof this.agentdb.getController === 'function') {
            return getOrCreate(name, () => this.agentdb.getController('graphAdapter') ?? null);
          }
        } catch { /* fallthrough */ }
        return null;
      }

      // ----- ADR-0061 Phase 2: Pure JS controllers -----
      // NOTE: case 'solverBandit' handled above (line ~1168) with state restore logic.
      // Duplicate case removed per ADR-0076 Phase 4 validation.

      case 'attentionMetrics': {
        try {
          const agentdbModule: any = await import('agentdb');
          const AMC = agentdbModule.AttentionMetricsCollector;
          if (!AMC) return null;
          return getOrCreate(name, () => new AMC());
        } catch { return null; }
      }

      // ----- ADR-0061 Phase 3: Attention suite -----
      case 'selfAttention': {
        try {
          const agentdbModule: any = await import('agentdb');
          const SAC = agentdbModule.SelfAttentionController;
          if (!SAC) return null;
          const vb = this.get('vectorBackend');
          const saCfg = this.config.selfAttention || {};
          return getOrCreate(name, () => new SAC(vb || null, { topK: saCfg.topK ?? 10 }));
        } catch { return null; }
      }

      case 'crossAttention': {
        try {
          const agentdbModule: any = await import('agentdb');
          const CAC = agentdbModule.CrossAttentionController;
          if (!CAC) return null;
          const vb = this.get('vectorBackend');
          return getOrCreate(name, () => new CAC(vb || null));
        } catch { return null; }
      }

      case 'multiHeadAttention': {
        try {
          const agentdbModule: any = await import('agentdb');
          const MHA = agentdbModule.MultiHeadAttentionController;
          if (!MHA) return null;
          const vb = this.get('vectorBackend');
          const mhaCfg = this.config.multiHeadAttention || {};
          return getOrCreate(name, () => new MHA(vb || null, {
            numHeads: mhaCfg.numHeads ?? 8,
            topK: mhaCfg.topK ?? 10,
          }));
        } catch { return null; }
      }

      case 'attentionService': {
        try {
          const agentdbModule: any = await import('agentdb');
          const AS = agentdbModule.AttentionService;
          if (!AS) return null;
          const asCfg = this.config.attentionService || {};
          const dim = this.resolvedDimension;
          const numHeads = asCfg.numHeads ?? 8;
          const svc = new AS({
            numHeads,
            headDim: Math.floor(dim / numHeads),
            embedDim: dim,
            useFlash: asCfg.useFlash ?? true,
            useMoE: asCfg.useMoE ?? false,
            useHyperbolic: asCfg.useHyperbolic ?? false,
          });
          await svc.initialize();
          return getOrCreate(name, () => svc);
        } catch { return null; }
      }

      // ----- ADR-0069 F3: Dual AttentionService instances for SONAWithAttention -----
      // Flash instance: self-attention layers (memory-efficient tiled computation)
      case 'flashAttentionService': {
        try {
          const agentdbModule: any = await import('agentdb');
          const AS = agentdbModule.AttentionService;
          if (!AS) return null;
          const dim = this.resolvedDimension;
          const numHeads = this.config.attentionService?.numHeads ?? 8;
          const svc = new AS({
            numHeads,
            headDim: Math.floor(dim / numHeads),
            embedDim: dim,
            useFlash: true,
            useMoE: false,
            useHyperbolic: false,
          });
          await svc.initialize();
          return getOrCreate(name, () => svc);
        } catch { return null; }
      }

      // MoE instance: expert routing (dynamic expert selection)
      case 'moeAttentionService': {
        try {
          const agentdbModule: any = await import('agentdb');
          const AS = agentdbModule.AttentionService;
          if (!AS) return null;
          const dim = this.resolvedDimension;
          const moeCfg = this.config.attentionService || {};
          const svc = new AS({
            numHeads: moeCfg.numHeads ?? 4,
            headDim: Math.floor(dim / (moeCfg.numHeads ?? 4)),
            embedDim: dim,
            useFlash: false,
            useMoE: true,
            numExperts: 8,
            topK: 2,
            useHyperbolic: false,
          });
          await svc.initialize();
          return getOrCreate(name, () => svc);
        } catch { return null; }
      }

      // ----- ADR-0061 Phase 4: Optimization -----
      case 'queryOptimizer': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const QO = agentdbModule.QueryOptimizer;
          if (!QO) return null;
          return getOrCreate(name, () => new QO(this.agentdb.database));
        } catch { return null; }
      }

      case 'enhancedEmbeddingService': {
        try {
          const agentdbModule: any = await import('agentdb');
          const EES = agentdbModule.EnhancedEmbeddingService;
          if (!EES) return null;
          return getOrCreate(name, () => new EES());
        } catch { return null; }
      }

      case 'auditLogger': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const AL = agentdbModule.AuditLogger;
          if (!AL) return null;
          return getOrCreate(name, () => new AL({
            maxFileSize: this.config.auditRotationSize ?? 10 * 1024 * 1024,
            maxFiles: this.config.auditRotationFiles ?? 10,
          }));
        } catch { return null; }
      }

      case 'quantizedVectorStore': {
        try {
          const agentdbModule: any = await import('agentdb');
          const QVS = agentdbModule.QuantizedVectorStore;
          if (!QVS) return null;
          return getOrCreate(name, () => new QVS({ type: this.config.quantizedVectorStore?.type ?? 'scalar-8bit' }));
        } catch { return null; }
      }

      // ----- ADR-0061 Phase 5: Self-learning -----
      case 'nativeAccelerator': {
        // Singleton pattern (ADR-0061 S9 verified)
        try {
          const agentdbModule: any = await import('agentdb');
          const getAcc = agentdbModule.getAccelerator;
          if (!getAcc) return null;
          return getOrCreate(name, () => getAcc());
        } catch { return null; }
      }

      case 'selfLearningRvfBackend': {
        // Private constructor -- must use static factory (ADR-0061 Bug #10)
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const SLRB = agentdbModule.SelfLearningRvfBackend;
          if (!SLRB) return null;
          const dbPath = this.config.dbPath || ':memory:';
          const storagePath = dbPath === ':memory:' ? ':memory:' : dbPath.replace(/\.db$/, '-rvf.sqlite');
          // ADR-0076: await the async factory BEFORE passing to getOrCreate
          // (getOrCreate is sync — passing an async factory stores a Promise, not an instance)
          const instance = await SLRB.create({
            dimension: this.resolvedDimension,
            storagePath,
            learning: true,
          });
          return getOrCreate(name, () => instance);
        } catch { return null; }
      }

      case 'metadataFilter': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const MF = agentdbModule.MetadataFilter;
          if (!MF) return null;
          return getOrCreate(name, () => new MF());
        } catch { return null; }
      }

      case 'indexHealthMonitor': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const IHM = agentdbModule.IndexHealthMonitor;
          if (!IHM) return null;
          return getOrCreate(name, () => new IHM());
        } catch { return null; }
      }

      case 'federatedLearningManager': {
        try {
          const agentdbModule: any = await import('agentdb');
          const FLM = agentdbModule.FederatedLearningManager;
          if (!FLM) return null;
          return getOrCreate(name, () => new FLM({ agentId: this.config.agentId || `agent-${Date.now().toString(36)}` }));
        } catch { return null; }
      }

      // ----- ADR-0061 Phase 6: Security infrastructure -----
      case 'resourceTracker': {
        try {
          const agentdbModule: any = await import('agentdb');
          const RT = agentdbModule.ResourceTracker;
          if (!RT) return null;
          return getOrCreate(name, () => new RT());
        } catch { return null; }
      }

      case 'rateLimiter': {
        try {
          const agentdbModule: any = await import('agentdb');
          const RL = agentdbModule.RateLimiter;
          if (!RL) return null;
          const rlCfg = this.config.rateLimiter || {};
          const maxTokens = rlCfg.maxRequests || 100;
          // ADR-0069 A2: config-chain rate limits
          const windowMs = rlCfg.windowMs || 60000;
          const refillRate = Math.max(1, Math.round(maxTokens / (windowMs / 1000)));
          return getOrCreate(name, () => new RL(maxTokens, refillRate));
        } catch { return null; }
      }

      case 'circuitBreaker': {
        try {
          const agentdbModule: any = await import('agentdb');
          const CB = agentdbModule.CircuitBreaker;
          if (CB) {
            const cbCfg = this.config.circuitBreaker || {};
            return getOrCreate(name, () => new CB(cbCfg.failureThreshold ?? 5, cbCfg.resetTimeoutMs ?? 60000));
          }
        } catch { /* agentdb not available — use inline fallback */ }
        // Level 0 security controller must NEVER return null
        const cfg = this.config.circuitBreaker || {};
        const threshold = cfg.failureThreshold ?? 5;
        const resetMs = cfg.resetTimeoutMs ?? 60000;
        let failures = 0;
        let state: 'closed' | 'open' | 'half-open' = 'closed';
        let openedAt = 0;
        return getOrCreate(name, () => ({
          getState: () => state,
          recordSuccess() { failures = 0; state = 'closed'; },
          recordFailure() {
            failures++;
            if (failures >= threshold) { state = 'open'; openedAt = Date.now(); }
          },
          isOpen() {
            if (state === 'open' && Date.now() - openedAt > resetMs) state = 'half-open';
            return state === 'open';
          },
          getStats: () => ({ state, failures, threshold }),
        }));
      }

      case 'telemetryManager': {
        try {
          const agentdbModule: any = await import('agentdb');
          const TM = agentdbModule.TelemetryManager;
          if (!TM) return null;
          return getOrCreate(name, () => TM.getInstance());
        } catch { return null; }
      }

      default:
        return null;
    }
  }

  /**
   * Shutdown a single controller gracefully.
   */
  private async shutdownController(name: ControllerName): Promise<void> {
    const entry = this.controllers.get(name);
    if (!entry?.instance) return;

    try {
      const instance = entry.instance as any;

      // Try known shutdown methods (always await for safety)
      if (typeof instance.destroy === 'function') {
        await instance.destroy();
      } else if (typeof instance.shutdown === 'function') {
        await instance.shutdown();
      } else if (typeof instance.close === 'function') {
        await instance.close();
      }
    } catch {
      // Best-effort cleanup
    }

    entry.enabled = false;
    entry.instance = null;
  }

  /**
   * Create an EmbeddingService for controllers that need it.
   * Uses the config's embedding generator or creates a minimal local service.
   * Reads dimension from the cached embedding config (populated during
   * initAgentDB) instead of hardcoding 768.
   */
  private createEmbeddingService(): any {
    // ADR-0062 P1-1: Reuse AgentDB's real embedder when available
    if (this.realEmbedder) return this.realEmbedder;

    // ADR-0076 Phase 2: Use EmbeddingPipeline singleton when available
    const pipeline = getPipeline();
    if (pipeline) {
      return {
        embed: async (text: string) => pipeline.embed(text),
        embedBatch: async (texts: string[]) => Promise.all(texts.map((t: string) => pipeline.embed(t))),
        initialize: async () => {},
      };
    }

    // If user provided an embedding generator, wrap it
    if (this.config.embeddingGenerator) {
      return {
        embed: async (text: string) => this.config.embeddingGenerator!(text),
        embedBatch: async (texts: string[]) => Promise.all(texts.map(t => this.config.embeddingGenerator!(t))),
        initialize: async () => {},
      };
    }
    // Return a minimal stub — HierarchicalMemory falls back to manualSearch without embeddings
    return {
      embed: async () => new Float32Array(this.resolvedDimension),
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(this.resolvedDimension)),
      initialize: async () => {},
    };
  }

  /**
   * Lightweight in-memory tiered store (fallback when HierarchicalMemory
   * cannot be initialized from agentdb).
   * Enforces per-tier size limits to prevent unbounded memory growth.
   */
  private createTieredMemoryStub() {
    const MAX_PER_TIER = 5000;
    const tiers: Record<string, Map<string, { value: string; ts: number }>> = {
      working: new Map(),
      episodic: new Map(),
      semantic: new Map(),
    };
    return {
      store(key: string, value: string, tier = 'working') {
        const t = tiers[tier] || tiers.working;
        // Evict oldest if at capacity
        if (t.size >= MAX_PER_TIER) {
          const oldest = t.keys().next().value;
          if (oldest !== undefined) t.delete(oldest);
        }
        t.set(key, { value: value.substring(0, 100_000), ts: Date.now() });
      },
      recall(query: string, topK = 5) {
        const safeTopK = Math.min(Math.max(1, topK), 100);
        const q = query.toLowerCase().substring(0, 10_000);
        const results: Array<{ key: string; value: string; tier: string; ts: number }> = [];
        for (const [tierName, map] of Object.entries(tiers)) {
          for (const [key, entry] of map) {
            if (key.toLowerCase().includes(q) || entry.value.toLowerCase().includes(q)) {
              results.push({ key, value: entry.value, tier: tierName, ts: entry.ts });
              if (results.length >= safeTopK * 3) break; // Early exit for large stores
            }
          }
        }
        return results.sort((a, b) => b.ts - a.ts).slice(0, safeTopK);
      },
      getTierStats() {
        return Object.fromEntries(
          Object.entries(tiers).map(([name, map]) => [name, map.size]),
        );
      },
    };
  }

  /**
   * No-op consolidation stub (fallback when MemoryConsolidation
   * cannot be initialized from agentdb).
   */
  private createConsolidationStub() {
    return {
      consolidate() {
        return { promoted: 0, pruned: 0, timestamp: Date.now() };
      },
    };
  }
}

export default ControllerRegistry;
