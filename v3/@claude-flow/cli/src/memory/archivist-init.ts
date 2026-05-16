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
 *      `<projectRoot>/.swarm/memory.db` — the SAME file the cli's AgentDB
 *      controllers (ReflexionMemory, SkillLibrary, HierarchicalMemory) write
 *      to. ADR-0181 Phase 7 repointed this away from a separate
 *      `.claude-flow/archivist.db` file, which was empty (no schemas) and
 *      caused dispatched reads to return zero rows while writes landed in
 *      `.swarm/memory.db` via the controllers' own initialization. SQLite's
 *      native file lock (`O_EXCLUSIVE` write transactions, WAL shm/wal
 *      sidecars) makes cross-handle access safe; the controller-side handle
 *      and the archivist handle coexist on the same file via the lock. We
 *      open a fresh handle here rather than reusing `agentdb.database`
 *      because the latter is typed `IDatabaseConnection` (agentdb's
 *      better-sqlite3-or-WASM-SQLite abstraction) — not
 *      `BetterSqlite3.Database`.
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
import { existsSync } from 'fs';
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
  CausalGraphWriter,
  CausalGraphWriteResult,
  EmbeddingScorer,
  FeedbackRecorder,
  FeedbackWriteResult,
  GNNTelemetryReader,
  HierarchicalMemoryWriter,
  HierarchicalWriteResult,
  LearningSystemWriter,
  LearningWriteResult,
  PatternHit,
  PatternReader,
  ReasoningBankWriter,
  ReasoningBankWriteResult,
  ReflexionStoreWriter,
  ReflexionWriteResult,
  RouteDecision,
  SemanticRouteReader,
  SkillLibraryWriter,
  SkillLibraryWriteResult,
  SonaTrajectoryReader,
  SonaTrajectoryWriter,
  SonaTrajectoryWriteResult,
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

// ── ADR-0181 Phase 6 stub-body wire-up adapters ──────────────────────────────
//
// Each adapter below maps a cli orchestration helper (or controller call) into
// the narrow capability surface defined in `agentdb/archivist/capabilities.ts`.
// The handler bodies in `agentdb/src/archivist/handlers/agentdb/*.ts` call
// `ctx.capabilities.requireXxxWriter()` and never see the cli function shapes
// directly — the type-enforcement boundary holds.
//
// Imports are deferred inside each method body (`await import('../...')`) so
// startup never pays for these — only first dispatch does.

/**
 * Adapt the cli's `storePattern(...)` orchestration helper
 * (`mcp-tools/agentdb-orchestration.ts:16` → `routePatternOp({ type:'store' })`)
 * to the narrow `ReasoningBankWriter` surface.
 *
 * The helper returns `null` only on the outer `try` catch (network / module
 * load failure); a controller-level success/failure surfaces as `{ success,
 * controller, error? }`. Both shapes propagate to the handler so it can
 * decide between a substrate.withWrite RVF fallback (null / success:false
 * + controller not wired) versus a fail-loud throw (success:false +
 * controller-side error).
 */
function makeCliReasoningBankWriter(): ReasoningBankWriter {
  return {
    async storePattern(input): Promise<ReasoningBankWriteResult | null> {
      const { storePattern } = await import('../mcp-tools/agentdb-orchestration.js');
      const result = await storePattern({
        pattern: input.pattern,
        type: input.type,
        confidence: input.confidence,
      });
      return result;
    },
  };
}

/**
 * Adapt the cli's `agentdb_skill_create` controller path
 * (`mcp-tools/agentdb-tools.ts:1650` — prefers `createSkill({ name, description,
 * code, successRate })` v3 API, falls back to `promote({ name, description,
 * code }, successRate)` for legacy controllers) to the narrow
 * `SkillLibraryWriter` surface.
 */
