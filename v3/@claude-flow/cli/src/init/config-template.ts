// ADR-0069: config template for init command

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
}

/**
 * Minimal config for `init` (default) — essential deployment keys only.
 * Produces ~25 lines of JSON when serialised.
 *
 * @param overrides - Optional values that replace built-in defaults
 * @returns A plain object ready for `JSON.stringify`
 */
export function getMinimalConfigTemplate(
  overrides?: ConfigOverrides,
): Record<string, unknown> {
  return {
    version: '3.0.0',
    swarm: {
      topology: 'hierarchical-mesh',
      maxAgents: overrides?.maxAgents ?? 15,
      autoScale: { enabled: true },
      coordinationStrategy: 'consensus',
    },
    memory: {
      backend: 'hybrid',
      similarityThreshold: overrides?.similarityThreshold ?? 0.7,
    },
    neural: {
      enabled: true,
      modelPath: '.claude-flow/neural',
    },
    mcp: {},
    ports: {
      mcp: overrides?.port ?? 3000,
    },
    hooks: {
      enabled: true,
      autoExecute: true,
    },
  };
}

/**
 * Full config for `init --full` — all ADR-0069 keys with documented defaults.
 * Produces ~180 lines of JSON when serialised.
 *
 * @param overrides - Optional values that replace built-in defaults
 * @returns A plain object ready for `JSON.stringify`
 */
export function getFullConfigTemplate(
  overrides?: ConfigOverrides,
): Record<string, unknown> {
  const minimal = getMinimalConfigTemplate(overrides);

  return {
    ...minimal,
    swarm: {
      ...(minimal.swarm as Record<string, unknown>),
    },
    memory: {
      backend: 'hybrid',
      maxElements: 100000,
      swarmDir: '.swarm',
      migrationBatchSize: 500,
      similarityThreshold: overrides?.similarityThreshold ?? 0.7,
      dedupThreshold: 0.95,
      embeddingCacheSize: 1000,
      cleanupIntervalMs: 60000,
      storage: { maxEntries: 100000 },
      sqlite: {
        cacheSize: -64000,
        busyTimeoutMs: 5000,
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      },
      learningBridge: {
        enabled: true,
        sonaMode: 'balanced',
        confidenceDecayRate: 0.0008,
        accessBoostAmount: 0.05,
        consolidationThreshold: 8,
      },
      memoryGraph: {
        enabled: true,
        pageRankDamping: 0.85, // ADR-0080: aligned with settings-generator
        maxNodes: 10000,
        similarityThreshold: 0.25, // intentionally lower than memory.similarityThreshold (0.7) — graph edges need permissive matching for dense PageRank connectivity
      },
    },
    neural: {
      enabled: true,
      modelPath: '.claude-flow/neural',
      ewcLambda: 2000,
      defaultLearningRate: 0.001,
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
      },
    },
    ports: {
      mcp: overrides?.port ?? 3000,
      mcpWebSocket: 3001,
      quic: 4433,
      federation: 8443,
      health: 8080,
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
    // ADR-0069: embeddings config (also written to embeddings.json by `embeddings init`)
    embeddings: {
      model: overrides?.embeddingModel ?? 'Xenova/all-mpnet-base-v2',
      dimension: overrides?.embeddingDim ?? 768,
      provider: 'transformers.js',
      hnsw: {
        M: 23,
        efConstruction: 100,
        efSearch: 50,
        maxElements: 100000,
        metric: 'cosine',
      },
      hashFallbackDimension: 128,
    },
  };
}
