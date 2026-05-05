/**
 * Memory MCP Tools for CLI - V3 with SQLite/HNSW Backend
 *
 * UPGRADED: Now uses the advanced SQLite + HNSW backend for:
 * - 150x-12,500x faster semantic search
 * - Vector embeddings with cosine similarity
 * - Persistent SQLite storage (WASM)
 * - Backward compatible with legacy JSON storage (auto-migrates)
 *
 * @module v3/cli/mcp-tools/memory-tools
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import type { MCPTool } from './types.js';
import { routeMemoryOp, getController, ensureRouter } from '../memory/memory-router.js';
import { validateIdentifier } from './validate-input.js';

// ADR-0162 Batch C+D hand-port: upstream's memory-bridge.ts (deleted in our
// fork per ADR-0086 / ADR-0161) housed `getMigrationMarkerPath`,
// `loadLegacyStore`, and `getMemoryFunctions`. The legacy migration path was
// removed from our fork's TS surface (only the compiled .js retained it as
// dead-code). Reinstate minimal local equivalents so the new memory_migrate
// and memory_import_claude tools landed by 8d2bfa91e / 3eb6b4d65 build.
const LEGACY_MEMORY_DIR = '.claude-flow/memory';
const MIGRATION_MARKER = '.migrated-to-sqlite';

function getMigrationMarkerPath(): string {
  return resolve(join(LEGACY_MEMORY_DIR, MIGRATION_MARKER));
}

/**
 * Legacy JSON store loader. The fork removed the legacy migration source-of-
 * truth but the memory_migrate tool still wants to surface "no legacy data"
 * cleanly. Returns null when no legacy file is present (the only path our
 * fork ever takes — legacy migration is a clean no-op now).
 */