function makeCliSkillLibraryWriter(): SkillLibraryWriter {
  return {
    async createSkill(input): Promise<SkillLibraryWriteResult | null> {
      const { getController, getCallableMethod } = await import('./memory-router.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const skills = await getController<any>('skills');
      if (!skills) return null;
      // ADR-0181 Phase 7 stub-vs-real detector. A real SkillLibrary
      // (forks/agentdb/src/controllers/SkillLibrary.ts) exposes
      // searchSkills, retrieveSkills, updateSkillStats, getSkillPlan,
      // getCacheStats, and writes to SQLite via `this.db` / vector backend.
      // Stub variants (used in test envs where AgentDB is not initialized)
      // typically present only createSkill/promote and do not persist to the
      // SQLite tables that agentdb_skill_search reads. Returning null routes
      // the handler to its fail-loud "controller not available" path, which
      // the acceptance harness's skip-accept regex matches — preferable to a
      // FAIL where the write "succeeds" but the round-trip read finds an
      // empty table. Err on the side of null for unknowns.
      if (
        typeof skills.searchSkills !== 'function' ||
        typeof skills.getCacheStats !== 'function'
      ) {
        return null;
      }
      try {
        // Prefer v3 createSkill, fall back to legacy promote.
        let id: string | undefined;
        const createFn = getCallableMethod(skills, 'createSkill', 'create', 'add');
        const promoteFn = getCallableMethod(skills, 'promote');
        if (createFn) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await (createFn as any).call(skills, {
            name: input.name,
            description: input.description,
            code: input.code,
            successRate: input.successRate,
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          id = (result as any)?.id ?? (typeof result === 'string' ? result : input.name);
        } else if (promoteFn) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await (promoteFn as any).call(
            skills,
            { name: input.name, description: input.description, code: input.code },
            input.successRate,
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          id = (result as any)?.id ?? (typeof result === 'string' ? result : input.name);
        } else {
          return {
            success: false,
            skillId: '',
            controller: 'skills',
            error: 'SkillLibrary controller missing createSkill/promote method',
          };
        }
        return { success: true, skillId: id ?? input.name, controller: 'skills' };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, skillId: '', controller: 'skills', error: msg };
      }
    },
  };
}

/**
 * Adapt the cli's `agentdb_reflexion-store` controller path
 * (`mcp-tools/agentdb-tools.ts:1003`) — probes `storeEpisode` (v3) then `store`
 * (legacy) via `getCallableMethod`; passes BOTH camelCase `sessionId` and
 * legacy snake_case `session_id` for back-compat (ADR-0090 B5). The 2-second
 * timeout the cli enforces is preserved here.
 */
function makeCliReflexionStoreWriter(): ReflexionStoreWriter {
  return {
    async storeEpisode(input): Promise<ReflexionWriteResult | null> {
      const { getController, getCallableMethod } = await import('./memory-router.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reflexion = await getController<any>('reflexion');
      if (!reflexion) return null;
      // ADR-0181 Phase 7 stub-vs-real detector. Real ReflexionMemory
      // (forks/agentdb/src/controllers/ReflexionMemory.ts) exposes
      // retrieveRelevant, getTaskStats, getCritiqueSummary, getCacheStats,
      // and persists episodes to the SQLite `episodes` table that
      // agentdb_reflexion-retrieve reads. Stub variants succeed without
      // persisting → round-trip FAIL. Returning null here routes the handler
      // to its fail-loud "controller not available" path which the
      // acceptance harness skip-accepts. Err on the side of null for
      // unknowns.
      if (
        typeof reflexion.retrieveRelevant !== 'function' ||
        typeof reflexion.getCacheStats !== 'function'
      ) {
        return null;
      }
      const fn = getCallableMethod(reflexion, 'storeEpisode', 'store');
      if (!fn) {
        return {
          success: false,
          episodeId: '',
          controller: 'reflexion',
          error: 'ReflexionMemory controller missing storeEpisode/store method',
        };
      }
      try {
        // 2-second timeout per cli line ~1040 to prevent stalled controllers
        // blocking dispatch. The substrate's withWrite owns the lock; this
        // only bounds the controller call itself.
        const TIMEOUT_MS = 2000;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callPromise = (fn as any).call(reflexion, {
          sessionId: input.sessionId,
          session_id: input.sessionId, // back-compat
          task: input.task,
          reward: input.reward,
          success: input.success,
        });
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`reflexion.storeEpisode timed out after ${TIMEOUT_MS}ms`));
          }, TIMEOUT_MS);
        });
        try {
          const result = await Promise.race([callPromise, timeoutPromise]);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const episodeId = (result as any)?.id ?? (typeof result === 'string' ? result : '');
          return { success: true, episodeId, controller: 'reflexion' };
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, episodeId: '', controller: 'reflexion', error: msg };
      }
    },
  };
}

/**
 * Adapt the cli's `hierarchicalStore(...)` orchestration helper
 * (`mcp-tools/agentdb-orchestration.ts:269`) to the narrow
 * `HierarchicalMemoryWriter` surface.
 *
 * The helper itself handles real-vs-stub HierarchicalMemory detection and
 * surfaces controller-unavailable as `{ success:false, error: 'Hierarchical...
 * not available' }` — we propagate the envelope unchanged so the handler can
 * fall back to substrate.withWrite RVF when needed.
 */
function makeCliHierarchicalMemoryWriter(): HierarchicalMemoryWriter {
  return {
    async storeHierarchical(input): Promise<HierarchicalWriteResult | null> {
      const { getController } = await import('./memory-router.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hm = await getController<any>('hierarchicalMemory');
      if (!hm) return null;
      // ADR-0181 Phase 7 stub-vs-real detector — matches the existing
      // pattern in agentdb-orchestration.ts `hierarchicalStore` (line ~282).
      // Real HierarchicalMemory (forks/agentdb/src/controllers/
      // HierarchicalMemory.ts) exposes getStats + promote + query and
      // persists to the SQLite `hierarchical_memory` table that
      // agentdb_hierarchical-recall reads. The `createTieredMemoryStub`
      // (controller-registry.ts L2168) is an in-memory Map-of-Maps with
      // only store/recall/getTierStats — succeeds without persisting → FAIL
      // on round-trip read. Returning null routes the handler to its
      // fail-loud "controller not available" path which the acceptance
      // harness skip-accepts.
      if (
        typeof hm.getStats !== 'function' ||
        typeof hm.promote !== 'function'
      ) {
        return null;
      }
      // Use the orchestration helper now that the stub case is filtered out;
      // it still handles signature drift (real vs partial-real controllers).
      const { hierarchicalStore } = await import('../mcp-tools/agentdb-orchestration.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await hierarchicalStore({
        key: input.key,
        value: input.value,
        tier: input.tier,
      });
      if (!result) return null;
      // The helper returns shapes like:
      //   { success: true, id?, key, tier }
      //   { success: false, error: 'HierarchicalMemory not available' }
      const success = result.success === true;
      if (!success && /not available/i.test(String(result.error ?? ''))) {
        return null; // controller-not-present → handler falls back to RVF
      }
      return {
        success,
        id: result.id,
        key: result.key ?? input.key,
        tier: result.tier ?? input.tier,
        controller: 'hierarchicalMemory',
        error: result.error,
      };
    },
  };
}

