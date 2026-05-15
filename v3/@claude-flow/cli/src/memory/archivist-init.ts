/**
 * ADR-0181 Phase 1 / Phase 4 — cli-process Memory Archivist `initialize(config)` feeding.
 *
 * The Memory Archivist (ADR-0180, `agentdb/archivist`) is scaffolded but not yet
 * live on any write path. ADR-0181 Phase 1 makes each host process (cli, ruflo
 * daemon, hook-handler) construct its OWN per-process `Archivist` — not a global
 * singleton, per ADR-0181 §Architecture — and feed it an `ArchivistInitConfig`.
 *
 * This module is the cli process's wiring point. It is consumed by:
 *   - `src/index.ts` (`CLI.run()` — the one-shot command path), and
 *   - `src/mcp-server.ts` (`startStdioServer()` — the long-lived MCP server path).
 *
 * ── Phase 1 → Phase 4 progression ────────────────────────────────────────────
 *
 * Phase 1 wired `projectRoot` only — `rvfBackend` / `sqliteDb` and the three
 * capability factories were deferred because the cli's RVF handle
 * (`memory-router.ts` `_storage`, `@claude-flow/memory`'s `RvfBackend` shape)
 * did not present agentdb's `VectorBackendAsync` interface, AND a *fresh*
 * agentdb `RvfBackend` on the same `.rvf` path would double-open (two native
 * handles + two HNSW indices on one file = split-brain writes,
 * `feedback-data-loss-zero-tolerance`). Phase 4's adapter-and-widening
 * combination resolves both — see item 1 below.
 *
 * Phase 4 closes those gaps:
 *
 *   1. **`rvfBackend`** — the W1 `MemoryRvfAdapter` (lives in agentdb at
 *      `agentdb/src/adapters/memory-rvf-adapter.ts`, imported here via the
 *      `agentdb/adapters/memory-rvf-adapter` subpath export) wraps
 *      memory-router's `_storage` (the `@claude-flow/memory`-shaped
 *      `RvfBackend`) and presents agentdb's `VectorBackendAsync` surface. The
 *      adapter typing is duck-typed (`IMemoryRvfBackend`) — no `as unknown as`
 *      cast-lie at the boundary, and no `@claude-flow/memory` package
 *      dependency in the adapter module. The adapter holds the SAME native
 *      handle the cli already uses, so no double-open; split-brain is avoided
 *      by construction. Sync `insert`/`search`/etc. throw fail-loud
 *      (memory-router is eager-WAL async-only); `flush` / `save` / `load` are
 *      no-ops because every write is already persisted on return.
 *   2. **`sqliteDb`** — a fresh `better-sqlite3.Database` opened on
 *      `<projectRoot>/.claude-flow/archivist.db` (a SEPARATE file from
 *      agentdb.db). SQLite's native file lock (`O_EXCLUSIVE` write transactions,
 *      WAL shm/wal sidecars) makes cross-process AND cross-handle access safe;
 *      the daemon's own Phase 1 handle (worker-daemon.ts) and the cli handle
 *      coexist on the same file via the lock. We open a fresh handle here
 *      rather than reusing `agentdb.database` because the latter is typed
 *      `IDatabaseConnection` (agentdb's better-sqlite3-or-WASM-SQLite
 *      abstraction) — not `BetterSqlite3.Database`.
 *   3. **`taskRouterFactory`** — adapts the cli's `routeTask(...)`
 *      (`mcp-tools/agentdb-orchestration.ts:227` — SemanticRouter `.route()` →
 *      LearningSystem `recommendAlgorithm` fallback) down to the narrow
 *      `TaskRouter` surface (`capabilities.ts`). Closes `handlers/agentdb/route.ts`
 *      `TODO(F4-2-config) #1`.
 *   4. **`embeddingScorerFactory`** — adapts the cli's `generateEmbedding(...)`
 *      (re-exported from `mcp-tools/embeddings-tools.ts:117` via
 *      `memory-router.ts:2335`) down to the narrow `EmbeddingScorer` surface
 *      (`embed` + `cosineSimilarity`). Closes `route.ts` `#2`,
 *      `reflexion-retrieve.ts`, and `skill-search.ts`'s `TODO(F4-2-config)`.
 *   5. **`patternReaderFactory`** — adapts the cli's `searchPatterns(...)`
 *      (`mcp-tools/agentdb-orchestration.ts:49` — `routePatternOp` →
 *      ReasoningBank BM25+semantic+RRF fusion) down to the narrow read-only
 *      `PatternReader` surface. Closes `handlers/agentdb/pattern-search.ts`
 *      `TODO(F4-2-config)`.
 *
 * ── On the `memory_search_index` Phase 3 indirection ──────────────────────────
 *
 * Phase 3 stood up the 4 `memory_*` read handlers (`handlers/memory/{search,
 * retrieve,list,search-unified}.ts`) against a placeholder FS-JSON store
 * `memory_search_index` that nothing populates — each handler returns an empty
 * result for every dispatched read. The handler-side comments (e.g.
 * `handlers/memory/search.ts` line 12-14) explicitly call out Phase 4 as the
 * point where the cli→agentdb RVF adapter collapses this two-store shape back
 * to a single `ctx.substrate.vectorSearch` against the proper `memory_store`
 * RVF storeId.
 *
 * ADR-0181 lines 155 + 166 explicitly list "Delete `memory_search_index`
 * FS-JSON storeId + the indirection (Phase 3 carry-forward collapse)" as
 * Phase 4 scope item #5. With `rvfBackend` now wired here (item 1 above),
 * this wiring change removes the substrate gap that forced the placeholder.
 *
 * BUT — the per-handler rewrite (flipping `STORE_ID = 'memory_search_index'`
 * → `'memory_store'` in the 4 `handlers/memory/*.ts` files, plus deleting
 * the placeholder `MemorySearchStore` interfaces) is **Phase 5
 * carry-forward** per team-lead ruling (DA-acknowledged). The reason it
 * cannot collapse in Phase 4: the archivist's substrate seam currently
 * exposes only `vectorSearch` against RVF — it does NOT expose key-based
 * lookup or `list` operations against the RVF substrate. A coherent
 * collapse needs either substrate-seam expansion (`getByKey` / `list`) OR
 * per-handler routing decisions at the cli call-site-delegation boundary,
 * both of which are Phase 5 work. The 5 memory_* handlers stay on
 * `memory_search_index` in Phase 4; no behavior change from Phase 3. W2's
 * `rvfBackend` wiring removes the substrate gap that *will* enable the
 * collapse once the seam-expansion / call-site-delegation lands — Phase 4
 * scope item #5 is therefore "enable, do not ship the collapse itself".
 *
 * ── Eager-vs-lazy resolution ──────────────────────────────────────────────────
 *
 * The three capability wirings use the lazy factory form (`*Factory: () => T`)
 * so the cli process pays for them only on first dispatch through the
 * corresponding handler. The two substrate slots are resolved as follows:
 *
 *   - `rvfBackend` — always wired. The adapter constructor itself is sync,
 *     but the underlying memory-router needs `ensureRouter()` to open the
 *     `.rvf` file + build the HNSW index. We await that once on startup,
 *     then synchronously construct the adapter against `getStorageInstance()`.
 *     This avoids any race between archivist `initialize()` and
 *     memory-router's lazy open.
 *   - `sqliteDb` — conditionally wired, gated on a project-marker check at
 *     the resolved `projectRoot`. When `findProjectRoot()` falls back to
 *     cwd (no `.ruflo-project` / `CLAUDE.md`+`.claude/` / `.git/` marker),
 *     we skip the `mkdirSync(.claude-flow/)` + `new BetterSqlite3(...)`
 *     entirely and omit `sqliteDb` from the config. This preserves the
 *     ADR-0069 Bug #3 invariant (no `.claude-flow/` creation in arbitrary
 *     cwds). Handlers that dispatch through SQLite-carve-out stores in a
 *     markerless cwd fail loud at `requireSqliteSubstrate()` — the correct
 *     ADR-0181 §Decision-Drivers failure mode.
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import BetterSqlite3 from 'better-sqlite3';
import {
  Archivist,
  setAuditLogPath,
  type ArchivistInitConfig,
  type EmbeddingScorer,
  type PatternHit,
  type PatternReader,
  type RouteDecision,
  type TaskRouter,
} from 'agentdb/archivist';
// `VectorBackendAsync` is the contract `ArchivistInitConfig.rvfBackend`
// (agentdb archivist/index.ts:195) is typed against. The interface lives at
// `agentdb/src/backends/VectorBackend.ts` but only `agentdb/wasm` re-exports
// it (`agentdb/backends` barrel re-exports the *base* `VectorBackend`, not
// the async variant). Importing from `agentdb/wasm` here is a minor naming
// awkwardness; the alternative — typing `buildArchivistConfig` against the
// concrete `MemoryRvfAdapter` class — over-constrains the parameter for no
// gain. Keep the interface contract at the boundary.
import type { VectorBackendAsync } from 'agentdb/wasm';
import { findProjectRoot } from '../mcp-tools/types.js';
// W1 adapter (ADR-0181 Phase 4): structurally types the cli's
// `@claude-flow/memory` `RvfBackend` as `IMemoryRvfBackend` and presents
// agentdb's `VectorBackendAsync` surface. No package dependency on
// `@claude-flow/memory` — duck-typing keeps the fork boundary clean.
// Sync `insert`/`search`/etc. throw fail-loud (the cli's memory-router is
// eager-WAL async-only); `flush` / `save` / `load` are no-ops.
//
// The adapter lives in `agentdb/src/adapters/memory-rvf-adapter.ts`
// (co-located with `agentdb/backends/rvf/*` so the `VectorBackendAsync`
// contract owner stays in the same package). It reaches us via the
// `./adapters/memory-rvf-adapter` subpath in agentdb's `exports` map.
// `ArchivistInitConfig.rvfBackend` is typed against the `VectorBackendAsync`
// interface (not the concrete `RvfBackend` class), so this adapter assigns
// without any cast.
import { MemoryRvfAdapter } from 'agentdb/adapters/memory-rvf-adapter';

/**
 * The one per-process `Archivist`. ADR-0181 §Architecture mandates a per-process
 * instance, NOT a global singleton — but "per-process" is exactly what a
 * module-level binding in this process's module graph is. `src/index.ts` and
 * `src/mcp-server.ts` are two entry points into the *same* cli process, so they
 * share this one instance; a separate daemon / hook process imports its own
 * module instance and gets its own `Archivist` (see `worker-daemon.ts` /
 * `hooks-daemon.js`).
 */
