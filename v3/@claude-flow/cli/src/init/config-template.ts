// ADR-0069: config template for init command
// ADR-0065 / ADR-0068 / ADR-0070: expanded tuning sections and memory.type alias

/**
 * Optional overrides applied when generating config templates.
 * Callers pass these to customise the generated configuration
 * without touching the structural defaults.
 */
export interface ConfigOverrides {
  port?: number;
  similarityThreshold?: number;
  maxAgents?: number;
  embeddingModel?: string;
  embeddingDim?: number;
  sonaMode?: string;
  confidenceDecayRate?: number;
  accessBoostAmount?: number;
  consolidationThreshold?: number;
  pageRankDamping?: number;
}

/**
 * Minimal config for `init` (default) — essential deployment keys only.
 * Produces ~40 lines of JSON when serialised.
 *
 * @param overrides - Optional values that replace built-in defaults
 * @returns A plain object ready for `JSON.stringify`
 */
export function getMinimalConfigTemplate(
  overrides?: ConfigOverrides,
): Record<string, unknown> {
  const port = overrides?.port ?? 3000;
  const similarityThreshold = overrides?.similarityThreshold ?? 0.7;
  const maxAgents = overrides?.maxAgents ?? 15;

  return {
    version: '3.0.0',
    swarm: {
      topology: 'hierarchical-mesh',
      maxAgents,
      autoScale: { enabled: true },
      coordinationStrategy: 'consensus',
    },
    memory: {
      backend: 'hybrid',
      type: 'hybrid', // ADR-0065: alias alongside backend for forward compat
      maxElements: 100000,
      swarmDir: '.swarm',
      similarityThreshold,
      dedupThreshold: 0.95,
      embeddingCacheSize: 1000,
      cleanupIntervalMs: 60000,
    },
    neural: {
      enabled: true,
      modelPath: '.claude-flow/neural',
      ewcLambda: 2000,
      defaultLearningRate: 0.001,
      qualityThreshold: 0.5,
    },
    mcp: {
      autoStart: true,
      transport: { port }, // ADR-0065: mcp.transport.port, not flat mcp.port
    },
    ports: {
      mcp: port,
      mcpWebSocket: 3001,
      quic: 4433,
      federation: 8443,
      health: 8080,
    },
    hooks: {
      enabled: true,
      autoExecute: true,
    },
  };
}

/**
 * Full config for `init --full` — all ADR-0069 / ADR-0070 keys with
 * documented defaults. Produces ~220 lines of JSON when serialised.
 *
 * Top-level keys (11):
 *   controllers, daemon, hooks, mcp, memory, neural,
 *   ports, rateLimiter, swarm, version, workers
 *
 * Note: embeddings settings are NOT written here — `init` writes them to a
 * separate `.claude-flow/embeddings.json` via `executor.ts`.
 *
 * @param overrides - Optional values that replace built-in defaults
 * @returns A plain object ready for `JSON.stringify`
 */
