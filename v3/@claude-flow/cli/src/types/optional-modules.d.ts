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

declare module 'agentic-flow/coordination/autopilot-learning' {
  // autopilot-state.ts:334 — `import('agentic-flow/coordination/autopilot-learning')`
  // gated by a MODULE_NOT_FOUND catch; the export is a class with
  // initialize() and a getMetrics() shape used by doctor.ts.
  export class AutopilotLearning {
    constructor(...args: any[]);
    initialize(): Promise<boolean>;
    getMetrics(): Promise<{ available: boolean; episodes: number; patterns: number }>;
    [key: string]: unknown;
  }
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

  // ONNX Embedder (ruvector >= 0.2.15, bundled MiniLM-L6-v2)
  export function initOnnxEmbedder(): Promise<void>;
  export function isOnnxAvailable(): boolean;
  export function getOptimizedOnnxEmbedder(): OptimizedOnnxEmbedder | null;

  export interface OptimizedOnnxEmbedder {
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    isReady(): boolean;
    getDimension(): number;
    similarity(a: number[], b: number[]): number;
  }

  // AdaptiveEmbedder (ruvector >= 0.2.16, LoRA B=0 fix — identity when untrained)
  export class AdaptiveEmbedder {
    constructor(options?: { useEpisodic?: boolean });
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    isReady(): boolean;
    getDimension(): number;
    similarity(a: number[], b: number[]): number;
    adapt(quality: number): void;
  }
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

declare module '@ruvector/rvagent-wasm' {
  /** Initialize the WASM module (browser — uses fetch for .wasm file). */
  export default function init(): Promise<void>;

  /** Initialize the WASM module synchronously (Node.js — pass bytes from fs). */
  export function initSync(bytes: BufferSource): void;

  /** Browser/Node sandboxed AI agent with virtual filesystem. */
  export class WasmAgent {
    constructor(config_json: string);
    prompt(input: string): Promise<string>;
    set_model_provider(callback: Function): void;
    reset(): void;
    free(): void;
    get_state(): unknown;
    get_todos(): unknown[];
    get_tools(): string[];
    execute_tool(tool_json: string): Promise<{ success: boolean; output: string }>;
    model(): string;
    name(): string | undefined;
    turn_count(): number;
    file_count(): number;
    is_stopped(): boolean;
  }

  /** JavaScript model provider callback wrapper. */
  export class JsModelProvider {
    constructor(callback: Function);
  }

  /** JSON-RPC 2.0 MCP server in WASM. */
  export class WasmMcpServer {
    constructor(agent: WasmAgent);
    handle_request(json_rpc: string): Promise<string>;
    free(): void;
  }

  /** Pre-built agent template gallery (6 templates). */
  export class WasmGallery {
    constructor();
    list(): Array<{
      id: string; name: string; description: string;
      category: string; tags: string[]; version: string;
      author: string; builtin: boolean;
    }>;
    get(id: string): unknown | undefined;
    search(query: string): Array<{
      id: string; name: string; description: string;
      category: string; tags: string[]; relevance: number;
    }>;
    count(): number;
    getCategories(): Record<string, number>;
    listByCategory(category: string): unknown[];
    addCustom(json: string): boolean;
    removeCustom(id: string): boolean;
    exportCustom(): string;
    importCustom(json: string): boolean;
    configure(json: string): boolean;
    getConfig(): unknown;
    setActive(id: string): boolean;
    getActive(): unknown | undefined;
    loadRvf(data: Uint8Array): boolean;
    free(): void;
  }

  /** RVF binary container builder. */
  export class WasmRvfBuilder {
    constructor();
    addPrompt(json: string): void;
    addPrompts(json: string): void;
    addTool(json: string): void;
    addTools(json: string): void;
    addSkill(json: string): void;
    addSkills(json: string): void;
    addCapabilities(json: string): void;
    addMcpTools(json: string): void;
    setOrchestrator(json: string): void;
    build(): Uint8Array;
    free(): void;
  }
}

declare module '@ruvector/ruvllm-wasm' {
  export default function init(): Promise<void>;

  /** Initialize WASM synchronously (Node.js). Must use object form: initSync({ module: bytes }) */
  export function initSync(opts: { module: BufferSource }): void;

