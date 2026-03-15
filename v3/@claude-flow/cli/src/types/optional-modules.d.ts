/**
 * Ambient type declarations for optional runtime-imported modules.
 *
 * These modules are dynamically imported at runtime and may or may not
 * be installed. They are NOT bundled — users install them as needed.
 * Declaring them here prevents TS2307 in strict pnpm CI builds where
 * hoisted node_modules are not available.
 */

declare module 'pg' {
  const pg: any;
  export default pg;
  export const Pool: any;
  export const Client: any;
}

declare module 'sql.js' {
  const initSqlJs: any;
  export default initSqlJs;
}

declare module 'agentic-flow' {
  export const reasoningbank: any;
}

declare module 'agentic-flow/reasoningbank' {
  export const VERSION: string;
  export const PAPER_URL: string;
  export class ReflexionMemory { constructor(...args: any[]); }
  export class SkillLibrary { constructor(...args: any[]); }
  export class CausalMemoryGraph { constructor(...args: any[]); }
  export class HybridReasoningBank { constructor(...args: any[]); }
  export class AdvancedMemorySystem { constructor(...args: any[]); }
  export class EmbeddingService { constructor(...args: any[]); }
  export class NightlyLearner { constructor(...args: any[]); }
  export function initialize(...args: any[]): Promise<any>;
  export function retrieveMemories(query: string, opts?: any): Promise<any[]>;
  export function formatMemoriesForPrompt(memories: any[]): string;
  export function judgeTrajectory(...args: any[]): any;
  export function distillMemories(...args: any[]): any;
  export function consolidate(...args: any[]): any;
  export function shouldConsolidate(...args: any[]): boolean;
  export function computeEmbedding(text: string): Promise<number[]>;
  export function cosineSimilarity(a: number[], b: number[]): number;
  export function clearEmbeddingCache(): void;
  export function containsPII(text: string): boolean;
  export function scrubPII(text: string): string;
  export function scrubMemory(text: string): string;
  export function mmrSelection(items: any[], query: any, opts?: any): any[];
  export function runTask(...args: any[]): Promise<any>;
  export function loadConfig(): any;
  export const db: any;
  export function CausalRecall(...args: any[]): any;
  export function mattsParallel(...args: any[]): any;
  export function mattsSequential(...args: any[]): any;
}

declare module 'agentic-flow/router' {
  export class ModelRouter { constructor(...args: any[]); route(prompt: string, opts?: any): Promise<any>; getStats(): any; }
  export class AnthropicProvider { constructor(...args: any[]); }
  export class GeminiProvider { constructor(...args: any[]); }
  export class OpenRouterProvider { constructor(...args: any[]); }
  export class ONNXLocalProvider { constructor(...args: any[]); }
  export const CLAUDE_MODELS: any;
  export function getModelName(id: string): string;
  export function listModels(): any[];
  export function mapModelId(id: string): string;
}

declare module 'agentic-flow/orchestration' {
  export function createOrchestrator(...args: any[]): any;
  export function createOrchestrationClient(...args: any[]): any;
  export function seedMemory(...args: any[]): Promise<any>;
  export function searchMemory(...args: any[]): Promise<any>;
  export function harvestMemory(...args: any[]): Promise<any>;
  export function recordLearning(...args: any[]): Promise<any>;
  export function getRunStatus(id: string): Promise<any>;
  export function getRunArtifacts(id: string): Promise<any>;
  export function cancelRun(id: string): Promise<any>;
}

declare module 'agentic-flow/agent-booster' {
  export class EnhancedAgentBooster { constructor(...args: any[]); }
  export function getEnhancedBooster(...args: any[]): any;
  export function enhancedApply(opts: { code: string; edit: string; language?: string }): Promise<{ confidence: number; output: string }>;
  export function benchmark(...args: any[]): Promise<any>;
}

declare module 'agentic-flow/intelligence/agent-booster-enhanced' {
  export class EnhancedAgentBooster { constructor(...args: any[]); }
  export function getEnhancedBooster(...args: any[]): any;
  export function enhancedApply(opts: { code: string; edit: string; language?: string }): Promise<{ confidence: number; output: string }>;
  export function benchmark(...args: any[]): Promise<any>;
}

declare module 'agentic-flow/sdk' {
  const sdk: any;
  export default sdk;
}

declare module 'agentic-flow/security' {
  const security: any;
  export default security;
}

declare module 'agentic-flow/transport/quic' {
  const quic: any;
  export default quic;
}

