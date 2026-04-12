/**
 * agentdb-orchestration.ts — Extracted orchestration helpers (ADR-0078 Phase 3)
 *
 * Each helper replicates the multi-controller orchestration logic from
 * memory-bridge.ts, using getController() from memory-router instead of
 * getBridge(). The bridge file is NOT modified.
 *
 * Drift detection: each helper has a source-marker comment referencing
 * the bridge function and line range it replicates. On upstream sync,
 * if memory-bridge.ts changed, audit this file.
 *
 * @module v3/cli/mcp-tools/agentdb-orchestration
 */

import { getController, routeMemoryOp, waitForDeferred } from '../memory/memory-router.js';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Shared utilities (copied verbatim from bridge)
// ---------------------------------------------------------------------------

// Replicates: memory-bridge.ts getCallableMethod (lines 1859-1868)
// Last synced: 2026-04-11
function getCallableMethod(obj: any, ...names: string[]): ((...args: any[]) => any) | null {
  if (!obj) return null;
  for (const name of names) {
    if (typeof obj[name] === 'function') return obj[name].bind(obj);
    if (obj.default && typeof obj.default[name] === 'function') return obj.default[name].bind(obj.default);
    if (obj.instance && typeof obj.instance[name] === 'function') return obj.instance[name].bind(obj.instance);
    if (obj.controller && typeof obj.controller[name] === 'function') return obj.controller[name].bind(obj.controller);
  }
  return null;
}

// Replicates: memory-bridge.ts generateId (lines 151-153)
// Last synced: 2026-04-11
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Category B: Multi-controller orchestration (12 functions)
// ---------------------------------------------------------------------------

// Replicates: memory-bridge.ts bridgeStorePattern (lines 1876-1938)
// Last synced: 2026-04-11
export async function storePattern(options: {
  pattern: string;
  type: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; patternId: string; controller: string; error?: string } | null> {
  const reasoningBank = await getController<any>('reasoningBank');
  const patternId = generateId('pattern');

  // OPT-001: Probe for callable store method across binding patterns
  const storeFn = getCallableMethod(reasoningBank, 'store', 'storePattern', 'add');
  if (storeFn) {
    try {
      await storeFn({
        id: patternId,
        content: options.pattern,
        type: options.type,
        confidence: options.confidence,
        metadata: options.metadata,
        timestamp: Date.now(),
      });
      return { success: true, patternId, controller: 'reasoningBank' };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, patternId: '', controller: '', error: `PatternStore failed: ${msg}` };
    }
  }

  // Fallback: store via routeMemoryOp
  try {
    const result = await routeMemoryOp({
      type: 'store',
      key: patternId,
      value: JSON.stringify({ pattern: options.pattern, type: options.type, confidence: options.confidence, metadata: options.metadata }),
      namespace: 'pattern',
      generateEmbedding: true,
      tags: [options.type, 'reasoning-pattern'],
    });
    if (result?.success) {
      return { success: true, patternId: (result.key as string) || patternId, controller: 'bridge-fallback' };
    }
    return { success: false, patternId: '', controller: '', error: 'PatternStore unavailable: store operation failed' };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, patternId: '', controller: '', error: `PatternStore failed: ${msg}` };
  }
}

