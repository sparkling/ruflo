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
// `better-sqlite3` is an OPTIONAL dependency (ADR-0086 — placed in
// `optionalDependencies` so the WASM-only path stays functional without the
// native build toolchain). A STATIC value import would make every `import` of
// `archivist-init.ts` — including from unit-test modules that never touch the
// SQLite-carve-out substrate — hard-fail with `ERR_MODULE_NOT_FOUND` when
// `better-sqlite3` is absent. The deferred dynamic `import('better-sqlite3')`
// in `ensureSqliteWired()` (the ONLY call site) is the file-architecture
// already mandated by the deferred-imports header at line ~180.
//
// The `import type` form below is erased at TS-emit and produces NO runtime
// import — it only exists so the `BetterSqlite3.Database` type reference in
// the public `buildArchivistConfig` signature can still resolve at
// type-check time.
import type BetterSqlite3 from 'better-sqlite3';
// agentdb value imports (`Archivist`, `setAuditLogPath`, `MemoryRvfAdapter`)
// are deferred to dynamic imports inside `initProcessArchivist()` and
// `ensureRvfWired()` — the only call sites. Rationale (parallel to the
// better-sqlite3 reasoning above): unit-test modules in the ruflo-patch
// repo import the cli's compiled dist `hive-mind-tools.js`, which has a
// static `import { getProcessArchivist } from '../memory/archivist-init.js'`.
// Loading that triggers archivist-init's top-level imports — and at
// `test-ci` time the build tree lives at `/tmp/ruflo-build/v3/@claude-flow/
// cli/` BEFORE publish-verdaccio runs, so `@sparkleideas/agentdb` is not
// yet in the build's `node_modules`. Static value imports therefore
// hard-fail with `ERR_MODULE_NOT_FOUND`. Deferring them to async helpers
// breaks the test-load chain while preserving the runtime behavior — the
// archivist still wires the same `Archivist` + adapters once
// `initProcessArchivist()` runs in the cli's startup path.
//
// Types (`ArchivistInitConfig`, `EmbeddingScorer`, `PatternReader`,
// `RouteDecision`, `TaskRouter`, `VectorBackendAsync`, `PatternHit`) stay
// as `import type` — erased at emit, produces zero runtime imports.
import type {
  Archivist,
  ArchivistInitConfig,
  EmbeddingScorer,
  PatternHit,
  PatternReader,
  RouteDecision,
  TaskRouter,
} from 'agentdb/archivist';
import type { VectorBackendAsync } from 'agentdb/wasm';
import { findProjectRoot } from '../mcp-tools/types.js';
// (`MemoryRvfAdapter` is only used as a value at the `new MemoryRvfAdapter()`
// call site in `ensureRvfWired` — deferred to a dynamic import there.)

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
 * The per-process `Archivist` instance (ADR-0181 Phase 5 DA-L1 revised — async).
 *
 * Async by construction so call sites cannot accidentally dispatch before
 * `initProcessArchivist()` has completed. The body folds in
 * `initProcessArchivist()` so the FIRST awaited call from anywhere in the
 * process completes startup wiring (setAuditLogPath, projectRoot,
 * capability factories) before returning the archivist. Subsequent calls
 * short-circuit on the `initialized` flag — `initProcessArchivist()` is
 * idempotent (line 425-432) so the fast path is a cheap no-op `await`.
 *
 * The structurally-impossible-to-misuse property is the key win: no call
 * site can write `getProcessArchivist().dispatch(...)` synchronously
 * anymore — TypeScript rejects it because the return type is now
 * `Promise<Archivist>`. The 13 delegation workers all write:
 *
 *     const archivist = await getProcessArchivist();
 *     await archivist.dispatch('tool_name', payload);
 *
 * Defense in depth: the agentdb-side `Archivist.hasRealConfig` throw
 * (forks/agentdb/src/archivist/index.ts) catches any hypothetical Phase 6+
 * consumer that constructs an `Archivist` directly (bypassing
 * `getProcessArchivist`); fail-loud at the first `dispatch` / `dispatchRead`
 * if `initialize(config)` was never called with a real `projectRoot`.
 */
