/**
 * ADR-0181 Phase 1 — cli-process Memory Archivist `initialize(config)` feeding.
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
 * ── What this config carries, and what it deliberately does not ──────────────
 *
 * Phase 1's `ArchivistInitConfig` for the cli process is `{ projectRoot }`.
 * `projectRoot` is a real `ArchivistInitConfig` field — it resolves the FS-JSON
 * store family's on-disk paths and is threaded onto every `MutationContext` /
 * `ReadContext` — so this is a genuine config, not an empty `{}`.
 *
 * It does NOT pass `rvfBackend` / `sqliteDb` (nor their factory forms). This is
 * a deliberate, verified decision, NOT an oversight:
 *
 *   - `ArchivistInitConfig.rvfBackend` is typed against the *concrete class*
 *     `agentdb/src/backends/rvf/RvfBackend` (`implements VectorBackendAsync`).
 *     The cli process's RVF handle is `memory-router.ts`'s `_storage`, which is
 *     `@claude-flow/memory`'s `RvfBackend` — a *different class in a different
 *     package* (`implements IMemoryBackend`). TypeScript types a class with
 *     `private` members nominally: the two are not assignable, and no agentdb
 *     `RvfBackend` instance exists anywhere in the cli process to borrow
 *     (`createBackend('auto')` returns `RuVectorBackend` / `SelfLearningRvfBackend`
 *     / `SqlJsRvfBackend`, never the bare `RvfBackend`). Passing `_storage` would
 *     require an `as unknown as` cast — a cast-lie that throws at the first
 *     `handle.rvf.searchAsync()` call (`feedback-no-fallbacks`).
 *   - `ArchivistInitConfig.sqliteDb` wants a `better-sqlite3` `Database`. The
 *     cli's only SQLite handle is `agentdb.database`, typed `IDatabaseConnection`
 *     (agentdb's better-sqlite3-OR-sql.js abstraction) — again not that type.
 *   - Constructing a *fresh* agentdb `RvfBackend` for the same `.rvf` path the
 *     memory-router already owns would be a double-open: two native handles +
 *     two HNSW indices on one file = split-brain writes
 *     (`feedback-data-loss-zero-tolerance`).
 *
 * TODO(F4-3-callsite): wiring a real `rvfBackend` / `sqliteDb` (and the
 * `taskRouter` / `embeddingScorer` / `patternReader` capability factories) for
 * the cli process needs a typed adapter from `@claude-flow/memory`'s
 * `IMemoryBackend`-shaped `RvfBackend` to agentdb's `VectorBackendAsync`-shaped
 * `RvfBackend` — net-new code whose method semantics do not map 1:1
 * (`IMemoryBackend` is key/value + vector; `VectorBackendAsync` is pure-vector
 * `insert` / `searchAsync` / `ingestBatch`). That adapter is ADR-0181 Phase 4/5
 * work (where the `TODO(F4-3-callsite)` markers in `archivist/index.ts` L195 /
 * L216 already live), not Phase 1. Phase 1 wires `projectRoot` honestly and
 * leaves the substrate-backend holders for the phase that can fill them without
 * a cast-lie or a double-open.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { Archivist, setAuditLogPath, type ArchivistInitConfig } from 'agentdb/archivist';
import { findProjectRoot } from '../mcp-tools/types.js';

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

/**
 * Build the cli process's `ArchivistInitConfig`. Phase 1: `projectRoot` only —
 * see the module header for why `rvfBackend` / `sqliteDb` are deliberately
 * absent. `projectRoot` is resolved via `findProjectRoot()` (the canonical
 * resolver — `.ruflo-project` / `CLAUDE.md`+`.claude/` / `.git` walk, never
 * throws, falls back to cwd with a logged warning) so the cli, daemon, and
 * hook-handler all agree on the same root.
 */
export function buildArchivistConfig(projectRoot?: string): ArchivistInitConfig {
  const root = projectRoot ?? findProjectRoot();
  return { projectRoot: root };
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

  const config = buildArchivistConfig(projectRoot);
  const root = config.projectRoot as string;

  // Ensure the audit-log directory exists. `audit-writer.ts` self-mkdirs on its
  // first write, but establishing it here means the dir is present even in a
  // process that never dispatches (Phase 1: no handler dispatches yet), and it
  // satisfies the ADR-0181 Phase 1 exit-gate expectation that `.claude-flow/data/`
  // exists for `archivist-audit.jsonl`.
  mkdirSync(join(root, '.claude-flow', 'data'), { recursive: true });

  // Point the audit writer at the SAME resolved root the archivist's FS-JSON
  // stores use. audit-writer's default is `process.cwd()`-relative; if we leave
  // it there while the archivist runs under `findProjectRoot()`, the FS-JSON
  // stores and the audit log land under different roots and the multi-process
  // audit chain (ADR-0180 §15) fragments. Must run before `initialize()` /
  // before any dispatch — `setAuditLogPath()` throws once the audit fd is open.
  setAuditLogPath(join(root, '.claude-flow', 'data', 'archivist-audit.jsonl'));

  await archivist.initialize(config);
  initialized = true;
  return archivist;
}
