/**
 * AgentDB MCP Tools — Phase 6 of ADR-053
 *
 * Exposes AgentDB v3 controller operations as MCP tools.
 * Provides direct access to ReasoningBank, CausalGraph, SkillLibrary,
 * AttestationLog, and bridge health through the MCP protocol.
 *
 * Security: All handlers validate input types, enforce length bounds,
 * and sanitize error messages before returning to MCP callers.
 *
 * @module v3/cli/mcp-tools/agentdb-tools
 */

import type { MCPTool } from './types.js';

// ===== Shared validation helpers =====

const MAX_STRING_LENGTH = 100_000; // 100KB max for any string input
const MAX_BATCH_SIZE = 500;        // Max entries per batch operation
const MAX_TOP_K = 100;             // Max results per query

function validateString(value: unknown, name: string, maxLen = MAX_STRING_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > maxLen) return null;
  return value;
}

function validatePositiveInt(value: unknown, defaultVal: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultVal;
  const n = Math.floor(value);
  return n > 0 ? Math.min(n, max) : defaultVal;
}

function validateScore(value: unknown, defaultVal: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultVal;
  return Math.max(0, Math.min(1, value));
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // Strip filesystem paths from error messages
    return error.message.replace(/\/[^\s:]+\//g, '<path>/').substring(0, 500);
  }
  return 'Internal error';
}

// Lazy-cached bridge module
let bridgeModule: typeof import('../memory/memory-bridge.js') | null = null;
async function getBridge() {
  if (!bridgeModule) {
    bridgeModule = await import('../memory/memory-bridge.js');
  }
  return bridgeModule;
}

// ===== agentdb_health — Controller health check =====