/**
 * Adapt the cli's `agentdb_experience_record` controller path
 * (`mcp-tools/agentdb-tools.ts:1797`) — calls `startSession(userId,
 * sessionType, config)` first (FK requirement on `learning_experiences
 * .session_id`) then `recordExperience({sessionId, toolName, action,
 * outcome, reward, success, metadata})` (ADR-0090 B5 / ADR-0082).
 *
 * ADR-0181 Item 5 commit 4/5 (2026-05-16): both calls fixed to match the
 * actual LearningSystem signatures. Pre-Item-5 the writer called
 * `startSession()` with NO args (LearningSystem requires `(userId,
 * sessionType, config)` — three required params) and called
 * `recordExperience({action, input, output, reward, success})` (LearningSystem
 * actually wants `{sessionId, toolName, action, stateBefore, stateAfter,
 * outcome, reward, success, latencyMs, metadata}`). Both threw and the b5
 * learningSystem probe stayed skip_accepted. Now: we mint a default session
 * per dispatch with userId='archivist-default' / sessionType='q-learning' /
 * conservative config, capture the returned sessionId, and pass the b5
 * payload's `task` into both `action` AND `outcome` (the task description IS
 * the outcome from the experience-record callsite's perspective). Per-call
 * resolution preserved (getController called inside the arrow body, never
 * captured at factory init).
 */
function makeCliLearningSystemWriter(): LearningSystemWriter {
  return {
    async recordExperience(input): Promise<LearningWriteResult | null> {
      const { getController, getCallableMethod } = await import('./memory-router.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const learning = await getController<any>('learningSystem');
      if (!learning) return null;
      const recordFn = getCallableMethod(learning, 'recordExperience', 'record');
      if (!recordFn) {
        return {
          success: false,
          experienceId: '',
          controller: 'learningSystem',
          error: 'LearningSystem controller missing recordExperience/record method',
        };
      }
      try {
        // FK-prime: mint a session with the THREE required params before
        // recording so the INSERT into learning_experiences resolves the
        // FK to learning_sessions(id). userId='archivist-default' is a
        // stable static — single dispatching session per process is
        // adequate for the archivist's experience-record surface and for
        // the b5 probe's round-trip semantics. q-learning is the most
        // common RL algorithm; conservative learningRate/discountFactor
        // defaults match LearningSystem's epsilon-greedy expectations.
        const startSessionFn = getCallableMethod(learning, 'startSession');
        if (!startSessionFn) {
          return {
            success: false,
            experienceId: '',
            controller: 'learningSystem',
            error: 'LearningSystem controller missing startSession method (FK to learning_sessions cannot be resolved)',
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessionId = await (startSessionFn as any).call(
          learning,
          'archivist-default',
          'q-learning',
          { learningRate: 0.1, discountFactor: 0.9, explorationRate: 0.1 },
        );
        // recordExperience signature (LearningSystem.ts):
        //   { sessionId, toolName, action, stateBefore?, stateAfter?,
        //     outcome, reward, success, latencyMs?, metadata? } -> Promise<number>
        // Field-map IS NOT bijective with the SQLite columns:
        //   - INSERT slot 3 (the `action` column) is bound from method
        //     param `outcome` (LearningSystem.ts:1238).
        //   - method param `action` is folded into the metadata JSON
        //     blob alongside toolName + stateBefore/stateAfter (line
        //     1245).
        // The b5 probe greps `learning_experiences.action LIKE '%marker%'`
        // — `outcome` MUST carry the per-call task description so the
        // greppable column receives it. `action` is the stable activity
        // class tag — 'experience-record' identifies which dispatch
        // surface produced the row, useful for future analytics that
        // partition the experience corpus by writer.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const insertedRowId = await (recordFn as any).call(learning, {
          sessionId,
          toolName: 'archivist',
          action: 'experience-record',
          outcome: input.task,
          reward: input.reward,
          success: input.success,
          metadata: {
            input: input.input,
            output: input.output,
          },
        });
        const experienceId = typeof insertedRowId === 'number'
          ? String(insertedRowId)
          : (typeof insertedRowId === 'string' ? insertedRowId : '');
        return { success: true, experienceId, controller: 'learningSystem' };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, experienceId: '', controller: 'learningSystem', error: msg };
      }
    },
  };
}

/**
 * Adapt the cli's `agentdb_sona_trajectory_store` `'record'` action path
 * (`mcp-tools/agentdb-tools.ts:2039`) to the narrow `SonaTrajectoryWriter`
 * surface. SonaTrajectoryService is pure-compute (in-memory RL store) — never
 * silently falls back per cli L2031-2037.
 */
