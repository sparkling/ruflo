/**
 * Memory MCP Tools for CLI - V3 with SQLite/HNSW Backend.
 *
 * Backed by an SQLite + HNSW pipeline (150x-12,500x faster semantic search;
 * ONNX cosine similarity; auto-migration from legacy JSON storage).
 *
 * ── ADR-0181 Phase 5 (F4-3) state, 2026-05-15 ────────────────────────────────
 *
 * Routed through the per-process Memory Archivist (typed `archivist.dispatch<K>`
 * overload from `agentdb/archivist/dispatch-types.ts`):
 *
 *   - `memory_store` (mutation, RVF-dependent) — `await ensureRvfWired()` then
 *     `archivist.dispatch('memory_store', payload)`. The handler at
 *     `handlers/memory/store.ts` writes through the cli's live RVF substrate
 *     via `MemoryRvfAdapter` (wired by Phase 4 / W-lazy). Mutation handler
 *     returns void; the cli re-reads via `routeMemoryOp({type:'get'})` to
 *     populate `hasEmbedding` / `embeddingDimensions` / `storedAt` for the
 *     response envelope (one extra fs read per write — team-lead ruling).
 *     This is the only memory tool where dispatch makes data flow today.
 *
 * Kept cli-native with PHASE 6+ markers (5 tools — release-acceptance gate):
 *
 *   The four read tools (`memory_search`, `memory_retrieve`, `memory_list`,
 *   `memory_search_unified`) have archivist counterparts, but those handlers
 *   register `STORE_ID = 'memory_search_index'` — a Phase 3 FS-JSON placeholder
 *   that NOTHING currently populates (see handler comments at
 *   `handlers/memory/search.ts` lines 32-38 / `retrieve.ts` lines 26-31 /
 *   `list.ts` lines 24-29 / `search-unified.ts` lines 24-30, all explicitly
 *   declaring "this handler returns an empty RankedResults for every dispatched
 *   read"). Dispatching now would regress production behavior. Each tool
 *   carries an inline `// PHASE 6+: route through archivist when
 *   memory_search_index→memory_store collapse lands` marker. Resolution
 *   requires ONE of: (a) cli-side writer populating `memory_search_index` from
 *   live RVF, (b) substrate-seam expansion (`getByKey` + `list` on
 *   `ReadOnlySubstrateHandle`) + per-handler STORE_ID flip to `memory_store`,
 *   (c) per-handler routing decisions at the cli edge — all deferred to
 *   Phase 6+.
 *
 *   `memory_bridge_status` is also cli-native: the archivist handler can only
 *   emit the `claude-code` leg live; agentdb/intelligence/bridge legs depend
 *   on `ctx.capabilities.*` deferred by the ADR-0180 F4-2 Phase C → Phase 1
 *   Amendment chain. PHASE 6+: route when capabilities are wired.
 *
 * Untouched (no archivist counterparts):
 *
 *   `memory_delete`, `memory_stats`, `memory_migrate`, `memory_import_claude` —
 *   stay on `routeMemoryOp` / `getMemoryFunctions()`.
 *
 * @module v3/cli/mcp-tools/memory-tools
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import type { MCPTool } from './types.js';
import { findProjectRoot } from './types.js';
import { routeMemoryOp, getController, ensureRouter } from '../memory/memory-router.js';
import { validateIdentifier } from './validate-input.js';
import { getProcessArchivist, ensureRvfWired } from '../memory/archivist-init.js';
import { withTimeoutLogged } from '../utils/timeout.js';

// ADR-0181 Phase 5 (F4-3) cli delegation summary (full rationale in the file
// header @module docblock):
//   FLIPPED: memory_store (mutation, RVF — `await ensureRvfWired()` then
//            `archivist.dispatch('memory_store', payload)`; cli re-reads via
//            `routeMemoryOp({type:'get'})` for response envelope fields).
//   PHASE 6+ markers (5 tools stay cli-native to avoid release regression
//            from the empty `memory_search_index` placeholder substrate):
//            memory_search, memory_retrieve, memory_list,
//            memory_search_unified, memory_bridge_status.
//   UNTOUCHED (no archivist counterpart): memory_delete, memory_stats,
//            memory_migrate, memory_import_claude.

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
        // ADR-0241: namespace is optional; handler defaults to "default" at :260.
        // Schema previously listed namespace in `required`, creating an asymmetry
        // where strict MCP clients refused calls that permissive clients passed
        // through to a `'default'`-defaulted write. Upstream is permissive
        // (`required: ['key', 'value']` at ruvnet/ruflo/v3/.../memory-tools.ts:274);
        // this relax re-converges with upstream.
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
      required: ['key', 'value'],
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
        // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler
        // at `handlers/memory/store.ts` owns the RVF-substrate write under
        // `substrate.withWrite({ storeId: 'memory_store' })`. Gate behind
        // `ensureRvfWired()` — RVF substrate (memory-router cold-start opens
        // .rvf + builds HNSW + loads ONNX embedder). Mutation handler returns
        // void; re-read the stored entry to populate `hasEmbedding` /
        // `embeddingDimensions` (one extra fs read per write — team-lead
        // ruling 2026-05-15).
        await ensureRvfWired();
        const archivist = await getProcessArchivist();
        await archivist.dispatch('memory_store', {
          namespace,
          key,
          content: value,
          tags,
          ttl,
          upsert,
          generateEmbedding: true,
        });

        const duration = performance.now() - startTime;

        // Re-read to surface embedding metadata in the response envelope.
        // `routeMemoryOp({type:'get'})` returns `{success, found, entry}` where
        // entry carries `hasEmbedding` / `embeddingDimensions` (memory-router
        // case 'get' at line 1223). The dispatch above is the authoritative
        // write — this read is purely for response-shape parity.
        let hasEmbedding = false;
        let embeddingDimensions: number | null = null;
        let storedAt: string | undefined;
        try {
          const getResult = await routeMemoryOp({ type: 'get', key, namespace });
          if (getResult.found && getResult.entry) {
            const entry = getResult.entry as Record<string, unknown>;
            hasEmbedding = !!entry.hasEmbedding;
            embeddingDimensions = (entry.embeddingDimensions as number | null) ?? null;
            storedAt = entry.createdAt as string | undefined;
          }
        } catch {
          // Re-read is non-fatal — the dispatch above already succeeded; the
          // response envelope just won't carry the embedding-metadata fields.
        }

        // WM-105a: Register node in MemoryGraph for importance scoring. Side-
        // effect on the cli-side controller — the archivist handler does the
        // substrate write; MemoryGraph indexing stays cli-local.
        try {
          const mg = await getController('memoryGraph');
          if (mg && typeof (mg as Record<string, unknown>).addNode === 'function') {
            (mg as { addNode: (key: string, meta: Record<string, unknown>) => void }).addNode(key, { namespace, value, tags });
          }
        } catch {
          // MemoryGraph enrichment is non-fatal -- continue with successful result
        }

        return {
          success: true,
          key,
          namespace,
          stored: true,
          storedAt: storedAt || new Date().toISOString(),
          hasEmbedding,
          embeddingDimensions,
          backend: 'archivist (RVF + HNSW)',
          storeTime: `${duration.toFixed(2)}ms`,
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
        includeProvenance: {
          type: 'boolean',
          description: 'ADR-0180 Phase 3: include archivist provenance metadata ({ storeId, matchType: "exact", rawScore: 1, rank: 1 }) on a found entry. Default false preserves the legacy retrieval shape.',
        },
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
      const includeProvenance = input.includeProvenance === true;

      validateMemoryInput(key);

      try {
        // PHASE 6+: route through archivist when memory_search_index→memory_store
        // collapse lands. The archivist handler at `handlers/memory/retrieve.ts`
        // reads from the FS-JSON `memory_search_index` placeholder store that
        // nothing currently writes to (Phase 3 carry-forward — see
        // `archivist-init.ts` header lines 75-92 + `handlers/memory/retrieve.ts`
        // lines 26-31). Dispatching now would return `found: false` for every
        // entry — a release-acceptance regression. Stay on `routeMemoryOp('get')`
        // until the substrate-seam expansion (or cli-side index populator)
        // lands.
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

          const base = {
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
          // ADR-0180 §Provenance rollout scope (Phase 3, 2026-05-14):
          // memory_retrieve is a single-entry exact (namespace, key) lookup.
          // matchType: 'exact' fits the closed Provenance union from
          // handlers/memory/search.ts. rawScore: 1 reflects the lossless exact
          // hit (vs memory_list enumeration's 0); rank: 1 because retrieve
          // returns at most one entry. Shape parity with the list/search
          // workers' optional `provenance` field.
          return includeProvenance
            ? {
                ...base,
                provenance: {
                  storeId: 'memory_store',
                  matchType: 'exact' as const,
                  rawScore: 1,
                  rank: 1,
                },
              }
            : base;
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
        includeProvenance: { type: 'boolean', description: 'When true, includes archivist provenance metadata on each result (ADR-0180 §102). Default false strips the provenance field for back-compat with existing scripts.' },
      },
      required: ['query'],
    },
    handler: async (input) => {
      await ensureInitialized();

      const query = input.query as string;
      const namespace = (input.namespace as string) || 'all';
      const limit = (input.limit as number) || 10;
      // ADR-0227 (2026-05-22): do NOT hardcode a default here. Pass `undefined`
      // through so the router resolves it via getAdaptiveThreshold (the fork's
      // FB-004 adaptive layer), which floors real ONNX/mpnet at 0.15 (measured
      // related content scores ~0.25-0.65; the old hardcoded 0.3 cut into recall
      // AND defeated the adaptive layer for the MCP path). An explicit
      // `threshold: 0` is still honored end-to-end (router `?? 0.3` keeps 0, then
      // getAdaptiveThreshold returns an explicit value as-is).
      const threshold = input.threshold as number | undefined;
      const includeProvenance = input.includeProvenance === true;

      validateMemoryInput(undefined, undefined, query);

      // ADR-0043: QueryOptimizer (B6) — check cache before searching.
      // ADR-0191 Cluster B (revised): cache lookup is a best-effort
      // enhancement; same graceful-degradation contract as the other
      // search-enrichment controllers (MetadataFilter, AttentionService,
      // etc. — see surrounding catches). Catch + log so signal is
      // observable, then proceed with the full search.
      try {
        const qo = await getController('queryOptimizer');
        if (qo && typeof (qo as Record<string, unknown>).getCached === 'function') {
          const cacheKey = JSON.stringify({ q: query, ns: namespace, limit, threshold });
          const cached = (qo as { getCached: (k: string) => Record<string, unknown> | null }).getCached(cacheKey);
          if (cached) {
            return { ...cached, cached: true };
          }
        }
      } catch (e) {
        console.error(`[memory_search] QueryOptimizer fall-through: ${e instanceof Error ? e.message : String(e)}`);
      }

      const startTime = performance.now();

      try {
        // PHASE 6+: route through archivist when memory_search_index→memory_store
        // collapse lands. The archivist handler at `handlers/memory/search.ts`
        // reads from the FS-JSON `memory_search_index` placeholder store that
        // nothing currently writes to (Phase 3 carry-forward — see
        // `archivist-init.ts` header lines 75-92 + `handlers/memory/search.ts`
        // lines 32-38). Dispatching now would return an empty RankedResults
        // for every query — a release-acceptance regression. Stay on
        // `routeMemoryOp('search')` (RVF-backed BM25/ONNX/hash-fusion + MMR
        // diversity + AttentionService boost) until the substrate-seam
        // expansion (or cli-side index populator) lands.
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

        // WM-103b: Apply MMRDiversityRanker for diversity re-ranking (ADR-068).
        // ADR-0191 Cluster B (revised): re-ranking is a best-effort
        // enhancement. Catch + log so signal is observable; fall through
        // to unranked results (matches MetadataFilter / AttentionService
        // graceful-degradation pattern above).
        let outputResults = filteredResults;
        try {
          const mmr = await getController('mmrDiversityRanker');
          if (mmr && typeof (mmr as Record<string, unknown>).selectDiverse === 'function' && outputResults.length > 1) {
            const lambda = (input.mmr_lambda as number) ?? 0.5;
            const diverseResults = await withTimeoutLogged(
              Promise.resolve(
                (mmr as { selectDiverse: (r: typeof outputResults, q: string, opts: { lambda: number; k: number }) => typeof outputResults })
                  .selectDiverse(outputResults, query, { lambda, k: limit })
              ),
              2000,
              'MMRDiversityRanker.selectDiverse',
            );
            if (Array.isArray(diverseResults) && diverseResults.length > 0) {
              outputResults = diverseResults;
            }
          }
        } catch (e) {
          console.error(`[memory_search] MMRDiversityRanker fall-through: ${e instanceof Error ? e.message : String(e)}`);
        }

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

        // Phase 4: AgentMemoryScope — filter results by scope.
        // ADR-0191 Cluster B (revised): scope filtering is a best-effort
        // enhancement; catch + log so signal is observable, then fall
        // through to unfiltered results.
        if (input.scope) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const scopeCtrl: any = await getController('agentMemoryScope');
            if (scopeCtrl && typeof scopeCtrl.filterByScope === 'function') {
              outputResults = scopeCtrl.filterByScope(
                outputResults,
                input.scope as 'agent' | 'session' | 'global',
                (input.scope_id || input.agent_id || input.session_id) as string | undefined,
              );
            }
          } catch (e) {
            console.error(`[memory_search] AgentMemoryScope fall-through: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // Context synthesis when requested (ADR-0033).
        // ADR-0191 Cluster B (revised): synthesis is a best-effort
        // enhancement; catch + log so signal is observable, then leave
        // synthesis undefined (caller handles that shape).
        let synthesis: unknown = undefined;
        if (input.synthesize && outputResults.length > 0) {
          try {
            const ctx = await getController('contextSynthesizer');
            if (ctx && typeof (ctx as Record<string, unknown>).synthesize === 'function') {
              synthesis = await withTimeoutLogged(
                Promise.resolve(
                  (ctx as { synthesize: (r: typeof outputResults) => unknown }).synthesize(outputResults)
                ),
                2000,
                'ContextSynthesizer.synthesize',
              );
            }
          } catch (e) {
            console.error(`[memory_search] ContextSynthesizer fall-through: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // ADR-0180 §102: Provenance shape branching.
        // - includeProvenance=true: pass through full RankedResult shape (carries `provenance` once archivist handler lands).
        // - includeProvenance=false (default): strip provenance field to preserve legacy shape for existing scripts.
        const shapedResults = includeProvenance
          ? outputResults
          : outputResults.map(r => {
              const { provenance: _provenance, ...rest } = r as Record<string, unknown>;
              return rest;
            });

        // ADR-0043: QueryOptimizer (B6) — cache results
        const response = {
          query,
          results: shapedResults,
          total: shapedResults.length,
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
        includeProvenance: {
          type: 'boolean',
          description: 'ADR-0180 Phase 3: include archivist provenance metadata ({ storeId, matchType: "exact", rawScore: 0, rank }) per entry. Default false preserves legacy enumeration shape.',
        },
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
      const includeProvenance = input.includeProvenance === true;

      try {
        // PHASE 6+: route through archivist when memory_search_index→memory_store
        // collapse lands. The archivist handler at `handlers/memory/list.ts`
        // reads from the FS-JSON `memory_search_index` enumeration store that
        // nothing currently writes to (Phase 3 carry-forward — see
        // `archivist-init.ts` header lines 75-92 + `handlers/memory/list.ts`
        // lines 24-29). Dispatching now would return an empty enumeration for
        // every call — a release-acceptance regression. Stay on
        // `routeMemoryOp('list')` (RVF `storage.query` with offset/limit)
        // until the substrate-seam expansion (or cli-side index populator)
        // lands.
        const result = await routeMemoryOp({
          type: 'list',
          namespace,
          limit,
          offset,
        });

        const rawEntries = (result.entries as Array<Record<string, unknown>>) || [];
        const entries = rawEntries.map((e, index) => {
          const base = {
            key: e.key,
            namespace: e.namespace,
            storedAt: e.createdAt,
            updatedAt: e.updatedAt,
            accessCount: e.accessCount,
            hasEmbedding: e.hasEmbedding,
            size: e.size,
          };
          // ADR-0180 §Provenance rollout scope (Phase 3, 2026-05-14):
          // memory_list is an enumeration, not a similarity rank — there is no
          // relevance score. matchType: 'exact' is the closest member of the
          // existing closed Provenance union in handlers/memory/search.ts —
          // enumeration is a degenerate form where every entry "matches" its
          // own (namespace, key) tuple exactly. rank reflects the
          // post-pagination position (1-based, includes offset) so clients can
          // correlate with offset+index. rawScore is 0 by enumeration semantics.
          return includeProvenance
            ? {
                ...base,
                provenance: {
                  storeId: 'memory_store',
                  matchType: 'exact' as const,
                  rawScore: 0,
                  rank: offset + index + 1,
                },
              }
            : base;
        });

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

        // ADR-0257 #4: report actual write path (ADR-0177 RVF restoration).
        // ADR-0257 #6: populate totalSize + location fields (was always empty).
        const rvfPath = join(findProjectRoot(), '.swarm', 'memory.rvf');
        let totalSize = 'unknown';
        const location = rvfPath;
        if (existsSync(rvfPath)) {
          const bytes = statSync(rvfPath).size;
          totalSize = bytes < 1024
            ? `${bytes} B`
            : bytes < 1024 * 1024
              ? `${(bytes / 1024).toFixed(1)} KB`
              : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        }

        return {
          initialized: !!result.initialized,
          totalEntries,
          entriesWithEmbeddings: withEmbeddings,
          embeddingCoverage: totalEntries > 0
            ? `${((withEmbeddings / totalEntries) * 100).toFixed(1)}%`
            : '0%',
          namespaces,
          backend: 'RVF + HNSW',
          totalSize,
          location,
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
        backend: 'SQLite + HNSW',
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
        // ADR-0100: anchor on findProjectRoot() so subdirectory invocations
        // resolve to the same project hash as `claude` running at the root.
        const cwd = findProjectRoot();
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
    description: 'Show Claude Code memory bridge status — AgentDB vectors, SONA learning, intelligence patterns, and connection health. With includeProvenance=true, returns archivist RankedResults<BridgeStatusEntry> shape (ADR-0180 Phase 3) — one ranked entry per component carrying state ∈ {up,down,degraded}, metadata, and provenance{storeId,matchType:"status",rawScore,rank}.',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        includeProvenance: { type: 'boolean', description: 'When true, return archivist RankedResults<BridgeStatusEntry> shape with provenance{storeId,matchType:"status",rawScore,rank} per entry (ADR-0180 Phase 3). Default false preserves the legacy shape for existing scripts.' },
      },
    },
    handler: async (input) => {
      await ensureInitialized();
      const includeProvenance = (input as Record<string, unknown> | undefined)?.includeProvenance === true;

      // ADR-0181 Phase 5 (F4-3): memory_bridge_status is INTENTIONALLY NOT
      // routed through `archivist.dispatchRead('memory_bridge_status', ...)`.
      // The archivist handler at `handlers/memory/bridge-status.ts` can only
      // emit the `claude-code` leg live; the agentdb / intelligence / bridge
      // legs depend on cli-internal capabilities (listEntries probe,
      // ../memory/intelligence.getIntelligenceStats) that cannot cross the
      // ADR-0161 agentdb-cannot-import-forks/ruflo boundary. Until
      // `ctx.capabilities.{listEntries, intelligence}` are wired (deferred
      // by ADR-0180 F4-2 Phase C, then by the Phase 1 Amendment), flipping
      // here would regress the legacy non-provenance shape from 4 live legs
      // to 1 live + 3 `degraded` stubs.
      //
      // PHASE 6+: route through archivist when capabilities are wired.
      // Team-lead ruling, 2026-05-15. Keep cli's 4-leg local assembly.

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
      let agentdbReachable = true;
      try {
        const { listEntries } = await getMemoryFunctions();
        const allEntries = await listEntries({});
        agentdbEntries = allEntries?.entries?.length ?? 0;
        const claudeEntries = await listEntries({ namespace: 'claude-memories' });
        claudeMemoryEntries = claudeEntries?.entries?.length ?? 0;
      } catch {
        agentdbReachable = false;
      }

      // Intelligence status
      let intelligence = { sonaEnabled: false, patternsLearned: 0, trajectoriesRecorded: 0 };
      let intelligenceReachable = true;
      try {
        const int = await import('../memory/intelligence.js');
        const stats = int.getIntelligenceStats?.();
        if (stats) intelligence = { sonaEnabled: stats.sonaEnabled, patternsLearned: stats.patternsLearned, trajectoriesRecorded: stats.trajectoriesRecorded };
        else intelligenceReachable = false;
      } catch {
        intelligenceReachable = false;
      }

      const claudeCode = { memoryFiles: claudeFiles, projects: claudeProjects };
      const agentdb = { totalEntries: agentdbEntries, claudeMemoryEntries, backend: 'SQLite + ONNX' };
      const bridge = { status: claudeMemoryEntries > 0 ? 'connected' : 'not-synced', embedding: 'all-MiniLM-L6-v2 (384-dim)' };

      if (includeProvenance) {
        // ADR-0180 §Architecture · Read-path return shape: RankedResults<BridgeStatusEntry>.
        // One ranked entry per component; score=1.0 (status, not similarity);
        // provenance.matchType='status' per Pass-3 disposition; rank assigned in order.
        // Mirrors the registration shape in
        // forks/agentdb/src/archivist/handlers/memory/bridge-status.ts.
        const entries = [
          {
            item: {
              component: 'claude-code',
              state: claudeFiles > 0 ? 'up' as const : 'degraded' as const,
              metadata: { ...claudeCode, namespace: 'filesystem' } as Record<string, unknown>,
            },
            score: 1.0 as const,
            provenance: { storeId: 'claude-code-projects', matchType: 'status' as const, rawScore: 1.0 as const },
          },
          {
            item: {
              component: 'agentdb',
              state: agentdbReachable ? 'up' as const : 'down' as const,
              metadata: { ...agentdb, namespace: 'all' } as Record<string, unknown>,
            },
            score: 1.0 as const,
            provenance: { storeId: 'agentdb', matchType: 'status' as const, rawScore: 1.0 as const },
          },
          {
            item: {
              component: 'intelligence',
              state: intelligenceReachable
                ? (intelligence.sonaEnabled ? 'up' as const : 'degraded' as const)
                : 'down' as const,
              metadata: { ...intelligence, namespace: 'sona' } as Record<string, unknown>,
            },
            score: 1.0 as const,
            provenance: { storeId: 'intelligence', matchType: 'status' as const, rawScore: 1.0 as const },
          },
          {
            item: {
              component: 'bridge',
              state: claudeMemoryEntries > 0 ? 'up' as const : 'degraded' as const,
              metadata: { ...bridge, namespace: 'claude-memories' } as Record<string, unknown>,
            },
            score: 1.0 as const,
            provenance: { storeId: 'memory-bridge', matchType: 'status' as const, rawScore: 1.0 as const },
          },
        ];
        return {
          results: entries.map((e, rank) => ({ ...e, provenance: { ...e.provenance, rank } })),
          total: entries.length,
        };
      }

      return { claudeCode, agentdb, intelligence, bridge };
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
        includeProvenance: { type: 'boolean', description: 'When true, includes archivist provenance metadata on each result (ADR-0180 §102). Cross-store fusion uses Reciprocal Rank Fusion (k=60) — provenance carries per-store rank and storeId so ExplainableRecall can reconstruct the fusion. Default false strips the provenance field for back-compat.' },
      },
      required: ['query'],
    },
    handler: async (input) => {
      await ensureInitialized();
      // ADR-0181 task #100 (2026-05-17): dispatch through the archivist. The
      // `memory_search_unified` handler (forks/agentdb handlers/memory/
      // search-unified.ts) owns cross-store sort+dedup after task #99 landed
      // STORE_ID = 'memory_store'. The dispatched path replaces the cli's
      // per-namespace `searchEntries` fan-out with a single multi-namespace
      // substrate.vectorSearch + post-hoc per-namespace bucketing.
      //
      // Carry-forward (handler header line 99): UNIFIED_TOPK_MULTIPLIER=8 —
      // the handler widens topK by 8× to keep per-namespace rank buckets
      // populated. Equivalent to the cli's pre-flip fan-out (each namespace
      // got `limit * 2` candidates) but bounded by ONE HNSW query rather
      // than N independent ones. At very large namespace counts with low
      // limit, the post-bucket rank assignment may have fewer per-store
      // members than the pre-flip path; if acceptance flags this, dispatch
      // becomes per-namespace.
      validateMemoryInput(undefined, undefined, input.query as string);

      const query = input.query as string;
      const limit = (input.limit as number) ?? 10;
      const ns = input.namespace as string | undefined;
      const includeProvenance = input.includeProvenance === true;

      if (ns) { const vNs = validateIdentifier(ns, 'namespace'); if (!vNs.valid) return { success: false, query, results: [], total: 0, error: vNs.error }; }

      // Pre-flip default fan-out (cli's enumerated namespaces) — preserved
      // for the response's `searchedNamespaces` field so downstream consumers
      // see a stable list of "namespaces this tool would have considered".
      const searchedNamespaces = ns
        ? [ns]
        : ['default', 'claude-memories', 'auto-memory', 'patterns', 'tasks', 'feedback'];

      try {
        await ensureRvfWired();
        const archivist = await getProcessArchivist();
        const raw = await archivist.dispatchRead('memory_search_unified', {
          query,
          limit,
          ...(ns !== undefined ? { namespace: ns } : {}),
        });
        const ranked = raw as ReadonlyArray<{
          item: { key: string; namespace: string; content: string; score: number };
          score: number;
          provenance: {
            storeId: string;
            matchType: 'semantic' | 'bm25' | 'exact' | 'fused' | 'status';
            rawScore: number;
            rank: number;
            matchedField?: string;
          };
        }>;

        // Flatten RankedResults to the cli's pre-flip flat shape. `source`
        // is derived from namespace the same way the pre-flip fan-out did
        // (claude-memories → 'claude-code', auto-memory → 'auto-memory',
        // anything else → 'agentdb'). The handler already populated
        // provenance.storeId from the per-store source, but mapping back
        // through the cli's source-derivation keeps the response stable for
        // any consumer keying off `source`.
        const flat = ranked.map((r) => {
          const recordNamespace = r.item.namespace;
          const source =
            recordNamespace === 'claude-memories'
              ? 'claude-code'
              : recordNamespace === 'auto-memory'
                ? 'auto-memory'
                : 'agentdb';
          return {
            key: r.item.key,
            content: (r.item.content || '').toString().slice(0, 200),
            score: r.score,
            namespace: recordNamespace,
            source,
            provenance: {
              storeId: source,
              matchType: 'semantic' as const,
              rawScore: r.provenance.rawScore,
              rank: r.provenance.rank,
              matchedField: 'content' as const,
            },
          };
        });

        // ADR-0180 §102: provenance flag gates the response shape.
        const shapedResults = includeProvenance
          ? flat
          : flat.map(r => {
              const { provenance: _provenance, ...rest } = r;
              return rest;
            });

        return {
          success: true,
          query,
          results: shapedResults,
          total: shapedResults.length,
          searchedNamespaces,
          searchTime: Date.now(),
        };
      } catch (error) {
        return {
          success: false,
          query,
          results: [],
          total: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  },

  {
    name: 'memory_export',
    description: 'Export memory entries to a JSON file (keys, namespaces, timestamps, values, embedding-presence flag). Reads through routeMemoryOp({type:"list"}) — same substrate seam as memory_list. Schema: ruflo-memory-export/v1. CSV/binary/includeVectors=true throw typed errors until implemented (ADR-0255 Phase 1).',
    category: 'memory',
    inputSchema: {
      type: 'object',
      properties: {
        outputPath: { type: 'string', description: 'Filesystem path to write the JSON export.' },
        format: { type: 'string', enum: ['json', 'csv', 'binary'], description: 'Output format. Phase 1: only "json" is implemented; "csv" and "binary" throw a typed error (ADR-0255 Decision #3 — no silent fallback).' },
        namespace: { type: 'string', description: 'Filter to a single namespace; omit to export all namespaces.' },
        includeVectors: { type: 'boolean', description: 'Phase 1: must be false (or omitted). includeVectors=true throws a typed error pending schema v2 with embeddingModel/embeddingDim fields (ADR-0255 Decision #6).' },
      },
      required: ['outputPath'],
    },
    handler: async (input) => {
      // Input validation BEFORE ensureInitialized() — typed errors fire without
      // paying the substrate-boot cost. Mirrors the early-validation discipline
      // for unsupported-flag rejection. ensureInitialized is only needed once
      // we actually intend to read the substrate (after all rejections pass).
      const outputPath = typeof input.outputPath === 'string' ? input.outputPath : '';
      if (!outputPath) {
        return { error: "'outputPath' is required and must be a non-empty string" };
      }
      const format = typeof input.format === 'string' ? input.format : 'json';
      if (format === 'csv' || format === 'binary') {
        throw new Error(`format '${format}' not implemented — Phase 1 ships JSON only; see ADR-0255 Plan`);
      }
      if (format !== 'json') {
        throw new Error(`format '${format}' not recognized — valid choices: 'json' (csv/binary deferred per ADR-0255 Plan)`);
      }
      if (input.includeVectors === true) {
        throw new Error('includeVectors=true not implemented — Phase 1 omits vector serialization (mpnet-768 vs MiniLM-384 incompatibility); schema v2 needed (ADR-0255 Decision #6 / Open Questions)');
      }
      const namespace = typeof input.namespace === 'string' && input.namespace.length > 0 ? input.namespace : undefined;
      if (namespace !== undefined) {
        const v = validateIdentifier(namespace, 'namespace');
        if (!v.valid) throw new Error(v.error);
      }

      await ensureInitialized();
      // PHASE 6+: route through archivist when memory_search_index→memory_store
      // collapse lands — same gate as memory_list (memory-tools.ts:790-799).
      // Explicit 100k cap (ADR-0255 Decision #7); buffered all-at-once.
      const all = await routeMemoryOp({ type: 'list', namespace, limit: 100000, offset: 0 });
      const rawEntries = (all.entries as Array<Record<string, unknown>>) || [];
      const entries = rawEntries.map((e) => ({
        key: e.key,
        namespace: e.namespace,
        value: typeof e.content === 'string' ? e.content : null,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        accessCount: e.accessCount,
        hasEmbedding: e.hasEmbedding,
        size: e.size,
      }));
      const payload = {
        schema: 'ruflo-memory-export/v1' as const,
        exportedAt: new Date().toISOString(),
        namespace: namespace ?? null,
        count: entries.length,
        entries,
      };
      const serialized = JSON.stringify(payload, null, 2);
      try {
        writeFileSync(outputPath, serialized, 'utf-8');
      } catch (e) {
        return { error: `Could not write ${outputPath}: ${e instanceof Error ? e.message : String(e)}` };
      }
      const vectorsWithEmb = entries.filter((e) => e.hasEmbedding === true).length;
      return {
        outputPath,
        format: 'json',
        exported: {
          entries: entries.length,
          vectors: vectorsWithEmb,
          patterns: 0,
        },
        fileSize: `${Buffer.byteLength(serialized)}B`,
      };
    },
  },
];
