/**
 * agentdb-orchestration.ts -- Thin delegation layer (ADR-0084 Phase 3, T3.3)
 *
 * Each helper delegates to memory-router.ts routeXxxOp() or getController().
 * The function signatures
 * and return shapes are unchanged -- agentdb-tools.ts callers need no edits.
 *
 * @module v3/cli/mcp-tools/agentdb-orchestration
 */

// ---------------------------------------------------------------------------
// Category A: Direct router equivalents (7 functions)
// ---------------------------------------------------------------------------

// Delegates to: memory-router.ts routePatternOp
export async function storePattern(options: {
  pattern: string;
  type: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}): Promise<{ success: boolean; patternId: string; controller: string; error?: string } | null> {
  try {
    const { routePatternOp } = await import('../memory/memory-router.js');
    const result = await routePatternOp({
      type: 'store',
      pattern: options.pattern,
      patternType: options.type,
      confidence: options.confidence,
      metadata: options.metadata,
    });
    return {
      success: result.success,
      patternId: (result.patternId as string) || '',
      controller: (result.controller as string) || '',
      error: result.error as string | undefined,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, patternId: '', controller: '', error: `PatternStore failed: ${msg}` };
  }
}

// Delegates to: memory-router.ts routePatternOp
// Bug-3 (2026-05-05): return shape changed from `T | null` to `T & { error? }`
// so real upstream errors survive instead of being laundered to the misleading
// "AgentDB not available. Use memory_store/memory_search instead." sentinel
// at the tool layer. The 5 tool-layer `result ?? sentinel` coalescers stay as
// defensive type-narrowing but no longer fire on real router failures.
export async function searchPatterns(options: {
  query: string;
  topK?: number;
  minConfidence?: number;
}): Promise<{ results: Array<{ id: string; content: string; score: number }>; controller: string; error?: string }> {
  try {
    const { routePatternOp } = await import('../memory/memory-router.js');
    const result = await routePatternOp({
      type: 'search',
      query: options.query,
      topK: options.topK,
      minConfidence: options.minConfidence,
    });
    if (!result.success) {
      return {
        results: [],
        controller: (result.controller as string) || 'unavailable',
        error: (result.error as string) || 'pattern search failed',
      };
    }
    const rawResults = (result.results as any[]) || [];
    return {
      results: rawResults.map((r: any) => ({
        id: r.id || r.patternId || '',
        content: r.content || r.pattern || '',
        score: r.score ?? r.confidence ?? 0,
      })),
      controller: (result.controller as string) || '',
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { results: [], controller: 'error', error: `pattern search failed: ${msg}` };
  }
}

// Delegates to: memory-router.ts routeFeedbackOp
export async function recordFeedback(options: {
  taskId: string;
  success: boolean;
  quality: number;
  agent?: string;
  duration?: number;
  patterns?: string[];
}): Promise<{ success: boolean; controller: string; updated: number } | null> {
  try {
    const { routeFeedbackOp } = await import('../memory/memory-router.js');
    const result = await routeFeedbackOp({
      type: 'record',
      taskId: options.taskId,
      success: options.success,
      quality: options.quality,
      agent: options.agent,
      duration: options.duration,
      patterns: options.patterns,
    });
    return {
      success: result.success,
      controller: (result.controller as string) || 'none',
      updated: (result.updated as number) || 0,
    };
  } catch {
    return { success: false, controller: 'none', updated: 0 };
  }
}

// Delegates to: memory-router.ts routeCausalOp
// Bug-3 (2026-05-05): see searchPatterns rationale. Real upstream errors now
// survive — the misleading "AgentDB not available" sentinel is no longer the
// default for legitimate per-edge failures (e.g. ADR-0094 RC-2 idempotency
// rejection on shared (src,dst) edges).
export async function recordCausalEdge(options: {
  sourceId: string;
  targetId: string;
  relation: string;
  weight?: number;
}): Promise<{ success: boolean; controller: string; error?: string }> {
  try {
    const { routeCausalOp } = await import('../memory/memory-router.js');
    const result = await routeCausalOp({
      type: 'edge',
      sourceId: options.sourceId,
      targetId: options.targetId,
      relation: options.relation,
      weight: options.weight,
    });
    return {
      success: result.success === true,
      controller: (result.controller as string) || (result.success ? '' : 'unavailable'),
      error: result.success ? undefined : ((result.error as string) || 'causal edge recording failed'),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, controller: 'error', error: `causal edge recording failed: ${msg}` };
  }
}

// Delegates to: memory-router.ts routeSessionOp
// Bug-3 (2026-05-05): see searchPatterns rationale.
export async function sessionStart(options: {
  sessionId: string;
  context?: string;
}): Promise<{ success: boolean; controller: string; restoredPatterns: number; sessionId: string; error?: string }> {
  try {
    const { routeSessionOp } = await import('../memory/memory-router.js');
    const result = await routeSessionOp({
      type: 'start',
      sessionId: options.sessionId,
      context: options.context,
    });
    return {
      success: result.success,
      controller: (result.controller as string) || 'none',
      restoredPatterns: (result.restoredPatterns as number) || 0,
      sessionId: options.sessionId,
      error: result.success ? undefined : ((result.error as string) || 'session start failed'),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, controller: 'error', restoredPatterns: 0, sessionId: options.sessionId, error: `session start failed: ${msg}` };
  }
}

// Delegates to: memory-router.ts routeSessionOp
export async function sessionEnd(options: {
  sessionId: string;
  summary?: string;
  tasksCompleted?: number;
  patternsLearned?: number;
}): Promise<{ success: boolean; controller: string; persisted: boolean } | null> {
  try {
    const { routeSessionOp } = await import('../memory/memory-router.js');
    const result = await routeSessionOp({
      type: 'end',
      sessionId: options.sessionId,
      summary: options.summary,
      tasksCompleted: options.tasksCompleted,
      patternsLearned: options.patternsLearned,
    });
    return {
      success: result.success,
      controller: (result.controller as string) || 'none',
      persisted: (result.persisted as boolean) || false,
    };
  } catch {
    return { success: false, controller: 'none', persisted: false };
  }
}

// Delegates to: memory-router.ts routeCausalOp
export async function causalRecall(options: {
  query: string;
  k?: number;
  includeEvidence?: boolean;
}): Promise<{ success: boolean; results?: any[]; warning?: string; error?: string }> {
  try {
    const { routeCausalOp } = await import('../memory/memory-router.js');
    const result = await routeCausalOp({
      type: 'recall',
      query: options.query,
      k: options.k,
      includeEvidence: options.includeEvidence,
    });
    return {
      success: result.success,
      results: (result.results as any[]) || [],
      warning: result.warning as string | undefined,
      error: result.error as string | undefined,
    };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Category B: Controller-direct delegation (10 functions)
// ---------------------------------------------------------------------------

// Delegates to: memory-router.ts getController('semanticRouter') + getController('learningSystem')
export async function routeTask(options: {
  task: string;
  context?: string;
}): Promise<{ route: string; confidence: number; agents: string[]; controller: string } | null> {
  const { getController } = await import('../memory/memory-router.js');

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

// Delegates to: memory-router.ts getController('hierarchicalMemory')
export async function hierarchicalStore(params: {
  key: string;
  value: string;
  tier?: string;
  importance?: number;
}): Promise<any> {
  const { getController } = await import('../memory/memory-router.js');
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

// Delegates to: memory-router.ts getController('hierarchicalMemory')
export async function hierarchicalRecall(params: {
  query: string;
  tier?: string;
  topK?: number;
}): Promise<any> {
  const { getController } = await import('../memory/memory-router.js');
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
    // Stub fallback -- recall(string, number)
    const results = hm.recall(params.query, params.topK || 5);
    const filtered = params.tier
      ? results.filter((r: any) => r.tier === params.tier)
      : results;
    return { results: filtered, controller: 'hierarchicalMemory' };
  } catch (e: any) {
    return { results: [], error: e.message };
  }
}

// Delegates to: memory-router.ts getController('hierarchicalMemory')
// Per ADR-0176 Phase 3: path/glob enumeration over the hierarchical store.
// Distinct from hierarchicalRecall (similarity search) and hierarchical-delete (by-key).
export async function hierarchicalQuery(params: {
  pathPattern: string;
  tier?: 'working' | 'episodic' | 'semantic';
  limit?: number;
}): Promise<any> {
  const { getController } = await import('../memory/memory-router.js');
  const hm = await getController<any>('hierarchicalMemory');
  if (!hm) return { results: [], error: 'HierarchicalMemory not available' };

  if (typeof hm.query !== 'function') {
    // Stub fallback: emulate path/glob via prefix on cached entries when the real
    // controller method is missing. Returns empty if the stub has no entries.
    if (typeof hm.entries === 'function') {
      const all = await hm.entries();
      const prefix = params.pathPattern.replace(/[*?]/g, '');
      const filtered = all
        .filter((e: any) => typeof e.content === 'string' && e.content.startsWith(prefix))
        .filter((e: any) => !params.tier || e.tier === params.tier)
        .slice(0, params.limit ?? 100);
      return { results: filtered, controller: 'hierarchicalMemory', stub: true };
    }
    return { results: [], error: 'HierarchicalMemory.query() not implemented in this controller version' };
  }

  try {
    const results = await hm.query(params.pathPattern, { tier: params.tier, limit: params.limit });
    return { results: results || [], controller: 'hierarchicalMemory' };
  } catch (e: any) {
    return { results: [], error: e.message };
  }
}

// Delegates to: memory-router.ts getController('contextSynthesizer') + getController('hierarchicalMemory')
export async function contextSynthesize(params: {
  query: string;
  maxEntries?: number;
}): Promise<any> {
  const { getController } = await import('../memory/memory-router.js');
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

// Delegates to: memory-router.ts routeLearningOp
export async function flashConsolidate(params: {
  entries?: any[];
  blockSize?: number;
}): Promise<{ success: boolean; result?: any; error?: string }> {
  try {
    const { routeLearningOp } = await import('../memory/memory-router.js');
    const result = await routeLearningOp({ type: 'consolidate' });
    if (result.success) {
      return { success: true, result: { consolidated: result.consolidated ?? 0 } };
    }
    return { success: false, error: (result.error as string) || 'Consolidation unavailable' };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Flash consolidation failed' };
  }
}

// Delegates to: memory-router.ts getController('batchOperations') + getController('resourceTracker') + getController('rateLimiter')
export async function batchOperation(params: {
  operation: string;
  entries: any[];
}): Promise<any> {
  const { getController } = await import('../memory/memory-router.js');

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

// Delegates to: memory-router.ts getController('enhancedEmbeddingService') + routeEmbeddingOp fallback
export async function embed(
  text: string,
): Promise<{ success: boolean; embedding?: number[]; dimension?: number; provider?: string; cached?: boolean; error?: string }> {
  if (!text || typeof text !== 'string') {
    return { success: false, error: 'text is required (non-empty string)' };
  }

  const { waitForDeferred, getController, generateEmbedding } = await import('../memory/memory-router.js');

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

  // A9 not available -- fallback to existing pipeline via memory-router
  try {
    const result = await generateEmbedding(text);
    return { success: true, embedding: Array.from(result.embedding), dimension: result.dimensions, provider: result.model };
  } catch {
    return { success: false, error: 'EnhancedEmbeddingService not active and fallback failed' };
  }
}

// Delegates to: memory-router.ts routeMemoryOp + getController('metadataFilter')
export async function filteredSearch(options: {
  query: string;
  filter?: Record<string, unknown>;
  namespace?: string;
  limit?: number;
  threshold?: number;
}): Promise<{ success: boolean; results: any[]; filtered: boolean; searchTime: number; error?: string } | null> {
  const { routeMemoryOp, getController } = await import('../memory/memory-router.js');

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

// Delegates to: memory-router.ts getController('batchOperations')
export async function batchOptimize(): Promise<{ success: boolean; stats?: any; error?: string }> {
  const { getController } = await import('../memory/memory-router.js');
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

// Delegates to: memory-router.ts getController('batchOperations')
export async function batchPrune(config?: {
  maxAge?: number;
  minReward?: number;
}): Promise<{ success: boolean; pruned?: any; error?: string }> {
  const { getController } = await import('../memory/memory-router.js');
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
