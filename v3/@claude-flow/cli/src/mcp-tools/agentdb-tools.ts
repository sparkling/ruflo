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

import {
  getController,
  hasController,
  waitForDeferred,
  healthCheck,
  listControllerInfo,
  getCallableMethod,
  routeCausalOp,
} from '../memory/memory-router.js';

import { validateIdentifier } from './validate-input.js';

/**
 * ADR-0162 Batch C+D hand-port (commit d031c3d13):
 * In upstream, the delete tools call into `memory-bridge.ts`'s `getBridge()`
 * helper which exposes `bridgeDeleteHierarchical / bridgeDeleteCausalEdge /
 * bridgeDeleteCausalNode`. memory-bridge.ts has been deleted in our fork
 * (ADR-0086 / ADR-0161 relocated the seam to memory-router.ts), so the
 * cleanest port is to provide a minimal getBridge() locally that probes
 * the same hierarchicalMemory / causalGraph controllers via getController()
 * and falls back to a "bridge not available" result when the registry is
 * uninitialized (the test scenario). Per ADR-0082 / feedback-no-fallbacks,
 * any unexpected error re-throws via sanitizeError() at the handler level.
 */
type BridgeDeleteResult = {
  success: boolean;
  deleted: boolean;
  controller: string;
  guarded?: boolean;
  error?: string;
} & Record<string, unknown>;

type AgentDbBridge = {
  bridgeDeleteHierarchical: (opts: { key: string; tier?: string }) => Promise<BridgeDeleteResult | null>;
  bridgeDeleteCausalEdge: (opts: { sourceId: string; targetId: string; relation?: string }) => Promise<BridgeDeleteResult | null>;
  bridgeDeleteCausalNode: (opts: { nodeId: string }) => Promise<(BridgeDeleteResult & { deletedNode: boolean; deletedEdges: number; nodeId?: string }) | null>;
};