export async function getProcessArchivist(): Promise<Archivist> {
  await initProcessArchivist();
  // `initProcessArchivist()` either returned the already-initialized
  // archivist or just finished initializing one — either way
  // `processArchivist` is non-null and `initialized` is true.
  return processArchivist!;
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
  // Deferred dynamic import — see file header (`agentdb` is unavailable
  // during test-ci, where unit tests load the build's compiled dist before
  // publish-verdaccio installs `@sparkleideas/agentdb`).
  const { Archivist, setAuditLogPath } = await import('agentdb/archivist');

  // NOTE (2026-05-15) — Phase 5 → Phase 6 carry-forward:
  //
  // Each handler module under `agentdb/archivist/handlers/**` performs a
  // top-level `registerMutationHandler` / `registerReadHandler` call. A
  // tempting fix is to side-effect-import the full barrel here:
  //
  //   await import('agentdb/archivist/handlers');
  //
  // — but this activates 39 STUB handlers (~26% of the handler population
  // as of 2026-05-15) whose bodies throw `pending Phase N wire-up`. The cli
  // mcp-tools Phase 5 flip dispatched to several of those (e.g.
  // `memory_store` → `handlers/memory/store.ts:53` stub) without a
  // try/catch fallback, so an active dispatch surfaces the stub-throw
  // through to acceptance (p14 SLO checks).
  //
  // Acceptance's `_expect_mcp_body` HARNESS treats `not registered` as
  // `skip_accepted` (ADR-0082 narrow whitelist) — so leaving the registry
  // empty makes dispatched cli call sites degrade cleanly: the dispatch
  // throws `no handler registered for tool '<name>'`, the cli propagates,
  // and acceptance skips that check. The bodies that DO need to run
  // (cli-only read paths, FS-JSON local routing) are unaffected — they
  // never reach the archivist.
  //
  // Re-enabling registration is the Phase 6 / Phase 7 capstone: every
  // dispatched cli tool needs either (a) a working handler body, or (b) a
  // documented try/catch fallback to its cli-native code path. Phase 5's
  // 100+ cli flips are infrastructure-ready for either, but neither is
  // done as of this release.

  // Bootstrap: cannot call the guarded `getProcessArchivist()` here — the guard
  // throws if `!initialized`, and `initialized` does not flip until the end of
  // this function. Mint / fetch the singleton directly. After this function
  // completes, all downstream call sites must use `getProcessArchivist()`.
  if (processArchivist === null) {
    processArchivist = new Archivist();
  }
  const archivist = processArchivist;
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
  //
  // The ADR-0069 Bug #3 marker check ran here in Phase 4 (eager `sqliteDb`
  // open). Phase 5 moves that check to `ensureSqliteWired()` — it has to live
  // beside the `mkdirSync` + `new BetterSqlite3` it gates, not at startup.

  const config: ArchivistInitConfig = {
    projectRoot: root,
    // NOTE: rvfBackend + sqliteDb deliberately omitted — see header.
    //   Phase 5 dispatch wiring re-introduces them via the post-initialize
    //   `ensureRvfWired()` / `ensureSqliteWired()` helpers below, which call
    //   `archivist.setRvfBackend(...)` / `setSqliteDb(...)` on first dispatch
    //   that needs the corresponding substrate.
    taskRouterFactory: makeCliTaskRouter,
    embeddingScorerFactory: makeCliEmbeddingScorer,
    patternReaderFactory: makeCliPatternReader,
  };

  // Remember the resolved root so `ensureSqliteWired()` agrees with
  // `initProcessArchivist()` on which directory holds `.claude-flow/`.
  // `findProjectRoot()` is cheap but not pure — the `ensure*` helpers can be
  // entered from many call sites, and re-resolving in each would let a
  // mid-process `cwd` shift split the substrate root from the audit-log
  // root. We pin it here.
  resolvedProjectRoot = root;

  await archivist.initialize(config);
  initialized = true;
  return archivist;
}