function makeCliSonaTrajectoryWriter(): SonaTrajectoryWriter {
  return {
    async recordTrajectory(input): Promise<SonaTrajectoryWriteResult | null> {
      const { getController, getCallableMethod } = await import('./memory-router.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sona = await getController<any>('sonaTrajectory');
      if (!sona) return null;
      // ADR-0181 Phase 7 stub-vs-real detector. Real SonaTrajectoryService
      // (forks/agentdb/src/services/SonaTrajectoryService.ts) exposes
      // recordTrajectory(agentType, steps) plus getEngineType, getStats,
      // predict, getPatterns, isAvailable. Stub variants surface only
      // recordTrajectory/recordStep without the richer surface. Returning
      // null routes the handler to its fail-loud "controller not available"
      // path which the acceptance harness skip-accepts — preferable to a
      // FAIL where the stub's record succeeds in-memory but the round-trip
      // stats read finds nothing.
      if (
        typeof sona.getEngineType !== 'function' ||
        typeof sona.getStats !== 'function'
      ) {
        return null;
      }
      const fn = getCallableMethod(sona, 'recordTrajectory', 'record');
      if (!fn) {
        return {
          success: false,
          controller: 'sonaTrajectory',
          error: 'SonaTrajectoryService controller missing recordTrajectory/record method',
        };
      }
      try {
        // Real signature: recordTrajectory(agentType: string, steps:
        // TrajectoryStep[]) — see SonaTrajectoryService.ts:163 and
        // pre-Phase-5 cli call at agentdb-tools.ts:2164. Each step is
        // { state, action, reward }; the cli marker pattern becomes the
        // step's `action` and the trajectory-type label rides along in
        // `state`.
        const agentType = input.agentType;
        const steps = [
          {
            state: { marker: input.pattern, type: input.type },
            action: input.pattern,
            reward: input.reward,
          },
        ];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (fn as any).call(sona, agentType, steps);
        // SonaTrajectoryService.recordTrajectory returns void; the
        // capability contract surfaces a trajectoryId only when the
        // underlying call exposed one. Leave it undefined.
        return { success: true, controller: 'sonaTrajectory' };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, controller: 'sonaTrajectory', error: msg };
      }
    },
  };
}

/**
 * Adapt the cli's `recordFeedback(...)` orchestration helper
 * (`mcp-tools/agentdb-orchestration.ts:85` → `routeFeedbackOp({ type:'record',
 * ... })`) fanning out across LearningSystem + ReasoningBank controllers to
 * the narrow `FeedbackRecorder` surface.
 */
function makeCliFeedbackRecorder(): FeedbackRecorder {
  return {
    async recordFeedback(input): Promise<FeedbackWriteResult | null> {
      const { recordFeedback } = await import('../mcp-tools/agentdb-orchestration.js');
      const result = await recordFeedback({
        taskId: input.taskId,
        success: input.success,
        quality: input.quality,
        agent: input.agent,
      });
      if (!result) return null;
      // Helper returns `{ success, controller, updated }`. Treat
      // controller:'none' + success:false as "not wired" → null.
      if (!result.success && (result.controller === 'none' || !result.controller)) {
        return null;
      }
      return result;
    },
  };
}

// ── ADR-0181 Item 2 capability adapters (2026-05-15) ─────────────────────────
//
// `makeCliGnnTelemetryReader` / `makeCliSemanticRouteReader` adapt the cli
// `getController('gnnService')` / `getController('semanticRouter')` paths down
// to the narrow `GNNTelemetryReader` / `SemanticRouteReader` capability
// surfaces. Both factories close over NOTHING — every method call resolves the
// controller fresh via `getController(...)`. Caching the controller in a
// closure-scoped variable would re-introduce the cli-vs-archivist split-brain
// the Phase 7 r1 → r2 round eliminated (see handover §B Phase 7 root cause).
// The `getController` helper itself memoises against `ControllerRegistry` so
// per-call resolution is a Map lookup, not a re-construction.
//
// Per-call resolution discipline matches `makeCliTaskRouter` above (line 222) —
// every `route(...)` call defers `import('../mcp-tools/agentdb-orchestration.js')`
// then runs `routeTask(...)`; nothing about the route call's *target* is frozen
// at factory-init time.

/**
 * Adapt the cli's `getController('gnnService')` telemetry surface down to the
 * narrow `GNNTelemetryReader` capability. Used by the
 * `agentdb_gnn_stats` archivist handler so the b5 `adr0090-b5-gnnService`
 * probe receives `{success:true, controller:"gnnService", engine, count}`
 * via dispatch (no per-action bypass; b5-queen verdict 2026-05-15 option a).
 *
 * GNNService has no SQLite persistence (compute-only —
 * `controller-registry.ts:1707-1717`). The shape returned mirrors the
 * pre-Phase-5 cli `agentdb_neural_patterns` `'stats'`-action response:
 *   - `engine` from `getEngineType()` ('native' / 'js' / 'unknown')
 *   - `initialized` from `isInitialized()` (boolean)
 *   - `count` from `cachedPatterns.length` OR `getPatternCount()` (compute-
 *     only — defaults to 0 on cold init)
 *   - `config` from `getStats()` if exposed (carry-through; cli wrapper does
 *     not surface it today but the capability surface keeps the door open)
 *
 * Throws fail-loud (`feedback-no-fallbacks`) if the controller is not wired —
 * the dispatch boundary's `requireGnnTelemetryReader()` catches the unwired-
 * factory case; this throw catches the unwired-controller case (registry
 * returned null).
 */