export const agentdbHealth: MCPTool = {
  name: 'agentdb_health',
  description: 'Get AgentDB v3 controller health status including cache stats and attestation count',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      // Wait for deferred controllers so health count matches controllers count
      await bridge.bridgeWaitForDeferred?.();
      const health = await bridge.bridgeHealthCheck();
      if (!health) return { available: false, error: 'AgentDB bridge not available' };
      return health;
    } catch (error) {
      return { available: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_controllers — List all controllers =====

export const agentdbControllers: MCPTool = {
  name: 'agentdb_controllers',
  description: 'List all AgentDB v3 controllers and their initialization status',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      // Wait for deferred (Level 2+) controllers to finish background init
      await bridge.bridgeWaitForDeferred?.();
      const controllers = await bridge.bridgeListControllers();
      if (!controllers) return { available: false, controllers: [], error: 'Bridge not available' };
      return {
        available: true,
        controllers,
        total: controllers.length,
        active: controllers.filter((c: any) => c.enabled).length,
      };
    } catch (error) {
      return { available: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_pattern_store — Store via ReasoningBank =====

export const agentdbPatternStore: MCPTool = {
  name: 'agentdb_pattern_store',
  description: 'Store a pattern directly via ReasoningBank controller',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Pattern description' },
      type: { type: 'string', description: 'Pattern type (e.g., task-routing, error-recovery)' },
      confidence: { type: 'number', description: 'Confidence score (0-1)' },
    },
    required: ['pattern'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const pattern = validateString(params.pattern, 'pattern');
      if (!pattern) return { success: false, error: 'pattern is required (non-empty string, max 100KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeStorePattern({
        pattern,
        type: validateString(params.type, 'type', 200) ?? 'general',
        confidence: validateScore(params.confidence, 0.8),
      });
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_pattern_search — Search via ReasoningBank =====

export const agentdbPatternSearch: MCPTool = {
  name: 'agentdb_pattern_search',
  description: 'Search patterns via ReasoningBank controller with BM25+semantic hybrid',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
      minConfidence: { type: 'number', description: 'Minimum score threshold (0-1)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSearchPatterns({
        query,
        topK: validatePositiveInt(params.topK, 5, MAX_TOP_K),
        minConfidence: validateScore(params.minConfidence, 0.3),
      });
      return result ?? { results: [], controller: 'unavailable' };
    } catch (error) {
      return { results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_feedback — Record task feedback =====

export const agentdbFeedback: MCPTool = {
  name: 'agentdb_feedback',
  description: 'Record task feedback for learning via LearningSystem + ReasoningBank controllers',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task identifier' },
      success: { type: 'boolean', description: 'Whether task succeeded' },
      quality: { type: 'number', description: 'Quality score (0-1)' },
      agent: { type: 'string', description: 'Agent that performed the task' },
    },
    required: ['taskId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const taskId = validateString(params.taskId, 'taskId', 500);
      if (!taskId) return { success: false, error: 'taskId is required (non-empty string, max 500 chars)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRecordFeedback({
        taskId,
        success: params.success === true,
        quality: validateScore(params.quality, 0.85),
        agent: validateString(params.agent, 'agent', 200) ?? undefined,
      });
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_causal_edge — Record causal relationships =====

export const agentdbCausalEdge: MCPTool = {
  name: 'agentdb_causal_edge',
  description: 'Record a causal edge between two memory entries via CausalMemoryGraph',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source entry ID' },
      targetId: { type: 'string', description: 'Target entry ID' },
      relation: { type: 'string', description: 'Relationship type (e.g., caused, preceded, succeeded)' },
      weight: { type: 'number', description: 'Edge weight (0-1)' },
    },
    required: ['sourceId', 'targetId', 'relation'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sourceId = validateString(params.sourceId, 'sourceId', 500);
      const targetId = validateString(params.targetId, 'targetId', 500);
      const relation = validateString(params.relation, 'relation', 200);
      if (!sourceId) return { success: false, error: 'sourceId is required (non-empty string)' };
      if (!targetId) return { success: false, error: 'targetId is required (non-empty string)' };
      if (!relation) return { success: false, error: 'relation is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRecordCausalEdge({
        sourceId,
        targetId,
        relation,
        weight: typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : undefined,
      });
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_route — Route via SemanticRouter =====

export const agentdbRoute: MCPTool = {
  name: 'agentdb_route',
  description: 'Route a task via AgentDB SemanticRouter or LearningSystem recommendAlgorithm',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to route' },
      context: { type: 'string', description: 'Additional context' },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const task = validateString(params.task, 'task', 10_000);
      if (!task) return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: 'task is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRouteTask({
        task,
        context: validateString(params.context, 'context', 10_000) ?? undefined,
      });
      return result ?? { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'fallback' };
    } catch (error) {
      return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_session_start — Session with ReflexionMemory =====

export const agentdbSessionStart: MCPTool = {
  name: 'agentdb_session_start',
  description: 'Start a session with ReflexionMemory episodic replay',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      context: { type: 'string', description: 'Session context for pattern retrieval' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionStart({
        sessionId,
        context: validateString(params.context, 'context', 10_000) ?? undefined,
      });
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_session_end — End session + NightlyLearner =====

export const agentdbSessionEnd: MCPTool = {
  name: 'agentdb_session_end',
  description: 'End session, persist to ReflexionMemory, trigger NightlyLearner consolidation',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      summary: { type: 'string', description: 'Session summary' },
      tasksCompleted: { type: 'number', description: 'Number of tasks completed' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionEnd({
        sessionId,
        summary: validateString(params.summary, 'summary', 50_000) ?? undefined,
        tasksCompleted: validatePositiveInt(params.tasksCompleted, 0, 10_000),
      });
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_hierarchical_store — Store to hierarchical memory =====

export const agentdbHierarchicalStore: MCPTool = {
  name: 'agentdb_hierarchical_store',
  description: 'Store to hierarchical memory with tier (working, episodic, semantic)',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory entry key' },
      value: { type: 'string', description: 'Memory entry value' },
      tier: {
        type: 'string',
        description: 'Memory tier (working, episodic, semantic)',
        enum: ['working', 'episodic', 'semantic'],
        default: 'working',
      },
    },
    required: ['key', 'value'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const key = validateString(params.key, 'key', 1000);
      const value = validateString(params.value, 'value');
      if (!key) return { success: false, error: 'key is required (non-empty string, max 1KB)' };
      if (!value) return { success: false, error: 'value is required (non-empty string, max 100KB)' };
      const tier = validateString(params.tier, 'tier', 20) ?? 'working';
      if (!['working', 'episodic', 'semantic'].includes(tier)) {
        return { success: false, error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalStore({ key, value, tier });
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_hierarchical_recall — Recall from hierarchical memory =====

export const agentdbHierarchicalRecall: MCPTool = {
  name: 'agentdb_hierarchical_recall',
  description: 'Recall from hierarchical memory with optional tier filter',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Recall query' },
      tier: { type: 'string', description: 'Filter by tier (working, episodic, semantic)' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { success: false, results: [], error: 'query is required (non-empty string, max 10KB)' };
      const tier = validateString(params.tier, 'tier', 20);
      if (tier && !['working', 'episodic', 'semantic'].includes(tier)) {
        return { success: false, results: [], error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalRecall({
        query,
        tier: tier ?? undefined,
        topK: validatePositiveInt(params.topK, 5, MAX_TOP_K),
      });
      if (!result) return { success: false, results: [], error: 'Bridge not available' };
      const resultObj = result as Record<string, unknown>;
      if (!resultObj.results || (Array.isArray(resultObj.results) && resultObj.results.length === 0)) {
        return { success: true, ...resultObj, notice: 'No results found. Hierarchical recall uses semantic search which may not match exact stored values.' };
      }
      return { success: true, ...resultObj };
    } catch (error) {
      return { success: false, results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_consolidate — Run memory consolidation =====

export const agentdbConsolidate: MCPTool = {
  name: 'agentdb_consolidate',
  description: 'Run memory consolidation to promote entries across tiers and compress old data',
  inputSchema: {
    type: 'object',
    properties: {
      minAge: { type: 'number', description: 'Minimum age in hours since store (optional)' },
      maxEntries: { type: 'number', description: 'Maximum entries to consolidate (optional)' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      const result = await bridge.bridgeConsolidate({
        minAge: typeof params.minAge === 'number' ? Math.max(0, params.minAge) : undefined,
        maxEntries: validatePositiveInt(params.maxEntries, 1000, 10_000),
      });
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_batch — Batch operations (insert, update, delete) =====

export const agentdbBatch: MCPTool = {
  name: 'agentdb_batch',
  description: 'Batch operations on memory entries (insert, update, delete)',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'Batch operation type',
        enum: ['insert', 'update', 'delete'],
      },
      entries: {
        type: 'array',
        description: 'Array of {key, value} entries to operate on',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['key'],
        },
      },
    },
    required: ['operation', 'entries'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const operation = validateString(params.operation, 'operation', 20);
      if (!operation) return { success: false, error: 'operation is required (string)' };
      if (!['insert', 'update', 'delete'].includes(operation)) {
        return { success: false, error: `Invalid operation: ${operation}. Must be insert, update, or delete` };
      }
      if (!Array.isArray(params.entries) || params.entries.length === 0) {
        return { success: false, error: 'entries is required (non-empty array)' };
      }
      if (params.entries.length > MAX_BATCH_SIZE) {
        return { success: false, error: `Too many entries: ${params.entries.length}. Max is ${MAX_BATCH_SIZE}` };
      }
      // Validate each entry
      const validatedEntries: Array<{ key: string; value?: string; metadata?: Record<string, unknown> }> = [];
      for (let i = 0; i < params.entries.length; i++) {
        const entry = params.entries[i];
        if (!entry || typeof entry !== 'object') {
          return { success: false, error: `entries[${i}] must be an object` };
        }
        const key = validateString((entry as any).key, `entries[${i}].key`, 1000);
        if (!key) return { success: false, error: `entries[${i}].key is required (non-empty string)` };
        const value = validateString((entry as any).value, `entries[${i}].value`);
        validatedEntries.push({ key, value: value ?? undefined });
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeBatchOperation({
        operation,
        entries: validatedEntries,
      });
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_context_synthesize — Synthesize context from memories =====

export const agentdbContextSynthesize: MCPTool = {
  name: 'agentdb_context_synthesize',
  description: 'Synthesize context from stored memories for a given query',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Query to synthesize context for' },
      maxEntries: { type: 'number', description: 'Maximum entries to include (default: 10)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { success: false, error: 'query is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeContextSynthesize({
        query,
        maxEntries: validatePositiveInt(params.maxEntries, 10, MAX_TOP_K),
      });
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_semantic_route — Route via SemanticRouter =====

export const agentdbSemanticRoute: MCPTool = {
  name: 'agentdb_semantic_route',
  description: 'Route an input via AgentDB SemanticRouter for intent classification',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input text to route' },
    },
    required: ['input'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const input = validateString(params.input, 'input', 10_000);
      if (!input) return { success: false, route: null, error: 'input is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSemanticRoute({ input });
      if (!result) return { success: false, route: null, error: 'Bridge not available' };
      const r = result as Record<string, unknown>;
      if (r.error || r.route === null || r.route === undefined) {
        return { success: false, ...r };
      }
      return { success: true, ...r };
    } catch (error) {
      return { success: false, route: null, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_reflexion_retrieve — Recall past task experiences (P3-B) =====

export const agentdbReflexionRetrieve: MCPTool = {
  name: 'agentdb_reflexion_retrieve',
  description: 'Retrieve reflexion memories for a task to inform decisions',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to find relevant reflexions for' },
      k: { type: 'number', description: 'Number of results to return (default: 5)' },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const task = validateString(params.task, 'task', 10_000);
      if (!task) return { success: false, results: [], error: 'task is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const reflexion = await bridge.bridgeGetController('reflexion');
      if (!reflexion || typeof reflexion.retrieve !== 'function') {
        return { success: false, results: [], error: 'ReflexionMemory not available' };
      }
      const k = validatePositiveInt(params.k, 5, MAX_TOP_K);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('reflexion_retrieve timeout (2s)')), 2000),
      );
      const results = await Promise.race([
        reflexion.retrieve(task, k),
        timeoutPromise,
      ]);
      return {
        success: true,
        results: Array.isArray(results) ? results : [],
        count: Array.isArray(results) ? results.length : 0,
      };
    } catch (error) {
      return { success: false, results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_reflexion_store — Record task outcome (P3-B) =====

export const agentdbReflexionStore: MCPTool = {
  name: 'agentdb_reflexion_store',
  description: 'Store a reflexion memory from a completed task',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session ID for the task' },
      task: { type: 'string', description: 'Task description' },
      reward: { type: 'number', description: 'Reward signal (0-1)' },
      success: { type: 'boolean', description: 'Whether the task succeeded' },
    },
    required: ['session_id', 'task', 'reward', 'success'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sessionId = validateString(params.session_id, 'session_id', 500);
      if (!sessionId) return { success: false, error: 'session_id is required (non-empty string, max 500 chars)' };
      const task = validateString(params.task, 'task', 10_000);
      if (!task) return { success: false, error: 'task is required (non-empty string, max 10KB)' };
      const reward = validateScore(params.reward, 0.5);
      const bridge = await getBridge();
      const reflexion = await bridge.bridgeGetController('reflexion');
      if (!reflexion || typeof reflexion.store !== 'function') {
        return { success: false, error: 'ReflexionMemory not available' };
      }
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('reflexion_store timeout (2s)')), 2000),
      );
      await Promise.race([
        reflexion.store({
          session_id: sessionId,
          task,
          reward,
          success: params.success === true,
        }),
        timeoutPromise,
      ]);
      return { success: true };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_causal_query — Query causal graph (P3-C) =====

export const agentdbCausalQuery: MCPTool = {
  name: 'agentdb_causal_query',
  description: 'Query causal relationships and experiment tracking from the causal memory graph',
  inputSchema: {
    type: 'object',
    properties: {
      cause: { type: 'string', description: 'Cause node to query effects for' },
      effect: { type: 'string', description: 'Effect node to query causes for' },
      min_uplift: { type: 'number', description: 'Minimum uplift threshold (default: 0)' },
      k: { type: 'number', description: 'Max results (default: 10)' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      const causal = await bridge.bridgeGetController('causalGraph');

      if (!causal) {
        return { success: false, results: [], error: 'CausalMemoryGraph not available' };
      }

      // Cold-start guard: skip if graph has <5 edges (returns noise)
      const stats = typeof causal.getStats === 'function' ? await causal.getStats() : null;
      if (stats && (stats.edgeCount || stats.edges || 0) < 5) {
        return {
          success: true,
          results: [],
          warning: 'Cold start: fewer than 5 causal edges recorded. Results would be noise.',
        };
      }

      const cause = validateString(params.cause, 'cause', 1000);
      const effect = validateString(params.effect, 'effect', 1000);
      const k = validatePositiveInt(params.k, 10, MAX_TOP_K);
      let results: unknown[] = [];

      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error('causal_query timeout (2s)')), 2000);
      });

      try {
        if (cause && typeof causal.getEffects === 'function') {
          results = await Promise.race([causal.getEffects(cause, k), timeoutPromise]) as unknown[];
        } else if (effect && typeof causal.getCauses === 'function') {
          results = await Promise.race([causal.getCauses(effect, k), timeoutPromise]) as unknown[];
        } else if (typeof causal.query === 'function') {
          results = await Promise.race([causal.query(params), timeoutPromise]) as unknown[];
        }
      } finally {
        clearTimeout(timerId);
      }

      // Filter by min_uplift
      if (typeof params.min_uplift === 'number' && Array.isArray(results)) {
        const minUplift = params.min_uplift;
        results = results.filter((r: any) => (r.uplift || r.weight || 0) >= minUplift);
      }

      return {
        success: true,
        results: Array.isArray(results) ? results : [],
        count: Array.isArray(results) ? results.length : 0,
      };
    } catch (error) {
      return { success: false, results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_branch — COW branching (P6-B) =====

export const agentdbBranch: MCPTool = {
  name: 'agentdb_branch',
  description: 'Create and manage copy-on-write memory branches for experimentation',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'get', 'store', 'merge', 'status'],
        description: 'Branch operation',
      },
      branch_name: { type: 'string', description: 'Name for the branch (create action)' },
      branch_id: { type: 'string', description: 'Branch ID (get/store/merge/status actions)' },
      key: { type: 'string', description: 'Entry key (get/store actions)' },
      value: { type: 'string', description: 'Entry value (store action)' },
      namespace: { type: 'string', description: 'Namespace (default: "default")' },
    },
    required: ['action'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const action = validateString(params.action, 'action', 20);
      if (!action) return { success: false, error: 'action is required' };

      const bridge = await getBridge();
      const backend = await bridge.bridgeGetController('vectorBackend');

      if (!backend) {
        return { success: false, error: 'Backend not available for branching' };
      }

      const timeoutMs = 2000;
      const timeout = () => new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('branch operation timeout (2s)')), timeoutMs),
      );

      switch (action) {
        case 'create': {
          const branchName = validateString(params.branch_name, 'branch_name', 500);
          if (!branchName) return { success: false, error: 'branch_name is required (non-empty string)' };
          if (typeof backend.derive !== 'function') {
            return { success: false, error: 'COW branching not supported by backend' };
          }
          return await Promise.race([backend.derive(branchName), timeout()]);
        }
        case 'get': {
          const branchId = validateString(params.branch_id, 'branch_id', 1000);
          const key = validateString(params.key, 'key', 1000);
          if (!branchId || !key) return { success: false, error: 'branch_id and key are required' };
          if (typeof backend.branchGet !== 'function') {
            return { success: false, error: 'COW branching not supported by backend' };
          }
          const ns = validateString(params.namespace, 'namespace', 200) ?? undefined;
          const entry = await Promise.race([backend.branchGet(branchId, key, ns), timeout()]);
          return { success: true, entry: entry ?? null };
        }
        case 'store': {
          const branchId = validateString(params.branch_id, 'branch_id', 1000);
          const key = validateString(params.key, 'key', 1000);
          const value = validateString(params.value, 'value');
          if (!branchId || !key || !value) {
            return { success: false, error: 'branch_id, key, and value are required' };
          }
          if (typeof backend.branchStore !== 'function') {
            return { success: false, error: 'COW branching not supported by backend' };
          }
          const ns = validateString(params.namespace, 'namespace', 200) ?? undefined;
          return await Promise.race([backend.branchStore(branchId, key, value, ns), timeout()]);
        }
        case 'merge': {
          const branchId = validateString(params.branch_id, 'branch_id', 1000);
          if (!branchId) return { success: false, error: 'branch_id is required' };
          if (typeof backend.branchMerge !== 'function') {
            return { success: false, error: 'COW branching not supported by backend' };
          }
          const ns = validateString(params.namespace, 'namespace', 200) ?? undefined;
          return await Promise.race([backend.branchMerge(branchId, ns), timeout()]);
        }
        case 'status': {
          const branchId = validateString(params.branch_id, 'branch_id', 1000);
          if (!branchId) return { success: false, error: 'branch_id is required' };
          const metaKey = `_branch_meta:${branchId}`;
          const meta = typeof backend.getByKey === 'function'
            ? await Promise.race([backend.getByKey('default', metaKey), timeout()])
            : null;
          return {
            success: true,
            branch: meta?.content ? JSON.parse(meta.content) : null,
          };
        }
        default:
          return { success: false, error: `Unknown action: ${action}. Must be create, get, store, merge, or status` };
      }
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_causal_recall — Causal-aware search (ADR-0033) =====

export const agentdbCausalRecall: MCPTool = {
  name: 'agentdb_causal_recall',
  description: 'Search with causal-aware re-ranking (boosts results with higher causal uplift)',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      k: { type: 'number', description: 'Number of results (default: 10)' },
      include_evidence: { type: 'boolean', description: 'Include causal evidence chains' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { success: false, error: 'query is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      if (!bridge?.bridgeCausalRecall) {
        return { success: false, error: 'bridgeCausalRecall not available' };
      }
      const result = await bridge.bridgeCausalRecall({
        query,
        k: validatePositiveInt(params.k, 10, MAX_TOP_K),
        includeEvidence: params.include_evidence === true,
      });
      return result;
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_batch_optimize — Optimize and prune storage (ADR-0033) =====

export const agentdbBatchOptimize: MCPTool = {
  name: 'agentdb_batch_optimize',
  description: 'Optimize and prune AgentDB storage (vacuum, stats, pruning)',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['optimize', 'prune', 'stats'], description: 'Operation to perform' },
      max_age: { type: 'number', description: 'Prune entries older than N days (prune action)' },
      min_reward: { type: 'number', description: 'Prune entries with reward below threshold (prune action)' },
    },
    required: ['action'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const action = validateString(params.action, 'action', 20);
      if (!action) return { success: false, error: 'action is required' };
      if (!['optimize', 'prune', 'stats'].includes(action)) {
        return { success: false, error: `Unknown action: ${action}. Must be optimize, prune, or stats` };
      }
      const bridge = await getBridge();
      switch (action) {
        case 'optimize': {
          if (!bridge?.bridgeBatchOptimize) return { success: false, error: 'bridgeBatchOptimize not available' };
          return await bridge.bridgeBatchOptimize();
        }
        case 'prune': {
          if (!bridge?.bridgeBatchPrune) return { success: false, error: 'bridgeBatchPrune not available' };
          return await bridge.bridgeBatchPrune({
            maxAge: typeof params.max_age === 'number' ? Math.max(0, params.max_age) : undefined,
            minReward: validateScore(params.min_reward, 0),
          });
        }
        case 'stats': {
          if (!bridge?.bridgeBatchOptimize) return { success: false, error: 'bridgeBatchOptimize not available' };
          return await bridge.bridgeBatchOptimize();
        }
        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0042: agentdb_rate_limit_status =====

export const agentdbRateLimitStatus: MCPTool = {
  name: 'agentdb_rate_limit_status',
  description: 'Get rate limiter status for all token buckets (insert, search, delete, batch)',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      return await bridge.bridgeRateLimitStatus();
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0042: agentdb_resource_usage =====

export const agentdbResourceUsage: MCPTool = {
  name: 'agentdb_resource_usage',
  description: 'Get resource tracker usage stats including memory ceiling and query counts',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      return await bridge.bridgeResourceUsage();
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0042: agentdb_circuit_status =====

export const agentdbCircuitStatus: MCPTool = {
  name: 'agentdb_circuit_status',
  description: 'Get circuit breaker status for all wrapped controllers (state, failure counts)',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      return await bridge.bridgeCircuitStatus();
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0047: agentdb_quantize_status =====

export const agentdbQuantizeStatus: MCPTool = {
  name: 'agentdb_quantize_status',
  description: 'Get quantized vector store status including compression type, ratio, and entry count',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      return await bridge.bridgeQuantizeStatus();
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0047: agentdb_health_report =====

export const agentdbHealthReport: MCPTool = {
  name: 'agentdb_health_report',
  description: 'Get index health assessment with p95 latency, recall estimates, and HNSW parameter recommendations',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      return await bridge.bridgeHealthReport();
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_filtered_search — Metadata-filtered semantic search (ADR-0043) =====

const agentdbFilteredSearch: MCPTool = {
  name: 'agentdb_filtered_search',
  description: 'Semantic search with MongoDB-style metadata filtering (B5 MetadataFilter). Supports $gt, $lt, $gte, $lte, $eq, $ne, $in, $nin, $regex, $exists, $and, $or, $not, $elemMatch operators.',
  category: 'agentdb',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (semantic similarity)' },
      filter: { type: 'object', description: 'MongoDB-style metadata filter (e.g. { score: { $gt: 0.7 } })' },
      namespace: { type: 'string', description: 'Namespace to search (default: all)' },
      limit: { type: 'number', description: 'Maximum results (default: 10)' },
      threshold: { type: 'number', description: 'Minimum similarity 0-1 (default: 0.3)' },
    },
    required: ['query'],
  },
  handler: async (input) => {
    try {
      const { bridgeFilteredSearch } = await import('../memory/memory-bridge.js');
      const result = await bridgeFilteredSearch({
        query: input.query as string,
        filter: input.filter as Record<string, unknown> | undefined,
        namespace: input.namespace as string | undefined,
        limit: input.limit as number | undefined,
        threshold: input.threshold as number | undefined,
      });
      if (!result) return { success: false, error: 'Bridge not available' };
      return result;
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_query_stats — Query optimizer statistics (ADR-0043) =====

const agentdbQueryStats: MCPTool = {
  name: 'agentdb_query_stats',
  description: 'Get QueryOptimizer (B6) cache statistics: hits, misses, and cache size.',
  category: 'agentdb',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const { bridgeQueryStats } = await import('../memory/memory-bridge.js');
      const result = await bridgeQueryStats();
      return result;
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0045: agentdb_embed — Embed text via EnhancedEmbeddingService =====

export const agentdbEmbed: MCPTool = {
  name: 'agentdb_embed',
  description: 'Generate embedding for text via A9 EnhancedEmbeddingService with multi-provider fallback chain',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to embed' },
    },
    required: ['text'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const text = validateString(params.text, 'text', MAX_STRING_LENGTH);
      if (!text) return { success: false, error: 'text is required (non-empty string, max 100KB)' };
      const bridge = await getBridge();
      // Wait for deferred (Level 2+) controllers so A9 EnhancedEmbeddingService is ready
      await bridge.bridgeWaitForDeferred?.();
      const result = await bridge.bridgeEmbed(text);
      return result ?? { success: false, error: 'Bridge not available' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0045: agentdb_embed_status — EnhancedEmbeddingService status =====

export const agentdbEmbedStatus: MCPTool = {
  name: 'agentdb_embed_status',
  description: 'Get A9 EnhancedEmbeddingService status including provider chain, cache stats, and dimension config',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      // D5: Report both enabled (configuration readiness) and initialized
      // (instantiation readiness) to avoid disagreement between health report
      // and embed_status for Level 3+ deferred controllers.
      const controllers = await bridge.bridgeListControllers();
      const entry = controllers?.find((c: { name: string }) => c.name === 'enhancedEmbeddingService');
      const enabled = entry?.enabled ?? false;
      const initialized = await bridge.bridgeHasController('enhancedEmbeddingService');
      // Try to get status from the controller if instantiated
      const controller = initialized ? await bridge.bridgeGetController('enhancedEmbeddingService') : null;
      const status: Record<string, unknown> = { active: initialized, enabled, initialized };
      if (controller && typeof controller === 'object') {
        if (typeof (controller as any).getStats === 'function') {
          Object.assign(status, (controller as any).getStats());
        }
      }
      return status;
    } catch (error) {
      return { active: false, enabled: false, initialized: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0045: agentdb_telemetry_metrics — TelemetryManager metrics =====

export const agentdbTelemetryMetrics: MCPTool = {
  name: 'agentdb_telemetry_metrics',
  description: 'Get D1 TelemetryManager metrics: counters, histograms (p50/p95/p99), and exporter config',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      const result = await bridge.bridgeTelemetryMetrics();
      if (!result) return { success: false, error: 'Bridge not available' };
      const metrics = result.metrics;
      const countersEmpty = !metrics?.counters || Object.keys(metrics.counters).length === 0;
      const histogramsEmpty = !metrics?.histograms || Object.keys(metrics.histograms).length === 0;
      const isEmpty = !metrics || (countersEmpty && histogramsEmpty);
      if (result.success && isEmpty) {
        return { ...result, notice: 'No telemetry instrumentation active. Counters require explicit startSpan/increment calls from controller operations.' };
      }
      return result;
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0045: agentdb_telemetry_spans — TelemetryManager spans =====

export const agentdbTelemetrySpans: MCPTool = {
  name: 'agentdb_telemetry_spans',
  description: 'Get recent D1 TelemetryManager spans with duration and attributes',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum spans to return (default: 100, max: 500)' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const limit = validatePositiveInt(params.limit, 100, 500);
      const bridge = await getBridge();
      const result = await bridge.bridgeTelemetrySpans(limit);
      if (!result) return { success: false, error: 'Bridge not available' };
      if (result.success && (!result.spans || result.spans.length === 0)) {
        return { ...result, notice: 'No span instrumentation wired. Spans require controller operations to call telemetryManager.startSpan().' };
      }
      return result;
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0044: agentdb_attention_compute =====

export const agentdbAttentionCompute: MCPTool = {
  name: 'agentdb_attention_compute',
  description: 'Compute attention-weighted search results using multi-head attention re-ranking',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      namespace: { type: 'string', description: 'Memory namespace' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['query'],
  },
  handler: async (args: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      const query = validateString(args.query, 'query');
      if (!query) return { success: false, error: 'query is required' };
      return await bridge.bridgeAttentionSearch({
        query,
        namespace: typeof args.namespace === 'string' ? args.namespace : undefined,
        limit: validatePositiveInt(args.limit, 10, MAX_TOP_K),
      });
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0044: agentdb_attention_benchmark =====

export const agentdbAttentionBenchmark: MCPTool = {
  name: 'agentdb_attention_benchmark',
  description: 'Benchmark Flash Attention consolidation performance',
  inputSchema: {
    type: 'object',
    properties: {
      entryCount: { type: 'number', description: 'Number of entries to benchmark (default 100)' },
      dimensions: { type: 'number', description: 'Vector dimensions for benchmark entries (default 64)' },
      blockSize: { type: 'number', description: 'Flash attention block size (default 256)' },
    },
  },
  handler: async (args: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      const count = validatePositiveInt(args.entryCount, 100, 10000);
      const dim = validatePositiveInt(args.dimensions, 64, 4096);
      // Generate synthetic entries for benchmarking
      const entries = Array.from({ length: count }, (_, i) => ({
        id: `bench_${i}`,
        embedding: Array.from({ length: dim }, () => Math.random()),
      }));
      const start = Date.now();
      const result = await bridge.bridgeFlashConsolidate({
        entries,
        blockSize: validatePositiveInt(args.blockSize, 256, 1024),
      });
      const elapsed = Date.now() - start;
      return { ...result, benchmark: { entries: count, elapsedMs: elapsed, opsPerSec: count / (elapsed / 1000) } };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0044: agentdb_attention_configure =====

export const agentdbAttentionConfigure: MCPTool = {
  name: 'agentdb_attention_configure',
  description: 'Get configuration and engine status of AttentionService mechanisms',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (args: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      // Use bridgeGetController to query the attentionService directly
      const result = await bridge.bridgeGetController('attentionService');
      if (!result) return { success: false, error: 'AttentionService not active' };
      const info = typeof result.getInfo === 'function' ? result.getInfo() : {};
      const stats = typeof result.getStats === 'function' ? result.getStats() : {};
      const engine = typeof result.getEngineType === 'function' ? result.getEngineType() : 'unknown';
      return { success: true, engine, info, stats };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== ADR-0044: agentdb_attention_metrics =====

export const agentdbAttentionMetrics: MCPTool = {
  name: 'agentdb_attention_metrics',
  description: 'Get per-mechanism latency percentiles and head utilization metrics from attention controllers',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (args: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      const metricsCtrl = await bridge.bridgeGetController('attentionMetrics');
      if (!metricsCtrl) return { success: false, error: 'AttentionMetrics (D2) not active' };
      const metrics = typeof metricsCtrl.getAllMetrics === 'function'
        ? Object.fromEntries(metricsCtrl.getAllMetrics())
        : typeof metricsCtrl.getStats === 'function'
          ? metricsCtrl.getStats()
          : {};
      if (!metrics || Object.keys(metrics as Record<string, unknown>).length === 0) {
        return { success: true, metrics, notice: 'No attention operations performed. Metrics populate after attention_compute or attention_benchmark calls.' };
      }
      return { success: true, metrics };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_skill_create — Create a reusable skill (P4) =====

export const agentdbSkillCreate: MCPTool = {
  name: 'agentdb_skill_create',
  description: 'Create a reusable skill from task patterns via SkillLibrary controller',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name' },
      description: { type: 'string', description: 'Skill description' },
      code: { type: 'string', description: 'Skill code or template' },
      success_rate: { type: 'number', description: 'Historical success rate (0-1)' },
    },
    required: ['name'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const name = validateString(params.name, 'name', 500);
      if (!name) return { success: false, error: 'name is required (non-empty string, max 500 chars)' };
      const bridge = await getBridge();
      const skills = await bridge.bridgeGetController('skills');
      if (!skills) return { success: false, error: 'SkillLibrary controller not available' };
      const description = validateString(params.description, 'description', 10_000) ?? '';
      const code = validateString(params.code, 'code', MAX_STRING_LENGTH) ?? '';
      const successRate = validateScore(params.success_rate, 0.5);
      if (typeof skills.createSkill === 'function') {
        const result = await skills.createSkill({ name, description, code, successRate });
        return { success: true, skillId: result?.id ?? result ?? name };
      }
      if (typeof skills.promote === 'function') {
        await skills.promote({ name, description, code }, successRate);
        return { success: true, skillId: name };
      }
      return { success: false, error: 'SkillLibrary lacks createSkill/promote methods' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_skill_search — Search reusable skills (P4) =====

export const agentdbSkillSearch: MCPTool = {
  name: 'agentdb_skill_search',
  description: 'Search for reusable skills by query via SkillLibrary controller',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Maximum results (default: 5)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { success: false, skills: [], error: 'query is required (non-empty string, max 10KB)' };
      const limit = validatePositiveInt(params.limit, 5, MAX_TOP_K);
      const bridge = await getBridge();
      const skills = await bridge.bridgeGetController('skills');
      if (!skills) return { success: false, skills: [], error: 'SkillLibrary controller not available' };
      if (typeof skills.retrieveSkills === 'function') {
        const results = await skills.retrieveSkills(query, limit);
        return { success: true, skills: Array.isArray(results) ? results : [] };
      }
      if (typeof skills.searchSkills === 'function') {
        const results = await skills.searchSkills(query, limit);
        return { success: true, skills: Array.isArray(results) ? results : [] };
      }
      if (typeof skills.search === 'function') {
        const results = await skills.search(query, limit);
        return { success: true, skills: Array.isArray(results) ? results : [] };
      }
      return { success: false, skills: [], error: 'SkillLibrary lacks retrieveSkills/searchSkills/search methods' };
    } catch (error) {
      return { success: false, skills: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_learner_run — Run NightlyLearner pipeline (P4) =====

export const agentdbLearnerRun: MCPTool = {
  name: 'agentdb_learner_run',
  description: 'Run the nightly learner pipeline (causal discovery, experiments, skill consolidation)',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      const learner = await bridge.bridgeGetController('nightlyLearner');
      if (!learner) return { success: false, error: 'NightlyLearner controller not available' };
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('learner-run timeout (10s)')), 10_000),
      );
      if (typeof learner.run === 'function') {
        const report = await Promise.race([learner.run(), timeoutPromise]);
        return { success: true, report: report ?? {} };
      }
      if (typeof learner.consolidate === 'function') {
        const report = await Promise.race([learner.consolidate({}), timeoutPromise]);
        return { success: true, report: report ?? {} };
      }
      return { success: false, error: 'NightlyLearner lacks run/consolidate methods' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_learning_predict — Predict optimal action (P4) =====

export const agentdbLearningPredict: MCPTool = {
  name: 'agentdb_learning_predict',
  description: 'Predict optimal action for a given state using learned policies via LearningSystem',
  inputSchema: {
    type: 'object',
    properties: {
      state: { type: 'string', description: 'Current state description' },
      context: { type: 'string', description: 'Additional context for prediction' },
    },
    required: ['state'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const state = validateString(params.state, 'state', 10_000);
      if (!state) return { success: false, error: 'state is required (non-empty string, max 10KB)' };
      const context = validateString(params.context, 'context', 10_000) ?? undefined;
      const bridge = await getBridge();
      const learningSystem = await bridge.bridgeGetController('learningSystem');
      if (!learningSystem) return { success: false, error: 'LearningSystem controller not available' };
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('learning-predict timeout (2s)')), 2000),
      );
      if (typeof learningSystem.predict === 'function') {
        const prediction = await Promise.race([learningSystem.predict(state, context), timeoutPromise]);
        return { success: true, prediction: prediction ?? {} };
      }
      if (typeof learningSystem.recommendAlgorithm === 'function') {
        const rec = await Promise.race([learningSystem.recommendAlgorithm(state), timeoutPromise]);
        return { success: true, prediction: rec ?? {} };
      }
      return { success: false, error: 'LearningSystem lacks predict/recommendAlgorithm methods' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_experience_record — Record a learning episode (P3) =====

export const agentdbExperienceRecord: MCPTool = {
  name: 'agentdb_experience_record',
  description: 'Record a learning experience (episode) with outcome via ReflexionMemory',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description' },
      input: { type: 'string', description: 'Task input or context' },
      output: { type: 'string', description: 'Task output or result' },
      reward: { type: 'number', description: 'Reward signal (0-1)' },
      success: { type: 'boolean', description: 'Whether the task succeeded' },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const task = validateString(params.task, 'task', 10_000);
      if (!task) return { success: false, error: 'task is required (non-empty string, max 10KB)' };
      const input = validateString(params.input, 'input', MAX_STRING_LENGTH) ?? '';
      const output = validateString(params.output, 'output', MAX_STRING_LENGTH) ?? '';
      const reward = validateScore(params.reward, 0.5);
      const succeeded = params.success === true;
      const bridge = await getBridge();
      const reflexion = await bridge.bridgeGetController('reflexion');
      if (!reflexion || typeof reflexion.store !== 'function') {
        return { success: false, error: 'ReflexionMemory controller not available' };
      }
      const sessionId = `exp-${Date.now()}`;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('experience-record timeout (2s)')), 2000),
      );
      await Promise.race([
        reflexion.store({ session_id: sessionId, task, input, output, reward, success: succeeded }),
        timeoutPromise,
      ]);
      return { success: true, episodeId: sessionId };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== Export all tools =====

export const agentdbTools: MCPTool[] = [
  agentdbHealth,
  agentdbControllers,
  agentdbPatternStore,
  agentdbPatternSearch,
  agentdbFeedback,
  agentdbCausalEdge,
  agentdbRoute,
  agentdbSessionStart,
  agentdbSessionEnd,
  agentdbHierarchicalStore,
  agentdbHierarchicalRecall,
  agentdbConsolidate,
  agentdbBatch,
  agentdbContextSynthesize,
  agentdbSemanticRoute,
  agentdbReflexionRetrieve,
  agentdbReflexionStore,
  agentdbCausalQuery,
  agentdbBranch,
  agentdbCausalRecall,
  agentdbBatchOptimize,
  agentdbRateLimitStatus,    // ADR-0042
  agentdbResourceUsage,      // ADR-0042
  agentdbCircuitStatus,      // ADR-0042
  agentdbFilteredSearch,     // ADR-0043
  agentdbQueryStats,         // ADR-0043
  agentdbQuantizeStatus,     // ADR-0047
  agentdbHealthReport,       // ADR-0047
  agentdbEmbed,              // ADR-0045
  agentdbEmbedStatus,        // ADR-0045
  agentdbTelemetryMetrics,   // ADR-0045
  agentdbTelemetrySpans,     // ADR-0045
  agentdbAttentionCompute,   // ADR-0044
  agentdbAttentionBenchmark, // ADR-0044
  agentdbAttentionConfigure, // ADR-0044
  agentdbAttentionMetrics,   // ADR-0044
  agentdbSkillCreate,        // P4: SkillLibrary
  agentdbSkillSearch,        // P4: SkillLibrary
  agentdbLearnerRun,         // P4: NightlyLearner
  agentdbLearningPredict,    // P4: LearningSystem
  agentdbExperienceRecord,   // P3: ReflexionMemory
];