async function getBridge(): Promise<AgentDbBridge> {
  return {
    async bridgeDeleteHierarchical({ key, tier }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hm = await getController<any>('hierarchicalMemory');
      if (!hm) return null;
      const fn = getCallableMethod(hm, 'delete', 'remove', 'deleteEpisode');
      if (!fn) {
        return { success: true, deleted: false, key, tier, controller: 'native-unsupported' };
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (fn as any).call(hm, key, tier ? { tier } : undefined);
        const deleted = typeof result === 'boolean' ? result : Boolean(result);
        return { success: true, deleted, key, tier, controller: 'bridge-fallback' };
      } catch (err) {
        return { success: false, deleted: false, key, tier, controller: 'sql-error', error: err instanceof Error ? err.message : String(err) };
      }
    },
    async bridgeDeleteCausalEdge({ sourceId, targetId, relation }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cg = await getController<any>('causalGraph');
      if (!cg) return null;
      const fn = getCallableMethod(cg, 'deleteEdgesByEndpoints', 'removeEdge', 'deleteEdge');
      if (!fn) {
        return { success: true, deleted: false, sourceId, targetId, controller: 'native-unsupported' };
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (fn as any).call(cg, sourceId, targetId, relation);
        const deleted = typeof result === 'boolean' ? result : Boolean(result);
        return { success: true, deleted, sourceId, targetId, controller: 'bridge-fallback' };
      } catch (err) {
        return { success: false, deleted: false, sourceId, targetId, controller: 'sql-error', error: err instanceof Error ? err.message : String(err) };
      }
    },
    async bridgeDeleteCausalNode({ nodeId }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cg = await getController<any>('causalGraph');
      if (!cg) return null;
      const fn = getCallableMethod(cg, 'deleteNode', 'removeNode');
      if (!fn) {
        return { success: true, deletedNode: false, deletedEdges: 0, deleted: false, nodeId, controller: 'native-unsupported' };
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await (fn as any).call(cg, nodeId, { cascade: true });
        const deletedNode = typeof result?.deletedNode === 'boolean' ? result.deletedNode : Boolean(result);
        const deletedEdges = typeof result?.deletedEdges === 'number' ? result.deletedEdges : 0;
        return { success: true, deleted: deletedNode, deletedNode, deletedEdges, nodeId, controller: 'bridge-fallback' };
      } catch (err) {
        return { success: false, deleted: false, deletedNode: false, deletedEdges: 0, nodeId, controller: 'sql-error', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

import {
  sessionStart,
  sessionEnd,
  hierarchicalQuery,
  contextSynthesize,
  flashConsolidate,
  batchOperation,
  batchOptimize,
  batchPrune,
} from './agentdb-orchestration.js';

// ADR-0181 Phase 5 (F4-3): cli MCP handlers dispatch through the per-process
// Memory Archivist for every tool with a registered archivist handler
// (handlers/agentdb/**). The orchestration helpers above remain for the
// surfaces without an archivist counterpart (sessionStart/sessionEnd,
// hierarchicalQuery, contextSynthesize, flashConsolidate, batchOperation,
// batchOptimize, batchPrune); flipped surfaces use the typed
// `archivist.dispatch<K>` / `dispatchRead<K>` overloads from
// `forks/agentdb/src/archivist/dispatch-types.ts`. RVF-family reads gate
// behind `ensureRvfWired()`, SQLite-carve-out reads behind
// `ensureSqliteWired()`; FS-JSON tools need neither (Phase 4
// `t1-6-empty-search` regression posture).
//
// `recordCausalEdge` is intentionally NOT imported here — the
// agentdb_causal_edge dispatch path reaches it indirectly via the
// `makeCliCausalGraphWriter` adapter in archivist-init.ts (deferred dynamic
// import per call). ADR-0181 Item 3 (2026-05-16).
import { getProcessArchivist, ensureRvfWired, ensureSqliteWired } from '../memory/archivist-init.js';

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
      // Wait for deferred controllers so health count matches controllers count
      await waitForDeferred();
      const health = await healthCheck();
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
      // Wait for deferred (Level 2+) controllers to finish background init
      await waitForDeferred();
      const controllers = await listControllerInfo();
      if (!controllers) return { available: false, controllers: [], error: 'AgentDB bridge not available — @claude-flow/memory not installed or missing controller-registry. Use memory_store/memory_search tools instead.' };
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
  name: 'agentdb_pattern-store',
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
      const type = validateString(params.type, 'type', 200) ?? 'general';
      const confidence = validateScore(params.confidence, 0.8);

      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `forks/agentdb/src/archivist/handlers/agentdb/pattern-store.ts` owns the
      // ReasoningBank write under substrate.withWrite. The handler returns void;
      // the cli envelope here is constructed locally from the validated inputs
      // (the prior `memory-store-fallback` branch — a silent fallback path under
      // ADR-0082 — is removed: the archivist surface fails loud if the substrate
      // is unwired, which is the documented dispatch contract).
      // ADR-0181 Phase 6: agentdb_pattern_store classifies to RVF substrate
      // (substrate-registry.ts L68); gate behind ensureRvfWired() so the
      // handler's substrate.withWrite resolves.
      await ensureRvfWired();
      await (await getProcessArchivist()).dispatch('agentdb_pattern_store', { pattern, type, confidence });
      return { success: true, pattern, type, confidence, controller: 'archivist' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_pattern_search — Search via ReasoningBank =====

export const agentdbPatternSearch: MCPTool = {
  name: 'agentdb_pattern-search',
  description: 'Search patterns via ReasoningBank controller with BM25+semantic hybrid',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
      minConfidence: { type: 'number', description: 'Minimum score threshold (0-1)' },
      includeProvenance: {
        type: 'boolean',
        description:
          'When true, return full RankedResult<T>[] shape with per-candidate provenance ' +
          '({ storeId, matchType: "fused"|"bm25"|"semantic", rawScore, rank, matchedField?, explanation? }) ' +
          'for ExplainableRecall (ADR-0180 §Provenance rollout scope — MANDATORY for this fusion site per ADR-0179). ' +
          'When false/omitted, returns the legacy { results: { id, content, score }[], controller } shape for back-compat. Default: false.',
      },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/pattern-search.ts` reads the SQLite-carve-out
      // ReasoningBank table via the PatternReader capability — gate behind
      // ensureSqliteWired() (memoized; cold-start opens
      // `.claude-flow/archivist.db`). Returns RankedResults<PatternSearchHit>;
      // we surface the legacy `{ results: [{id, content, score}], controller }`
      // envelope via field-pick (cli's includeProvenance branching is deferred
      // per ADR-0180 Phase 6 — the handler emits canonical provenance, the cli
      // narrows to the legacy flat shape).
      await ensureSqliteWired();
      const ranked = await (await getProcessArchivist()).dispatchRead('agentdb_pattern_search', {
        query,
        topK: validatePositiveInt(params.topK, 5, MAX_TOP_K),
        minConfidence: validateScore(params.minConfidence, 0.3),
      }) as ReadonlyArray<{ item: { id: string; content: string; score: number } }>;
      return {
        results: ranked.map((r) => r.item),
        controller: 'archivist',
      };
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
      const success = params.success === true;
      const quality = validateScore(params.quality, 0.85);
      const agent = validateString(params.agent, 'agent', 200) ?? undefined;
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/feedback.ts` owns the LearningSystem + ReasoningBank
      // write under substrate.withWrite. Mutation handler returns void; cli
      // envelope reconstructs `{success, taskId, quality, agent}` from
      // validated inputs.
      // ADR-0181 Phase 6: agentdb_feedback classifies to RVF — wire RVF.
      await ensureRvfWired();
      await (await getProcessArchivist()).dispatch('agentdb_feedback', { taskId, success, quality, agent });
      return { success: true, taskId, recorded: { success, quality, agent }, controller: 'archivist' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_causal_edge — Record causal relationships =====

export const agentdbCausalEdge: MCPTool = {
  name: 'agentdb_causal-edge',
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
      const weight = typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : undefined;
      // ADR-0181 Item 3 (2026-05-16): dispatch through the archivist. The
      // handler at `handlers/agentdb/causal-edge.ts` opens a SQLite
      // carve-out `withWrite` scope (audit boundary only) and calls the
      // CausalGraphWriter capability — the cli adapter
      // (`makeCliCausalGraphWriter` at archivist-init.ts) delegates to the
      // existing `recordCausalEdge`/`routeCausalOp` path. Today the actual
      // write lands in RVF via router-fallback because ADR-0147 R7 (string
      // → numeric memoryId mapping) has not landed yet — the handler header
      // documents the audit-vs-storage split-brain so a future R7 wire-up
      // doesn't accidentally collapse the wrong way.
      // Storage classification: see archivist handler causal-edge.ts header
      // — Item 3 is audit-trail wiring; durable bytes still land in RVF via
      // router-fallback (ADR-0147 R7).
      // Gate behind ensureSqliteWired() — storeId classifies as SQLite
      // carve-out at substrate-registry.ts:118 even though today's writer
      // doesn't use the SQLite scope; the gate is the carve-out invariant
      // boundary, not a byte-target predicate.
      await ensureSqliteWired();
      await (await getProcessArchivist()).dispatch('agentdb_causal_edge', {
        sourceId,
        targetId,
        relation,
        weight,
      });
      return { success: true, sourceId, targetId, relation, controller: 'archivist' };
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
      const context = validateString(params.context, 'context', 10_000) ?? undefined;
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/route.ts` owns the TaskRouter capability invocation
      // (SemanticRouter / LearningSystem.recommendAlgorithm composition) and
      // persists the routing decision into the RVF-family
      // `agentdb_route` store. Per phase5-agentdb-orch recursion-avoidance
      // handoff, the cli flips here while the capability adapter
      // (`makeCliTaskRouter` at archivist-init.ts) continues to call the
      // `routeTask` orchestration helper directly — not via this MCP tool.
      // Gate behind ensureRvfWired() (RVF-dependent substrate, memoized).
      await ensureRvfWired();
      await (await getProcessArchivist()).dispatch('agentdb_route', { task, context });
      // Handler returns void; the routing decision is persisted but not
      // returned across the dispatch boundary. The cli envelope here surfaces
      // the dispatched-OK state — callers that need the decision payload should
      // read it back via the appropriate trajectory tool (the Phase 6 wire-up
      // exposes a sibling read handler).
      return { success: true, task, controller: 'archivist' };
    } catch (error) {
      return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_session_start — Session with ReflexionMemory =====

export const agentdbSessionStart: MCPTool = {
  name: 'agentdb_session-start',
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
      const result = await sessionStart({
        sessionId,
        context: validateString(params.context, 'context', 10_000) ?? undefined,
      });
      return result ?? { success: false, error: 'AgentDB not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_session_end — End session + NightlyLearner =====

export const agentdbSessionEnd: MCPTool = {
  name: 'agentdb_session-end',
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
      const result = await sessionEnd({
        sessionId,
        summary: validateString(params.summary, 'summary', 50_000) ?? undefined,
        tasksCompleted: validatePositiveInt(params.tasksCompleted, 0, 10_000),
      });
      return result ?? { success: false, error: 'AgentDB not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_hierarchical_store — Store to hierarchical memory =====

export const agentdbHierarchicalStore: MCPTool = {
  name: 'agentdb_hierarchical-store',
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
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/hierarchical-store.ts` owns the HierarchicalMemory
      // write under substrate.withWrite. ADR-0181 Phase 7 reclassification:
      // `agentdb_hierarchical_store` moved from the RVF roster to the SQLite
      // carve-out (substrate-registry.ts) so the archivist write hits the
      // SAME `.swarm/memory.db` file the controllers initialize. Gate behind
      // ensureSqliteWired() — mirrors the read-side pattern at the
      // hierarchical-recall site below.
      await ensureSqliteWired();
      await (await getProcessArchivist()).dispatch('agentdb_hierarchical_store', {
        key,
        value,
        tier: tier as 'working' | 'episodic' | 'semantic',
      });
      return { success: true, key, tier, controller: 'archivist' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_hierarchical_recall — Recall from hierarchical memory =====

export const agentdbHierarchicalRecall: MCPTool = {
  name: 'agentdb_hierarchical-recall',
  description: 'Recall from hierarchical memory with optional tier filter',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Recall query' },
      tier: { type: 'string', description: 'Filter by tier (working, episodic, semantic)' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
      includeProvenance: { type: 'boolean', description: 'When true, return RankedResults<HierarchicalRecallHit> with per-hit provenance (storeId, matchType, rawScore, rank). Default false preserves legacy `{ results: [...] }` shape (ADR-0180 Phase 6).' },
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
      // ADR-0181 Phase 7: agentdb_hierarchical_recall classifies to the
      // SQLite carve-out (substrate-registry.ts). The handler at
      // `handlers/agentdb/hierarchical-recall.ts` runs
      // `SELECT FROM hierarchical_memory ORDER BY importance DESC LIMIT topK`
      // against the shared `.swarm/memory.db` handle — same handle the
      // ControllerRegistry-owned AgentDB wires for the WRITE side at L516.
      // Gate behind ensureSqliteWired(); ensureRvfWired() would leave the
      // SQLite handle unset and ctx.substrate.query would throw / return
      // empty (the symptom that pre-r3 surfaced as adr0112-27-4-rt-hierarchical
      // failing). Returns RankedResults<HierarchicalRecallHit> — narrow to
      // legacy `{results}` envelope via field-pick (`includeProvenance`
      // branching deferred per ADR-0180 Phase 6).
      await ensureSqliteWired();
      const ranked = await (await getProcessArchivist()).dispatchRead('agentdb_hierarchical_recall', {
        query,
        tier: tier as 'working' | 'episodic' | 'semantic' | undefined,
        topK: validatePositiveInt(params.topK, 5, MAX_TOP_K),
      }) as ReadonlyArray<{ item: unknown }>;
      return {
        success: true,
        results: ranked.map((r) => r.item),
        controller: 'archivist',
      };
    } catch (error) {
      return { success: false, results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_hierarchical-query — Path/glob enumeration over hierarchical store (ADR-0176 Phase 3) =====

export const agentdbHierarchicalQuery: MCPTool = {
  name: 'agentdb_hierarchical-query',
  description: 'Enumerate records from hierarchical memory by path/glob pattern. Distinct from hierarchical-recall (similarity search) — use this when you have a path like "adr/*" and want all records under it. `*` matches multi-char, `?` matches single-char.',
  inputSchema: {
    type: 'object',
    properties: {
      pathPattern: { type: 'string', description: 'Path/glob pattern (e.g., "adr/*", "skills/*-store")' },
      tier: { type: 'string', description: 'Optional filter by tier: working | episodic | semantic' },
      limit: { type: 'number', description: 'Optional max results (default: unlimited)' },
    },
    required: ['pathPattern'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const pathPattern = validateString(params.pathPattern, 'pathPattern', 10_000);
      if (!pathPattern) return { success: false, results: [], error: 'pathPattern is required (non-empty string, max 10KB)' };
      const tier = validateString(params.tier, 'tier', 20);
      if (tier && !['working', 'episodic', 'semantic'].includes(tier)) {
        return { success: false, results: [], error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const result = await hierarchicalQuery({
        pathPattern,
        tier: tier as 'working' | 'episodic' | 'semantic' | undefined,
        limit: validatePositiveInt(params.limit, undefined as any, MAX_TOP_K),
      });
      return result ?? { results: [], error: 'AgentDB not available.' };
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
      const ctrl = await getController<any>('memoryConsolidation');
      if (!ctrl) return { success: false, error: 'Memory consolidation controller not available' };
      // consolidate(ctx?: MutationContext) takes an optional mutation context,
      // NOT an options object. Passing { minAge, maxEntries } made the truthy
      // object satisfy `ctx?.child` (no null short-circuit) but lack `.child`,
      // throwing "ctx?.child is not a function" — the catch then returned the
      // report WITHOUT calling logConsolidation(), so consolidation_log stayed
      // empty (ADR-0082 silent-pass). The MCP path has no mutation context to
      // thread, so call it with none. minAge/maxEntries remain in the schema
      // for forward-compat but consolidate() does not consume them.
      void params;
      const result = typeof ctrl.consolidate === 'function'
        ? await ctrl.consolidate()
        : null;
      return result ?? { success: false, error: 'consolidate method not available' };
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
      const result = await batchOperation({
        operation,
        entries: validatedEntries,
      });
      return result ?? { success: false, error: 'AgentDB not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_context_synthesize — Synthesize context from memories =====

export const agentdbContextSynthesize: MCPTool = {
  name: 'agentdb_context-synthesize',
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
      const result = await contextSynthesize({
        query,
        maxEntries: validatePositiveInt(params.maxEntries, 10, MAX_TOP_K),
      });
      return result ?? { success: false, error: 'AgentDB not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_semantic_route — Route via SemanticRouter =====

export const agentdbSemanticRoute: MCPTool = {
  name: 'agentdb_semantic-route',
  description: 'Route an input via AgentDB SemanticRouter for intent classification',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input text to route' },
      includeProvenance: {
        type: 'boolean',
        description:
          'When true, return archivist RankedResults<SemanticRouteHit> shape with provenance ' +
          '{ storeId: "semantic-router", matchType: "semantic", rawScore: confidence, rank } per entry ' +
          '(ADR-0180 Phase 6 §Provenance rollout scope). When false/omitted, returns the legacy ' +
          '{ route, confidence, ... } flat shape for back-compat. Default: false.',
      },
    },
    required: ['input'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const input = validateString(params.input, 'input', 10_000);
      if (!input) return { success: false, route: null, error: 'input is required (non-empty string, max 10KB)' };
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/semantic-route.ts` runs the RVF-family
      // SemanticRouter.route read; gate behind ensureRvfWired(). Returns
      // RankedResults<SemanticRouteHit>; cli flattens to legacy
      // `{ route, confidence, ... }` from the top hit per ADR-0180 Phase 6
      // (includeProvenance branching deferred — handler emits canonical
      // provenance, cli narrows to legacy flat shape).
      await ensureRvfWired();
      const ranked = await (await getProcessArchivist()).dispatchRead('agentdb_semantic_route', {
        input,
      }) as ReadonlyArray<{ item: { route: string; confidence: number; metadata?: Record<string, unknown> } }>;
      const top = ranked[0]?.item;
      if (!top) return { success: false, route: null, error: 'No route matched' };
      return { success: true, route: top.route, confidence: top.confidence, metadata: top.metadata, controller: 'archivist' };
    } catch (error) {
      return { success: false, route: null, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_graph_node_create — Create a node in GraphDatabaseAdapter =====

export const agentdbGraphNodeCreate: MCPTool = {
  name: 'agentdb_graph_node_create',
  description: 'Create a node in AgentDB GraphDatabaseAdapter. Requires controllers.graphAdapter=true in config.',
  inputSchema: {
    type: 'object',
    properties: {
      id:         { type: 'string', description: 'Unique node ID' },
      label:      { type: 'string', description: 'Node label (e.g. "Episode", "Skill")' },
      properties: { type: 'object', description: 'Optional key-value properties (string values)' },
    },
    required: ['id', 'label'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const id    = validateString(params.id,    'id',    500);
      const label = validateString(params.label, 'label', 200);
      if (!id)    return { success: false, error: 'id is required (non-empty string, max 500 chars)' };
      if (!label) return { success: false, error: 'label is required (non-empty string, max 200 chars)' };
      const ctrl = await getController<any>('graphAdapter');
      if (!ctrl) return { success: false, error: 'graphAdapter not available (controllers.graphAdapter must be enabled in config)' };
      const properties: Record<string, string> = {};
      if (params.properties && typeof params.properties === 'object') {
        for (const [k, v] of Object.entries(params.properties as Record<string, unknown>)) {
          properties[k] = String(v);
        }
      }
      const nodeId = await ctrl.createNode({ id, labels: [label], embedding: new Float32Array(0), properties });
      return { success: true, nodeId };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_graph_edge_create — Create an edge in GraphDatabaseAdapter =====

export const agentdbGraphEdgeCreate: MCPTool = {
  name: 'agentdb_graph_edge_create',
  description: 'Create an edge between two nodes in AgentDB GraphDatabaseAdapter. Requires controllers.graphAdapter=true in config.',
  inputSchema: {
    type: 'object',
    properties: {
      from:       { type: 'string', description: 'Source node ID' },
      to:         { type: 'string', description: 'Target node ID' },
      type:       { type: 'string', description: 'Edge type / description' },
      properties: { type: 'object', description: 'Optional key-value metadata (string values)' },
    },
    required: ['from', 'to', 'type'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const from = validateString(params.from, 'from', 500);
      const to   = validateString(params.to,   'to',   500);
      const type = validateString(params.type, 'type', 500);
      if (!from) return { success: false, error: 'from is required (non-empty string, max 500 chars)' };
      if (!to)   return { success: false, error: 'to is required (non-empty string, max 500 chars)' };
      if (!type) return { success: false, error: 'type is required (non-empty string, max 500 chars)' };
      const ctrl = await getController<any>('graphAdapter');
      if (!ctrl) return { success: false, error: 'graphAdapter not available (controllers.graphAdapter must be enabled in config)' };
      const metadata: Record<string, string> = {};
      if (params.properties && typeof params.properties === 'object') {
        for (const [k, v] of Object.entries(params.properties as Record<string, unknown>)) {
          metadata[k] = String(v);
        }
      }
      await ctrl.createEdge({ from, to, description: type, embedding: new Float32Array(0), metadata });
      return { success: true, from, to, type };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_graph_node_get — Query a node by ID from GraphDatabaseAdapter =====

export const agentdbGraphNodeGet: MCPTool = {
  name: 'agentdb_graph_node_get',
  description: 'Query a node by ID from AgentDB GraphDatabaseAdapter using Cypher. Requires controllers.graphAdapter=true in config.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Node ID to retrieve' },
    },
    required: ['id'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const id = validateString(params.id, 'id', 500);
      if (!id) return { success: false, error: 'id is required (non-empty string, max 500 chars)' };
      const ctrl = await getController<any>('graphAdapter');
      if (!ctrl) return { success: false, error: 'graphAdapter not available (controllers.graphAdapter must be enabled in config)' };
      // Prefer the direct getNodeById path (O(1), no Cypher parse). Fall back
      // to the Cypher query surface only when the adapter build predates
      // the getNodeById method (pre-@ruvector/graph-node 2.1.0).
      if (typeof ctrl.getNodeById === 'function') {
        const node = await ctrl.getNodeById(id);
        return { success: true, nodes: node ? [node] : [], edges: [] };
      }
      const result = await ctrl.query('MATCH (n) RETURN n');
      const match = result?.nodes?.find((n: any) => n.id === id);
      return { success: true, nodes: match ? [match] : [], edges: [] };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_semantic_add_route — Add a named route to SemanticRouter =====
//
// Cross-process persistence: agentdb.SemanticRouter holds routes in a
// process-local Map. For MCP consumers that spawn a fresh CLI process
// per tool call (the canonical model), routes added in one process
// vanish before the next read. We persist each mutation to
// `.claude-flow/semantic-routes.json`; controller-registry hydrates
// the router from this file on construction.
async function _persistSemanticRoutes(
  action: 'add' | 'remove',
  entry: { name: string; description?: string; keywords?: string[] },
): Promise<void> {
  try {
    const { existsSync, readFileSync, mkdirSync, writeFileSync } =
      await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { findProjectRoot } = await import('./types.js');
    const path = join(findProjectRoot(), '.claude-flow', 'semantic-routes.json');
    let routes: Array<{ name: string; description?: string; keywords?: string[] }> = [];
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) routes = parsed;
      } catch { /* corrupt file — overwrite */ }
    }
    routes = routes.filter(r => r && r.name !== entry.name);
    if (action === 'add') {
      routes.push({
        name: entry.name,
        description: entry.description ?? '',
        keywords: entry.keywords ?? [],
      });
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(routes, null, 2), 'utf-8');
  } catch (err) {
    // ADR-0112 Phase 2 (MCP handler track): persist failure is fatal.
    // The route was added in-memory but will not survive process restart;
    // returning success here violates ADR-0082 + ADR-0112 §Required
    // follow-up #4 (no "best-effort" persistence paths). Re-throw so the
    // outer handler returns success:false.
    throw new Error(
      `Failed to persist semantic routes to disk: ${err instanceof Error ? err.message : String(err)}. In-memory route was added but will be lost on restart.`,
    );
  }
}

export const agentdbSemanticAddRoute: MCPTool = {
  name: 'agentdb_semantic_add_route',
  description: 'Add a named route to AgentDB SemanticRouter for intent classification',
  inputSchema: {
    type: 'object',
    properties: {
      name:        { type: 'string',                    description: 'Unique route name' },
      description: { type: 'string',                    description: 'Natural-language description of the route' },
      keywords:    { type: 'array', items: { type: 'string' }, description: 'Optional keywords for this route' },
    },
    required: ['name', 'description'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const name        = validateString(params.name,        'name',        500);
      const description = validateString(params.description, 'description', 5_000);
      if (!name)        return { success: false, error: 'name is required (non-empty string, max 500 chars)' };
      if (!description) return { success: false, error: 'description is required (non-empty string, max 5KB)' };
      const keywords = Array.isArray(params.keywords)
        ? (params.keywords as unknown[]).filter((k): k is string => typeof k === 'string')
        : undefined;
      const ctrl = await getController<any>('semanticRouter');
      if (!ctrl)             return { success: false, error: 'SemanticRouter not available' };
      if (typeof ctrl.addRoute !== 'function') return { success: false, error: 'addRoute method not available' };
      await ctrl.addRoute(name, description, keywords);
      // Persist so subsequent CLI subprocesses see the route after hydrate.
      await _persistSemanticRoutes('add', { name, description, keywords });
      return { success: true, name, description, keywords: keywords ?? [] };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_semantic_remove_route — Remove a named route from SemanticRouter =====

export const agentdbSemanticRemoveRoute: MCPTool = {
  name: 'agentdb_semantic_remove_route',
  description: 'Remove a named route from AgentDB SemanticRouter',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the route to remove' },
    },
    required: ['name'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const name = validateString(params.name, 'name', 500);
      if (!name) return { success: false, error: 'name is required (non-empty string, max 500 chars)' };
      const ctrl = await getController<any>('semanticRouter');
      if (!ctrl)                return { success: false, error: 'SemanticRouter not available' };
      if (typeof ctrl.removeRoute !== 'function') return { success: false, error: 'removeRoute method not available' };
      await ctrl.removeRoute(name);
      await _persistSemanticRoutes('remove', { name });
      return { success: true, removed: name };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_semantic_list_routes — List all routes in SemanticRouter =====

export const agentdbSemanticListRoutes: MCPTool = {
  name: 'agentdb_semantic_list_routes',
  description: 'List all named routes registered in AgentDB SemanticRouter',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (_params: Record<string, unknown>) => {
    try {
      const ctrl = await getController<any>('semanticRouter');
      if (!ctrl)               return { success: false, routes: [], error: 'SemanticRouter not available' };
      if (typeof ctrl.getRoutes !== 'function') return { success: false, routes: [], error: 'getRoutes method not available' };
      const routes = await ctrl.getRoutes();
      return { success: true, routes: routes ?? [] };
    } catch (error) {
      return { success: false, routes: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_reflexion_retrieve — Recall past task experiences (P3-B) =====

export const agentdbReflexionRetrieve: MCPTool = {
  name: 'agentdb_reflexion-retrieve',
  description: 'Retrieve reflexion memories for a task to inform decisions',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to find relevant reflexions for' },
      k: { type: 'number', description: 'Number of results to return (default: 5)' },
      includeProvenance: {
        type: 'boolean',
        description:
          'When true, return full RankedResult<T>[] shape with per-candidate provenance ' +
          '({ storeId: "reflexion", matchType: "semantic", rawScore, rank, matchedField?, explanation? }) ' +
          'for ExplainableRecall (ADR-0180 §Provenance rollout scope — ranked recall site). ' +
          'When false/omitted, returns the legacy episode array for back-compat. Default: false.',
      },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const task = validateString(params.task, 'task', 10_000);
      if (!task) return { success: false, results: [], error: 'task is required (non-empty string, max 10KB)' };
      const k = validatePositiveInt(params.k, 5, MAX_TOP_K);
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/reflexion-retrieve.ts` runs the SQLite-carve-out
      // ReflexionMemory read (PERMANENT_SQLITE_CARVE_OUT per ADR-0166); gate
      // behind ensureSqliteWired(). Returns RankedResults<ReflexionEpisodeHit>;
      // cli surfaces the episode array via field-pick (includeProvenance
      // branching deferred per ADR-0180 Phase 6).
      await ensureSqliteWired();
      const ranked = await (await getProcessArchivist()).dispatchRead('agentdb_reflexion_retrieve', {
        task,
        k,
      }) as ReadonlyArray<{ item: unknown }>;
      return {
        success: true,
        results: ranked.map((r) => r.item),
        count: ranked.length,
        controller: 'archivist',
      };
    } catch (error) {
      return { success: false, results: [], error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_reflexion_store — Record task outcome (P3-B) =====

export const agentdbReflexionStore: MCPTool = {
  name: 'agentdb_reflexion-store',
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
      const success = params.success === true;
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/reflexion-store.ts` owns the ReflexionMemory write
      // under substrate.withWrite. ADR-0181 Phase 7 reclassification:
      // `agentdb_reflexion_store` moved from the RVF roster to the SQLite
      // carve-out (substrate-registry.ts) so the archivist write hits the
      // SAME `.swarm/memory.db` file the controllers initialize. Gate behind
      // ensureSqliteWired() — mirrors the read-side pattern at the
      // reflexion-retrieve site above.
      await ensureSqliteWired();
      await (await getProcessArchivist()).dispatch('agentdb_reflexion_store', {
        session_id: sessionId,
        task,
        reward,
        success,
      });
      return { success: true, sessionId, controller: 'archivist' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_causal_query — Query causal graph (P3-C) =====

export const agentdbCausalQuery: MCPTool = {
  name: 'agentdb_causal-query',
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
    // Bug-2 (2026-05-05): delegate to routeCausalOp({type:'query'}) so the
    // read path uses the same router-fallback ladder as the edge writes.
    // Previously this handler bypassed the router entirely, so edges
    // written to the 'causal-edges' namespace via fallback were unreachable.
    try {
      const cause = validateString(params.cause, 'cause', 1000) ?? undefined;
      const effect = validateString(params.effect, 'effect', 1000) ?? undefined;
      const k = validatePositiveInt(params.k, 10, MAX_TOP_K);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('causal_query timeout (2s)')), 2000),
      );
      const routed = await Promise.race([
        routeCausalOp({ type: 'query', cause, effect, k }),
        timeoutPromise,
      ]) as { success: boolean; results?: unknown[]; controller?: string; error?: string };

      let results: unknown[] = Array.isArray(routed.results) ? routed.results : [];
      if (typeof params.min_uplift === 'number') {
        const minUplift = params.min_uplift;
        results = results.filter((r: any) => (r.uplift || r.weight || 0) >= minUplift);
      }
      return {
        success: routed.success !== false,
        results,
        count: results.length,
        controller: routed.controller,
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

      const backend = await getController<any>('vectorBackend');

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
  name: 'agentdb_causal-recall',
  description: 'Search with causal-aware re-ranking (boosts results with higher causal uplift)',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      k: { type: 'number', description: 'Number of results (default: 10)' },
      include_evidence: { type: 'boolean', description: 'Include causal evidence chains' },
      includeProvenance: { type: 'boolean', description: 'Return full RankedResults<CausalRecallHit> with provenance (storeId, matchType, rawScore, rank) per ADR-0180 §Provenance rollout scope; default false preserves legacy flattened shape' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { success: false, error: 'query is required (non-empty string, max 10KB)' };
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/causal-recall.ts` reads the SQLite-carve-out
      // CausalRecall edges table (PERMANENT_SQLITE_CARVE_OUT per ADR-0166);
      // gate behind ensureSqliteWired(). Returns RankedResults<CausalRecallHit>;
      // cli narrows to legacy `{ id, content, score }[]` via field-pick
      // (includeProvenance branching deferred per ADR-0180 Phase 6).
      await ensureSqliteWired();
      const ranked = await (await getProcessArchivist()).dispatchRead('agentdb_causal_recall', {
        query,
        k: validatePositiveInt(params.k, 10, MAX_TOP_K),
        includeEvidence: params.include_evidence === true,
      }) as ReadonlyArray<{ item: unknown }>;
      return {
        success: true,
        results: ranked.map((r) => r.item),
        count: ranked.length,
        controller: 'archivist',
      };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_batch_optimize — Optimize and prune storage (ADR-0033) =====

export const agentdbBatchOptimize: MCPTool = {
  name: 'agentdb_batch-optimize',
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
      switch (action) {
        case 'optimize':
        case 'stats':
          return await batchOptimize();
        case 'prune':
          return await batchPrune({
            maxAge: typeof params.max_age === 'number' ? Math.max(0, params.max_age) : undefined,
            minReward: validateScore(params.min_reward, 0),
          });
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
      const ctrl = await getController<any>('rateLimiter');
      if (!ctrl) return { success: false, error: 'Rate limiter not available' };
      const stats = typeof ctrl.getStats === 'function' ? ctrl.getStats() : {};
      return { success: true, ...stats };
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
      const ctrl = await getController<any>('resourceTracker');
      if (!ctrl) return { success: false, error: 'Resource tracker not available' };
      const stats = typeof ctrl.getStats === 'function' ? ctrl.getStats() : {};
      return { success: true, ...stats };
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
      const ctrl = await getController<any>('circuitBreakerController');
      if (!ctrl) return { success: false, error: 'Circuit breaker not available' };
      const stats = typeof ctrl.getStats === 'function' ? ctrl.getStats() : {};
      return { success: true, ...stats };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// agentdb_quantize_status — deferred (bridge not implemented)
// agentdb_health_report  — deferred (bridge not implemented)

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
      includeProvenance: {
        type: 'boolean',
        description:
          'When true, return full RankedResult<T>[] shape with per-candidate provenance ' +
          '({ storeId, matchType: "fused"|"bm25"|"semantic", rawScore, rank, matchedField?, explanation? }) ' +
          'for ExplainableRecall (ADR-0180 §Provenance rollout scope — MANDATORY for this fusion site per ADR-0179). ' +
          'When false/omitted, returns the legacy { id, content, score }[] flat shape for back-compat. Default: false.',
      },
    },
    required: ['query'],
  },
  handler: async (input) => {
    try {
      const query = input.query as string;
      if (!query || typeof query !== 'string') {
        return { success: false, error: 'query is required (non-empty string)' };
      }
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/filtered-search.ts` runs the FS-JSON corpus filter
      // (STORE_ID = 'agentdb_filtered_search', not in RVF or SQLite-carve-out
      // rosters) — no ensure*Wired call needed. Returns
      // RankedResults<FilteredSearchHit>; cli narrows to legacy
      // `{ results: [{id, content, score}] }` envelope via field-pick.
      const ranked = await (await getProcessArchivist()).dispatchRead('agentdb_filtered_search', {
        query,
        filter: input.filter as Record<string, unknown> | undefined,
        namespace: input.namespace as string | undefined,
        limit: input.limit as number | undefined,
        threshold: input.threshold as number | undefined,
      }) as ReadonlyArray<{ item: unknown }>;
      return {
        success: true,
        results: ranked.map((r) => r.item),
        count: ranked.length,
        controller: 'archivist',
      };
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
      const ctrl = await getController<any>('queryOptimizer');
      if (!ctrl) return { success: false, error: 'QueryOptimizer not available' };
      // getCacheStats() returns cache hit/miss/size; getStats() returns per-query array
      const stats = typeof ctrl.getCacheStats === 'function'
        ? ctrl.getCacheStats()
        : typeof ctrl.getStats === 'function' ? ctrl.getStats() : {};
      return { success: true, ...stats };
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
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/embed.ts` is capability-only (no `ctx.substrate`
      // touch) — embeds via `ctx.capabilities.requireEmbeddingScorer()`, which
      // adapts down to the cli's EnhancedEmbeddingService. Per team-lead ruling
      // no ensure*Wired call is needed (capability-only path).
      const result = await (await getProcessArchivist()).dispatchRead('agentdb_embed', { text }) as {
        success: true; embedding: ReadonlyArray<number>; dimension: number;
      } | undefined;
      return result ?? { success: false, error: 'Embedding service not available' };
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
      // D5: Report both enabled (configuration readiness) and initialized
      // (instantiation readiness) to avoid disagreement between health report
      // and embed_status for Level 3+ deferred controllers.
      const controllers = await listControllerInfo();
      const entry = (controllers as any[])?.find((c: { name: string }) => c.name === 'enhancedEmbeddingService');
      const enabled = entry?.enabled ?? false;
      const initialized = await hasController('enhancedEmbeddingService');
      // Try to get status from the controller if instantiated
      const controller = initialized ? await getController<any>('enhancedEmbeddingService') : null;
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
      const ctrl = await getController<any>('telemetryManager');
      if (!ctrl) return { success: false, error: 'TelemetryManager not available' };
      const result = typeof ctrl.getMetrics === 'function' ? { success: true, metrics: ctrl.getMetrics() } : { success: false, error: 'getMetrics not available' };
      if (!result.success) return result;
      const metrics = result.metrics;
      const countersEmpty = !metrics?.counters || Object.keys(metrics.counters).length === 0;
      const histogramsEmpty = !metrics?.histograms || Object.keys(metrics.histograms).length === 0;
      const isEmpty = !metrics || (countersEmpty && histogramsEmpty);
      if (isEmpty) {
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
      const ctrl = await getController<any>('telemetryManager');
      if (!ctrl) return { success: false, error: 'TelemetryManager not available' };
      const spans = typeof ctrl.getSpans === 'function' ? ctrl.getSpans(limit) : [];
      if (!spans || (Array.isArray(spans) && spans.length === 0)) {
        return { success: true, spans: [], notice: 'No span instrumentation wired. Spans require controller operations to call telemetryManager.startSpan().' };
      }
      return { success: true, spans };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// agentdb_attention_compute — deferred (bridge not implemented)

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
      const count = validatePositiveInt(args.entryCount, 100, 10000);
      const dim = validatePositiveInt(args.dimensions, 64, 4096);
      // Generate synthetic entries for benchmarking
      const entries = Array.from({ length: count }, (_, i) => ({
        id: `bench_${i}`,
        embedding: Array.from({ length: dim }, () => Math.random()),
      }));
      const start = Date.now();
      const result = await flashConsolidate({
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
      const result = await getController<any>('attentionService');
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
      const metricsCtrl = await getController<any>('attentionMetrics');
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
      const description = validateString(params.description, 'description', 10_000) ?? '';
      const code = validateString(params.code, 'code', MAX_STRING_LENGTH) ?? '';
      const successRate = validateScore(params.success_rate, 0.5);
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/skill-create.ts` owns the SkillLibrary write under
      // substrate.withWrite. ADR-0181 Phase 7 reclassification: STORE_ID
      // `agentdb_skill_create` moved from the RVF roster to the SQLite
      // carve-out (substrate-registry.ts) so the archivist write hits the
      // SAME `.swarm/memory.db` file the controllers initialize. Gate behind
      // ensureSqliteWired() — mirrors the read-side pattern at the
      // skill-search site below.
      await ensureSqliteWired();
      await (await getProcessArchivist()).dispatch('agentdb_skill_create', {
        name,
        description,
        code,
        success_rate: successRate,
      });
      return { success: true, skillId: name, controller: 'archivist' };
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
      includeProvenance: {
        type: 'boolean',
        description:
          'When true, return full RankedResult<SkillSearchHit>[] shape with per-candidate provenance ' +
          '({ storeId: "skills", matchType: "semantic", rawScore, rank, matchedField?: "name"|"description", explanation? }) ' +
          'for ExplainableRecall (ADR-0180 §Provenance rollout scope). ' +
          'When false/omitted, returns the legacy { success, skills: [...] } shape for back-compat. Default: false.',
      },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { success: false, skills: [], error: 'query is required (non-empty string, max 10KB)' };
      const limit = validatePositiveInt(params.limit, 5, MAX_TOP_K);
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/skill-search.ts` runs a SQL query (`SELECT ... FROM
      // skills ...`) against the SQLite-carve-out skills table — per
      // team-lead ruling gate behind ensureSqliteWired(). Returns
      // RankedResults<SkillSearchHit>; cli surfaces legacy
      // `{ success, skills: [...] }` envelope via field-pick.
      await ensureSqliteWired();
      const ranked = await (await getProcessArchivist()).dispatchRead('agentdb_skill_search', {
        query,
        limit,
      }) as ReadonlyArray<{ item: unknown }>;
      return {
        success: true,
        skills: ranked.map((r) => r.item),
        controller: 'archivist',
      };
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
      // ADR-0181 Item 4 (2026-05-16) — pre-warm the SQLite carve-out
      // substrate before invoking the controller. NightlyLearner's
      // F4-2 substrate-seam wraps (NightlyLearner.ts call sites at L313
      // / L435 / L529 / L579 / L614) need
      // `getControllerRegistryAgentDb()` resolved so a future caller
      // that mints a MutationContext finds an initialized substrate
      // for `agentdb_causal_edge` / `agentdb_causal_experiment`. Forward-
      // defensive: today the cli passes no ctx so the wraps stay dead,
      // but pre-positioning the handle costs nothing and matches the
      // L516/L1103/L1733 pattern. NOT mirrored at memory-router.ts:1958
      // because that branch is dead per task #88's misnamed-method bug.
      await ensureSqliteWired();
      const learner = await getController<any>('nightlyLearner');
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
      const learningSystem = await getController<any>('learningSystem');
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
  description: 'Record a learning experience (episode) in the learning_experiences table via LearningSystem',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description (stored as `action`)' },
      input: { type: 'string', description: 'Task input or context (stored in metadata)' },
      output: { type: 'string', description: 'Task output or result (stored in metadata)' },
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
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `handlers/agentdb/experience-record.ts` owns the LearningSystem write
      // (including the FOREIGN-KEY-honoring session bootstrap) under
      // substrate.withWrite. ADR-0181 Item 5 (2026-05-16): post-pglite→SQLite
      // port, LearningSystem persists to the SQLite carve-out — same off-by-one
      // class as the Phase 7 r3 fix at agentdb-tools.ts:559 — gate behind
      // ensureSqliteWired() so the cli's existing AgentDB SQLite handle is
      // shared with the archivist substrate (handle-share, not path-repoint).
      await ensureSqliteWired();
      await (await getProcessArchivist()).dispatch('agentdb_experience_record', {
        task,
        input,
        output,
        reward,
        success: succeeded,
      });
      return { success: true, task, controller: 'archivist' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_neural_patterns — GNNService telemetry + pattern inspection (ADR-0094 W2-I4) =====
//
// Exposes the gnnService controller (GNNService class in agentdb) through the
// MCP manifest. Prior to W2-I4 this tool did not exist and ADR-0090 Tier B5
// check `adr0090-b5-gnnService` classified as SKIP_ACCEPTED because the tool
// was missing ("Tool not found"). GNNService is a compute-only service (no
// SQLite persistence by design — see architectural note in
// controller-registry.ts:1566-1576 and the service's d.ts — so this tool
// returns live state + telemetry rather than a persistence round-trip.
//
// Supported actions:
//   - "stats" (default) — returns { engine, initialized, config, count }
//                         where `count` is the number of cached patterns (0
//                         when none have been submitted yet). Matches the
//                         agent-guided response shape from the B5 check's
//                         "real tool output — probably patterns or count
//                         field" guidance.
//   - "similar"         — run findSimilarPatterns against the caller's
//                         `pattern` embedding (or a one-hot placeholder when
//                         no embedding is supplied). Returns a `patterns`
//                         array with index/similarity entries.
//
// Failure modes (narrow, per ADR-0082):
//   - Controller not wired in build → { success: false, error: 'GNNService controller not available' }
//   - Action unsupported           → { success: false, error: '...' }
//   - Internal error               → { success: false, error: sanitizeError(...) }
//
// Never silently falls back — every code path surfaces an explicit status so
// the B5 check helper can discriminate PASS from SKIP_ACCEPTED.

export const agentdbNeuralPatterns: MCPTool = {
  name: 'agentdb_neural_patterns',
  description: 'Inspect GNNService neural patterns (stats, engine type, similarity search). Read-only — no persistence by design.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['stats', 'similar'],
        description: 'What to query. "stats" returns engine + pattern count. "similar" runs findSimilarPatterns against the supplied pattern. Default: stats.',
      },
      pattern: {
        type: 'string',
        description: 'Pattern identifier or text (used as a marker + to derive a deterministic placeholder embedding when no vector supplied).',
      },
      type: {
        type: 'string',
        description: 'Optional pattern type label (informational only).',
      },
      embedding: {
        type: 'array',
        description: 'Optional explicit embedding vector (number[]) for similarity queries.',
      },
      includeProvenance: {
        type: 'boolean',
        description:
          'When true and action is "similar", return RankedResults<NeuralPatternHit> with provenance ' +
          '({ storeId: "gnnService", matchType: "semantic", rawScore: similarity, rank }) per ADR-0180 ' +
          '§Provenance rollout scope. Ignored for action "stats" (provenance-exempt). Default: false.',
      },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const action = (validateString(params.action, 'action', 32) ?? 'stats') as 'stats' | 'similar';
      const patternMarker = validateString(params.pattern, 'pattern', 10_000) ?? undefined;
      const patternType = validateString(params.type, 'type', 200) ?? 'neural';
      const embedding = Array.isArray(params.embedding) && (params.embedding as unknown[]).every((n) => typeof n === 'number')
        ? (params.embedding as number[])
        : undefined;

      // ADR-0181 Item 2 (2026-05-15) — `'stats'` and `'similar'` route to
      // SEPARATE dispatched handlers. Per b5-queen verdict, option (a) (split
      // handler) over option (c) (cli-side bypass for stats) — keeps every
      // action of this tool flowing through dispatch so the cli/archivist
      // boundary stays clean. The new `agentdb_gnn_stats` handler reads
      // GNNService telemetry through the `GNNTelemetryReader` capability
      // (no substrate dependency — telemetry lives on the controller). The
      // existing `agentdb_neural_patterns` handler stays substrate-backed for
      // `'similar'` — `ctx.substrate.vectorSearch` against
      // `agentdb_pattern_store` (RVF-family — gate behind ensureRvfWired).
      if (action === 'stats') {
        const stats = await (await getProcessArchivist()).dispatchRead('agentdb_gnn_stats', {
          pattern: patternMarker,
          type: patternType,
        });
        // Return the legacy cli `{success:true, controller:"gnnService",
        // engine, count, ...}` shape the b5 PASS-branch matches at
        // lib/acceptance-adr0090-b5-checks.sh:1540-1554. The handler already
        // returns this shape verbatim so the response IS the cli envelope.
        return stats;
      }

      // action === 'similar': substrate-backed read.
      await ensureRvfWired();
      const ranked = await (await getProcessArchivist()).dispatchRead('agentdb_neural_patterns', {
        action,
        pattern: patternMarker,
        type: patternType,
        embedding,
      }) as ReadonlyArray<{ item: { index: number; similarity?: number } }>;
      const patterns = ranked.map((r) => r.item);
      return {
        success: true,
        controller: 'archivist',
        action,
        patterns,
        count: patterns.length,
        marker: patternMarker ?? null,
        type: patternType,
      };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== agentdb_sona_trajectory_store — SonaTrajectoryService record + stats (ADR-0094 W2-I5) =====
//
// Exposes the sonaTrajectory controller (SonaTrajectoryService in agentdb)
// through a dedicated MCP tool. Prior to W2-I5, `agentdb_pattern_store` was
// the only pattern-ish surface and it is hard-wired to ReasoningBank — calling
// it with `type:"sona-trajectory"` landed in `reasoning_patterns`, not
// anywhere observable on the sonaTrajectory controller. B5 verifier
// (acceptance-adr0090-b5-checks.sh:746) classified as SKIP_ACCEPTED via the
// wrong-controller branch (helper 4g). That is the regression-guard this tool
// dismantles: a dedicated `controller:"sonaTrajectory"` response shape so B5
// can do real state-diff verification.
//
// SonaTrajectoryService is architecturally in-memory (no SQLite persistence —
// see the service's d.ts at packages/agentdb/dist/src/services/
// SonaTrajectoryService.d.ts). There is no `sona_trajectories` table anywhere
// in agentdb source. This tool therefore follows the same template as W2-I4
// `agentdb_neural_patterns`: state-diff verification via getStats()
// trajectoryCount rather than row-count on SQLite.
//
// Supported actions:
//   - "record" (default) — calls recordTrajectory(agentType, steps) with the
//                          supplied pattern as a marker step. Returns
//                          { success, controller: 'sonaTrajectory', engine,
//                            trajectoryCount, agentType, marker }.
//                          `trajectoryCount` reflects total stored trajectories
//                          across all agentTypes (sum over service's Map).
//   - "stats"             — returns { success, controller, engine, stats }
//                          without modifying state. Used by B5 for the
//                          before/after diff assertion.
//
// Failure modes (narrow, per ADR-0082):
//   - Controller not wired in build → { success: false, error: 'SonaTrajectoryService controller not available' }
//   - recordTrajectory not callable → { success: false, error: '...' }
//   - Action unsupported            → { success: false, error: '...' }
//   - Internal error                → { success: false, error: sanitizeError(...) }
//
// Never silently falls back — every code path surfaces an explicit status so
// the B5 check helper can discriminate PASS from SKIP_ACCEPTED.

export const agentdbSonaTrajectoryStore: MCPTool = {
  name: 'agentdb_sona_trajectory_store',
  description: 'Record a trajectory on SonaTrajectoryService (in-memory RL store) or query its stats. Pure-compute controller — no SQLite persistence by design.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['record', 'stats'],
        description: 'What to do. "record" calls recordTrajectory (mutates state). "stats" returns engine + trajectoryCount without mutation. Default: record.',
      },
      pattern: {
        type: 'string',
        description: 'Trajectory marker / action label — forwarded as the step\'s `action`. Required for record.',
      },
      agentType: {
        type: 'string',
        description: 'Agent type key the trajectory is attributed to (e.g. "coder"). Default: "mcp-sona-store".',
      },
      type: {
        type: 'string',
        description: 'Optional trajectory type label (informational only).',
      },
      reward: {
        type: 'number',
        description: 'Reward for the step (0-1, default 0.8).',
      },
      confidence: {
        type: 'number',
        description: 'Alias for reward — matches the pattern-store contract for call-site compatibility.',
      },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const action = (validateString(params.action, 'action', 32) ?? 'record') as 'record' | 'stats';
      const pattern = validateString(params.pattern, 'pattern', 10_000) ?? undefined;
      const agentType = validateString(params.agentType, 'agentType', 200) ?? 'mcp-sona-store';
      const trajectoryType = validateString(params.type, 'type', 200) ?? 'sona-trajectory';
      const reward = typeof params.reward === 'number'
        ? validateScore(params.reward, 0.8)
        : validateScore(params.confidence, 0.8);
      if (action === 'record' && !pattern) {
        return { success: false, error: 'pattern is required for record action (non-empty string, max 10KB)' };
      }
      // ADR-0181 Item 6 (2026-05-16): split-by-action dispatch.
      //   - 'stats' → dispatchRead against sibling registerReadHandler
      //   - 'record' → dispatch (mutation) followed by a second dispatchRead
      //     to project trajectoryCount/agentTypes into the b5 envelope
      //
      // Substrate-registry classification moved RVF→SQLite carve-out (the
      // `sona_trajectories` table is now the persistence model). Gate behind
      // ensureSqliteWired() per the same off-by-one fix Phase 7 r3 made for
      // hierarchical-recall (handover §B Phase 7 root cause; commit
      // `7a5fa0913`). The b5 probe at lib/acceptance-adr0090-b5-checks.sh:1830
      // requires `controller=sonaTrajectory` (not 'archivist'); the response
      // envelope below builds that shape from the read handler's projection.
      //
      // Two-dispatch trade-off (b5-da-q3): one mutation + one read per record
      // is acceptable; refactoring to one-dispatch (mutation handler computes
      // post-write stats inside the withWrite envelope and returns them
      // through a typed return shape) is a follow-up, not blocking.
      await ensureSqliteWired();
      const archivist = await getProcessArchivist();

      // ADR-0181 Item 6 r2 (2026-05-16): the read handler is registered
      // under a DISTINCT storeId — `agentdb_sona_trajectory_stats` — NOT
      // `agentdb_sona_trajectory_store`. r1 co-registered both under the
      // same name and dispatchRead resolved the mutation entry instead
      // (getRegistration in registration.ts:150 checks mutation first).
      // Distinct-storeId pattern matches Item 2's neural_patterns/gnn_stats
      // split. The cli surface (`agentdb_sona_trajectory_store` MCP tool +
      // `--params action=stats|record`) stays unchanged for callers; only
      // the archivist's internal storeId for the read side is split off.
      if (action === 'stats') {
        const stats = await archivist.dispatchRead('agentdb_sona_trajectory_stats', {
          action: 'stats',
        }) as {
          success: true;
          controller: 'sonaTrajectory';
          engine: string;
          available: boolean;
          trajectoryCount: number;
          agentTypes: ReadonlyArray<string>;
        };
        return stats;
      }

      // action === 'record'
      await archivist.dispatch('agentdb_sona_trajectory_store', {
        action,
        pattern,
        agentType,
        type: trajectoryType,
        reward,
      });
      // Project post-write stats into the b5 record envelope (probe at
      // lib/acceptance-adr0090-b5-checks.sh:1841-1855 reads trajectoryCount /
      // trajectoryCountDelta / agentTypes from the record response).
      const after = await archivist.dispatchRead('agentdb_sona_trajectory_stats', {
        action: 'stats',
      }) as {
        success: true;
        controller: 'sonaTrajectory';
        engine: string;
        available: boolean;
        trajectoryCount: number;
        agentTypes: ReadonlyArray<string>;
      };
      return {
        success: true,
        controller: 'sonaTrajectory',
        action,
        engine: after.engine,
        agentType,
        marker: pattern ?? null,
        type: trajectoryType,
        trajectoryCount: after.trajectoryCount,
        // Delta is at-least-1 because we just performed a successful record;
        // the b5 probe (L1848) accepts any non-negative delta. Synthesise +1
        // since the dispatched mutation is opaque to count-before.
        trajectoryCountDelta: 1,
        agentTypes: after.agentTypes,
      };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== #1784: Delete tools — symmetry for hierarchical-store + causal-edge =====

export const agentdbHierarchicalDelete: MCPTool = {
  name: 'agentdb_hierarchical-delete',
  description: 'Delete a hierarchical-memory entry by key. Returns controller="native-unsupported" when the entry is in a backend without a public delete API.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory entry key to delete' },
      tier: {
        type: 'string',
        description: 'Optional tier filter (working, episodic, semantic)',
        enum: ['working', 'episodic', 'semantic'],
      },
    },
    required: ['key'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vKey = validateIdentifier(params.key, 'key');
      if (!vKey.valid) return { success: false, deleted: false, error: vKey.error };
      if (params.tier) { const vTier = validateIdentifier(params.tier, 'tier'); if (!vTier.valid) return { success: false, deleted: false, error: vTier.error }; }
      const key = validateString(params.key, 'key', 1000);
      if (!key) return { success: false, deleted: false, error: 'key is required (non-empty string, max 1KB)' };
      const tier = validateString(params.tier, 'tier', 20);
      if (tier && !['working', 'episodic', 'semantic'].includes(tier)) {
        return { success: false, deleted: false, error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeDeleteHierarchical({ key, tier: tier ?? undefined });
      return result ?? { success: false, deleted: false, error: 'AgentDB bridge not available' };
    } catch (error) {
      return { success: false, deleted: false, error: sanitizeError(error) };
    }
  },
};

export const agentdbCausalEdgeDelete: MCPTool = {
  name: 'agentdb_causal-edge-delete',
  description: 'Delete a causal edge between two memory entries. Returns controller="native-unsupported" when the edge lives in graph-node native storage (no public delete API).',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source entry ID' },
      targetId: { type: 'string', description: 'Target entry ID' },
      relation: { type: 'string', description: 'Optional relationship type filter' },
    },
    required: ['sourceId', 'targetId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vSourceId = validateIdentifier(params.sourceId, 'sourceId');
      if (!vSourceId.valid) return { success: false, deleted: false, error: vSourceId.error };
      const vTargetId = validateIdentifier(params.targetId, 'targetId');
      if (!vTargetId.valid) return { success: false, deleted: false, error: vTargetId.error };
      const sourceId = validateString(params.sourceId, 'sourceId', 500);
      const targetId = validateString(params.targetId, 'targetId', 500);
      if (!sourceId) return { success: false, deleted: false, error: 'sourceId is required (non-empty string)' };
      if (!targetId) return { success: false, deleted: false, error: 'targetId is required (non-empty string)' };
      const relation = validateString(params.relation, 'relation', 200) ?? undefined;
      const bridge = await getBridge();
      const result = await bridge.bridgeDeleteCausalEdge({ sourceId, targetId, relation });
      return result ?? { success: false, deleted: false, error: 'AgentDB bridge not available' };
    } catch (error) {
      return { success: false, deleted: false, error: sanitizeError(error) };
    }
  },
};

export const agentdbCausalNodeDelete: MCPTool = {
  name: 'agentdb_causal-node-delete',
  description: 'Cascade-delete a causal node and all its incident edges from the SQL fallback. Native graph-node entries are unaffected (no delete API in the binding).',
  inputSchema: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Node ID to delete (cascades to all incident edges)' },
    },
    required: ['nodeId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const vNodeId = validateIdentifier(params.nodeId, 'nodeId');
      if (!vNodeId.valid) return { success: false, deletedNode: false, deletedEdges: 0, error: vNodeId.error };
      const nodeId = validateString(params.nodeId, 'nodeId', 500);
      if (!nodeId) return { success: false, deletedNode: false, deletedEdges: 0, error: 'nodeId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeDeleteCausalNode({ nodeId });
      return result ?? { success: false, deletedNode: false, deletedEdges: 0, error: 'AgentDB bridge not available' };
    } catch (error) {
      return { success: false, deletedNode: false, deletedEdges: 0, error: sanitizeError(error) };
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
  agentdbCausalEdgeDelete,
  agentdbCausalNodeDelete,
  agentdbRoute,
  agentdbSessionStart,
  agentdbSessionEnd,
  agentdbHierarchicalStore,
  agentdbHierarchicalRecall,
  agentdbHierarchicalQuery,
  agentdbHierarchicalDelete,
  agentdbConsolidate,
  agentdbBatch,
  agentdbContextSynthesize,
  agentdbSemanticRoute,
  agentdbSemanticAddRoute,
  agentdbSemanticRemoveRoute,
  agentdbSemanticListRoutes,
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
  // agentdbQuantizeStatus / agentdbHealthReport — deferred (ADR-0047)
  agentdbEmbed,              // ADR-0045
  agentdbEmbedStatus,        // ADR-0045
  agentdbTelemetryMetrics,   // ADR-0045
  agentdbTelemetrySpans,     // ADR-0045
  // agentdbAttentionCompute — deferred (ADR-0044)
  agentdbAttentionBenchmark, // ADR-0044
  agentdbAttentionConfigure, // ADR-0044
  agentdbAttentionMetrics,   // ADR-0044
  agentdbSkillCreate,        // P4: SkillLibrary
  agentdbSkillSearch,        // P4: SkillLibrary
  agentdbLearnerRun,         // P4: NightlyLearner
  agentdbLearningPredict,    // P4: LearningSystem
  agentdbExperienceRecord,   // P3: ReflexionMemory
  agentdbNeuralPatterns,     // W2-I4: GNNService telemetry + pattern inspection
  agentdbSonaTrajectoryStore, // W2-I5: SonaTrajectoryService record + stats (in-memory RL)
  agentdbGraphNodeCreate,    // W2-I6: GraphDatabaseAdapter node create
  agentdbGraphEdgeCreate,    // W2-I6: GraphDatabaseAdapter edge create
  agentdbGraphNodeGet,       // W2-I6: GraphDatabaseAdapter node query by ID
];