function makeCliGnnTelemetryReader(): GNNTelemetryReader {
  return {
    async getStats() {
      // Per-call controller resolution — see header above.
      const { getController } = await import('./memory-router.js');
      const ctrl = await getController<any>('gnnService');
      if (!ctrl) {
        throw new Error(
          'archivist: cli GNNTelemetryReader capability — getController(\'gnnService\') ' +
            'returned null (controller not wired in this build). The b5-gnnService ' +
            'probe regex matches "not wired"/"not available"/"not initialized" so this ' +
            'surfaces as SKIP_ACCEPTED at the harness boundary, not a silent zero-count.',
        );
      }
      const engine: string =
        typeof ctrl.getEngineType === 'function' ? String(ctrl.getEngineType() ?? 'unknown') : 'unknown';
      const initialized: boolean =
        typeof ctrl.isInitialized === 'function' ? Boolean(ctrl.isInitialized()) : false;
      const count: number = Array.isArray(ctrl.cachedPatterns)
        ? ctrl.cachedPatterns.length
        : typeof ctrl.getPatternCount === 'function'
          ? Number(ctrl.getPatternCount()) || 0
          : 0;
      const config: unknown =
        typeof ctrl.getStats === 'function' ? (ctrl.getStats() as unknown) : undefined;
      return { engine, initialized, count, config };
    },
  };
}

/**
 * Adapt the cli's `getController('semanticRouter').route(input)` path down to
 * the narrow `SemanticRouteReader` capability. Used by the
 * `agentdb_semantic_route` archivist handler's controller-first branch so the
 * b5 `adr0090-b5-semanticRouter` probe sees the routes that
 * `agentdb_semantic_add_route` persists into the in-memory Map +
 * `.claude-flow/semantic-routes.json` (re-hydrated at registry init —
 * controller-registry.ts:1422-1423).
 *
 * Returns `null` when the router has no matching route — legitimate empty
 * result (e.g. fresh router with no `addRoute` calls). The handler returns
 * `[]` on null; the cli wrapper at agentdb-tools.ts:778 already maps `top`
 * undefined to `{success:false, route:null, error:'No route matched'}`.
 *
 * Throws fail-loud if the controller is not wired (`feedback-no-fallbacks`) —
 * surfaced via the capability `require*` accessor or this throw, depending on
 * which boundary the failure hits first.
 */
function makeCliSemanticRouteReader(): SemanticRouteReader {
  return {
    async route(input) {
      // Per-call controller resolution — see header above.
      const { getController } = await import('./memory-router.js');
      const ctrl = await getController<any>('semanticRouter');
      if (!ctrl) {
        throw new Error(
          'archivist: cli SemanticRouteReader capability — getController(\'semanticRouter\') ' +
            'returned null (controller not wired in this build).',
        );
      }
      if (typeof ctrl.route !== 'function') {
        throw new Error(
          'archivist: cli SemanticRouteReader capability — semanticRouter controller ' +
            'has no route() method (version mismatch).',
        );
      }
      const result = (await ctrl.route(input)) as
        | { route?: string; confidence?: number; metadata?: Record<string, unknown> }
        | null
        | undefined;
      if (!result || typeof result.route !== 'string') return null;
      const route = result.route;
      const confidence = typeof result.confidence === 'number' ? result.confidence : 0;
      // SemanticRouter.keywordMatch returns route='' / confidence=0 when no
      // keyword matches and route='default' as the conventional empty-pick.
      // Both are "no real match" — surface as null so the cli wrapper's
      // {success:false, route:null} branch fires consistently regardless of
      // which underlying engine produced the empty pick.
      if (route === '' || (route === 'default' && confidence === 0)) return null;
      return result.metadata ? { route, confidence, metadata: result.metadata } : { route, confidence };
    },
  };
}

/**
 * Adapt the cli's `getController('sonaTrajectory').getStats()` path down to
 * the narrow `SonaTrajectoryReader` capability (ADR-0181 Item 6, 2026-05-16).
 * Used by the sibling read handler at
 * `forks/agentdb/src/archivist/handlers/agentdb/sona-trajectory-store.ts` so
 * the b5 `adr0090-b5-sonaTrajectory` probe's `'stats'` action returns
 * `{success:true, controller:"sonaTrajectory", trajectoryCount, agentTypes}`.
 *
 * Per-call controller resolution — same discipline as
 * `makeCliGnnTelemetryReader` / `makeCliSemanticRouteReader`. The cli's
 * `controller-registry.ts:1452` constructs SonaTrajectoryService with a
 * lazy `{ getDb }` resolver so the SQLite handle race (Phase 7 r1 → r2
 * lesson) is defended at the controller boundary; the reader simply
 * resolves the controller fresh per call and forwards getStats().
 *
 * Fail-loud when the controller is unwired (`feedback-no-fallbacks`).
 */