let processArchivist: Archivist | null = null;

/** Set once `initProcessArchivist()` has run `initialize()` to completion. */
let initialized = false;

// ── Capability adapters (Phase 4) ────────────────────────────────────────────
//
// Each cli-side controller is wrapped here in a TINY adapter that presents the
// narrow `agentdb/archivist` capability surface — handlers never see the cli
// function shapes, only `TaskRouter` / `EmbeddingScorer` / `PatternReader`
// (`capabilities.ts`). The cli `routeTask(...)` / `generateEmbedding(...)` /
// `searchPatterns(...)` paths already encode the project's preferred semantics
// (ADR-0069 unified embedding, ADR-0166 axis separation, B7 BanditLearner) —
// these adapters do not re-implement them, they re-shape.
//
// Imports are deferred (`await import('../...')`) so the cli archivist startup
// path does not eager-load the entire memory-router / mcp-tools surface — a
// handler dispatch is what pulls them in.

/**
 * Adapt the cli's `routeTask({ task, context })` path
 * (`mcp-tools/agentdb-orchestration.ts:227` — SemanticRouter `.route()` →
 * LearningSystem `recommendAlgorithm` fallback + B7 BanditLearner arm
 * statistics) to the narrow `TaskRouter` capability.
 *
 * `TaskRouter.route(...)` MUST return a `RouteDecision`; cli `routeTask`
 * returns `null` when neither SemanticRouter nor LearningSystem is wired —
 * surface that as a throw, not as a silent default, per `feedback-no-fallbacks`.
 */