function loadLegacyStore(): { entries: Record<string, unknown> } | null {
  try {
    const legacyPath = resolve(join(LEGACY_MEMORY_DIR, 'store.json'));
    if (!existsSync(legacyPath)) return null;
    const raw = readFileSync(legacyPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.entries
      ? (parsed as { entries: Record<string, unknown> })
      : { entries: {} };
  } catch {
    return null;
  }
}

/**
 * Memory function bag. Upstream's memory-bridge re-exported a curated set of
 * helpers; the new tools landed in this batch use storeEntry / listEntries /
 * searchEntries. Re-derive them from memory-router's routeMemoryOp surface.
 *
 * Note: upstream's tool callers pass `generateEmbeddingFlag` (the flag name
 * from upstream's own bridge API). We accept it as an alias for
 * `generateEmbedding` (memory-router's flag name) so existing tool code
 * compiles without modification.
 */
async function getMemoryFunctions(): Promise<{
  storeEntry: (opts: { key: string; value: string; namespace?: string; tags?: string[]; metadata?: Record<string, unknown>; generateEmbeddingFlag?: boolean; generateEmbedding?: boolean }) => Promise<unknown>;
  listEntries: (opts: { namespace?: string; limit?: number }) => Promise<{ entries: Array<Record<string, unknown>> }>;
  searchEntries: (opts: { query: string; namespace?: string; limit?: number }) => Promise<{ results: Array<Record<string, unknown>> }>;
}> {
  return {
    storeEntry: async (opts) => routeMemoryOp({
      type: 'store',
      key: opts.key,
      value: opts.value,
      namespace: opts.namespace ?? 'default',
      tags: opts.tags ?? [],
      generateEmbedding: opts.generateEmbeddingFlag ?? opts.generateEmbedding ?? true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(opts.metadata ? { metadata: opts.metadata } : {}) as any,
    }),
    listEntries: async (opts) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await routeMemoryOp({ type: 'list', namespace: opts.namespace, limit: opts.limit } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries = ((result as any)?.entries ?? (result as any)?.results ?? []) as Array<Record<string, unknown>>;
      return { entries };
    },
    searchEntries: async (opts) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await routeMemoryOp({ type: 'search', query: opts.query, namespace: opts.namespace, limit: opts.limit } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = ((result as any)?.results ?? (result as any)?.entries ?? []) as Array<Record<string, unknown>>;
      return { results };
    },
  };
}

// D-2: Input bounds for memory parameters
const MAX_KEY_LENGTH = 1024;
const MAX_VALUE_SIZE = 1024 * 1024; // 1MB
const MAX_QUERY_LENGTH = 4096;

function validateMemoryInput(key?: string, value?: string, query?: string): void {
  if (key && key.length > MAX_KEY_LENGTH) {
    throw new Error(`'key' must be a string of at most ${MAX_KEY_LENGTH} characters (invalid: length ${key.length})`);
  }
  if (value && value.length > MAX_VALUE_SIZE) {
    throw new Error(`'value' must be a string of at most ${MAX_VALUE_SIZE} bytes (invalid: length ${value.length})`);
  }
  if (query && query.length > MAX_QUERY_LENGTH) {
    throw new Error(`'query' must be a string of at most ${MAX_QUERY_LENGTH} characters (invalid: length ${query.length})`);
  }
}

async function ensureInitialized(): Promise<void> {
  await ensureRouter();
}

export const memoryTools: MCPTool[] = [
  {
    name: 'memory_store',
    description: 'Persistent key-value store with vector embedding — survives across sessions and is searchable by meaning, not just by file path. Use when native Write is wrong because the data is not a file (e.g. a learned pattern, a decision, a budget config) AND you need to recall it later by semantic query, not by path. Defaults to namespace="default"; pass --upsert=true to update an existing key.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key (unique within namespace)' },
        value: { description: 'Value to store (string or object)' },
        namespace: { type: 'string', description: 'Namespace for organization (default: "default")' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for filtering',
        },
        ttl: { type: 'number', description: 'Time-to-live in seconds (optional)' },
        upsert: { type: 'boolean', description: 'If true, update existing key instead of failing (default: false)' },
        scope: { type: 'string', enum: ['agent', 'session', 'global'], description: 'Memory scope (default: unscoped)' },
        scope_id: { type: 'string', description: 'Scope identifier (agent ID or session ID)' },
      },
      required: ['key', 'value', 'namespace'],
    },
    handler: async (input) => {
      await ensureInitialized();

      // ADR-0094 RC-3a: strict input type validation — reject non-string keys and
      // non-string values rather than silently coercing (ADR-0082 no-silent-pass).
      if (typeof input.key !== 'string' || input.key.length === 0) {
        return {
          success: false,
          stored: false,
          hasEmbedding: false,
          error: "'key' is required and must be a non-empty string",
        };
      }
      if (input.value === undefined || input.value === null) {
        return {
          success: false,
          key: input.key,
          stored: false,
          hasEmbedding: false,
          error: "'value' is required and must be a non-empty string",
        };
      }
      if (typeof input.value !== 'string') {
        return {
          success: false,
          key: input.key,
          stored: false,
          hasEmbedding: false,
          error: "'value' must be a string (got " + typeof input.value + "; arrays/numbers/objects are not silently stringified)",
        };
      }
      if (input.namespace !== undefined && typeof input.namespace !== 'string') {
        return {
          success: false,
          key: input.key,
          stored: false,
          hasEmbedding: false,
          error: "'namespace' must be a string when provided (got " + typeof input.namespace + ")",
        };
      }

      let key = input.key as string;

      // Phase 4: AgentMemoryScope — apply scope prefix to key.
      // ADR-0112 Phase 2 (MCP handler track): if the caller explicitly
      // requested a scope but the controller threw at scopeKey(), the
      // entry would silently land at an unscoped key — a data-integrity
      // bug that violates ADR-0082 + ADR-0112 §Required follow-up #4.
      // Discriminate: missing controller is a legitimate "no scoping
      // available" path (entry stays unscoped); controller errors
      // propagate.
      if (input.scope) {
        const scopeCtrl: any = await getController('agentMemoryScope');
        if (scopeCtrl && typeof scopeCtrl.scopeKey === 'function') {
          // No catch — if scopeKey throws, propagate to the outer handler
          key = scopeCtrl.scopeKey(
            key,
            input.scope as 'agent' | 'session' | 'global',
            (input.scope_id || input.agent_id || input.session_id) as string | undefined,
          );
        }
        // controller missing or method missing → entry stored unscoped
        // (legitimate: scoping is opt-in via input.scope, but the build
        // may not have agentMemoryScope wired)
      }
      const namespace = (input.namespace as string) || 'default';
      const value = input.value as string;
      const tags = (input.tags as string[]) || [];
      const ttl = input.ttl as number | undefined;
      const upsert = (input.upsert as boolean) || false;

      if (value.length === 0) {
        return {
          success: false,
          key,
          stored: false,
          hasEmbedding: false,
          error: "'value' is required and must be a non-empty string",
        };
      }

      validateMemoryInput(key, value);

      const startTime = performance.now();

      try {
        const result = await routeMemoryOp({
          type: 'store',
          key,
          value,
          namespace,
          tags,
          ttl,
          upsert,
          generateEmbedding: true,
        });

        const duration = performance.now() - startTime;

        // WM-105a: Register node in MemoryGraph for importance scoring
        if (result.success) {
          try {
            const mg = await getController('memoryGraph');
            if (mg && typeof (mg as Record<string, unknown>).addNode === 'function') {
              (mg as { addNode: (key: string, meta: Record<string, unknown>) => void }).addNode(key, { namespace, value, tags });
            }
          } catch {
            // MemoryGraph enrichment is non-fatal -- continue with successful result
          }
        }

        return {
          success: result.success,
          key,
          namespace,
          stored: result.success,
          storedAt: result.storedAt as string || new Date().toISOString(),
          hasEmbedding: !!result.hasEmbedding,
          embeddingDimensions: (result.embeddingDimensions as number | null) || null,
          backend: 'SQLite + HNSW',
          storeTime: `${duration.toFixed(2)}ms`,
          error: result.error,
        };
      } catch (error) {
        return {
          success: false,
          key,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_retrieve',
    description: 'Read back a value previously stored via memory_store, by exact (namespace, key) — lossless, includes metadata. Use when native Read is wrong because the value is not a file (it lives in the .swarm/memory.db SQLite store) AND you know the exact key. For semantic lookup by meaning, use memory_search.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key' },
        namespace: { type: 'string', description: 'Namespace (e.g. "patterns", "solutions", "tasks")' },
      },
      required: ['key', 'namespace'],
    },
    handler: async (input) => {
      await ensureInitialized();

      const key = input.key as string;
      const namespace = input.namespace as string;
      if (!namespace || namespace === 'all') {
        throw new Error("'namespace' is required and must be a specific string (cannot be \"all\"). Use namespace: \"patterns\", \"solutions\", or \"tasks\"");
      }

      validateMemoryInput(key);

      try {
        const result = await routeMemoryOp({ type: 'get', key, namespace });

        if (result.found && result.entry) {
          const entry = result.entry as Record<string, unknown>;
          // Try to parse JSON value
          let value: unknown = entry.content;
          try {
            value = JSON.parse(entry.content as string);
          } catch {
            // Keep as string
          }

          return {
            key,
            namespace,
            value,
            tags: entry.tags,
            storedAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            accessCount: entry.accessCount,
            hasEmbedding: entry.hasEmbedding,
            found: true,
            backend: 'SQLite + HNSW',
          };
        }

        return {
          key,
          namespace,
          value: null,
          found: false,
        };
      } catch (error) {
        return {
          key,
          namespace,
          value: null,
          found: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_search',
    description: 'Find stored memories by meaning (vector similarity), not by literal text — finds "JWT auth pattern" when you query "token-based login flow". Use when native Grep is wrong because Grep matches characters and you need to find conceptually-related entries across past sessions. Backed by HNSW index over ONNX embeddings; returns top-k with similarity scores. Pair with smart=true for query expansion + MMR diversity.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (semantic similarity)' },
        namespace: { type: 'string', description: 'Namespace to search (default: "all" = all namespaces)' },
        limit: { type: 'number', description: 'Maximum results (default: 10)' },
        threshold: { type: 'number', description: 'Minimum similarity threshold 0-1 (default: 0.3)' },
        metadata_filter: { type: 'object', description: 'Optional metadata predicates for structured filtering (MongoDB-style)' },
        mmr_lambda: { type: 'number', description: 'MMR diversity lambda 0-1 (default: 0.5; 1.0 = pure relevance, 0.0 = pure diversity)' },
        synthesize: { type: 'boolean', description: 'Synthesize context from search results (default: false)' },
        scope: { type: 'string', enum: ['agent', 'session', 'global'], description: 'Memory scope (default: unscoped)' },
        scope_id: { type: 'string', description: 'Scope identifier (agent ID or session ID)' },
      },
      required: ['query'],
    },
    handler: async (input) => {
      await ensureInitialized();

      const query = input.query as string;
      const namespace = (input.namespace as string) || 'all';
      const limit = (input.limit as number) || 10;
      const threshold = (input.threshold as number) || 0.3;

      validateMemoryInput(undefined, undefined, query);

      // ADR-0043: QueryOptimizer (B6) — check cache before searching
      try {
        const qo = await getController('queryOptimizer');
        if (qo && typeof (qo as Record<string, unknown>).getCached === 'function') {
          const cacheKey = JSON.stringify({ q: query, ns: namespace, limit, threshold });
          const cached = (qo as { getCached: (k: string) => Record<string, unknown> | null }).getCached(cacheKey);
          if (cached) {
            return { ...cached, cached: true };
          }
        }
      } catch { /* QueryOptimizer cache unavailable — proceed with search */ }

      const startTime = performance.now();

      try {
        const result = await routeMemoryOp({
          type: 'search',
          query,
          namespace,
          limit,
          threshold,
        });

        const duration = performance.now() - startTime;

        // WM-105b: Get MemoryGraph controller for importance boosting
        let _mg: { getImportance: (key: string) => number | undefined } | null = null;
        try {
          const _mgCtrl = await getController('memoryGraph');
          if (_mgCtrl && typeof (_mgCtrl as Record<string, unknown>).getImportance === 'function') {
            _mg = _mgCtrl as { getImportance: (key: string) => number | undefined };
          }
        } catch {
          // MemoryGraph importance boost is non-fatal -- continue without boosting
        }

        // Parse JSON values in results, apply importance boost if available
        const rawResults = (result.results as Array<Record<string, unknown>>) || [];
        const results = rawResults.map(r => {
          let value: unknown = r.content;
          try {
            value = JSON.parse(r.content as string);
          } catch {
            // Keep as string
          }

          const importance = _mg ? (_mg.getImportance(r.key as string) ?? 0) : 0;
          return {
            key: r.key as string,
            namespace: r.namespace as string,
            value,
            similarity: (r.score as number) + importance * 0.1,
            importance: importance || undefined,
          };
        });

        // WM-103b: Apply MetadataFilter for structured filtering (ADR-068)
        let filteredResults = results;
        if (input.metadata_filter) {
          try {
            const mf = await getController('metadataFilter');
            if (mf && typeof (mf as Record<string, unknown>).filter === 'function') {
              filteredResults = (mf as { filter: (r: typeof results, f: unknown) => typeof results }).filter(results, input.metadata_filter);
            }
          } catch {
            // MetadataFilter is non-fatal -- continue with unfiltered results
          }
        }

        // WM-103b: Apply MMRDiversityRanker for diversity re-ranking (ADR-068)
        let outputResults = filteredResults;
        try {
          const mmr = await getController('mmrDiversityRanker');
          if (mmr && typeof (mmr as Record<string, unknown>).selectDiverse === 'function' && outputResults.length > 1) {
            const lambda = (input.mmr_lambda as number) ?? 0.5;
            const diverseResults = await Promise.race([
              Promise.resolve(
                (mmr as { selectDiverse: (r: typeof outputResults, q: string, opts: { lambda: number; k: number }) => typeof outputResults })
                  .selectDiverse(outputResults, query, { lambda, k: limit })
              ),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MMR timeout')), 2000)),
            ]);
            if (Array.isArray(diverseResults) && diverseResults.length > 0) {
              outputResults = diverseResults;
            }
          }
        } catch { /* MMR diversity re-ranking unavailable — continue with unranked results */ }

        // WM-114c: Boost results with attention scores when available
        let attentionApplied = false;
        try {
          const attnService = await getController('attentionService');
          if (attnService && typeof (attnService as Record<string, unknown>).score === 'function' && outputResults.length > 1) {
            for (const r of outputResults) {
              const attnScore = (attnService as { score: (key: string) => number }).score(r.key);
              if (typeof attnScore === 'number' && attnScore > 0) {
                r.similarity = r.similarity * 0.8 + attnScore * 0.2;
                (r as Record<string, unknown>).attentionBoosted = true;
              }
            }
            outputResults.sort((a, b) => b.similarity - a.similarity);
            attentionApplied = true;
          }
        } catch {
          // AttentionService re-ranking is non-fatal -- continue with unranked results
        }

        // Phase 4: AgentMemoryScope — filter results by scope
        try {
          if (input.scope) {
            const scopeCtrl: any = await getController('agentMemoryScope');
            if (scopeCtrl && typeof scopeCtrl.filterByScope === 'function') {
              outputResults = scopeCtrl.filterByScope(
                outputResults,
                input.scope as 'agent' | 'session' | 'global',
                (input.scope_id || input.agent_id || input.session_id) as string | undefined,
              );
            }
          }
        } catch { /* scope filtering unavailable */ }

        // Context synthesis when requested (ADR-0033)
        let synthesis: unknown = undefined;
        if (input.synthesize && outputResults.length > 0) {
          try {
            const ctx = await getController('contextSynthesizer');
            if (ctx && typeof (ctx as Record<string, unknown>).synthesize === 'function') {
              synthesis = await Promise.race([
                Promise.resolve(
                  (ctx as { synthesize: (r: typeof outputResults) => unknown }).synthesize(outputResults)
                ),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ContextSynthesizer timeout')), 2000)),
              ]);
            }
          } catch { /* context synthesis unavailable */ }
        }

        // ADR-0043: QueryOptimizer (B6) — cache results
        const response = {
          query,
          results: outputResults,
          total: outputResults.length,
          searchTime: `${duration.toFixed(2)}ms`,
          backend: 'HNSW + SQLite',
          attention: attentionApplied,
          ...(synthesis ? { synthesis } : {}),
        };

        try {
          const qo = await getController('queryOptimizer');
          if (qo && typeof (qo as Record<string, unknown>).cache === 'function') {
            const cacheKey = JSON.stringify({ q: query, ns: namespace, limit, threshold });
            (qo as { cache: (k: string, v: unknown) => void }).cache(cacheKey, response);
          }
        } catch { /* QueryOptimizer cache write failed — non-fatal */ }

        return response;
      } catch (error) {
        return {
          query,
          results: [],
          total: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_delete',
    description: 'Remove a stored memory entry by exact (namespace, key). Use when a previously stored decision is invalidated or contains stale data. No native equivalent — Write to a file does not affect the .swarm/memory.db SQLite store.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key' },
        namespace: { type: 'string', description: 'Namespace (e.g. "patterns", "solutions", "tasks")' },
      },
      required: ['key', 'namespace'],
    },
    handler: async (input) => {
      await ensureInitialized();

      const key = input.key as string;
      const namespace = input.namespace as string;
      if (!namespace || namespace === 'all') {
        throw new Error("'namespace' is required and must be a specific string (cannot be \"all\"). Use namespace: \"patterns\", \"solutions\", or \"tasks\"");
      }

      validateMemoryInput(key);

      try {
        const result = await routeMemoryOp({ type: 'delete', key, namespace });

        return {
          success: !!result.deleted,
          key,
          namespace,
          deleted: !!result.deleted,
          hnswIndexInvalidated: !!result.deleted,
          backend: 'SQLite + HNSW',
        };
      } catch (error) {
        return {
          success: false,
          key,
          namespace,
          deleted: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_list',
    description: 'Enumerate stored memory entries (optionally filtered by namespace/tags) without semantic search. Use when native Glob is wrong because the entries are not files (they live in .swarm/memory.db). For inspection / audit / "what is in my memory" — pair with memory_search for retrieval-by-meaning.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace to list (default: "all" = all namespaces)' },
        limit: { type: 'number', description: 'Maximum results (default: 50)' },
        offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
      },
    },
    handler: async (input) => {
      await ensureInitialized();

      // ADR-0094 Sprint 1.4 (d9): when `input.namespace` is undefined/empty,
      // the previous `|| 'all'` default passed the literal string 'all' to the
      // router. The router did convert 'all' → undefined (line 723), but then
      // `undefined || 'default'` at the storage.query call filtered to only the
      // 'default' namespace. Pass undefined through so the list-handler treats
      // the missing filter as "no namespace filter" (all namespaces). Scoped
      // calls still work because a provided namespace survives the cast.
      const rawNamespace = input.namespace as string | undefined;
      const namespace = rawNamespace && rawNamespace.length > 0 ? rawNamespace : undefined;
      const limit = (input.limit as number) || 50;
      const offset = (input.offset as number) || 0;

      try {
        const result = await routeMemoryOp({
          type: 'list',
          namespace,
          limit,
          offset,
        });

        const rawEntries = (result.entries as Array<Record<string, unknown>>) || [];
        const entries = rawEntries.map(e => ({
          key: e.key,
          namespace: e.namespace,
          storedAt: e.createdAt,
          updatedAt: e.updatedAt,
          accessCount: e.accessCount,
          hasEmbedding: e.hasEmbedding,
          size: e.size,
        }));

        return {
          entries,
          total: (result.total as number) || 0,
          limit,
          offset,
          backend: 'SQLite + HNSW',
        };
      } catch (error) {
        return {
          entries: [],
          total: 0,
          limit,
          offset,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_stats',
    description: 'Get memory storage statistics including HNSW index status',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      await ensureInitialized();

      try {
        const result = await routeMemoryOp({ type: 'stats' });

        const totalEntries = (result.totalEntries as number) || 0;
        const withEmbeddings = (result.entriesWithEmbeddings as number) || 0;
        const namespaces = (result.namespaces as Record<string, number>) || {};

        return {
          initialized: !!result.initialized,
          totalEntries,
          entriesWithEmbeddings: withEmbeddings,
          embeddingCoverage: totalEntries > 0
            ? `${((withEmbeddings / totalEntries) * 100).toFixed(1)}%`
            : '0%',
          namespaces,
          backend: 'SQLite + HNSW',
          version: '3.0.0',
          features: {
            vectorEmbeddings: true,
            hnswIndex: true,
            semanticSearch: true,
          },
        };
      } catch (error) {
        return {
          initialized: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },
  {
    name: 'memory_migrate',
    description: 'Manually trigger migration from legacy JSON store to sql.js',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Force re-migration even if already done' },
      },
    },
    handler: async (input) => {
      const force = input.force as boolean;

      // Remove migration marker if forcing
      if (force) {
        const markerPath = getMigrationMarkerPath();
        if (existsSync(markerPath)) {
          unlinkSync(markerPath);
        }
      }

      // Check for legacy data
      const legacyStore = loadLegacyStore();
      if (!legacyStore || Object.keys(legacyStore.entries).length === 0) {
        return {
          success: true,
          message: 'No legacy data to migrate',
          migrated: 0,
        };
      }

      // Run migration via ensureInitialized
      await ensureInitialized();

      return {
        success: true,
        message: 'Migration completed',
        migrated: Object.keys(legacyStore.entries).length,
        backend: 'sql.js + HNSW',
      };
    },
  },

  // ===== Claude Code Memory Bridge Tools =====

  {
    name: 'memory_import_claude',
    description: 'Import Claude Code auto-memory files into AgentDB with ONNX vector embeddings. Reads ~/.claude/projects/*/memory/*.md files, parses YAML frontmatter, splits into sections, and stores with 384-dim embeddings for semantic search. Use allProjects=true to import from ALL Claude projects.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        allProjects: { type: 'boolean', description: 'Import from all Claude projects (default: current project only)' },
        namespace: { type: 'string', description: 'Target namespace (default: "claude-memories")' },
      },
    },
    handler: async (input) => {
      await ensureInitialized();
      const { storeEntry } = await getMemoryFunctions();

      const ns = (input.namespace as string) || 'claude-memories';
      if (input.namespace) { const vNs = validateIdentifier(ns, 'namespace'); if (!vNs.valid) return { success: false, imported: 0, error: vNs.error }; }
      const allProjects = input.allProjects as boolean;
      const claudeProjectsDir = join(homedir(), '.claude', 'projects');

      // Find memory files
      const memoryFiles: Array<{ path: string; project: string; file: string }> = [];

      if (allProjects) {
        // Scan all projects
        if (existsSync(claudeProjectsDir)) {
          try {
            for (const project of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
              if (!project.isDirectory()) continue;
              const memDir = join(claudeProjectsDir, project.name, 'memory');
              if (!existsSync(memDir)) continue;
              for (const file of readdirSync(memDir).filter((f: string) => f.endsWith('.md'))) {
                memoryFiles.push({ path: join(memDir, file), project: project.name, file });
              }
            }
          } catch { /* scan error */ }
        }
      } else {
        // Current project only — find by CWD hash
        const cwd = process.cwd();
        const projectHash = cwd.replace(/\//g, '-');
        const memDir = join(claudeProjectsDir, projectHash, 'memory');
        if (existsSync(memDir)) {
          try {
            for (const file of readdirSync(memDir).filter((f: string) => f.endsWith('.md'))) {
              memoryFiles.push({ path: join(memDir, file), project: projectHash, file });
            }
          } catch { /* scan error */ }
        }
      }

      if (memoryFiles.length === 0) {
        return { success: true, imported: 0, message: 'No Claude memory files found' };
      }

      let imported = 0;
      let skipped = 0;
      // #1791.8 — Claude Code's `~/.claude/projects/` accumulates historical
      // project_id directories (truncated forms, sandbox cwds, renamed
      // workspaces) that all contain copies of the same memory files. The
      // previous import indexed each copy under a different `project_id`
      // prefix, producing 5–8x duplication on long-lived homes. Dedupe by
      // file content hash so the same memory is imported once even if it
      // appears under several project directories.
      const seenContentHashes = new Set<string>();
      let duplicatesSkipped = 0;
      const projects = new Set<string>();

      for (const memFile of memoryFiles) {
        projects.add(memFile.project);
        try {
          const content = readFileSync(memFile.path, 'utf-8');

          // #1791.8 — Skip if we've already imported this exact content under
          // a different project_id directory.
          const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
          if (seenContentHashes.has(contentHash)) {
            duplicatesSkipped++;
            continue;
          }
          seenContentHashes.add(contentHash);

          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
          let name = memFile.file.replace('.md', '');
          let body = content;

          if (frontmatterMatch) {
            const yaml = frontmatterMatch[1];
            body = frontmatterMatch[2].trim();
            const nameMatch = yaml.match(/^name:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
          }

          // Split into sections for granular search
          const sections = body.split(/^(?=## )/m).filter(s => s.trim().length > 20);

          if (sections.length === 0 && body.length > 10) {
            await storeEntry({ key: `claude:${memFile.project}:${name}`, value: body.slice(0, 4096), namespace: ns, generateEmbeddingFlag: true });
            imported++;
          } else {
            for (const section of sections) {
              const titleMatch = section.match(/^##\s+(.+)/);
              const sectionTitle = titleMatch ? titleMatch[1].trim() : name;
              const sectionBody = section.replace(/^##\s+.+\n/, '').trim();
              if (sectionBody.length < 10) continue;
              await storeEntry({ key: `claude:${memFile.project}:${name}:${sectionTitle.slice(0, 50)}`, value: sectionBody.slice(0, 4096), namespace: ns, generateEmbeddingFlag: true });
              imported++;
            }
          }
        } catch {
          skipped++;
        }
      }

      return {
        success: true,
        imported,
        skipped,
        duplicatesSkipped,
        files: memoryFiles.length,
        projects: projects.size,
        namespace: ns,
        embedding: 'ONNX all-MiniLM-L6-v2 (384-dim)',
      };
    },
  },

  {
    name: 'memory_bridge_status',
    description: 'Show Claude Code memory bridge status — AgentDB vectors, SONA learning, intelligence patterns, and connection health.',
    category: 'memory',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      await ensureInitialized();

      // Count Claude memory files
      const claudeProjectsDir = join(homedir(), '.claude', 'projects');
      let claudeFiles = 0;
      let claudeProjects = 0;
      if (existsSync(claudeProjectsDir)) {
        try {
          for (const project of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
            if (!project.isDirectory()) continue;
            const memDir = join(claudeProjectsDir, project.name, 'memory');
            if (!existsSync(memDir)) continue;
            const files = readdirSync(memDir).filter((f: string) => f.endsWith('.md'));
            if (files.length > 0) { claudeProjects++; claudeFiles += files.length; }
          }
        } catch { /* ignore */ }
      }

      // AgentDB status
      let agentdbEntries = 0;
      let claudeMemoryEntries = 0;
      try {
        const { listEntries } = await getMemoryFunctions();
        const allEntries = await listEntries({});
        agentdbEntries = allEntries?.entries?.length ?? 0;
        const claudeEntries = await listEntries({ namespace: 'claude-memories' });
        claudeMemoryEntries = claudeEntries?.entries?.length ?? 0;
      } catch { /* ignore */ }

      // Intelligence status
      let intelligence = { sonaEnabled: false, patternsLearned: 0, trajectoriesRecorded: 0 };
      try {
        const int = await import('../memory/intelligence.js');
        const stats = int.getIntelligenceStats?.();
        if (stats) intelligence = { sonaEnabled: stats.sonaEnabled, patternsLearned: stats.patternsLearned, trajectoriesRecorded: stats.trajectoriesRecorded };
      } catch { /* not initialized */ }

      return {
        claudeCode: { memoryFiles: claudeFiles, projects: claudeProjects },
        agentdb: { totalEntries: agentdbEntries, claudeMemoryEntries, backend: 'sql.js + ONNX' },
        intelligence,
        bridge: { status: claudeMemoryEntries > 0 ? 'connected' : 'not-synced', embedding: 'all-MiniLM-L6-v2 (384-dim)' },
      };
    },
  },

  {
    name: 'memory_search_unified',
    description: 'Search across both Claude Code memories and AgentDB entries using semantic vector similarity. Returns merged, deduplicated results from all namespaces.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (natural language)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
        namespace: { type: 'string', description: 'Filter to namespace (omit for all)' },
      },
      required: ['query'],
    },
    handler: async (input) => {
      await ensureInitialized();
      const { searchEntries } = await getMemoryFunctions();
      validateMemoryInput(undefined, undefined, input.query as string);

      const query = input.query as string;
      const limit = (input.limit as number) ?? 10;
      const ns = input.namespace as string | undefined;

      if (ns) { const vNs = validateIdentifier(ns, 'namespace'); if (!vNs.valid) return { success: false, query, results: [], total: 0, error: vNs.error }; }

      // Search all namespaces unless filtered
      const namespaces = ns ? [ns] : ['default', 'claude-memories', 'auto-memory', 'patterns', 'tasks', 'feedback'];
      const allResults: Array<{ key: string; content: string; score: number; namespace: string; source: string }> = [];

      for (const searchNs of namespaces) {
        try {
          const r = await searchEntries({ query, namespace: searchNs, limit: limit * 2 });
          if (r?.results) {
            for (const entry of r.results) {
              const e = entry as Record<string, unknown>;
              allResults.push({
                key: (e.key as string) || (e.id as string) || '',
                content: ((e.content as string) || (e.value as string) || '').toString().slice(0, 200),
                score: (e.score as number) || 0,
                namespace: searchNs,
                source: searchNs === 'claude-memories' ? 'claude-code' : searchNs === 'auto-memory' ? 'auto-memory' : 'agentdb',
              });
            }
          }
        } catch { /* namespace may not exist */ }
      }

      // Sort by score, deduplicate by key, take top N
      allResults.sort((a, b) => b.score - a.score);
      const seen = new Set<string>();
      const deduplicated = allResults.filter(r => {
        if (seen.has(r.key)) return false;
        seen.add(r.key);
        return true;
      }).slice(0, limit);

      return {
        success: true,
        query,
        results: deduplicated,
        total: deduplicated.length,
        searchedNamespaces: namespaces,
        searchTime: Date.now(),
      };
    },
  },
];