  export class RuvLLMWasm {
    constructor();
    initialize(): void;
    initializeWithConfig(config: KvCacheConfigWasm): void;
    isInitialized: boolean;
    getPoolStats(): string;
    reset(): void;
    // NOTE: version() is NOT on RuvLLMWasm — use standalone getVersion()
  }
  export class ChatMessageWasm {
    static system(content: string): ChatMessageWasm;
    static user(content: string): ChatMessageWasm;
    static assistant(content: string): ChatMessageWasm;
    role: string;
    content: string;
  }
  export class ChatTemplateWasm {
    static llama3(): ChatTemplateWasm;
    static mistral(): ChatTemplateWasm;
    static chatml(): ChatTemplateWasm;
    static phi(): ChatTemplateWasm;
    static gemma(): ChatTemplateWasm;
    static custom(template: string): ChatTemplateWasm;
    static detectFromModelId(model_id: string): ChatTemplateWasm;
    format(messages: ChatMessageWasm[]): string;
    name: string;
  }
  export class GenerateConfig {
    constructor();
    maxTokens: number;
    temperature: number;
    topP: number;
    topK: number;
    repetitionPenalty: number;
    addStopSequence(seq: string): void;
    clearStopSequences(): void;
    toJson(): string;
    static fromJson(json: string): GenerateConfig;
  }
  export class HnswRouterWasm {
    constructor(dimensions: number, max_patterns: number);
    /** Requires 3 args: (embedding, name, metadata_json). Panics at ~12+ patterns in v2.0.1. */
    addPattern(embedding: Float32Array, name: string, metadata: string): boolean;
    route(query: Float32Array, k: number): any[];
    setEfSearch(ef: number): void;
    clear(): void;
    toJson(): string;
    static fromJson(json: string): HnswRouterWasm;
    dimensions: number;
  }
  /** Configuration for SonaInstantWasm. Required since v2.0.1 (replaces raw number). */
  export class SonaConfigWasm {
    constructor();
    hiddenDim: number;
    learningRate: number;
    emaDecay: number;
    ewcLambda: number;
    microLoraRank: number;
    patternCapacity: number;
    toJson(): string;
  }
  export class SonaInstantWasm {
    /** v2.0.1: requires SonaConfigWasm, not raw number */
    constructor(config: SonaConfigWasm);
    instantAdapt(quality: number): void;
    recordPattern(embedding: number[], success: boolean): void;
    suggestAction(context: string): string | undefined;
    stats(): any;
    toJson(): string;
    static fromJson(json: string): SonaInstantWasm;
    reset(): void;
  }
  export class KvCacheConfigWasm {
    constructor();
    tailLength: number;
    maxTokens: number;
    numKvHeads: number;
    headDim: number;
  }
  export class KvCacheWasm {
    constructor(config: KvCacheConfigWasm);
    static withDefaults(): KvCacheWasm;
    append(keys: Float32Array, values: Float32Array): void;
    stats(): any;
    clear(): void;
    tokenCount: number;
  }
  /** Configuration for MicroLoraWasm. */
  export class MicroLoraConfigWasm {
    constructor();
    inputDim: number;
    outputDim: number;
    rank: number;
    alpha: number;
  }
  /** Feedback for MicroLoraWasm.adapt(). */
  export class AdaptFeedbackWasm {
    constructor();
    quality: number;
    learningRate: number;
    success: boolean;
  }
  export class MicroLoraWasm {
    constructor(config: MicroLoraConfigWasm);
    /** Transform input through LoRA adapter */
    apply(input: Float32Array): Float32Array;
    /** Adapt weights — v2.0.2: takes (input, feedback), v2.0.1: takes (feedback) */
    adapt(input: Float32Array, feedback: AdaptFeedbackWasm): void;
    adapt(feedback: AdaptFeedbackWasm): void;
    applyUpdates(gradients: Float32Array): void;
    stats(): any;
    reset(): void;
    toJson(): string;
    getConfig(): MicroLoraConfigWasm;
    pendingUpdates(): number;
  }
  export class InferenceArenaWasm {
    constructor(capacity: number);
    static forModel(hidden_dim: number, vocab_size: number, batch_size: number): InferenceArenaWasm;
    reset(): void;
    used: number;
    capacity: number;
    remaining: number;
  }
  export class BufferPoolWasm {
    constructor();
    static withCapacity(max: number): BufferPoolWasm;
    prewarmAll(count: number): void;
    statsJson(): string;
    hitRate: number;
    clear(): void;
  }
  export function getVersion(): string;
  export function isReady(): boolean;
  export function detectChatTemplate(model_id: string): ChatTemplateWasm;
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
    // ADR-0204 (c): HTTP transport bridges the CLI tool registry via registerTools.
    registerTools(tools: unknown[]): { registered: number; failed: string[] };
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
    forward_count(operatorType: number): bigint;
    total_adapt_count(): bigint;
    total_forward_count(): bigint;
    reset_all(): void;
    reset_scope(operatorType: number): void;
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