function makeCliTaskRouter(): TaskRouter {
  return {
    async route(input): Promise<RouteDecision> {
      const { routeTask } = await import('../mcp-tools/agentdb-orchestration.js');
      const decision = await routeTask({
        task: input.task,
        context: input.context,
      });
      if (!decision) {
        throw new Error(
          'archivist: cli TaskRouter capability — routeTask() returned null ' +
            '(SemanticRouter and LearningSystem both unavailable in this process). ' +
            'Wire one of the two controllers via memory-router before dispatching agentdb_route.',
        );
      }
      // RouteDecision has `readonly agents: ReadonlyArray<string>`; cli
      // routeTask returns `agents: string[]`. The array is already a fresh
      // allocation per call, so pass it through as readonly without copying.
      return {
        route: decision.route,
        confidence: decision.confidence,
        agents: decision.agents,
        controller: decision.controller,
      };
    },
  };
}

/**
 * Adapt the cli's `generateEmbedding(text)` path
 * (`memory-router.ts:2335` re-export from `mcp-tools/embeddings-tools.ts:117`,
 * which itself dispatches to the unified ADR-0069 mpnet pipeline) to the
 * narrow `EmbeddingScorer` capability.
 *
 * `cosineSimilarity` is implemented locally — exactly one well-tested
 * implementation per the `capabilities.ts` rationale, rather than three
 * handler-local copies. Throws on length mismatch (no silent 0,
 * `feedback-no-fallbacks` — a 0 there would mask a dimension bug).
 */