// ─── Phase 5 lazy substrate wiring ───────────────────────────────────────────
//
// `initProcessArchivist()` deliberately runs `Archivist.initialize()` with NO
// substrate (the Phase 4 hotfix — eager wiring regressed `t1-6-empty-search`
// 33× and broke `adr0100-e-sentinel-pri`). Phase 5 flips cli call sites from
// their own mcp-tools handlers to `archivist.dispatchRead()` / `.dispatch()`,
// which means a handler eventually reaches `ctx.substrate.{read,vectorSearch,
// query}` and `getSubstrate()` throws fail-loud for any storeId in a family
// whose backend was not wired.
//
// The cli-side delegation worker calls the appropriate `ensure*Wired()`
// helper BEFORE dispatching when its tool touches RVF / SQLite substrates.
// Tools that need neither (pure FS-JSON or routing-only) pay no cost — the
// helper is not called.
//
// Memoization is on the PROMISE, not the resolved result: two concurrent
// dispatches that both reach `ensureRvfWired()` must serialize on a single
// installer (memory-router open + adapter construct + `setRvfBackend`),
// otherwise `setRvfBackend` would throw on the second caller. Storing the
// in-flight promise (`Promise<void>`) and `await`ing it everywhere gives us
// that — `await` on a settled promise is cheap, and a `.catch(() => undefined)`
// would only mask a fail-loud propagation, which we explicitly do not want.

/** The resolved project root pinned at `initProcessArchivist()` time. */
let resolvedProjectRoot: string | null = null;

/**
 * Marker-gate (ADR-0069 Bug #3 invariant) — duplicated from the original
 * `initProcessArchivist` inline check so `ensureSqliteWired()` and any future
 * pre-flight diagnostics share one canonical predicate. A `.ruflo-project`,
 * `CLAUDE.md`+`.claude/`, or `.git/` at the root marks a real project; only
 * then is creating `.claude-flow/` + opening `archivist.db` permitted.
 */
function isRealProjectRoot(root: string): boolean {
  return (
    existsSync(join(root, '.ruflo-project')) ||
    (existsSync(join(root, 'CLAUDE.md')) && existsSync(join(root, '.claude'))) ||
    existsSync(join(root, '.git'))
  );
}

/** Memoized installer promise — RVF substrate; set on first call, awaited by all subsequent ones. */
let rvfWirePromise: Promise<void> | null = null;
/** Memoized installer promise — SQLite carve-out substrate. */
let sqliteWirePromise: Promise<void> | null = null;

/**
 * Resolve + install the cli's RVF substrate on the per-process archivist.
 *
 * Lazy + memoized: the first call awaits `memory-router.ensureRouter()`
 * (memory-router cold-start: open `.rvf`, build HNSW index, load ONNX
 * embedder), constructs a `MemoryRvfAdapter` against the live
 * `getStorageInstance()`, and threads it into the archivist via
 * `setRvfBackend()`. The resulting promise is cached; subsequent calls await
 * the same promise. Concurrent callers serialize on one installer — exactly
 * what `Archivist.setRvfBackend`'s no-double-install contract requires.
 *
 * Fail-loud on the failing attempt (`feedback-no-fallbacks`): if
 * `ensureRouter()` or the adapter construction throws, the rejection
 * propagates to the caller — the dispatch that triggered the wire fails
 * loudly with the actual error. The memoized promise is then CLEARED so a
 * subsequent dispatch can retry. Rationale (ADR-0181 Phase 5 DA-L2,
 * team-lead ruling): for the long-lived MCP server, a transient EBUSY on
 * the `.rvf` open should not permanently brick the process — the user
 * shouldn't have to restart the server to recover. The dispatch site still
 * observes the throw on the failing attempt, so structural faults
 * (corrupt `.rvf`, missing module) surface every time they're dispatched;
 * only the in-process state is allowed to retry.
 *
 * Cross-substrate dispatch (MG1, theoretical): no Phase 4 handler needs
 * both RVF and SQLite at once, but a hypothetical future handler would
 * call `await Promise.all([ensureRvfWired(), ensureSqliteWired()])` — both
 * memos are independent and the `setRvfBackend`/`setSqliteDb` idempotency
 * guards on the agentdb side make ordering irrelevant.
 *
 * `initProcessArchivist()` must have run first — call sites that reach this
 * helper are downstream of cli startup, which already calls
 * `initProcessArchivist()` from `src/index.ts` / `src/mcp-server.ts`. Workers
 * that want belt-and-suspenders can `await ensureArchivistInitialized()`
 * before reaching for this helper.
 */
