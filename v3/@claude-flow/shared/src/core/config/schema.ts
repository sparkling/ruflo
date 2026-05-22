/**
 * V3 Configuration Schemas
 * Zod schemas for all configuration types
 */

import { z } from 'zod';

/**
 * Agent configuration schema
 */
export const AgentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  maxConcurrentTasks: z.number().int().min(1).default(5),
  priority: z.number().int().min(0).max(100).default(50),
  timeout: z.number().int().positive().optional(),
  retryPolicy: z.object({
    maxRetries: z.number().int().min(0).default(3),
    backoffMs: z.number().int().positive().default(1000),
    backoffMultiplier: z.number().positive().default(2),
  }).optional(),
  resources: z.object({
    maxMemoryMb: z.number().int().positive().optional(),
    maxCpuPercent: z.number().min(0).max(100).optional(),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Task configuration schema
 */
export const TaskConfigSchema = z.object({
  type: z.string().min(1),
  description: z.string().min(1),
  priority: z.number().int().min(0).max(100).default(50),
  timeout: z.number().int().positive().optional(),
  assignedAgent: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  metadata: z.object({
    requiredCapabilities: z.array(z.string()).optional(),
    retryCount: z.number().int().min(0).optional(),
    maxRetries: z.number().int().min(0).optional(),
    critical: z.boolean().optional(),
    parentTaskId: z.string().optional(),
    childTaskIds: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
});

/**
 * Swarm configuration schema
 */
export const SwarmConfigSchema = z.object({
  topology: z.enum(['hierarchical', 'mesh', 'ring', 'star', 'adaptive', 'hierarchical-mesh']),
  maxAgents: z.number().int().positive().default(20),
  autoScale: z.object({
    enabled: z.boolean().default(false),
    minAgents: z.number().int().min(0).default(1),
    maxAgents: z.number().int().positive().default(20),
    scaleUpThreshold: z.number().min(0).max(1).default(0.8),
    scaleDownThreshold: z.number().min(0).max(1).default(0.3),
  }).optional(),
  coordination: z.object({
    consensusRequired: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(10000),
    retryPolicy: z.object({
      maxRetries: z.number().int().min(0).default(3),
      backoffMs: z.number().int().positive().default(500),
    }),
  }).optional(),
  communication: z.object({
    protocol: z.enum(['events', 'messages', 'shared-memory']).default('events'),
    batchSize: z.number().int().positive().default(10),
    flushIntervalMs: z.number().int().positive().default(100),
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Memory configuration schema
 */
export const MemoryConfigSchema = z.object({
  type: z.enum(['sqlite', 'agentdb', 'hybrid', 'redis', 'memory']).default('hybrid'),
  path: z.string().optional(),
  maxSize: z.number().int().positive().optional(),
  ttlMs: z.number().int().positive().optional(),
  sqlite: z.object({
    filename: z.string().optional(),
    inMemory: z.boolean().default(false),
    wal: z.boolean().default(true),
  }).optional(),
  agentdb: z.object({
    dimensions: z.number().int().positive().default(768),
    indexType: z.enum(['hnsw', 'flat', 'ivf']).default('hnsw'),
    efConstruction: z.number().int().positive().default(100),
    m: z.number().int().positive().default(23),
    quantization: z.enum(['none', 'scalar', 'product']).default('none'),
  }).optional(),
  redis: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().positive().default(6379),
    password: z.string().optional(),
    db: z.number().int().min(0).default(0),
    keyPrefix: z.string().default('claude-flow:'),
  }).optional(),
  hybrid: z.object({
    vectorThreshold: z.number().int().positive().default(100),
  }).optional(),
});

/**
 * MCP server configuration schema
 */
export const MCPServerConfigSchema = z.object({
  name: z.string().min(1).default('claude-flow'),
  version: z.string().min(1).default('3.0.0'),
  transport: z.object({
    type: z.enum(['stdio', 'http', 'websocket']).default('stdio'),
    port: z.number().int().positive().optional(),
    host: z.string().optional(),
    path: z.string().optional(),
  }),
  capabilities: z.object({
    tools: z.boolean().default(true),
    resources: z.boolean().default(true),
    prompts: z.boolean().default(true),
    logging: z.boolean().default(true),
    experimental: z.record(z.boolean()).optional(),
  }).optional(),
});

/**
 * Orchestrator configuration schema
 */
export const OrchestratorConfigSchema = z.object({
  session: z.object({
    persistSessions: z.boolean().default(true),
    dataDir: z.string().default('./data'),
    sessionRetentionMs: z.number().int().positive().default(3600000),
  }),
  health: z.object({
    checkInterval: z.number().int().positive().default(30000),
    historyLimit: z.number().int().positive().default(100),
    degradedThreshold: z.number().int().min(0).default(1),
    unhealthyThreshold: z.number().int().min(0).default(2),
  }),
  lifecycle: z.object({
    maxConcurrentAgents: z.number().int().positive().default(20),
    spawnTimeout: z.number().int().positive().default(30000),
    terminateTimeout: z.number().int().positive().default(10000),
    maxSpawnRetries: z.number().int().min(0).default(3),
  }),
});

/**
 * Full system configuration schema
 * Uses passthrough() to accept unknown extra keys from user configs
 * without failing validation (e.g., simple key-value pairs, custom fields).
 */
export const SystemConfigSchema = z.object({
  orchestrator: OrchestratorConfigSchema,
  memory: MemoryConfigSchema.optional(),
  mcp: MCPServerConfigSchema.optional(),
  swarm: SwarmConfigSchema.optional(),
}).passthrough();

// =============================================================================
// Runtime config schema (ADR-0224) — `.claude-flow/config.json` shape
// =============================================================================
//
// Distinct from SystemConfigSchema above (which models the CLI's
// `--config <file>` shape with a required `orchestrator` block). The init
// command writes a different shape under `.claude-flow/config.json` via
// `getMinimalConfigTemplate()` / `getFullConfigTemplate()`, and ~17 substrate
// callsites historically read that file directly via `JSON.parse(readFileSync)`
// with hardcoded try/catch fallbacks (the no-fallbacks anti-pattern at the
// config layer; see ADR-0224 + [[feedback-no-fallbacks]]).
//
// This schema captures the substrate-consumed leaf keys as strictly typed
// (string-where-number-expected throws at the accessor, not five layers down)
// while passing through every other key the init template emits.

/** Per-factory worker timeout (workers.factory.<type>.timeout). */
const WorkerFactoryTimeoutSchema = z.object({
  timeout: z.number().positive().optional(),
}).passthrough();

/** Memory-substrate runtime keys (see ADR-0224 callsite table). */
const RuntimeMemorySchema = z.object({
  similarityThreshold: z.number().optional(),
  cleanupIntervalMs: z.number().positive().optional(),
  dedupThreshold: z.number().optional(),
  embeddingCacheSize: z.number().positive().optional(),
  migrationBatchSize: z.number().positive().optional(),
  persistPath: z.string().optional(),
  path: z.string().optional(),
  swarmDir: z.string().optional(),
}).passthrough();

/** Neural-substrate runtime keys. */
const RuntimeNeuralSchema = z.object({
  ewcLambda: z.number().optional(),
  defaultLearningRate: z.number().positive().optional(),
  learningRates: z.object({
    qLearning: z.number().positive().optional(),
    sarsa: z.number().positive().optional(),
    moe: z.number().positive().optional(),
    sona: z.number().positive().optional(),
    lora: z.number().positive().optional(),
  }).passthrough().optional(),
}).passthrough();

/** Worker-substrate runtime keys. */
const RuntimeWorkersSchema = z.object({
  factory: z.record(WorkerFactoryTimeoutSchema).optional(),
}).passthrough();

/**
 * Runtime configuration schema for `.claude-flow/config.json`.
 *
 * The init template emits a freeform object with version/swarm/memory/neural/
 * embedding/index/mcp/ports/hooks at minimum (and controllers/rateLimiter/
 * workers/daemon in --full mode). We validate only the substrate-consumed
 * leaves strictly; everything else passes through.
 */
export const RuntimeConfigSchema = z.object({
  version: z.string().optional(),
  memory: RuntimeMemorySchema.optional(),
  neural: RuntimeNeuralSchema.optional(),
  workers: RuntimeWorkersSchema.optional(),
}).passthrough();

export type RuntimeConfig = z.output<typeof RuntimeConfigSchema>;
export type RuntimeConfigInput = z.input<typeof RuntimeConfigSchema>;

/**
 * Export schema types
 * Using z.output to get post-default types (fields with defaults are required in output)
 */
export type AgentConfig = z.output<typeof AgentConfigSchema>;
export type TaskConfig = z.output<typeof TaskConfigSchema>;
export type SwarmConfig = z.output<typeof SwarmConfigSchema>;
export type MemoryConfig = z.output<typeof MemoryConfigSchema>;
export type MCPServerConfig = z.output<typeof MCPServerConfigSchema>;
export type OrchestratorConfig = z.output<typeof OrchestratorConfigSchema>;
export type SystemConfig = z.output<typeof SystemConfigSchema>;

/**
 * Input types (for validation before defaults are applied)
 */
export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
export type TaskConfigInput = z.input<typeof TaskConfigSchema>;
export type SwarmConfigInput = z.input<typeof SwarmConfigSchema>;
export type MemoryConfigInput = z.input<typeof MemoryConfigSchema>;
export type MCPServerConfigInput = z.input<typeof MCPServerConfigSchema>;
export type OrchestratorConfigInput = z.input<typeof OrchestratorConfigSchema>;
export type SystemConfigInput = z.input<typeof SystemConfigSchema>;