function makeCliEmbeddingScorer(): EmbeddingScorer {
  return {
    async embed(text: string): Promise<Float32Array> {
      const { generateEmbedding } = await import('./memory-router.js');
      const result = await generateEmbedding(text);
      // generateEmbedding returns { embedding: number[], dimensions, model }
      // (per memory-router.ts:2335 → adapter.generateEmbedding). Convert
      // number[] → Float32Array; do not store the intermediate array.
      const arr = (result as { embedding: number[] }).embedding;
      if (!Array.isArray(arr)) {
        throw new Error(
          'archivist: cli EmbeddingScorer capability — generateEmbedding(text) ' +
            'returned a shape without an `embedding: number[]` field.',
        );
      }
      return Float32Array.from(arr);
    },
    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      if (a.length !== b.length) {
        throw new Error(
          `archivist: cli EmbeddingScorer.cosineSimilarity — length mismatch ` +
            `(${a.length} vs ${b.length}); refusing to silently return 0.`,
        );
      }
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        dot += x * y;
        normA += x * x;
        normB += y * y;
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      if (denom === 0) {
        // One of the vectors is the zero vector — cosine similarity is
        // mathematically undefined. Returning 0 (orthogonal) is the
        // conventional choice; we surface it explicitly rather than silently.
        return 0;
      }
      return dot / denom;
    },
  };
}

/**
 * Adapt the cli's `searchPatterns({ query, topK, minConfidence })` path
 * (`mcp-tools/agentdb-orchestration.ts:49` — `routePatternOp` → ReasoningBank
 * BM25+semantic+RRF fusion over the `reasoning_patterns` SQLite table) to the
 * narrow read-only `PatternReader` capability.
 *
 * The cli returns `{ results, controller, error? }`; the narrow surface
 * returns `ReadonlyArray<PatternHit>`. A populated `error` means the upstream
 * ReasoningBank route failed — surface as a throw rather than silently
 * returning an empty array (`feedback-no-fallbacks`); an empty `results` with
 * no error is a legitimate "no patterns matched" and passes through.
 */
function makeCliPatternReader(): PatternReader {
  return {
    async searchPatterns(query): Promise<ReadonlyArray<PatternHit>> {
      const { searchPatterns } = await import('../mcp-tools/agentdb-orchestration.js');
      const result = await searchPatterns({
        query: query.query,
        topK: query.topK,
        minConfidence: query.minConfidence,
      });
      if (result.error) {
        throw new Error(
          `archivist: cli PatternReader capability — searchPatterns failed ` +
            `(controller=${result.controller}): ${result.error}`,
        );
      }
      // result.results is `Array<{ id, content, score }>` — already
      // structurally compatible with `PatternHit`. Cast for readonly + freeze.
      return result.results.map((r) => ({ id: r.id, content: r.content, score: r.score }));
    },
  };
}