// Replicates: memory-bridge.ts bridgeSearchPatterns (lines 1944-1990)
// Last synced: 2026-04-11
export async function searchPatterns(options: {
  query: string;
  topK?: number;
  minConfidence?: number;
}): Promise<{ results: Array<{ id: string; content: string; score: number }>; controller: string } | null> {
  const reasoningBank = await getController<any>('reasoningBank');

  // ReasoningBank may expose .searchPatterns() (agentdb) or .search() (legacy)
  if (reasoningBank && typeof (reasoningBank.searchPatterns ?? reasoningBank.search) === 'function') {
    try {
      let results: any;
      if (typeof reasoningBank.searchPatterns === 'function') {
        results = await reasoningBank.searchPatterns({ task: options.query, k: options.topK || 5, threshold: options.minConfidence || 0.3 });
      } else {
        results = await reasoningBank.search(options.query, { topK: options.topK || 5, minScore: options.minConfidence || 0.3 });
      }
      return {
        results: Array.isArray(results) ? results.map((r: any) => ({
          id: r.id || r.patternId || '',
          content: r.content || r.pattern || '',
          score: r.score ?? r.confidence ?? 0,
        })) : [],
        controller: 'reasoningBank',
      };
    } catch {
      return null;
    }
  }

  // Fallback: search via routeMemoryOp
  try {
    const result = await routeMemoryOp({
      type: 'search',
      query: options.query,
      namespace: 'pattern',
      limit: options.topK || 5,
      threshold: options.minConfidence || 0.3,
    });
    if (result?.results) {
      return {
        results: (result.results as any[]).map((r: any) => ({ id: r.id || '', content: r.content || '', score: r.score || 0 })),
        controller: 'bridge-fallback',
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Replicates: memory-bridge.ts bridgeRecordFeedback (lines 1998-2096)
// Last synced: 2026-04-11
export async function recordFeedback(options: {
  taskId: string;
  success: boolean;
  quality: number;
  agent?: string;
  duration?: number;
  patterns?: string[];
}): Promise<{ success: boolean; controller: string; updated: number } | null> {
  let controller = 'none';
  let updated = 0;

  // Try LearningSystem first
  const learningSystem = await getController<any>('learningSystem');
  if (learningSystem) {
    try {
      if (typeof learningSystem.recordFeedback === 'function') {
        await learningSystem.recordFeedback({
          taskId: options.taskId, success: options.success, quality: options.quality,
          agent: options.agent, duration: options.duration, timestamp: Date.now(),
        });
        controller = 'learningSystem';
        updated++;
      } else if (typeof learningSystem.record === 'function') {
        await learningSystem.record(options.taskId, options.quality, options.success ? 'success' : 'failure');
        controller = 'learningSystem';
        updated++;
      }
    } catch { /* API mismatch — skip */ }
  }

  // Also record in ReasoningBank for pattern reinforcement
  const reasoningBank = await getController<any>('reasoningBank');
  if (reasoningBank) {
    try {
      const recordOutcomeFn = getCallableMethod(reasoningBank, 'recordOutcome');
      const recordFn = !recordOutcomeFn ? getCallableMethod(reasoningBank, 'record', 'addFeedback') : null;
      if (recordOutcomeFn) {
        await recordOutcomeFn({
          taskId: options.taskId, verdict: options.success ? 'success' : 'failure',
          score: options.quality, timestamp: Date.now(),
        });
        controller = controller === 'none' ? 'reasoningBank' : `${controller}+reasoningBank`;
        updated++;
      } else if (recordFn) {
        await recordFn(options.taskId, options.quality);
        controller = controller === 'none' ? 'reasoningBank' : `${controller}+reasoningBank`;
        updated++;
      }
    } catch { /* API mismatch — skip */ }
  }

  // SkillLibrary promotion for high-quality patterns
  if (options.success && options.quality >= 0.9 && options.patterns?.length) {
    const skills = await getController<any>('skills');
    if (skills && typeof skills.promote === 'function') {
      for (const pattern of options.patterns) {
        try { await skills.promote(pattern, options.quality); updated++; } catch { /* skip */ }
      }
      controller += '+skills';
    }
  }

  // ADR-0046: Forward to SelfLearningRvfBackend (fire-and-forget)
  const a6 = await getController<any>('selfLearningRvfBackend');
  if (a6 && typeof (a6 as any).recordFeedback === 'function') {
    (a6 as any).recordFeedback({
      query: options.taskId,
      selectedResult: options.agent || 'unknown',
      reward: options.quality,
    });
    controller = controller === 'none' ? 'selfLearningRvf' : `${controller}+selfLearningRvf`;
    updated++;
  }

  // Always store feedback as a memory entry for retrieval
  try {
    const storeResult = await routeMemoryOp({
      type: 'store',
      key: `feedback-${options.taskId}`,
      value: JSON.stringify(options),
      namespace: 'feedback',
      tags: [options.success ? 'success' : 'failure', options.agent || 'unknown'],
    });
    if (storeResult?.success) {
      controller = controller === 'none' ? 'bridge-store' : `${controller}+bridge-store`;
      updated++;
    }
  } catch { /* store failure non-fatal */ }

  return { success: true, controller, updated };
}

// Replicates: memory-bridge.ts bridgeRecordCausalEdge (lines 2103-2145)
// Last synced: 2026-04-11
export async function recordCausalEdge(options: {
  sourceId: string;
  targetId: string;
  relation: string;
  weight?: number;
}): Promise<{ success: boolean; controller: string } | null> {
  const causalGraph = await getController<any>('causalGraph');
  if (causalGraph && typeof causalGraph.addEdge === 'function') {
    try {
      causalGraph.addEdge(options.sourceId, options.targetId, {
        relation: options.relation,
        weight: options.weight ?? 1.0,
        timestamp: Date.now(),
      });
      return { success: true, controller: 'causalGraph' };
    } catch {
      return null;
    }
  }

  // Fallback: store edge via routeMemoryOp
  try {
    const result = await routeMemoryOp({
      type: 'store',
      key: `${options.sourceId}→${options.targetId}`,
      value: JSON.stringify(options),
      namespace: 'causal-edges',
    });
    if (result?.success) return { success: true, controller: 'bridge-fallback' };
  } catch { /* skip */ }

  return null;
}

// Replicates: memory-bridge.ts bridgeRouteTask (lines 2274-2320)
// Last synced: 2026-04-11
export async function routeTask(options: {
  task: string;
  context?: string;
}): Promise<{ route: string; confidence: number; agents: string[]; controller: string } | null> {
  // Try SemanticRouter
  const semanticRouter = await getController<any>('semanticRouter');
  if (semanticRouter && typeof semanticRouter.route === 'function') {
    try {
      const result = await semanticRouter.route(options.task, { context: options.context });
      if (result) {
        return {
          route: result.route || result.category || 'general',
          confidence: result.confidence ?? result.score ?? 0.5,
          agents: result.agents || result.suggestedAgents || [],
          controller: 'semanticRouter',
        };
      }
    } catch { /* fall through */ }
  }

  // Try LearningSystem recommendAlgorithm
  const learningSystem = await getController<any>('learningSystem');
  if (learningSystem && typeof learningSystem.recommendAlgorithm === 'function') {
    try {
      const rec = await learningSystem.recommendAlgorithm(options.task);
      if (rec) {
        return {
          route: rec.algorithm || rec.route || 'general',
          confidence: rec.confidence ?? 0.5,
          agents: rec.agents || [],
          controller: 'learningSystem',
        };
      }
    } catch { /* fall through */ }
  }

  return null;
}

// Replicates: memory-bridge.ts bridgeSessionStart (lines 2153-2199)
// Last synced: 2026-04-11
export async function sessionStart(options: {
  sessionId: string;
  context?: string;
}): Promise<{ success: boolean; controller: string; restoredPatterns: number; sessionId: string } | null> {
  let restoredPatterns = 0;
  let controller = 'none';

  // Try ReflexionMemory for episodic session replay
  const reflexion = await getController<any>('reflexion');
  if (reflexion && typeof reflexion.startEpisode === 'function') {
    try {
      await reflexion.startEpisode(options.sessionId, { context: options.context });
      controller = 'reflexion';
    } catch { /* skip */ }
  }

  // Load recent patterns from past sessions
  try {
    const searchResult = await routeMemoryOp({
      type: 'search',
      query: options.context || 'session patterns',
      namespace: 'session',
      limit: 10,
      threshold: 0.3,
    });
    if (searchResult?.results) {
      restoredPatterns = (searchResult.results as any[]).length;
    }
  } catch { /* search failure non-fatal */ }

  return {
    success: true,
    controller: controller === 'none' ? 'bridge-search' : controller,
    restoredPatterns,
    sessionId: options.sessionId,
  };
}

// Replicates: memory-bridge.ts bridgeSessionEnd (lines 2204-2266)
// Last synced: 2026-04-11
export async function sessionEnd(options: {
  sessionId: string;
  summary?: string;
  tasksCompleted?: number;
  patternsLearned?: number;
}): Promise<{ success: boolean; controller: string; persisted: boolean } | null> {
  let controller = 'none';
  let persisted = false;

  // End episode in ReflexionMemory
  const reflexion = await getController<any>('reflexion');
  if (reflexion && typeof reflexion.endEpisode === 'function') {
    try {
      await reflexion.endEpisode(options.sessionId, {
        summary: options.summary,
        tasksCompleted: options.tasksCompleted,
        patternsLearned: options.patternsLearned,
      });
      controller = 'reflexion';
      persisted = true;
    } catch { /* skip */ }
  }

  // Persist session summary as memory entry
  try {
    await routeMemoryOp({
      type: 'store',
      key: `session-${options.sessionId}`,
      value: JSON.stringify({
        sessionId: options.sessionId,
        summary: options.summary || 'Session ended',
        tasksCompleted: options.tasksCompleted ?? 0,
        patternsLearned: options.patternsLearned ?? 0,
        endedAt: new Date().toISOString(),
      }),
      namespace: 'session',
      tags: ['session-end'],
      upsert: true,
    });
    if (controller === 'none') controller = 'bridge-store';
    persisted = true;
  } catch { /* store failure non-fatal */ }

  // Trigger NightlyLearner consolidation if available
  const nightlyLearner = await getController<any>('nightlyLearner');
  if (nightlyLearner && typeof nightlyLearner.consolidate === 'function') {
    try {
      await nightlyLearner.consolidate({ sessionId: options.sessionId });
      controller += '+nightlyLearner';
    } catch { /* non-fatal */ }
  }

  return { success: true, controller, persisted };
}

// Replicates: memory-bridge.ts bridgeHierarchicalStore (lines 2399-2419)
// Last synced: 2026-04-11
export async function hierarchicalStore(params: {
  key: string;
  value: string;
  tier?: string;
  importance?: number;
}): Promise<any> {
  const hm = await getController<any>('hierarchicalMemory');
  if (!hm) return { success: false, error: 'HierarchicalMemory not available' };
  const tier = params.tier || 'working';

  try {
    // Detect real HierarchicalMemory (has async store returning id) vs stub
    if (typeof hm.getStats === 'function' && typeof hm.promote === 'function') {
      const id = await hm.store(params.value, params.importance || 0.5, tier, {
        metadata: { key: params.key },
        tags: [params.key],
      });
      return { success: true, id, key: params.key, tier };
    }
    // Stub fallback
    hm.store(params.key, params.value, tier);
    return { success: true, key: params.key, tier };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// Replicates: memory-bridge.ts bridgeHierarchicalRecall (lines 2431-2458)
// Last synced: 2026-04-11
export async function hierarchicalRecall(params: {
  query: string;
  tier?: string;
  topK?: number;
}): Promise<any> {
  const hm = await getController<any>('hierarchicalMemory');
  if (!hm) return { results: [], error: 'HierarchicalMemory not available' };

  try {
    // Detect real HierarchicalMemory vs stub
    if (typeof hm.getStats === 'function' && typeof hm.promote === 'function') {
      const memoryQuery: any = { query: params.query, k: params.topK || 5 };
      if (params.tier) memoryQuery.tier = params.tier;
      const results = await hm.recall(memoryQuery);
      return { results: results || [], controller: 'hierarchicalMemory' };
    }
    // Stub fallback — recall(string, number)
    const results = hm.recall(params.query, params.topK || 5);
    const filtered = params.tier
      ? results.filter((r: any) => r.tier === params.tier)
      : results;
    return { results: filtered, controller: 'hierarchicalMemory' };
  } catch (e: any) {
    return { results: [], error: e.message };
  }
}

// Replicates: memory-bridge.ts bridgeContextSynthesize (lines 2536-2567)
// Last synced: 2026-04-11
export async function contextSynthesize(params: {
  query: string;
  maxEntries?: number;
}): Promise<any> {
  const CS = await getController<any>('contextSynthesizer');
  if (!CS || typeof CS.synthesize !== 'function') {
    return { success: false, error: 'ContextSynthesizer not available' };
  }

  try {
    // Gather memory patterns from hierarchical memory as input
    const hm = await getController<any>('hierarchicalMemory');
    let memories: any[] = [];
    if (hm && typeof hm.recall === 'function') {
      let recalled: any[];
      if (typeof hm.promote === 'function') {
        // Real agentdb HierarchicalMemory
        recalled = await hm.recall({ query: params.query, k: params.maxEntries || 10 });
      } else {
        // Stub
        recalled = hm.recall(params.query, params.maxEntries || 10);
      }
      memories = (recalled || []).map((r: any) => ({
        content: r.value || r.content || '',
        key: r.key || r.id || '',
        reward: 1,
        verdict: 'success',
      }));
    }
    const result = CS.synthesize(memories, { includeRecommendations: true });
    return { success: true, synthesis: result };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// Replicates: memory-bridge.ts bridgeFlashConsolidate (lines 3500-3526)
// Last synced: 2026-04-11
export async function flashConsolidate(params: {
  entries?: any[];
  blockSize?: number;
}): Promise<{ success: boolean; result?: any; error?: string }> {
  const attn = await getController<any>('attentionService');
  if (!attn || typeof attn.applyFlashAttention !== 'function') {
    // Fallback to standard consolidation
    const mc = await getController<any>('memoryConsolidation');
    if (!mc) return { success: false, error: 'AttentionService and MemoryConsolidation not available' };
    try {
      const result = await mc.consolidate();
      return { success: true, result: { consolidated: result } };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  try {
    const entries = params.entries || [];
    if (entries.length === 0) return { success: true, result: { consolidated: 0 } };
    const embeddings = entries.map((e: any) => e.embedding || []).filter((e: any[]) => e.length > 0);
    if (embeddings.length < 2) return { success: true, result: { consolidated: embeddings.length } };
    const query = embeddings[0];
    const keys = embeddings.slice(1);
    const values = keys; // Self-attention: keys === values
    const output = await attn.applyFlashAttention(query, keys, values);
    return { success: true, result: { consolidated: entries.length, flashOutput: output } };
  } catch {
    return { success: false, error: 'Flash consolidation failed' };
  }
}

// Replicates: memory-bridge.ts bridgeBatchOperation (lines 2487-2530)
// Last synced: 2026-04-11
export async function batchOperation(params: {
  operation: string;
  entries: any[];
}): Promise<any> {
  // ADR-0042: Resource check before batch
  const resourceTracker = await getController<any>('resourceTracker');
  if (resourceTracker && typeof resourceTracker.isOverLimit === 'function') {
    if (resourceTracker.isOverLimit()) return { success: false, error: 'resource_limit_exceeded' };
    if (typeof resourceTracker.recordQuery === 'function') resourceTracker.recordQuery();
  }

  // Rate limit check
  const rateLimiter = await getController<any>('rateLimiter');
  if (rateLimiter && typeof rateLimiter.tryConsume === 'function') {
    if (!rateLimiter.tryConsume('batch')) {
      const retryAfter = typeof rateLimiter.getRetryAfter === 'function' ? rateLimiter.getRetryAfter('batch') : 1000;
      return { success: false, error: 'rate_limited', retryAfter };
    }
  }

  const batch = await getController<any>('batchOperations');
  if (!batch) return { success: false, error: 'BatchOperations not available' };

  try {
    let result;
    switch (params.operation) {
      case 'insert': {
        const episodes = params.entries.map((e: any) => ({
          content: e.value || e.content || JSON.stringify(e),
          metadata: e.metadata || { key: e.key },
        }));
        result = await batch.insertEpisodes(episodes);
        break;
      }
      case 'delete': {
        const keys = params.entries.map((e: any) => e.key).filter(Boolean);
        for (const key of keys) {
          await batch.bulkDelete('episodes', { key });
        }
        result = { deleted: keys.length };
        break;
      }
      case 'update': {
        for (const entry of params.entries) {
          await batch.bulkUpdate('episodes', { content: entry.value || entry.content }, { key: entry.key });
        }
        result = { updated: params.entries.length };
        break;
      }
      default:
        return { success: false, error: `Unknown operation: ${params.operation}` };
    }
    return { success: true, operation: params.operation, count: params.entries.length, result };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Category C: Deferred init + type detection (4 functions)
// ---------------------------------------------------------------------------

// Replicates: memory-bridge.ts bridgeEmbed (lines 3181-3257)
// Last synced: 2026-04-11
export async function embed(
  text: string,
): Promise<{ success: boolean; embedding?: number[]; dimension?: number; provider?: string; cached?: boolean; error?: string }> {
  if (!text || typeof text !== 'string') {
    return { success: false, error: 'text is required (non-empty string)' };
  }

  // Wait for deferred (Level 2+) controllers so A9 EnhancedEmbeddingService is ready
  await waitForDeferred();

  const enhanced = await getController<any>('enhancedEmbeddingService');
  if (enhanced && typeof enhanced.embed === 'function') {
    try {
      const result = await enhanced.embed(text);
      // N6: EnhancedEmbeddingService.embed() returns Float32Array, not an object.
      if (result instanceof Float32Array || ArrayBuffer.isView(result)) {
        const embedding = Array.from(result as Float32Array);
        if (embedding.length === 0) {
          return { success: false, error: 'EnhancedEmbeddingService returned empty embedding' };
        }
        let provider = 'transformers';
        if (typeof enhanced.getStats === 'function') {
          const stats = enhanced.getStats();
          provider = stats?.model?.provider ?? 'transformers';
        }
        return { success: true, embedding, dimension: embedding.length, provider, cached: false };
      }
      if (result && typeof result === 'object') {
        const embeddingData = (result as any).embedding;
        const arr = Array.isArray(embeddingData) ? embeddingData
          : (embeddingData instanceof Float32Array || ArrayBuffer.isView(embeddingData))
            ? Array.from(embeddingData as Float32Array)
            : [];
        if (arr.length === 0) {
          return { success: false, error: 'EnhancedEmbeddingService returned empty embedding' };
        }
        return {
          success: true,
          embedding: arr,
          dimension: (result as any).dimension ?? arr.length,
          provider: (result as any).provider ?? 'unknown',
          cached: (result as any).cached ?? false,
        };
      }
      return { success: false, error: 'EnhancedEmbeddingService returned unexpected result type' };
    } catch (err) {
      return { success: false, error: 'Embedding failed: ' + (err instanceof Error ? err.message : 'unknown') };
    }
  }

  // A9 not available — fallback to existing pipeline via memory-initializer
  try {
    const { generateEmbedding } = await import('../memory/memory-router.js');
    const result = await generateEmbedding(text);
    return { success: true, embedding: Array.from(result.embedding), dimension: result.dimensions, provider: result.model };
  } catch {
    return { success: false, error: 'EnhancedEmbeddingService not active and fallback failed' };
  }
}

// Replicates: memory-bridge.ts bridgeFilteredSearch (lines 3061-3111)
// Last synced: 2026-04-11
export async function filteredSearch(options: {
  query: string;
  filter?: Record<string, unknown>;
  namespace?: string;
  limit?: number;
  threshold?: number;
}): Promise<{ success: boolean; results: any[]; filtered: boolean; searchTime: number; error?: string } | null> {
  // First, perform the base search via routeMemoryOp
  let searchResult: any;
  const start = Date.now();
  try {
    searchResult = await routeMemoryOp({
      type: 'search',
      query: options.query,
      namespace: options.namespace,
      limit: options.limit,
      threshold: options.threshold,
    });
  } catch {
    return { success: false, results: [], filtered: false, searchTime: 0, error: 'FilteredSearch unavailable: search failed' };
  }

  const searchTime = Date.now() - start;
  if (!searchResult?.success) {
    return { success: false, results: [], filtered: false, searchTime, error: 'FilteredSearch unavailable: search returned no results' };
  }

  const results = (searchResult.results as any[]) || [];
  if (!options.filter || Object.keys(options.filter).length === 0) {
    return { success: true, results, filtered: false, searchTime };
  }

  // Apply metadata filter
  const mf = await getController<any>('metadataFilter');
  if (!mf || typeof mf.filter !== 'function') {
    return { success: true, results, filtered: false, searchTime };
  }

  try {
    const filtered = mf.filter(results, options.filter);
    return {
      success: true,
      results: Array.isArray(filtered) ? filtered : results,
      filtered: true,
      searchTime,
    };
  } catch {
    return { success: true, results, filtered: false, searchTime };
  }
}

// Replicates: memory-bridge.ts bridgeCausalRecall (lines 2793-2822)
// Last synced: 2026-04-11
export async function causalRecall(options: {
  query: string;
  k?: number;
  includeEvidence?: boolean;
}): Promise<{ success: boolean; results?: any[]; warning?: string; error?: string }> {
  const cr = await getController<any>('causalRecall');
  if (!cr || typeof cr.search !== 'function') {
    return { success: false, error: 'CausalRecall not available' };
  }

  // Cold-start guard: check if causal graph has enough edges
  if (typeof cr.getStats === 'function') {
    const stats = cr.getStats();
    if (stats && (stats.totalCausalEdges || 0) < 5) {
      return { success: true, results: [], warning: 'Cold start: fewer than 5 causal edges' };
    }
  }

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('CausalRecall timeout (2s)')), 2000)
    );
    const results = await Promise.race([
      cr.search({ query: options.query, k: options.k || 10, includeEvidence: options.includeEvidence }),
      timeoutPromise,
    ]);
    return { success: true, results: Array.isArray(results) ? results : [] };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// Replicates: memory-bridge.ts bridgeBatchOptimize (lines 2829-2876)
// Last synced: 2026-04-11
export async function batchOptimize(): Promise<{ success: boolean; stats?: any; error?: string }> {
  const bo = await getController<any>('batchOperations');
  if (!bo) return { success: false, error: 'BatchOperations not available' };

  try {
    if (typeof bo.optimize === 'function') {
      bo.optimize();
    }
    let stats = null;
    if (typeof bo.getStats === 'function') {
      stats = await Promise.race([
        Promise.resolve(bo.getStats()),
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
    }
    return { success: true, stats };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// Replicates: memory-bridge.ts bridgeBatchPrune (lines 2858-2876)
// Last synced: 2026-04-11
export async function batchPrune(config?: {
  maxAge?: number;
  minReward?: number;
}): Promise<{ success: boolean; pruned?: any; error?: string }> {
  const bo = await getController<any>('batchOperations');
  if (!bo || typeof bo.pruneData !== 'function') {
    return { success: false, error: 'BatchOperations not available' };
  }

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('BatchOperations prune timeout (2s)')), 2000)
    );
    const pruned = await Promise.race([bo.pruneData(config), timeoutPromise]);
    return { success: true, pruned };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}