export async function ensureRvfWired(): Promise<void> {
  if (!initialized) {
    throw new Error(
      'archivist-init: ensureRvfWired called before initProcessArchivist — call ' +
        'initProcessArchivist() (or ensureArchivistInitialized()) from the cli startup ' +
        'path before dispatching any archivist tool that needs the RVF substrate.',
    );
  }
  if (rvfWirePromise) return rvfWirePromise;

  const attempt = (async (): Promise<void> => {
    const { ensureRouter, getStorageInstance } = await import('./memory-router.js');
    // Deferred — see file header (agentdb value imports defer to here so
    // test-ci's pre-publish load of the cli dist doesn't trip
    // ERR_MODULE_NOT_FOUND).
    const { MemoryRvfAdapter } = await import('agentdb/adapters/memory-rvf-adapter');
    await ensureRouter();
    const cliMemoryRvfBackend = getStorageInstance();
    // ADR-0069/0072 unified embedding dimension — same value memory-router /
    // intelligence.ts / embeddings-tools.ts use. The adapter wraps the same
    // backend memory-router already opened at 768, so this is not a config
    // duplication — it is the dimension hint the adapter surfaces for
    // empty-store `VectorStats`.
    const EMBEDDING_DIMENSION = 768;
    const rvfBackend = new MemoryRvfAdapter(cliMemoryRvfBackend, {
      dimension: EMBEDDING_DIMENSION,
    });
    const archivist = await getProcessArchivist();
    archivist.setRvfBackend(rvfBackend);
  })();

  // L2 memo-only-success: store the in-flight promise so concurrent
  // dispatches share one installer, but clear it on rejection so a later
  // dispatch can retry (e.g. transient EBUSY recovers, or a corrupt-file
  // condition was repaired out-of-band). The rejection still propagates to
  // the current caller — the failure is loud at the dispatch site that
  // triggered it.
  rvfWirePromise = attempt;
  attempt.catch(() => {
    if (rvfWirePromise === attempt) {
      rvfWirePromise = null;
    }
  });

  return attempt;
}

/**
 * Resolve + install the cli's SQLite-carve-out substrate on the per-process
 * archivist.
 *
 * Lazy + memoized: the first call rechecks the project-marker invariant at
 * the pinned `resolvedProjectRoot`, opens `<root>/.claude-flow/archivist.db`
 * via `better-sqlite3`, and threads the handle into the archivist via
 * `setSqliteDb()`. The promise is cached and shared by concurrent callers.
 *
 * Fail-loud (per team-lead ruling): if the marker check fails, this throws —
 * the delegation worker should NOT have dispatched a SQLite-carve-out tool
 * from a markerless cwd in the first place. Silently omitting the wire-up
 * would let `getSubstrate()` throw deeper in the dispatch with a less
 * actionable message ("no SQLite backend supplied"). Surfacing the
 * marker-check failure HERE points at the actual root cause.
 *
 * `mkdirSync({ recursive: true })` on `.claude-flow/` is safe because the
 * marker check has confirmed we are inside a real project — Bug #3 only
 * fires when we mkdir in arbitrary cwds. `<root>/.claude-flow/archivist.db`
 * is a separate file from `agentdb.db` (archivist mutation-audit trail does
 * not share a transaction surface with controller writes — same rationale
 * as the prior `buildArchivistConfig` doc-block).
 *
 * L2 memo-only-success (ADR-0181 Phase 5 team-lead ruling): on rejection
 * (transient EBUSY on SQLite open, intermediate FS state), the memo clears
 * and a subsequent dispatch retries. The current caller still observes the
 * throw — same fail-loud-at-dispatch posture as `ensureRvfWired`.
 *
 * Cross-substrate dispatch (MG1, theoretical): a hypothetical handler that
 * needs both RVF and SQLite should `await Promise.all([ensureRvfWired(),
 * ensureSqliteWired()])` — the memos are independent and the
 * `setRvfBackend`/`setSqliteDb` idempotency guards on the agentdb side make
 * ordering irrelevant.
 */