declare module 'ruvector' {
  const ruvector: any;
  export default ruvector;
  export const VectorDB: any;
  export const VectorDb: any;
  export function isWasm(): boolean;
}

declare module '@ruvector/core' {
  const core: any;
  export default core;
}

declare module '@claude-flow/memory' {
  export class ControllerRegistry {
    constructor();
    initialize(config?: any): Promise<void>;
    getAgentDB(): any;
    getBackend(): any;
    getActiveCount(): number;
    register(name: string, instance: any): void;
  }
}

declare module '@xenova/transformers' {
  const transformers: any;
  export default transformers;
  export const pipeline: any;
  export const env: any;
}

declare module '@claude-flow/embeddings' {
  export function createEmbeddingService(opts: { provider: string }): {
    embed(text: string): Promise<{ embedding: number[] }>;
  };
  export function downloadEmbeddingModel(
    model: string,
    dir: string,
    onProgress?: (p: { percent: number }) => void
  ): Promise<void>;
  export function chunkText(
    text: string,
    opts: {
      maxChunkSize: number;
      overlap: number;
      strategy: 'character' | 'sentence' | 'paragraph' | 'token';
    }
  ): {
    chunks: Array<{ length: number; tokenCount: number; text: string }>;
    totalChunks: number;
    originalLength: number;
  };
  export function euclideanToPoincare(
    vec: number[],
    opts?: { curvature?: number }
  ): number[] | Float64Array;
  export function hyperbolicDistance(
    v1: number[],
    v2: number[],
    opts?: { curvature?: number }
  ): number;
  export function hyperbolicCentroid(
    vectors: number[][],
    opts?: { curvature?: number }
  ): number[] | Float64Array;
  export function listEmbeddingModels(): Array<{ id: string; dimension: number; size: string; quantized: boolean; downloaded: boolean }>;
}

declare module '@claude-flow/guidance/compiler' {
  export class GuidanceCompiler {
    compile(rootContent: string, localContent?: string): {
      constitution: { rules: any[]; hash: string };
      shards: any[];
      manifest: { totalRules: number; compiledAt: string; rules: any[] };
    };
  }
}

declare module '@claude-flow/guidance/retriever' {
  export class ShardRetriever {
    constructor(embeddingProvider: any);
    loadBundle(bundle: any): Promise<void>;
    retrieve(opts: {
      taskDescription: string;
      maxShards?: number;
      intent?: any;
    }): Promise<{
      detectedIntent: string;
      latencyMs: number;
      constitution: { rules: any[] };
      shards: Array<{ shard: { rule: { id: string; riskClass: string; text: string } } }>;
      policyText: string;
    }>;
  }
  export class HashEmbeddingProvider {
    constructor(dimension: number);
  }
}

declare module '@claude-flow/guidance/gates' {
  export class EnforcementGates {
    evaluateCommand(command: string): any;
    evaluateSecrets(content: string): any;
    evaluateToolAllowlist(tool: string): any;
  }
}

declare module '@claude-flow/guidance/analyzer' {
  export function analyze(
    rootContent: string,
    localContent?: string
  ): { compositeScore: number; grade: string; [key: string]: any };
  export function formatReport(analysis: any): string;
  export function optimizeForSize(
    rootContent: string,
    opts: {
      contextSize?: number | string;
      localContent?: string;
      maxIterations?: number;
      targetScore?: number;
    }
  ): {
    optimized: string;
    benchmark: {
      after: { compositeScore: number; grade: string };
      delta: number;
    };
    appliedSteps: string[];
  };
  export function formatBenchmark(benchmark: any): string;
  export function abBenchmark(...args: any[]): Promise<any>;
  export function getDefaultABTasks(): any[];
}

declare module '@claude-flow/aidefence' {
  export interface AIDefenceInstance {
    detect(text: string): Promise<{
      safe: boolean;
      threats: Array<{ severity: string; [key: string]: any }>;
      piiFound: boolean;
      detectionTimeMs: number;
      inputHash: string;
    }>;
    quickScan(text: string): { threat: boolean; [key: string]: any };
    getStats(): Promise<{
      detectionCount: number;
      avgDetectionTimeMs: number;
      learnedPatterns: number;
      mitigationStrategies: number;
      avgMitigationEffectiveness: number;
    }>;
    getBestMitigation(threatType: string): { strategy: string; effectiveness: number; [key: string]: any } | null;
    searchSimilarThreats(text: string, opts?: { k?: number }): Promise<any[]>;
    learnFromDetection(input: string, result: any, opts?: any): Promise<void>;
    recordMitigation(threatType: string, strategy: string, success: boolean): void;
    hasPII(text: string): boolean;
  }
  export function createAIDefence(opts?: { enableLearning?: boolean }): AIDefenceInstance;
  export function isSafe(input: string): boolean;
}