/**
 * Build the cli process's `ArchivistInitConfig`. Phase 4 wires `projectRoot`
 * plus four substrate/capability slots; `rvfBackend` is supplied separately by
 * the caller (the `MemoryRvfAdapter` is async to construct, so
 * `initProcessArchivist()` pre-resolves it and threads the instance in here).
 *
 * `projectRoot` is resolved via `findProjectRoot()` (the canonical resolver —
 * `.ruflo-project` / `CLAUDE.md`+`.claude/` / `.git` walk, never throws, falls
 * back to cwd with a logged warning) so the cli, daemon, and hook-handler all
 * agree on the same root.
 *
 * `sqliteDb` is conditionally opened on `<projectRoot>/.claude-flow/archivist.db`
 * (a separate file from `agentdb.db` so the archivist's mutation audit trail
 * does not share a transaction surface with the cli's controller writes). The
 * open is gated on a project-marker check in `initProcessArchivist()` — when
 * `findProjectRoot()` falls back to cwd, the caller passes `sqliteDb: null`
 * and this function omits the slot from the config. See the module header's
 * "Eager-vs-lazy resolution" section for the full Bug-#3 rationale.
 *
 * The three capability factories (`taskRouter`, `embeddingScorer`,
 * `patternReader`) use the lazy form so an idle archivist does not
 * force-construct an embedding pipeline or open the router. The adapter
 * closures defer the cli-side `import(...)` until first dispatch.
 */
export function buildArchivistConfig(
  projectRoot: string,
  rvfBackend: VectorBackendAsync,
  sqliteDb: BetterSqlite3.Database | null,
): ArchivistInitConfig {
  // `sqliteDb` is nullable: when `initProcessArchivist()` detects that
  // `findProjectRoot()` fell back to cwd (no `.ruflo-project` / `CLAUDE.md`
  // + `.claude/` / `.git/` marker), the archivist DB is NOT opened — we
  // pass `null` and omit the slot via conditional spread so the archivist
  // holds no SQLite substrate. Any handler dispatched through a
  // SQLite-carve-out store will fail loud at `requireSqliteSubstrate()`
  // (agentdb archivist index.ts:374-378), which is the correct
  // ADR-0181 §Decision-Drivers failure mode for "running in a non-project
  // cwd".
  //
  // Retained for the V1 test in forks/agentdb/test/archivist/init-config-
  // feeding.test.ts which constructs eager backends in-test to verify init
  // accepts them. Production cli (`initProcessArchivist`) uses the lazy
  // factory variant below — see `buildArchivistConfigLazy`.
  return {
    projectRoot,
    rvfBackend,
    ...(sqliteDb !== null ? { sqliteDb } : {}),
    taskRouterFactory: makeCliTaskRouter,
    embeddingScorerFactory: makeCliEmbeddingScorer,
    patternReaderFactory: makeCliPatternReader,
  };
}


/**
 * The per-process `Archivist` instance. Constructs it lazily on first call;
 * does NOT call `initialize()` — that is `initProcessArchivist()`'s job. Phase 5
 * call-site delegation reaches the archivist through this accessor.
 */
export function getProcessArchivist(): Archivist {
  if (processArchivist === null) {
    processArchivist = new Archivist();
  }
  return processArchivist;
}

/**
 * EAGER, AWAITED archivist init for the cli process. Call this on the startup
 * path BEFORE any surface that could `dispatch()` goes live (the MCP stdin
 * listener; a command's `action`).
 *
 * Why eager + awaited + before-listen: `Archivist.dispatch()` / `dispatchRead()`
 * each begin with `await this.initialize()` — with NO arguments, i.e.
 * `config = {}` — and `initialize()` is idempotent (first call wins
 * permanently). If a dispatch ran before this function, the empty-config init
 * would win and our real `projectRoot` config would be silently dropped for the
 * whole process. Running this eagerly, awaited, before the first dispatchable
 * surface, makes our config win the race deterministically.
 *
 * Fail-loud (`feedback-no-fallbacks`): there is no `try/catch` here and callers
 * MUST NOT wrap this in one that swallows. A projectRoot that cannot be resolved
 * or an `initialize()` that throws must abort cli startup, not degrade silently.
 *
 * Idempotent: safe to call from both `src/index.ts` and `src/mcp-server.ts` in
 * the same process — the second call is a no-op. `setAuditLogPath()` is only
 * invoked on the first call (it throws if called after the audit fd is open).
 */