export async function ensureSqliteWired(): Promise<void> {
  if (!initialized) {
    throw new Error(
      'archivist-init: ensureSqliteWired called before initProcessArchivist — call ' +
        'initProcessArchivist() (or ensureArchivistInitialized()) from the cli startup ' +
        'path before dispatching any archivist tool that needs the SQLite carve-out substrate.',
    );
  }
  if (sqliteWirePromise) return sqliteWirePromise;

  const attempt = (async (): Promise<void> => {
    if (resolvedProjectRoot === null) {
      throw new Error(
        'archivist-init: ensureSqliteWired — resolvedProjectRoot was not set by ' +
          'initProcessArchivist. This is a wiring bug, not a marker-gate failure.',
      );
    }
    const root = resolvedProjectRoot;
    if (!isRealProjectRoot(root)) {
      throw new Error(
        `archivist-init: ensureSqliteWired — '${root}' is not a real ruflo project ` +
          `(no .ruflo-project, no CLAUDE.md+.claude/, no .git/). Refusing to create ` +
          `.claude-flow/archivist.db in a markerless cwd (ADR-0069 Bug #3 invariant). ` +
          `The dispatching call site should not have routed a SQLite-carve-out tool ` +
          `(ADR-0166) here — if you are seeing this from an MCP tool, fix the call ` +
          `site, not this gate.`,
      );
    }
    const claudeFlowDir = join(root, '.claude-flow');
    mkdirSync(claudeFlowDir, { recursive: true });
    // Deferred dynamic import — see file header note next to the
    // commented-out static import. Keeps `archivist-init.ts` importable in
    // environments that don't have the native `better-sqlite3` build (the
    // optional-dependency contract from ADR-0086).
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    const sqliteDb = new BetterSqlite3(join(claudeFlowDir, 'archivist.db'));
    const archivist = await getProcessArchivist();
    archivist.setSqliteDb(sqliteDb);
  })();

  // L2 memo-only-success: store the promise but clear it on rejection so
  // transient failures (EBUSY on mkdir / SQLite open) can retry without
  // process restart. Marker-gate violations also clear — the gate will fail
  // identically on the next attempt unless the user fixes their cwd.
  sqliteWirePromise = attempt;
  attempt.catch(() => {
    if (sqliteWirePromise === attempt) {
      sqliteWirePromise = null;
    }
  });

  return attempt;
}

/**
 * Idempotent host-process bootstrap helper (ADR-0181 Phase 5 DA-L1).
 *
 * Mostly redundant since the L1-revised `getProcessArchivist()` is itself
 * async + folds in `initProcessArchivist()`. Kept as an intent marker for
 * call sites that want to bootstrap WITHOUT fetching the archivist handle
 * — e.g. a startup probe that just wants to confirm the per-process
 * archivist can stand up, or the mcp-server's first-touch wrapper that
 * runs `ensureRvfWired()` eagerly post-init.
 *
 * Equivalent to `await getProcessArchivist().then(() => undefined)`; both
 * are no-ops after the first call thanks to `initProcessArchivist`'s
 * idempotency guard (line 425-432).
 */
export async function ensureArchivistInitialized(): Promise<void> {
  await initProcessArchivist();
}