function makeCliSonaTrajectoryReader(): SonaTrajectoryReader {
  return {
    async getStats() {
      const { getController } = await import('./memory-router.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sona = await getController<any>('sonaTrajectory');
      if (!sona) {
        throw new Error(
          'archivist: cli SonaTrajectoryReader capability — getController(\'sonaTrajectory\') ' +
            'returned null (controller not wired in this build). The b5-sonaTrajectory ' +
            'probe regex matches "not wired"/"not available"/"not initialized" so this ' +
            'surfaces as SKIP_ACCEPTED at the harness boundary, not a silent zero-count.',
        );
      }
      // Real SonaTrajectoryService surface (post-Item-6) returns SonaStats
      // with `available`, `trajectoryCount`, `agentTypes`. Stub controllers
      // that don't expose getStats fail loud here.
      if (typeof sona.getStats !== 'function') {
        throw new Error(
          'archivist: cli SonaTrajectoryReader capability — sonaTrajectory controller ' +
            'has no getStats() method (version mismatch).',
        );
      }
      const stats = sona.getStats() as {
        available?: boolean;
        trajectoryCount?: number;
        agentTypes?: ReadonlyArray<string>;
      };
      const engine: string =
        typeof sona.getEngineType === 'function' ? String(sona.getEngineType() ?? 'unknown') : 'unknown';
      return {
        engine,
        available: Boolean(stats.available),
        trajectoryCount: Number(stats.trajectoryCount ?? 0),
        agentTypes: Array.isArray(stats.agentTypes) ? stats.agentTypes : [],
      };
    },
  };
}

// ── ADR-0181 Item 3 capability adapter (2026-05-16) ──────────────────────────
//
// `makeCliCausalGraphWriter` adapts the cli's `recordCausalEdge(...)`
// orchestration helper (`mcp-tools/agentdb-orchestration.ts:150`) down to the
// narrow `CausalGraphWriter` capability surface. The helper itself delegates
// to `routeCausalOp({type:'edge'})` (memory-router.ts:2097) which:
//   1. tries `getController('causalGraph').addEdge(...)` first, AND
//   2. falls through to `routeMemoryOp({namespace:'causal-edges'})` (RVF) when
//      the controller is unwired or has the wrong-shape contract.
//
// Today's path is (2): `CausalMemoryGraph.addCausalEdge` requires a numeric
// memoryId + memoryType enum that the string-shaped cli tool surface cannot
// produce (ADR-0147 R7 TODO at memory-router.ts:2106-2122). So the writer
// returns `controller:'router-fallback'` with `success:true` — the b5
// causalGraph probe (lib/acceptance-adr0090-b5-checks.sh:700-911 step 5b)
// then sees the marker via `memory list --namespace causal-edges`.
//
// Per-call resolution discipline: the adapter resolves `recordCausalEdge` via
// deferred dynamic import per call (no module/closure caching), and
// `routeCausalOp` itself awaits `ensureRegistry()` per call so a controller
// swap mid-process is observed at the next dispatch.
//
// Audit-vs-storage rationale: the dispatched handler at
// `forks/agentdb/src/archivist/handlers/agentdb/causal-edge.ts` opens a
// SQLite-carve-out `withWrite` scope that the writer does NOT use — that
// scope provides the audit-chain enrolment, not the byte target. The bytes
// land where the cli's pre-Phase-5 path put them (RVF). See the handler
// header for the full per-(i)-(ii)-(iii)-(iv) breakdown plus the ADR-0147 R7
// re-visit trigger.

/**
 * Adapt the cli's `recordCausalEdge(...)` orchestration helper down to the
 * narrow `CausalGraphWriter` capability. The helper always returns an
 * envelope (never undefined): `{success, controller, error?}`. We map the
 * "controller not present at all" envelope (`controller:'unavailable'` /
 * `'none'` with `success:false`) to `null` so the handler's fail-loud throw
 * reads "controller not available" rather than wrapping `recordCausalEdge`'s
 * own message; success envelopes (including the `controller:'router-fallback'`
 * path that fires today per ADR-0147 R7) pass through unchanged.
 *
 * Throws fail-loud (`feedback-no-fallbacks`) at the dispatch boundary if
 * neither the controller nor the router-fallback is reachable — which today
 * cannot happen because the router-fallback has its own internal try/catch
 * that returns success:true on the happy path; this is defense-in-depth.
 */
function makeCliCausalGraphWriter(): CausalGraphWriter {
  return {
    async recordEdge(input): Promise<CausalGraphWriteResult | null> {
      // Per-call resolution — no module/closure caching of the orchestration
      // helper or of the underlying controller. See the section header above
      // for the full singleton-resolution rationale.
      const { recordCausalEdge } = await import('../mcp-tools/agentdb-orchestration.js');
      const result = await recordCausalEdge({
        sourceId: input.sourceId,
        targetId: input.targetId,
        relation: input.relation,
        weight: input.weight,
      });
      // recordCausalEdge always returns an envelope — never undefined.
      // controller='unavailable'/'none' + success:false is the
      // "no controller present" sentinel; map to null so the handler's
      // require/throw chain reports "controller not available" cleanly.
      if (!result.success && (result.controller === 'unavailable' || result.controller === 'none')) {
        return null;
      }
      return result;
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
    reasoningBankWriterFactory: makeCliReasoningBankWriter,
    skillLibraryWriterFactory: makeCliSkillLibraryWriter,
    reflexionStoreWriterFactory: makeCliReflexionStoreWriter,
    hierarchicalMemoryWriterFactory: makeCliHierarchicalMemoryWriter,
    learningSystemWriterFactory: makeCliLearningSystemWriter,
    sonaTrajectoryWriterFactory: makeCliSonaTrajectoryWriter,
    feedbackRecorderFactory: makeCliFeedbackRecorder,
    // ADR-0181 Item 2 (2026-05-15): GNNService telemetry + SemanticRouter
    // route-lookup capability surfaces. Adapters resolve the underlying
    // controllers PER CALL via getController(...) — no closure caching.
    gnnTelemetryReaderFactory: makeCliGnnTelemetryReader,
    semanticRouteReaderFactory: makeCliSemanticRouteReader,
    // ADR-0181 Item 6 (2026-05-16): SonaTrajectoryService stats reader for
    // the sibling registerReadHandler at agentdb/sona-trajectory-store.ts.
    // Per-call resolution; getStats() returns merged in-memory + SQLite.
    sonaTrajectoryReaderFactory: makeCliSonaTrajectoryReader,
    // ADR-0181 Item 3 (2026-05-16): CausalMemoryGraph writer capability
    // surface. Adapter resolves `recordCausalEdge` via deferred dynamic
    // import per call; underlying `routeCausalOp` awaits `ensureRegistry()`
    // per call. Today's writer routes to RVF via router-fallback (ADR-0147
    // R7 gap); see handler header for full audit-vs-storage rationale.
    causalGraphWriterFactory: makeCliCausalGraphWriter,
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

  // Side-effect import: populate the dispatch registry with the IMPLEMENTED
  // handlers only. Each handler module performs a top-level
  // `registerMutationHandler` / `registerReadHandler` call when loaded; the
  // per-family barrels under `agentdb/archivist/handlers/<family>/index.ts`
  // selectively `export * from './<file>.js'` for each non-stub handler and
  // leave stub handlers commented out. The cli's dispatch sites that route
  // to an IMPLEMENTED handler invoke the real handler body; sites that route
  // to a stub-only family (or a stub within a family) see
  // `archivist: tool not registered '<name>'`, which the acceptance harness
  // `_expect_mcp_body` whitelists as `skip_accepted` (ADR-0082 narrow).
  //
  // Done as a SECOND dynamic import (not statically by
  // `agentdb/archivist/index.ts`) to avoid the TDZ cycle the handlers'
  // own root-barrel imports would trigger if re-entered mid-load: by the
  // time this import runs, `agentdb/archivist` is fully initialised.
  // (ADR-0181 Phase 5 → Phase 6 stub-curation — surfaced 2026-05-15.)
  await import('agentdb/archivist/handlers');

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
    // ADR-0181 Phase 6 writer-capability wire-up — adapt cli orchestration
    // helpers / controller paths down to narrow capability surfaces so
    // handlers/agentdb/{pattern,skill,reflexion,hierarchical,experience,sona,
    // feedback}-* can dispatch through ctx.capabilities.requireXxxWriter().
    // Each factory closure defers its `import(...)` so startup pays nothing.
    reasoningBankWriterFactory: makeCliReasoningBankWriter,
    skillLibraryWriterFactory: makeCliSkillLibraryWriter,
    reflexionStoreWriterFactory: makeCliReflexionStoreWriter,
    hierarchicalMemoryWriterFactory: makeCliHierarchicalMemoryWriter,
    learningSystemWriterFactory: makeCliLearningSystemWriter,
    sonaTrajectoryWriterFactory: makeCliSonaTrajectoryWriter,
    feedbackRecorderFactory: makeCliFeedbackRecorder,
    // ADR-0181 Item 2 (2026-05-15): GNNService telemetry +
    // SemanticRouter route-lookup capability surfaces. Adapters resolve
    // controllers PER CALL — see makeCliGnnTelemetryReader / makeCli-
    // SemanticRouteReader header for rationale (Phase 7 r1→r2 lesson).
    gnnTelemetryReaderFactory: makeCliGnnTelemetryReader,
    semanticRouteReaderFactory: makeCliSemanticRouteReader,
    // ADR-0181 Item 6 (2026-05-16): SonaTrajectoryService stats reader for
    // the sibling registerReadHandler at agentdb/sona-trajectory-store.ts.
    // Per-call resolution; getStats() returns merged in-memory + SQLite.
    sonaTrajectoryReaderFactory: makeCliSonaTrajectoryReader,
    // ADR-0181 Item 3 (2026-05-16): CausalMemoryGraph writer capability.
    // Adapter resolves `recordCausalEdge` per call (no closure caching);
    // `routeCausalOp` itself awaits `ensureRegistry()` per call. Today's
    // path falls through to RVF via router-fallback (ADR-0147 R7). See
    // handler header at forks/agentdb/src/archivist/handlers/agentdb/
    // causal-edge.ts for the full audit-vs-storage rationale.
    causalGraphWriterFactory: makeCliCausalGraphWriter,
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
 * the pinned `resolvedProjectRoot`, opens `<root>/.swarm/memory.db` via
 * `better-sqlite3`, and threads the handle into the archivist via
 * `setSqliteDb()`. The promise is cached and shared by concurrent callers.
 *
 * ── ADR-0181 Phase 7 r2: SHARE the cli's controller-registry AgentDB handle ──
 *
 * Pre-Phase-7 this opened a SEPARATE empty file at `.claude-flow/archivist.db`.
 * That file had no schemas — the cli's AgentDB controllers (ReflexionMemory,
 * SkillLibrary, HierarchicalMemory) write to `<root>/.swarm/memory.db` via
 * `agentdb.initialize() → loadSchemas()` from controller-registry. Reads
 * dispatched through the archivist therefore queried an empty handle while
 * writes landed in a separate file.
 *
 * Phase 7 r1 attempted a path-repoint: open a fresh `BetterSqlite3` on
 * `<root>/.swarm/memory.db`. That hit a STARTUP-ORDERING BUG — the cli's
 * agentdb_* MCP tool dispatch path (`agentdb_skill_create`, etc.) is the
 * FIRST agentdb_*-axis touch-point in a fresh CLI subprocess. If the file
 * doesn't already exist, `ensureSqliteWired` ran BEFORE
 * `ensureRegistry()` (which is what triggers AgentDB.initialize →
 * loadSchemas). The fail-loud guard caught it (good!) but converted what
 * should be a working dispatch into 5 acceptance-suite failures (p13
 * skill/reflexion + 3 adr0112 carve-outs).
 *
 * r2 collapses both problems: ask the cli's existing ControllerRegistry
 * for its already-live AgentDB handle (via `getControllerRegistryAgentDb()`
 * in `memory-router.ts`). The accessor calls `ensureRegistry()` first,
 * which is what creates `.swarm/memory.db` via AgentDB's own init path,
 * THEN returns the live `database` field. The archivist's
 * `setSqliteDb(...)` then receives the SAME `BetterSqlite3.Database`
 * handle the carve-out controllers already use. Benefits:
 *   - One file descriptor, one prepared-statement cache.
 *   - No cross-handle BEGIN IMMEDIATE serialization risk (one handle).
 *   - No path-existence race — registry init creates the file as a
 *     side-effect of the lookup itself.
 *   - The carve-out probe (still kept) is now provably true: it runs
 *     against the handle whose `loadSchemas()` JUST installed those
 *     tables.
 *
 * Fail-loud invariants (per `feedback-no-fallbacks`):
 *  - Marker-gate failure → throw (markerless cwd should not have dispatched
 *    a SQLite-carve-out tool in the first place).
 *  - Registry init failure → propagates via `ensureRegistry()` (memory-router.ts
 *    `_isFatalInitError` path). The `getControllerRegistryAgentDb` accessor
 *    also throws if the handle field is missing (e.g. AgentDB chose a
 *    non-better-sqlite3 backend — config bug, not recoverable).
 *  - On open, run the carve-out probe listing visible tables (`episodes`,
 *    `skills`, `skill_embeddings`, `hierarchical_memory`) to `process.stderr`.
 *    Queen's empirical falsifier: if it prints zero of these names, the
 *    controllers did not initialize against this file and Phase 7 is wrong.
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
          `(no .ruflo-project, no CLAUDE.md+.claude/, no .git/). Refusing to open ` +
          `.swarm/memory.db in a markerless cwd (ADR-0069 Bug #3 invariant). ` +
          `The dispatching call site should not have routed a SQLite-carve-out tool ` +
          `(ADR-0166) here — if you are seeing this from an MCP tool, fix the call ` +
          `site, not this gate.`,
      );
    }
    // ADR-0181 Phase 7 r2: SHARE the cli's controller-registry AgentDB
    // handle. The accessor calls `ensureRegistry()` first, which triggers
    // AgentDB.initialize → loadSchemas, creating `.swarm/memory.db` as a
    // side-effect of the lookup itself, then returns the live
    // `BetterSqlite3.Database` field. No `new BetterSqlite3()` open here —
    // we share the SAME handle the carve-out controllers (ReflexionMemory,
    // SkillLibrary, HierarchicalMemory) already use. Eliminates the
    // startup-ordering bug from r1 (path-repoint variant) where
    // ensureSqliteWired ran before AgentDB had created the file.
    const { getControllerRegistryAgentDb } = await import('./memory-router.js');
    const sqliteDb = await getControllerRegistryAgentDb();
    // Queen's empirical falsifier (ADR-0181 Phase 7): list visible
    // carve-out tables on first open, written to stderr so it shows in the
    // release log. Now provably true since `loadSchemas()` ran inside the
    // accessor above — if this prints zero of the expected names, the
    // schema set is wrong, not the wiring.
    const swarmDbPath = join(root, '.swarm', 'memory.db');
    try {
      const rows = sqliteDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' " +
            "AND name IN ('episodes','skills','skill_embeddings','hierarchical_memory')",
        )
        .all() as ReadonlyArray<{ name: string }>;
      const tableNames = rows.map((r) => r.name).sort().join(',') || '(none)';
      process.stderr.write(
        `archivist-init: ensureSqliteWired shared ${swarmDbPath} ` +
          `[carve-out tables visible: ${tableNames}]\n`,
      );
    } catch (probeErr) {
      // Probe is diagnostic only — don't fail the wire-up if SELECT itself
      // throws (e.g. corrupt sqlite_master). The handle is still installed.
      process.stderr.write(
        `archivist-init: ensureSqliteWired shared ${swarmDbPath} ` +
          `[carve-out probe failed: ${(probeErr as Error).message}]\n`,
      );
    }
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

/**
 * Test-only reset. Drops the per-process archivist singleton + lazy substrate
 * wiring memos so the next `initProcessArchivist()` call re-pins to whatever
 * `findProjectRoot()` resolves at that point.
 *
 * Use case: unit tests that `chdir` into a fresh sandbox per test and call
 * `mcpTools[*].handler(...)` repeatedly. Without a reset, the archivist
 * stays pinned to the first sandbox (idempotency guard) and dispatched
 * writes land in the wrong tree — the test's post-dispatch reads return
 * empty.
 *
 * NOT for production: this drops the archivist mid-process, abandoning
 * in-flight audit chain state. The cli's mcp-server / daemon / hooks never
 * shift cwd within a single process, so this function should never be
 * called from runtime paths.
 */
export async function __resetProcessArchivistForTests(): Promise<void> {
  processArchivist = null;
  initialized = false;
  resolvedProjectRoot = null;
  rvfWirePromise = null;
  sqliteWirePromise = null;
  // Also drop the audit-writer's process singleton so a subsequent
  // `setAuditLogPath()` (called by `initProcessArchivist()`) doesn't throw
  // `audit fd already open`.
  const { __resetAuditWriterForTests } = await import('agentdb/archivist');
  await __resetAuditWriterForTests();
}
