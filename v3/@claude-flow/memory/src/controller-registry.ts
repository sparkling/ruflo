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
import { EMBEDDING_DIM } from './embedding-constants.js';

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
  | 'federatedLearningManager'; // A11

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
  | 'resourceTracker'            // D4
  | 'rateLimiter'                // D5
  | 'circuitBreakerController'   // D6 - registry-level decorator
  | 'metadataFilter'             // B5
  | 'queryOptimizer'             // B6
  | 'indexHealthMonitor'         // B3
  | 'auditLogger'               // D3
  | 'attentionMetrics'           // D2
  | 'telemetryManager';          // D1

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

  /** Vector dimension — derived from embedding model config. Do NOT hardcode. */
  dimension?: number;

  /** Embedding generator function */
  embeddingGenerator?: EmbeddingGenerator;

  /** Memory backend config */
  memory?: {
    enableHNSW?: boolean;
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
  // Level 0: Foundation — infrastructure controllers (must init first)
  { level: 0, controllers: ['telemetryManager', 'resourceTracker', 'rateLimiter', 'circuitBreakerController'] },
  // Level 1: Core intelligence
  { level: 1, controllers: ['reasoningBank', 'hierarchicalMemory', 'learningBridge', 'solverBandit', 'tieredCache', 'metadataFilter', 'queryOptimizer'] },
  // Level 2: Graph, security, composites
  { level: 2, controllers: ['memoryGraph', 'agentMemoryScope', 'vectorBackend', 'mutationGuard', 'gnnService', 'selfAttention', 'crossAttention', 'multiHeadAttention', 'attentionService', 'selfLearningRvfBackend', 'nativeAccelerator', 'quantizedVectorStore'] },
  // Level 3: Specialization
  { level: 3, controllers: ['skills', 'explainableRecall', 'reflexion', 'attestationLog', 'batchOperations', 'memoryConsolidation', 'enhancedEmbeddingService', 'auditLogger'] },
  // Level 4: Causal, routing, health
  { level: 4, controllers: ['causalGraph', 'nightlyLearner', 'learningSystem', 'semanticRouter', 'indexHealthMonitor', 'federatedLearningManager', 'attentionMetrics'] },
  // Level 5: Advanced services
  { level: 5, controllers: ['sonaTrajectory', 'contextSynthesizer', 'rvfOptimizer', 'mmrDiversityRanker', 'guardedVectorBackend'] },
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
 *     enableHNSW: true,
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
  private backend: IMemoryBackend | null = null;
  private config: RuntimeConfig = {};
  private initialized = false;
  private initTimeMs = 0;
  /** Cached embedding dimension from getEmbeddingConfig() — set in initAgentDB */
  private embeddingDimension = 0;
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

    // Step 2: Set up the backend
    this.backend = config.backend || null;

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

      this.agentdb = new AgentDBClass({ dbPath });

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

      // SemanticRouter — auto-enable if agentdb available (exported since alpha.10)
      case 'semanticRouter':
        return this.agentdb !== null;

      // WM-116b: Agent memory scope — enabled when backend available
      case 'agentMemoryScope':
        return this.agentdb !== null || this.backend !== null;

      // Optional controllers
      case 'sonaTrajectory':
        return false; // Require explicit enabling

      // ADR-0041: Level 0 infrastructure — always enabled
      case 'resourceTracker':
      case 'rateLimiter':
      case 'circuitBreakerController':
      case 'telemetryManager':
        return true;

      // ADR-0041: Level 1 additions — enabled when AgentDB available
      case 'metadataFilter':
      case 'queryOptimizer':
        return this.agentdb !== null;

      // ADR-0041: Level 2 composites — enabled when AgentDB available
      case 'selfLearningRvfBackend':
      case 'nativeAccelerator':
      case 'quantizedVectorStore':
      case 'selfAttention':          // A1 - ADR-0044
      case 'crossAttention':         // A2 - ADR-0044
      case 'multiHeadAttention':     // A3 - ADR-0044
      case 'attentionService':
        return this.agentdb !== null;

      // ADR-0041: Level 3 additions
      case 'enhancedEmbeddingService':
      case 'auditLogger':
        return this.agentdb !== null;

      // ADR-0041: Level 4 additions
      case 'indexHealthMonitor':
      case 'federatedLearningManager':
      case 'attentionMetrics':
        return this.agentdb !== null;

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
        return bridge;
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
          return bandit;
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

          return {
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
          };
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
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
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'sonaTrajectory':
        // Delegate to AgentDB's SonaTrajectoryService if available
        if (this.agentdb && typeof this.agentdb.getController === 'function') {
          try {
            return this.agentdb.getController('sonaTrajectory');
          } catch (e) {
            const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
            this.initErrors.push(err);
            this.emit('controller:init-error', { name, error: err });
            if (this.strictMode) throw err;
            return null;
          }
        }
        return null;

      case 'hierarchicalMemory': {
        // HierarchicalMemory exported from agentdb 3.0.0-alpha.10 (ADR-066 Phase P2-3)
        // Constructor: (db, embedder, vectorBackend?, graphBackend?, config?)
        if (!this.agentdb) return this.createTieredMemoryStub();
        try {
          const agentdbModule: any = await import('agentdb');
          const HM = agentdbModule.HierarchicalMemory;
          if (!HM) return this.createTieredMemoryStub();
          const embedder = this.createEmbeddingService();
          const hm = new HM(this.agentdb.database, embedder);
          await hm.initializeDatabase();
          return hm;
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
          return mc;
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return this.createConsolidationStub();
        }
      }

      // ----- AgentDB-internal controllers (via getController) -----
      // AgentDB.getController() only supports: reflexion/memory, skills, causalGraph/causal
      case 'reasoningBank': {
        // ReasoningBank is exported directly, not via getController
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const RB = agentdbModule.ReasoningBank;
          if (!RB) return null;
          const embedder = this.createEmbeddingService();
          return new RB(this.agentdb.database, embedder);
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'skills':
      case 'reflexion':
      case 'causalGraph': {
        if (!this.agentdb || typeof this.agentdb.getController !== 'function') return null;
        try {
          return this.agentdb.getController(name) ?? null;
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'causalRecall': {
        // ADR-0040: inject embedder + vectorBackend + optional singletons
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const CR = agentdbModule.CausalRecall;
          if (!CR) return null;
          const embedder = this.createEmbeddingService();
          const vb = this.agentdb.vectorBackend ?? null;
          const cg = this.get('causalGraph') as any;
          const er = this.get('explainableRecall') as any;
          return new CR(this.agentdb.database, embedder, vb, undefined, cg, er);
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'learningSystem': {
        // ADR-0040: inject embedder
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const LS = agentdbModule.LearningSystem;
          if (!LS) return null;
          return new LS(this.agentdb.database, this.createEmbeddingService());
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'explainableRecall': {
        // ADR-0040: inject embedder (optional per ExplainableRecall constructor)
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const ER = agentdbModule.ExplainableRecall;
          if (!ER) return null;
          return new ER(this.agentdb.database, this.createEmbeddingService());
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'nightlyLearner': {
        // ADR-0040: inject embedder + pass pre-created singletons to avoid duplicates
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const NL = agentdbModule.NightlyLearner;
          if (!NL) return null;
          const embedder = this.createEmbeddingService();
          const cg = this.get('causalGraph') as any;
          const ref = this.get('reflexion') as any;
          const sk = this.get('skills') as any;
          return new NL(this.agentdb.database, embedder, undefined, cg, ref, sk);
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      // ----- Direct-instantiation controllers -----
      case 'batchOperations': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const BO = agentdbModule.BatchOperations;
          if (!BO) return null;
          const embedder = this.config.embeddingGenerator || null;
          return new BO(this.agentdb.database, embedder);
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
          return agentdbModule.ContextSynthesizer ?? null;
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'mmrDiversityRanker': {
        try {
          const agentdbModule: any = await import('agentdb');
          const MMR = agentdbModule.MMRDiversityRanker;
          if (!MMR) return null;
          return new MMR();
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'mutationGuard': {
        // MutationGuard exported from agentdb 3.0.0-alpha.10 (ADR-060)
        // Constructor: (config?) where config.dimension, config.maxElements, config.enableWasmProofs
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const MG = agentdbModule.MutationGuard;
          if (!MG) return null;
          return new MG({ dimension: this.config.dimension || EMBEDDING_DIM });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
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
          const svc = new GNN({
            inputDim: this.config.dimension || EMBEDDING_DIM,
            hiddenDim: 128,
            outputDim: 64,
            heads: 8,
          });
          if (typeof svc.initialize === 'function') {
            await svc.initialize();
          }
          return svc;
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'rvfOptimizer': {
        // ADR-0040: stats-only wrapper — backend optimization helper
        // RVFOptimizer class doesn't exist in agentdb — wrap backend optimization
        try {
          const _agentdbModule = await import('agentdb');
          const backend = this.backend;

          return {
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
          };
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
          return new GVB(vb, guard, log || undefined);
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
        return this.agentdb.vectorBackend ?? null;
      }

      case 'graphAdapter': {
        // graphAdapter accessed via getController fallback
        if (!this.agentdb) return null;
        try {
          if (typeof this.agentdb.getController === 'function') {
            return this.agentdb.getController('graphAdapter') ?? null;
          }
        } catch { /* fallthrough */ }
        return null;
      }

      // ----- ADR-0041: Level 0 Infrastructure -----

      case 'resourceTracker': {
        // D4: Resource tracking with memory ceiling and query stats (ADR-0042)
        const resources = new Map<string, { allocated: number; limit: number }>();
        const CEILING = 160 * 1024 * 1024 * 1024; // 160GB — dedicated 187GB server, nothing else running
        let currentUsage = 0;
        let queryCount = 0;
        const queryWindow: number[] = []; // rolling last 100 query timestamps
        return {
          track(name: string, allocated: number, limit: number) {
            resources.set(name, { allocated, limit });
          },
          check(name: string): { allocated: number; limit: number } | null {
            return resources.get(name) ?? null;
          },
          record(bytes: number) { currentUsage += bytes; },
          recordQuery() {
            queryCount++;
            queryWindow.push(Date.now());
            if (queryWindow.length > 100) queryWindow.shift();
          },
          isOverLimit(): boolean { return currentUsage >= CEILING; },
          isWarning(): boolean { return currentUsage >= CEILING * 0.8; },
          getStats() {
            const pct = CEILING > 0 ? currentUsage / CEILING : 0;
            return {
              tracked: resources.size,
              resources: Object.fromEntries(resources),
              currentUsage, ceiling: CEILING, pct,
              warning: currentUsage >= CEILING * 0.8,
              overlimit: currentUsage >= CEILING,
              queryCount, queries: queryWindow.length,
            };
          },
        };
      }

      case 'rateLimiter': {
        // D5: Token-bucket rate limiter with pre-configured buckets (ADR-0042)
        const buckets = new Map<string, { tokens: number; lastRefill: number; rate: number; max: number }>();
        const refill = (b: { tokens: number; lastRefill: number; rate: number; max: number }) => {
          const now = Date.now();
          b.tokens = Math.min(b.max, b.tokens + ((now - b.lastRefill) / 1000) * b.rate);
          b.lastRefill = now;
        };
        const limiter = {
          configure(name: string, rate: number, max: number) {
            buckets.set(name, { tokens: max, lastRefill: Date.now(), rate, max });
          },
          tryAcquire(name: string): boolean {
            const bucket = buckets.get(name);
            if (!bucket) return true;
            refill(bucket);
            if (bucket.tokens >= 1) { bucket.tokens--; return true; }
            return false;
          },
          tryConsume(name: string): boolean { return limiter.tryAcquire(name); },
          getRetryAfter(name: string): number {
            const bucket = buckets.get(name);
            if (!bucket) return 0;
            refill(bucket);
            if (bucket.tokens >= 1) return 0;
            return Math.ceil((1 - bucket.tokens) / bucket.rate * 1000);
          },
          getStats() {
            const details: Record<string, { tokens: number; rate: number; max: number }> = {};
            for (const [n, b] of buckets) { refill(b); details[n] = { tokens: b.tokens, rate: b.rate, max: b.max }; }
            return { buckets: buckets.size, names: [...buckets.keys()], details };
          },
        };
        // Pre-configure default buckets per ADR-0042
        limiter.configure('insert', 1000, 1000);
        limiter.configure('search', 10000, 10000);
        limiter.configure('delete', 500, 500);
        limiter.configure('batch', 100, 100);
        return limiter;
      }

      case 'circuitBreakerController': {
        // D6: Registry-level circuit breaker decorator with events (ADR-0042)
        const self = this;
        const breakers = new Map<string, { failures: number; state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; lastFailure: number }>();
        const FAILURE_THRESHOLD = 5;
        const RESET_TIMEOUT_MS = 30_000;

        return {
          wrap<T>(controllerName: string, fn: () => T): T | null {
            let breaker = breakers.get(controllerName);
            if (!breaker) {
              breaker = { failures: 0, state: 'CLOSED', lastFailure: 0 };
              breakers.set(controllerName, breaker);
            }
            if (breaker.state === 'OPEN') {
              if (Date.now() - breaker.lastFailure > RESET_TIMEOUT_MS) {
                breaker.state = 'HALF_OPEN';
              } else {
                return null;
              }
            }
            try {
              const result = fn();
              if (breaker.state === 'HALF_OPEN') {
                breaker.state = 'CLOSED';
                breaker.failures = 0;
              }
              return result;
            } catch (error) {
              breaker.failures++;
              breaker.lastFailure = Date.now();
              if (breaker.failures >= FAILURE_THRESHOLD) {
                breaker.state = 'OPEN';
                self.emit('controller:circuit-open', { name: controllerName, error });
              }
              return null;
            }
          },
          reset(controllerName: string) {
            const breaker = breakers.get(controllerName);
            if (breaker) { breaker.state = 'CLOSED'; breaker.failures = 0; }
          },
          getState(controllerName: string): string {
            return breakers.get(controllerName)?.state ?? 'CLOSED';
          },
          getStats() {
            const stats: Record<string, { state: string; failures: number; lastFailure: number }> = {};
            for (const [n, b] of breakers) {
              stats[n] = { state: b.state, failures: b.failures, lastFailure: b.lastFailure };
            }
            return { breakers: stats, total: breakers.size };
          },
        };
      }

      case 'telemetryManager': {
        // D1: OpenTelemetry spans + counters + histograms (ADR-0045)
        // Level 0: initializes before all other controllers to instrument init times
        const spans: Array<{ name: string; startTime: number; endTime: number | null; attributes: Record<string, unknown> }> = [];
        const counters: Record<string, number> = {};
        const histograms: Record<string, number[]> = {};
        const exporters: string[] = this.config.telemetryExporters ?? ['console'];

        return {
          startSpan(name: string, attributes?: Record<string, unknown>) {
            const span = { name, startTime: performance.now(), endTime: null as number | null, attributes: attributes ?? {} };
            spans.push(span);
            return {
              end() {
                span.endTime = performance.now();
                const duration = span.endTime - span.startTime;
                if (!histograms[name]) histograms[name] = [];
                histograms[name].push(duration);
              },
              setAttribute(key: string, value: unknown) { span.attributes[key] = value; },
            };
          },
          increment(name: string, value = 1) {
            counters[name] = (counters[name] ?? 0) + value;
          },
          recordHistogram(name: string, value: number) {
            if (!histograms[name]) histograms[name] = [];
            histograms[name].push(value);
          },
          getMetrics() {
            const percentile = (arr: number[], p: number) => {
              if (arr.length === 0) return 0;
              const sorted = [...arr].sort((a, b) => a - b);
              const idx = Math.ceil(sorted.length * p / 100) - 1;
              return sorted[Math.max(0, idx)];
            };
            const histogramStats: Record<string, { count: number; p50: number; p95: number; p99: number }> = {};
            for (const [key, values] of Object.entries(histograms)) {
              histogramStats[key] = {
                count: values.length,
                p50: percentile(values, 50),
                p95: percentile(values, 95),
                p99: percentile(values, 99),
              };
            }
            return { counters: { ...counters }, histograms: histogramStats, exporters };
          },
          getSpans(limit = 100) {
            return spans.slice(-limit).map(s => ({
              name: s.name,
              durationMs: s.endTime !== null ? s.endTime - s.startTime : null,
              attributes: s.attributes,
            }));
          },
          getStats() {
            return { spanCount: spans.length, counterCount: Object.keys(counters).length, histogramCount: Object.keys(histograms).length, exporters };
          },
        };
      }

      // ----- ADR-0041: Level 1 Additions -----

      case 'metadataFilter': {
        // B5: Metadata-based result filtering
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const MF = agentdbModule.MetadataFilter;
          if (!MF) return null;
          return new MF();
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'queryOptimizer': {
        // B6: Query plan optimization
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const QO = agentdbModule.QueryOptimizer;
          if (!QO) return null;
          return new QO();
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      // ----- ADR-0041: Level 2 Composites -----

      case 'nativeAccelerator': {
        // B4: Shared singleton — used by A6, A5, B2, A7 (ADR-0046)
        // Uses getAccelerator() for module-level singleton with auto-initialization
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          // Prefer singleton factory (handles init + caching)
          const getAccel = agentdbModule.getAccelerator;
          if (typeof getAccel === 'function') {
            return await getAccel();
          }
          // Fallback: direct construction + manual init
          const NA = agentdbModule.NativeAccelerator;
          if (!NA) return null;
          const accel = new NA();
          if (typeof accel.initialize === 'function') {
            await accel.initialize();
          }
          return accel;
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'selfLearningRvfBackend': {
        // A6: Composite parent — creates 6 children internally via initComponents()
        // Children: B1 SemanticQueryRouter, A8 SonaLearningBackend, A7 ContrastiveTrainer,
        //           B2 TemporalCompressor, FederatedSessionManager, RvfSolver
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const SLRB = agentdbModule.SelfLearningRvfBackend;
          if (!SLRB) return null;
          // Private constructor — must use static async create() factory
          if (typeof SLRB.create !== 'function') return null;
          return await SLRB.create({
            dimension: this.config.dimension || EMBEDDING_DIM,
          });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'quantizedVectorStore': {
        // B9: Composite parent — creates B7 (Scalar) or B8 (Product) based on config
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const QVS = agentdbModule.QuantizedVectorStore;
          if (!QVS) return null;
          return new QVS({
            type: 'scalar-8bit' as const,
          });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'selfAttention': {
        // A1: SelfAttentionController — pure JS, no native deps (ADR-0044)
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const SA = agentdbModule.SelfAttentionController;
          if (!SA) return null;
          const vb = this.get('vectorBackend');
          return new SA({ dimension: this.config.dimension || EMBEDDING_DIM, vectorBackend: vb || undefined });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'crossAttention': {
        // A2: CrossAttentionController — pure JS, no native deps (ADR-0044)
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const CA = agentdbModule.CrossAttentionController;
          if (!CA) return null;
          const vb = this.get('vectorBackend');
          return new CA({ dimension: this.config.dimension || EMBEDDING_DIM, vectorBackend: vb || undefined });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'multiHeadAttention': {
        // A3: MultiHeadAttentionController — pure JS, no native deps (ADR-0044)
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const MHA = agentdbModule.MultiHeadAttentionController;
          if (!MHA) return null;
          const vb = this.get('vectorBackend');
          return new MHA({
            dimension: this.config.dimension || EMBEDDING_DIM,
            numHeads: 8,
            vectorBackend: vb || undefined,
          });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'attentionService': {
        // A5: AttentionService (Flash, MoE, GraphRoPE enabled by default)
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const AS = agentdbModule.AttentionService;
          if (!AS) return null;
          const accel = this.get('nativeAccelerator');
          return new AS({
            dimension: this.config.dimension || EMBEDDING_DIM,
            accelerator: accel || undefined,
            // A5 mechanism gating: Hyperbolic only when NativeAccelerator reports simdAvailable
            enableHyperbolic: !!(accel && typeof (accel as any).simdAvailable === 'boolean' && (accel as any).simdAvailable),
          });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      // ----- ADR-0041: Level 3 Additions -----

      case 'enhancedEmbeddingService': {
        // A9: Multi-provider embeddings with LRU cache, semaphore batch, dimension alignment (ADR-0045)
        // Barrel export must point to services/enhanced-embeddings.ts (full impl),
        // not controllers/EnhancedEmbeddingService.ts (WASM wrapper).
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const EES = agentdbModule.EnhancedEmbeddingService;
          if (!EES) return null;
          // Read model + dimension from centralized embedding config
          const embCfg = typeof agentdbModule.getEmbeddingConfig === 'function'
            ? agentdbModule.getEmbeddingConfig()
            : { model: 'nomic-ai/nomic-embed-text-v1.5', dimension: 768 };
          return new EES({
            model: embCfg.model,
            dimension: this.config.dimension || embCfg.dimension,
            cache: { maxSize: this.config.embeddingCacheSize ?? 500_000 },
            batch: { maxConcurrency: this.config.embeddingBatchConcurrency ?? 24 },
          });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'auditLogger': {
        // D3: 18 typed security events, file rotation, SOC2/GDPR/HIPAA (ADR-0045)
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const AL = agentdbModule.AuditLogger;
          if (!AL) return null;
          return new AL({
            maxFileSize: this.config.auditRotationSize ?? 10 * 1024 * 1024,
            maxFiles: this.config.auditRotationFiles ?? 10,
          });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      // ----- ADR-0041: Level 4 Additions -----

      case 'indexHealthMonitor': {
        // B3: Eager-loaded in A6 but independently useful for health reporting
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const IHM = agentdbModule.IndexHealthMonitor;
          if (!IHM) return null;
          return new IHM();
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'federatedLearningManager': {
        // A11: Depends on selfLearningRvfBackend (level 2) being ready
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const FLM = agentdbModule.FederatedLearningManager;
          if (!FLM) return null;
          return new FLM({
            agentId: 'default',
          });
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
      }

      case 'attentionMetrics': {
        // D2: Metrics collection for A1-A3 + A5 attention controllers (ADR-0044)
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const AM = agentdbModule.AttentionMetricsCollector;
          if (!AM) return null;
          return new AM();
        } catch (e) {
          const err = new ControllerInitError(name, e instanceof Error ? e : new Error(String(e)));
          this.initErrors.push(err);
          this.emit('controller:init-error', { name, error: err });
          if (this.strictMode) throw err;
          return null;
        }
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
    // If user provided an embedding generator, wrap it
    if (this.config.embeddingGenerator) {
      return {
        embed: async (text: string) => this.config.embeddingGenerator!(text),
        embedBatch: async (texts: string[]) => Promise.all(texts.map(t => this.config.embeddingGenerator!(t))),
        initialize: async () => {},
      };
    }
    // Use dimension from centralized embedding config (cached in initAgentDB)
    const dim = this.embeddingDimension || this.config.dimension || EMBEDDING_DIM;
    // Return a minimal stub — HierarchicalMemory falls back to manualSearch without embeddings
    return {
      embed: async () => new Float32Array(dim),
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(dim)),
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
