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
  | 'graphTransformer'
  | 'mutationGuard'
  | 'attestationLog'
  | 'vectorBackend'
  | 'graphAdapter'
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
  | 'hybridSearch'
  | 'federatedSession'
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
  | 'nativeAccelerator'
  | 'selfLearningRvfBackend'
  | 'federatedLearningManager'
  | 'enhancedEmbeddingService'
  | 'quantizedVectorStore'
  | 'resourceTracker'
  | 'rateLimiter'
  | 'circuitBreaker'
  | 'telemetryManager';

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

  /** Backend instance to use (if pre-created) */
  backend?: IMemoryBackend;

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
    'solverBandit', 'attentionMetrics',
  ] as ControllerName[] },
  // Level 2: Graph, security & attention
  { level: 2, controllers: [
    'memoryGraph', 'agentMemoryScope', 'vectorBackend', 'mutationGuard', 'gnnService',
    'selfAttention', 'crossAttention', 'multiHeadAttention', 'attentionService',
    'nativeAccelerator', 'queryOptimizer',
  ] as ControllerName[] },
  // Level 3: Specialization (causalGraph moved here from L4 — ADR-0062 P0-1: nightlyLearner depends on it)
  { level: 3, controllers: [
    'skills', 'explainableRecall', 'reflexion', 'attestationLog', 'batchOperations',
    'memoryConsolidation',
    'enhancedEmbeddingService', 'auditLogger', 'causalGraph',
  ] as ControllerName[] },
  // Level 4: Routing & self-learning
  { level: 4, controllers: [
    'nightlyLearner', 'learningSystem', 'semanticRouter',
    'selfLearningRvfBackend', 'federatedLearningManager',
  ] as ControllerName[] },
  // Level 5: Advanced services
  { level: 5, controllers: [
    'graphTransformer', 'sonaTrajectory', 'contextSynthesizer', 'rvfOptimizer',
    'mmrDiversityRanker', 'guardedVectorBackend',
    'quantizedVectorStore',
  ] as ControllerName[] },
  // Level 6: Session management
  { level: 6, controllers: ['federatedSession', 'graphAdapter'] },
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
  /** ADR-0064: Resolved dimension from config → getEmbeddingConfig() → 768 fallback */
  private resolvedDimension = 768;

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

    // Step 1c: Resolve embedding dimension (ADR-0064 P0)
    // Priority: explicit config → getEmbeddingConfig() → 768 fallback
    if (config.dimension) {
      this.resolvedDimension = config.dimension;
    } else {
      try {
        const agentdbModule = await import('@claude-flow/agentdb');
        if (typeof agentdbModule.getEmbeddingConfig === 'function') {
          this.resolvedDimension = agentdbModule.getEmbeddingConfig().dimension || 768;
        }
      } catch { /* agentdb not available — use 768 default */ }
    }

    // Step 2: Set up the backend
    this.backend = config.backend || null;

    // Step 3: Initialize controllers level by level
    for (const level of INIT_LEVELS) {
      const controllersToInit = level.controllers.filter(
        (name) => this.isControllerEnabled(name),
      );

      if (controllersToInit.length === 0) continue;

      // Initialize all controllers in this level in parallel
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
    this.emit('initialized', {
      initTimeMs: this.initTimeMs,
      activeControllers: this.getActiveCount(),
      totalControllers: this.controllers.size,
    });
  }

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
      activeControllers: active,
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
      case 'graphTransformer':
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

      // Pure JS, zero cost — enabled by default (ADR-0061 Phase 2)
      case 'solverBandit':
      case 'attentionMetrics':
        return true;

      // Attention + optimization — enabled if agentdb available (ADR-0061 Phase 3-4)
      case 'selfAttention':
      case 'crossAttention':
      case 'multiHeadAttention':
      case 'attentionService':
      case 'nativeAccelerator':
      case 'enhancedEmbeddingService':
      case 'auditLogger':
      case 'queryOptimizer':
        return this.agentdb !== null;

      // Advanced controllers — enabled if agentdb available (ADR-0061 Phase 5)
      case 'selfLearningRvfBackend':
      case 'quantizedVectorStore':
        return this.agentdb !== null;

      // Federated learning — only useful in multi-agent swarms
      case 'federatedLearningManager':
        return false;

      // Security infrastructure — always enabled (ADR-0061 Phase 6)
      case 'resourceTracker':
      case 'rateLimiter':
      case 'circuitBreaker':
      case 'telemetryManager':
        return true;

      // Optional controllers
      case 'hybridSearch':
      case 'agentMemoryScope':
      case 'sonaTrajectory':
      case 'federatedSession':
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
        if (!this.backend) return null;
        const config = this.config.memory?.learningBridge || {};
        const bridge = new LearningBridge(this.backend, {
          sonaMode: config.sonaMode || this.config.neural?.sonaMode || 'balanced',
          confidenceDecayRate: config.confidenceDecayRate,
          accessBoostAmount: config.accessBoostAmount,
          consolidationThreshold: config.consolidationThreshold,
          enabled: true,
        });
        return bridge;
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
        return graph;
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
        return cache;
      }

      case 'hybridSearch': {
        // BM25 + HNSW reciprocal rank fusion (ADR-0068 W4-3)
        try {
          const { HybridSearchController } = await import('./controllers/hybrid-search.js');
          const backend = this.get('vectorBackend') ?? this.agentdb;
          return new HybridSearchController(backend);
        } catch { return null; }
      }

      case 'agentMemoryScope': {
        // Agent memory scoping — returns scope config from project settings
        // AgentMemoryScope is a type ('project'|'local'|'user'), not a class.
        // The "controller" returns the active scope from config.
        const scope = this.config?.agentMemoryScope ?? 'project';
        return { name: 'agentMemoryScope', scope, getScope: () => scope };
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
          return router;
        } catch { return null; }
      }

      case 'sonaTrajectory':
        // SonaTrajectoryService — delegate to AgentDB, fallback to direct construction (ADR-0061 Bug #7)
        if (this.agentdb && typeof this.agentdb.getController === 'function') {
          try {
            const ctrl = this.agentdb.getController('sonaTrajectory');
            if (ctrl) return ctrl;
          } catch { /* fall through to direct construction */ }
        }
        try {
          const agentdbModule: any = await import('agentdb');
          const STS = agentdbModule.SonaTrajectoryService;
          if (!STS) return null;
          const svc = new STS();
          if (typeof svc.initialize === 'function') await svc.initialize();
          return svc;
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
          return hm;
        } catch {
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
          return mc;
        } catch {
          return this.createConsolidationStub();
        }
      }

      case 'federatedSession': {
        // Shared session transport with LWW conflict resolution (ADR-0068 W4-3)
        try {
          const { FederatedSessionController } = await import('./controllers/federated-session.js');
          const backend = this.get('vectorBackend') ?? this.agentdb;
          return new FederatedSessionController(backend);
        } catch { return null; }
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
          return this.agentdb.getController(name) ?? null;
        } catch { return null; }
      }

      case 'nightlyLearner': {
        // ADR-0068 W2-3: Delegate to AgentDB first, fall back to direct construction
        // only when AgentDB does not yet expose nightlyLearner.
        if (!this.agentdb) return null;
        if (typeof this.agentdb.getController === 'function') {
          try {
            const ctrl = this.agentdb.getController('nightlyLearner');
            if (ctrl) return ctrl;
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
          return new NL(
            this.agentdb.database,
            this.createEmbeddingService(),
            { ENABLE_FLASH_CONSOLIDATION: hasAttention },
            this.get('causalGraph') || undefined,
            this.get('reflexion') || undefined,
            this.get('skills') || undefined,
          );
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
          return new BO(this.agentdb.database, embedder);
        } catch { return null; }
      }

      case 'contextSynthesizer': {
        // ContextSynthesizer.synthesize is static — return the class itself
        try {
          const agentdbModule: any = await import('agentdb');
          return agentdbModule.ContextSynthesizer ?? null;
        } catch { return null; }
      }

      case 'mmrDiversityRanker': {
        // MMRDiversityRanker is static-only — return class reference (ADR-0061 Bug #5)
        try {
          const agentdbModule: any = await import('agentdb');
          return agentdbModule.MMRDiversityRanker ?? null;
        } catch { return null; }
      }

      case 'mutationGuard': {
        // ADR-0068 W2-3: Delegate to AgentDB; fall back to direct construction
        if (!this.agentdb) return null;
        if (typeof this.agentdb.getController === 'function') {
          try {
            const ctrl = this.agentdb.getController('mutationGuard');
            if (ctrl) return ctrl;
          } catch { /* fall through to direct construction */ }
        }
        // Fallback: direct construction (AgentDB < alpha.12)
        try {
          const agentdbModule: any = await import('agentdb');
          const MG = agentdbModule.MutationGuard;
          if (!MG) return null;
          const mg = new MG({ dimension: this.resolvedDimension });
          await mg.initialize();
          return mg;
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
          return new AL(this.agentdb.database);
        } catch { return null; }
      }

      case 'gnnService': {
        // GNNService exported from agentdb 3.0.0-alpha.10 (ADR-062)
        // Constructor: (config?) — requires initialize() after construction
        try {
          const agentdbModule: any = await import('agentdb');
          const GNN = agentdbModule.GNNService;
          if (!GNN) return null;
          const gnn = new GNN({ inputDim: this.resolvedDimension });
          await gnn.initialize();
          return gnn;
        } catch { return null; }
      }

      case 'rvfOptimizer': {
        // RVFOptimizer exported from agentdb 3.0.0-alpha.10 (ADR-062/065)
        // Constructor: (config?) — no-arg for defaults
        try {
          const agentdbModule: any = await import('agentdb');
          const RVF = agentdbModule.RVFOptimizer;
          if (!RVF) return null;
          return new RVF();
        } catch { return null; }
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
          return new GVB(vb, guard, log || undefined);
        } catch { return null; }
      }

      case 'vectorBackend':
      case 'graphAdapter': {
        // These are accessed via AgentDB internal state, not direct construction
        if (!this.agentdb) return null;
        try {
          if (typeof this.agentdb.getController === 'function') {
            return this.agentdb.getController(name) ?? null;
          }
        } catch { /* fallthrough */ }
        return null;
      }

      // ----- ADR-0061 Phase 2: Pure JS controllers -----
      case 'solverBandit': {
        try {
          const agentdbModule: any = await import('agentdb');
          const SB = agentdbModule.SolverBandit;
          if (!SB) return null;
          const sbCfg = this.config.solverBandit || {};
          return new SB({
            costWeight: sbCfg.costWeight,
            costDecay: sbCfg.costDecay,
            explorationBonus: sbCfg.explorationBonus,
          });
        } catch { return null; }
      }

      case 'attentionMetrics': {
        try {
          const agentdbModule: any = await import('agentdb');
          const AMC = agentdbModule.AttentionMetricsCollector;
          if (!AMC) return null;
          return new AMC();
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
          return new SAC(vb || null, { topK: saCfg.topK ?? 10 });
        } catch { return null; }
      }

      case 'crossAttention': {
        try {
          const agentdbModule: any = await import('agentdb');
          const CAC = agentdbModule.CrossAttentionController;
          if (!CAC) return null;
          const vb = this.get('vectorBackend');
          return new CAC(vb || null);
        } catch { return null; }
      }

      case 'multiHeadAttention': {
        try {
          const agentdbModule: any = await import('agentdb');
          const MHA = agentdbModule.MultiHeadAttentionController;
          if (!MHA) return null;
          const vb = this.get('vectorBackend');
          const mhaCfg = this.config.multiHeadAttention || {};
          return new MHA(vb || null, {
            numHeads: mhaCfg.numHeads ?? 8,
            topK: mhaCfg.topK ?? 10,
          });
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
          return svc;
        } catch { return null; }
      }

      // ----- ADR-0061 Phase 4: Optimization -----
      case 'queryOptimizer': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const QO = agentdbModule.QueryOptimizer;
          if (!QO) return null;
          return new QO(this.agentdb.database);
        } catch { return null; }
      }

      case 'enhancedEmbeddingService': {
        try {
          const agentdbModule: any = await import('agentdb');
          const EES = agentdbModule.EnhancedEmbeddingService;
          if (!EES) return null;
          return new EES();
        } catch { return null; }
      }

      case 'quantizedVectorStore': {
        try {
          const agentdbModule: any = await import('agentdb');
          const QVS = agentdbModule.QuantizedVectorStore;
          if (!QVS) return null;
          return new QVS({ type: this.config.quantizedVectorStore?.type ?? 'scalar-8bit' });
        } catch { return null; }
      }

      // ----- ADR-0061 Phase 5: Self-learning -----
      case 'nativeAccelerator': {
        // Singleton pattern (ADR-0061 S9 verified)
        try {
          const agentdbModule: any = await import('agentdb');
          const getAcc = agentdbModule.getAccelerator;
          if (!getAcc) return null;
          return await getAcc();
        } catch { return null; }
      }

      case 'selfLearningRvfBackend': {
        // Private constructor — must use static factory (ADR-0061 Bug #10)
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const SLRB = agentdbModule.SelfLearningRvfBackend;
          if (!SLRB) return null;
          const dbPath = this.config.dbPath || ':memory:';
          const storagePath = dbPath === ':memory:' ? ':memory:' : dbPath.replace(/\.db$/, '-rvf.sqlite');
          return await SLRB.create({
            dimension: this.resolvedDimension,
            storagePath,
            learning: true,
          });
        } catch { return null; }
      }

      case 'federatedLearningManager': {
        try {
          const agentdbModule: any = await import('agentdb');
          const FLM = agentdbModule.FederatedLearningManager;
          if (!FLM) return null;
          return new FLM({ agentId: this.config.agentId || `agent-${Date.now().toString(36)}` });
        } catch { return null; }
      }

      // ----- ADR-0061 Phase 6: Security infrastructure -----
      case 'resourceTracker': {
        try {
          const agentdbModule: any = await import('agentdb');
          const RT = agentdbModule.ResourceTracker;
          if (!RT) return null;
          return new RT();
        } catch { return null; }
      }

      case 'rateLimiter': {
        try {
          const agentdbModule: any = await import('agentdb');
          const RL = agentdbModule.RateLimiter;
          if (!RL) return null;
          const rlCfg = this.config.rateLimiter || {};
          const maxTokens = rlCfg.maxRequests || 100;
          const windowMs = rlCfg.windowMs || 1000;
          const refillRate = Math.max(1, Math.round(maxTokens / (windowMs / 1000)));
          return new RL(maxTokens, refillRate);
        } catch { return null; }
      }

      case 'circuitBreaker': {
        try {
          const agentdbModule: any = await import('agentdb');
          const CB = agentdbModule.CircuitBreaker;
          if (!CB) return null;
          const cbCfg = this.config.circuitBreaker || {};
          return new CB(cbCfg.failureThreshold || 5, cbCfg.resetTimeoutMs || 60000);
        } catch { return null; }
      }

      case 'telemetryManager': {
        try {
          const agentdbModule: any = await import('agentdb');
          const TM = agentdbModule.TelemetryManager;
          if (!TM) return null;
          return TM.getInstance();
        } catch { return null; }
      }

      case 'auditLogger': {
        try {
          const agentdbModule: any = await import('agentdb');
          const AL = agentdbModule.AuditLogger;
          if (!AL) return null;
          return new AL();
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
   */
  private createEmbeddingService(): any {
    // ADR-0062 P1-1: Reuse AgentDB's real embedder when available
    if (this.realEmbedder) return this.realEmbedder;

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