export async function initProcessArchivist(projectRoot?: string): Promise<Archivist> {
  const archivist = getProcessArchivist();
  if (initialized) return archivist;

  const root = projectRoot ?? findProjectRoot();
  const claudeFlowDir = join(root, '.claude-flow');

  // Point the audit writer at the SAME resolved root the archivist's FS-JSON
  // stores use. audit-writer's default is `process.cwd()`-relative; if we leave
  // it there while the archivist runs under `findProjectRoot()`, the FS-JSON
  // stores and the audit log land under different roots and the multi-process
  // audit chain (ADR-0180 §15) fragments. Must run before `initialize()` /
  // before any dispatch — `setAuditLogPath()` throws once the audit fd is open.
  setAuditLogPath(join(claudeFlowDir, 'data', 'archivist-audit.jsonl'));

  // ── Defer ALL heavy substrate construction (ADR-0181 Phase 4 hotfix) ──
  //
  // Earlier-revision posture eagerly awaited `ensureRouter()` (memory-router
  // cold-start = HNSW index build + ONNX model load, ~12-18s) and opened a
  // `better-sqlite3` handle inline. Two release-acceptance regressions:
  //
  //   - `t1-6-empty-search` ballooned from ~575ms to ~18s — `memory search`
  //     blocked on the eager `ensureRouter()` before its own action ran.
  //   - `adr0100-e-sentinel-pri` failed — `ensureRouter()` runs memory-
  //     router's OWN `_findProjectRoot()` (memory-router.ts L260) which
  //     walks up to the nearest `.claude-flow/`, bypassing an inner
  //     `.ruflo-project` sentinel, and wrote `memory.rvf`/`memory.rvf.lock`
  //     to the OUTER `.swarm/`. The inner sentinel should win; memory-
  //     router doesn't honor it.
  //
  // The archivist's `rvfBackendFactory` / `sqliteDbFactory` are NOT lazy in
  // the "first-dispatch" sense — agentdb `archivist/index.ts:320` invokes
  // them eagerly inside `initialize()`. So a lazy factory that builds on
  // first call merely shifts the cost from `initProcessArchivist()` to
  // `archivist.initialize()` — the same caller, no relief.
  //
  // The honest fix for Phase 4: **omit `rvfBackend`/`sqliteDb` from the cli's
  // config**. Phase 4's W3/W5 reads + route mutation register against the
  // archivist (for type checking + future Phase 5 dispatch), but the cli
  // currently dispatches the 8 agentdb_* + 5 memory_* reads through its OWN
  // mcp-tools handlers, NOT through `archivist.dispatchRead()`. Until Phase
  // 5 flips that, the archivist never invokes its substrates — so wiring
  // them up is pure latency cost. Keep the adapter, handlers, and
  // factory shapes on disk for Phase 5 to pick up; just don't feed them in
  // Phase 4. `Archivist.initialize()` still completes (it's idempotent and
  // accepts a `projectRoot`-only config — Phase 1 Amendment).
  //
  // ── ADR-0069 Bug #3 invariant ──
  //
  // Without `sqliteDb` in the config, no `.claude-flow/` is created in
  // markerless cwds at all (the eager mkdir is gone). Marker-gating is
  // preserved for Phase 5 when `sqliteDb` re-enters the config: the
  // helper below will recheck the marker at that point.
  //
  // ── Capability factories ──
  //
  // The 3 capability factories (taskRouter / embeddingScorer / patternReader)
  // stay wired. They're invoked once in `initialize()` and the cli adapters
  // ARE synchronous-construction safe — they return narrow capability
  // objects whose method bodies defer the heavy `await import(...)` until
  // first method-call. So they don't block startup.
  const isRealProjectRoot =
    existsSync(join(root, '.ruflo-project')) ||
    (existsSync(join(root, 'CLAUDE.md')) && existsSync(join(root, '.claude'))) ||
    existsSync(join(root, '.git'));
  void isRealProjectRoot; // preserved for Phase 5 sqliteDb re-wiring

  const config: ArchivistInitConfig = {
    projectRoot: root,
    // NOTE: rvfBackend + sqliteDb deliberately omitted — see header.
    //   Phase 5 dispatch wiring re-introduces them once cli call sites flip
    //   from their own mcp-tools handlers to `archivist.dispatchRead()`.
    taskRouterFactory: makeCliTaskRouter,
    embeddingScorerFactory: makeCliEmbeddingScorer,
    patternReaderFactory: makeCliPatternReader,
  };

  await archivist.initialize(config);
  initialized = true;
  return archivist;
}