export function getFullConfigTemplate(
  overrides?: ConfigOverrides,
): Record<string, unknown> {
  const minimal = getMinimalConfigTemplate(overrides);
  const minimalMemory = minimal.memory as Record<string, unknown>;
  const minimalNeural = minimal.neural as Record<string, unknown>;

  return {
    ...minimal,
    memory: {
      ...minimalMemory,
      migrationBatchSize: 500,
      sqlite: {
        cacheSize: -64000,
        busyTimeoutMs: 5000,
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      },
      storage: { maxEntries: 100000 }, // ADR-0080: canonical DEFAULT_MAX_ENTRIES
      learningBridge: {
        enabled: true,
        sonaMode: overrides?.sonaMode ?? 'balanced',
        confidenceDecayRate: overrides?.confidenceDecayRate ?? 0.0008,
        accessBoostAmount: overrides?.accessBoostAmount ?? 0.05,
        consolidationThreshold: overrides?.consolidationThreshold ?? 8,
      },
      memoryGraph: {
        enabled: true,
        pageRankDamping: overrides?.pageRankDamping ?? 0.82, // ADR-0070: align with adr0069 T-series
        maxNodes: 10000,
        similarityThreshold: 0.25, // intentionally lower than memory.similarityThreshold (0.7) — graph edges need permissive matching for dense PageRank connectivity
      },
      // ADR-0080 P2: embeddings config mirror (source of truth is .claude-flow/embeddings.json
      //   written by executor.ts). Kept here for adr0080-maxelements source-inspection tests
      //   and for tooling that reads only config.json.
      embeddings: {
        model: 'Xenova/all-mpnet-base-v2',
        dimension: 768,
        provider: 'transformers.js',
        hnsw: {
          metric: 'cosine',
          maxElements: 100000,
          M: 23, // ADR-0065: uppercase to match resolve-config canonical
          efConstruction: 100,
          efSearch: 50,
        },
      },
    },
    neural: {
      ...minimalNeural,
      learningRates: {
        qLearning: 0.1,
        sarsa: 0.1,
        moe: 0.01,
        sona: 0.001,
        lora: 0.001,
      },
    },
    controllers: {
      enabled: {
        reasoningBank: true,
        causalRecall: true,
        nightlyLearner: true,
        queryOptimizer: false,
        auditLogger: false,
        batchOperations: false,
        attentionService: true,
        hierarchicalMemory: false,
        memoryConsolidation: false,
        hybridSearch: false,
        agentMemoryScope: true,
        federatedSession: false, // ADR-0068: deprecated controller, disabled by default
      },
      // ADR-0068 Wave 1: controller tuning sections
      nightlyLearner: {
        schedule: '0 3 * * *',
        maxPatternsPerRun: 500,
        rewardThreshold: 0.3,
        useEwcConsolidation: true,
        ewcLambda: 0.5,
      },
      causalRecall: {
        maxDepth: 5,
        minEdgeWeight: 0.1,
        temporalDecay: true,
        decayHalfLifeMs: 86400000,
      },
      queryOptimizer: {
        planCache: true,
        maxCachedPlans: 256,
        autoIndexHints: true,
        vectorCostWeight: 0.6,
      },
      selfLearningRvfBackend: {
        learningRate: 0.01,
        feedbackWindowSize: 100,
        autoRerank: true,
        minFeedbackCount: 10,
      },
      mutationGuard: {
        walEnabled: true,
        maxMutationsPerTx: 1000,
        schemaValidation: true,
        allowedNamespaces: [],
      },
      // ADR-0065: 8 attention / infra controller tuning sections
      attentionService: {
        numHeads: 8,
        useFlash: true,
        useMoE: false,
        useHyperbolic: false,
      },
      multiHeadAttention: {
        numHeads: 8,
        topK: 10,
      },
      selfAttention: {
        topK: 10,
      },
      rateLimiter: {
        maxRequests: 100,
      },
      circuitBreaker: {
        failureThreshold: 5,
        resetTimeoutMs: 60000,
      },
      tieredCache: {
        maxSize: 10000,
        ttl: 300000,
      },
      quantizedVectorStore: {
        type: 'scalar-8bit',
      },
      solverBandit: {
        costWeight: 0.3,
        costDecay: 0.05,
        explorationBonus: 0.1,
      },
    },
    rateLimiter: {
      default: { maxRequests: 100, windowMs: 60000 },
      auth: { maxRequests: 10, windowMs: 60000 },
      tools: { maxRequests: 10, windowMs: 60000 },
      memory: { maxRequests: 100, windowMs: 60000 },
      files: { maxRequests: 50, windowMs: 60000 },
    },
    workers: {
      triggers: {
        optimize: { timeoutMs: 300000, priority: 'high' },
        audit: { timeoutMs: 180000, priority: 'critical' },
        testgaps: { timeoutMs: 120000, priority: 'normal' },
        map: { timeoutMs: 300000, priority: 'normal' },
        deepdive: { timeoutMs: 300000, priority: 'normal' },
        document: { timeoutMs: 240000, priority: 'normal' },
        learning: { timeoutMs: 90000, priority: 'normal' },
        security: { timeoutMs: 120000, priority: 'normal' },
      },
    },
    daemon: {
      maxConcurrent: 2,
      workerTimeoutMs: 300000,
      headless: false,
      resourceThresholds: {
        maxCpuLoad: 28,
        minFreeMemoryPercent: 5,
      },
    },
  };
}