declare module '@claude-flow/shared' {
  export interface SystemConfig {
    orchestrator?: {
      lifecycle?: {
        maxConcurrentAgents?: number;
        spawnTimeout?: number;
        terminateTimeout?: number;
        maxSpawnRetries?: number;
      };
      session?: {
        dataDir?: string;
        persistSessions?: boolean;
        sessionRetentionMs?: number;
      };
      health?: {
        checkInterval?: number;
        historyLimit?: number;
        degradedThreshold?: number;
        unhealthyThreshold?: number;
      };
    };
    swarm?: {
      topology?: string;
      maxAgents?: number;
      autoScale?: {
        enabled?: boolean;
        minAgents?: number;
        maxAgents?: number;
        scaleUpThreshold?: number;
        scaleDownThreshold?: number;
      };
      coordination?: {
        consensusRequired?: boolean;
        timeoutMs?: number;
        retryPolicy?: {
          maxRetries?: number;
          backoffMs?: number;
        };
      };
      communication?: {
        protocol?: string;
        batchSize?: number;
        flushIntervalMs?: number;
      };
    };
    memory?: {
      type?: string;
      path?: string;
      maxSize?: number;
      agentdb?: {
        dimensions?: number;
        indexType?: string;
        efConstruction?: number;
        m?: number;
        quantization?: string;
      };
    };
    mcp?: {
      name?: string;
      version?: string;
      transport?: {
        type?: 'stdio' | 'http' | 'websocket';
        host?: string;
        port?: number;
      };
      capabilities?: {
        tools?: boolean;
        resources?: boolean;
        prompts?: boolean;
        logging?: boolean;
      };
    };
  }
  export function loadConfig(opts?: {
    file?: string;
    paths?: string[];
  }): Promise<{ config: SystemConfig; warnings?: string[] }>;
}

declare module '@claude-flow/mcp' {
  export interface MCPServerConfig {
    name: string;
    version: string;
    transport?: 'http' | 'websocket' | 'stdio';
    host?: string;
    port?: number;
    enableMetrics?: boolean;
    enableCaching?: boolean;
  }
  export interface MCPServerLogger {
    debug(msg: string, data?: unknown): void;
    info(msg: string, data?: unknown): void;
    warn(msg: string, data?: unknown): void;
    error(msg: string, data?: unknown): void;
  }
  export interface MCPServer {
    start(): Promise<void>;
    stop?(): Promise<void>;
  }
  export function createMCPServer(config: MCPServerConfig, logger?: MCPServerLogger): MCPServer;
}

declare module '@ruvector/learning-wasm' {
  export class WasmMicroLoRA {
    constructor(dim: number, alpha: number, lr: number);
    dim(): number;
    adapt_array(gradient: Float32Array): void;
    adapt_with_reward(improvement: number): void;
    forward_array(input: Float32Array): Float32Array;
    delta_norm(): number;
    adapt_count(): bigint;
    forward_count(): bigint;
    param_count(): number;
    reset(): void;
    free(): void;
  }
  export class WasmScopedLoRA {
    constructor(dim: number, alpha: number, lr: number);
    set_category_fallback(enabled: boolean): void;
    adapt_array(operatorType: number, gradient: Float32Array): void;
    adapt_with_reward(operatorType: number, improvement: number): void;
    forward_array(operatorType: number, input: Float32Array): Float32Array;
    delta_norm(operatorType: number): number;
    adapt_count(operatorType: number): bigint;
    total_adapt_count(): bigint;
    total_forward_count(): bigint;
    reset_all(): void;
    free(): void;
  }
  export class WasmTrajectoryBuffer {
    constructor(capacity: number, dim: number);
    record(embedding: Float32Array, operatorType: number, attentionType: number, executionMs: number, baselineMs: number): void;
    is_empty(): boolean;
    success_rate(): number;
    mean_improvement(): number;
    best_improvement(): number;
    total_count(): bigint;
    high_quality_count(threshold: number): number;
    variance(): number;
    reset(): void;
    free(): void;
  }
  export function initSync(opts: { module: Buffer | ArrayBuffer }): void;
}

declare module '@noble/ed25519' {
  export function verifyAsync(
    signature: Uint8Array | Buffer,
    message: Uint8Array,
    publicKey: Uint8Array | Buffer
  ): Promise<boolean>;
}
