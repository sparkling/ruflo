/**
 * Swarm MCP Tools for CLI
 *
 * Tool definitions for swarm coordination with file-based state persistence.
 * Replaces previous stub implementations with real state tracking.
 *
 * ── ADR-0181 Phase 5 F4-3 cli delegation ─────────────────────────────────────
 *
 * `swarm_init` and `swarm_shutdown` flip to `archivist.dispatch(...)` so every
 * swarm coordination mutation flows through the ADR-0180 audit chain. The
 * archivist handlers (`agentdb/src/archivist/handlers/swarm/{init,shutdown}.ts`)
 * own the substrate write — they reach the SAME `.swarm/swarm-state.json` file
 * via the substrate-registry's sibling-rooted FS-JSON store (Phase 2 Option A;
 * substrate-registry.ts:247-248). The handlers register as `Promise<void>`, so
 * the cli MCP tool re-reads the persisted store after dispatch to derive the
 * legacy structured response envelope (queen ruling 2026-05-15: dispatch then
 * read-shape for server-minted IDs — `before/after diff` for swarm_init's
 * internally-minted `swarmId`).
 *
 * `swarm_status` and `swarm_health` are NOT in `ToolPayloadMap` (the archivist
 * has no read handler counterpart) and stay cli-authoritative — they continue
 * to read `.swarm/swarm-state.json` directly via `loadSwarmStore()`. Note
 * `loadSwarmStore` retains its reconciliation-persist side effect via
 * `saveSwarmStore` (a pre-existing reap-on-read pattern) — the audit-chain
 * hygiene rule (ONE dispatch per mutation) covers the swarm_init / swarm_shutdown
 * call sites; the on-read orphan reconciliation is intentionally not under the
 * audit chain (it's a bookkeeping side effect of read, not a user-intent
 * mutation — same posture as the cli's pre-Phase-5 behavior). The `O_EXCL`
 * sentinel lock helper (`withSwarmStoreLock`) was removed alongside the flips:
 * the substrate-registry routes archivist swarm_* writes through `makeFsJsonSubstrate`,
 * whose own O_EXCL sentinel subsumes the legacy lock, and the cli no longer
 * holds a direct mutation path through this file.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, findProjectRoot } from './types.js';
import { getProcessArchivist } from '../memory/archivist-init.js';
import type { ToolPayloadMap } from 'agentdb/archivist';

// Sub-types from the typed dispatch surface. ADR-0181 Phase 5 chose to re-
// export only `ToolPayloadMap` / `ToolName` from `agentdb/archivist`
// (archivist/index.ts:137); the per-tool payload interfaces and their literal
// unions (`SwarmTopology`, `SwarmStrategy`) are intentionally NOT public. The
// indexed access types below let the cli call site narrow `topology` /
// `strategy` strings to the handler's literal-union shape without naming the
// underlying interface — which keeps the typed dispatch overload as the SINGLE
// import surface, per the ToolPayloadMap rationale at dispatch-types.ts:4-25.
type SwarmInitDispatchPayload = ToolPayloadMap['swarm_init'];
type SwarmTopology = NonNullable<SwarmInitDispatchPayload['topology']>;
type SwarmStrategy = NonNullable<SwarmInitDispatchPayload['strategy']>;

// Swarm state persistence
// ADR-0069 A4: standardized on .swarm (was .claude-flow/swarm)
const SWARM_DIR = '.swarm';
const SWARM_STATE_FILE = 'swarm-state.json';

interface SwarmState {
  swarmId: string;
  topology: string;
  maxAgents: number;
  status: 'initializing' | 'running' | 'paused' | 'shutting_down' | 'terminated';
  agents: string[];
  tasks: string[];
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /**
   * #1799 — process that initialized this swarm. Used by reconciliation
   * on `loadSwarmStore()` to detect orphan entries whose host process has
   * already exited (common on Windows where backgrounded daemons don't
   * always survive shell exit). Optional for backward compat with
   * pre-#1799 stores.
   */
  pid?: number;
  /** Reason set when status was forced to 'terminated' by reconciliation. */
  terminationReason?: string;
}

interface SwarmStore {
  swarms: Record<string, SwarmState>;
  version: string;
}

function getSwarmDir(): string {
  // ADR-0100: findProjectRoot walks up to the project root marker, NOT process.cwd().
  // Claude Code CWD drift was landing .swarm/ inside subdirectories (see ADR-0100).
  return join(findProjectRoot(), SWARM_DIR);
}

function getSwarmStatePath(): string {
  return join(getSwarmDir(), SWARM_STATE_FILE);
}

function ensureSwarmDir(): void {
  const dir = getSwarmDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * #1799 — return true when `pid` belongs to a live process. process.kill(pid, 0)
 * with signal 0 is the documented liveness probe: ESRCH ⇒ dead, EPERM ⇒ alive
 * but owned by another user (still alive — don't reap), success ⇒ alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * #1799 — Walk swarms with status='running' and mark orphans as 'terminated':
 *
 *   - PID-based: if `pid` is set and the process is dead, the swarm is an
 *     orphan (host crashed / shell exited / daemon backgrounded poorly).
 *   - TTL fallback: pre-#1799 entries have no `pid`; reap them when their
 *     `updatedAt` is older than 24h. This is conservative — long-idle but
 *     legitimately running swarms can recover by writing a heartbeat.
 *
 * Mutates `store` in place; returns the count for the caller to decide
 * whether to persist.
 */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
function reconcileOrphanSwarms(store: SwarmStore): number {
  let reconciled = 0;
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  for (const swarm of Object.values(store.swarms)) {
    if (swarm.status !== 'running') continue;
    let orphanReason: string | null = null;
    if (typeof swarm.pid === 'number') {
      if (!isPidAlive(swarm.pid)) {
        orphanReason = `host process ${swarm.pid} exited`;
      }
    } else {
      const ageMs = nowMs - new Date(swarm.updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs > ORPHAN_TTL_MS) {
        orphanReason = `no pid recorded and heartbeat is ${Math.round(ageMs / 3600000)}h stale`;
      }
    }
    if (orphanReason) {
      swarm.status = 'terminated';
      swarm.terminationReason = orphanReason;
      swarm.updatedAt = nowIso;
      reconciled++;
    }
  }
  return reconciled;
}

// #2085 — exported so `agent-tools.ts agent_spawn` can push into
// `swarm.agents` (the field `swarm_status` reads).
export function loadSwarmStore(): SwarmStore {
  let store: SwarmStore = { swarms: {}, version: '3.0.0' };
  try {
    const path = getSwarmStatePath();
    if (existsSync(path)) {
      store = JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch { /* fall through with default */ }

  // #1799 — reconcile orphans on every load and persist if anything changed.
  // Cheap (process.kill(pid, 0) is sub-millisecond) and means
  // `swarm_status`/`swarm_health` never see ghost "running" entries.
  const reconciled = reconcileOrphanSwarms(store);
  if (reconciled > 0) {
    try { saveSwarmStore(store); } catch { /* best-effort */ }
  }
  return store;
}

export function saveSwarmStore(store: SwarmStore): void {
  // ADR-0098: atomic write (temp + rename) — prevents partial writes under the lock
  // #2085: exported so agent-tools.ts can write to the same on-disk store
  ensureSwarmDir();
  const path = getSwarmStatePath();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, path);
}

// Input validation — mirrors handler's allow-list (handlers/swarm/init.ts:66-74).
// The cli boundary uses this for fast-fail before dispatching so the existing
// `{success: false, error}` envelope is preserved on invalid input AND so the
// `string`-to-literal-union cast at the dispatch call site is honest (the
// handler's `SwarmTopology` / `SwarmStrategy` are closed unions — passing an
// unvalidated `string` through `as` would be a cast-lie).
//
// ADR-0181 Phase 5: `withSwarmStoreLock` was removed alongside the swarm_init /
// swarm_shutdown call-site flips — the archivist substrate-registry routes
// these writes through `makeFsJsonSubstrate`, whose O_EXCL sentinel subsumes
// the legacy lock. `SWARM_REUSE_TTL_MS` moved with the dedupe logic into
// `handlers/swarm/init.ts:77`. Local read paths (`swarm_status`, `swarm_health`)
// read through `loadSwarmStore()` directly — no lock-coordination is required
// because reads tolerate the atomic-rename snapshot semantics.
const VALID_TOPOLOGIES: ReadonlySet<string> = new Set<string>([
  'hierarchical', 'mesh', 'hierarchical-mesh', 'ring', 'star', 'hybrid', 'adaptive',
]);
function isValidTopology(s: string): s is SwarmTopology {
  return VALID_TOPOLOGIES.has(s);
}
// Strategy allow-list — mirrors the handler's `SwarmStrategy` closed union
// (handlers/swarm/init.ts:45). Pre-Phase-5 cli did NOT validate strategy
// (input.strategy was passed through as `string` and stored verbatim in
// config.strategy). Phase 5 cli boundary validation is honest about the
// dispatch payload's literal-union shape — unknown strategies fast-fail with
// the same `{success: false, error}` envelope rather than silently widening
// into config and breaking dedupe equality (init.ts:147 compares strategy
// strictly).
const VALID_STRATEGIES: ReadonlySet<string> = new Set<string>([
  'specialized', 'balanced', 'adaptive',
]);
function isValidStrategy(s: string): s is SwarmStrategy {
  return VALID_STRATEGIES.has(s);
}

export const swarmTools: MCPTool[] = [
  {
    name: 'swarm_init',
    description: 'Initialize a swarm with persistent state tracking. ADR-0098: reuses an existing running swarm with matching {topology, maxAgents, strategy} within 7-day TTL unless force=true.',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        topology: { type: 'string', description: 'Swarm topology type (hierarchical, mesh, hierarchical-mesh, ring, star, hybrid, adaptive)' },
        maxAgents: { type: 'number', description: 'Maximum number of agents (1-50)' },
        strategy: { type: 'string', description: 'Agent strategy (specialized, balanced, adaptive)' },
        config: { type: 'object', description: 'Additional swarm configuration' },
        force: { type: 'boolean', description: 'Force create a new swarm even if a matching running one exists within TTL (default: false)' },
        reason: { type: 'string', description: 'Optional rationale when force=true — advisory, logged for audit' },
      },
    },
    handler: async (input) => {
      const topology = (input.topology as string) || 'hierarchical-mesh';
      const maxAgents = Math.min(Math.max((input.maxAgents as number) || 15, 1), 50);
      const strategy = (input.strategy as string) || 'specialized';
      const config = (input.config || {}) as Record<string, unknown>;
      const force = input.force === true;
      const reason = input.reason as string | undefined;

      // Cli-side fast-fail on invalid topology / strategy so the existing MCP
      // `{success: false, error}` envelope is preserved without paying for a
      // dispatch round-trip. The archivist handler ALSO validates topology
      // (init.ts:97-102) — that throw is the audit-chain backstop for non-cli
      // callers; this check is the cli boundary's user-facing error shape.
      // Strategy validation is new at this boundary (handler doesn't validate
      // strategy strings) — see VALID_STRATEGIES rationale at its declaration.
      if (!isValidTopology(topology)) {
        return {
          success: false,
          error: `Invalid topology: ${topology}. Valid: ${[...VALID_TOPOLOGIES].join(', ')}`,
        };
      }
      if (!isValidStrategy(strategy)) {
        return {
          success: false,
          error: `Invalid strategy: ${strategy}. Valid: ${[...VALID_STRATEGIES].join(', ')}`,
        };
      }

      if (force && !reason) {
        // Advisory warning — ADR-0098 Flaw 4 mitigation: force=true without
        // reason is a drift smell. Emitted at the cli boundary so MCP-tool
        // callers see it on stderr; the archivist handler also emits this
        // warning for non-cli dispatch paths.
        process.stderr.write(
          '[WARN] swarm_init called with force=true but no reason — ' +
          'prefer passing reason="..." to document why a fresh swarm is required\n',
        );
      }

      // ADR-0181 Phase 5 F4-3: dispatch through archivist (audit chain + guards
      // + invariants), then re-read `.swarm/swarm-state.json` to derive the
      // legacy MCP response envelope. The handler MINTS swarmId internally
      // (handlers/swarm/init.ts:165) so the cli does a before/after diff to
      // identify which entry was created or reused (queen ruling 2026-05-15).
      //
      // Snapshot pre-dispatch state. `loadSwarmStore()` performs reconciliation
      // and persists it eagerly; the snapshot captures the post-reconcile +
      // pre-mutation state, which is the correct baseline for the diff. The
      // archivist handler runs its own reconciliation under withWrite — that
      // re-reconciles an already-reconciled store (idempotent) and is the
      // expected double-pass for the migration period.
      const before = loadSwarmStore();
      const beforeIds = new Set(Object.keys(before.swarms));
      const beforeUpdatedAt: Record<string, string> = {};
      for (const [id, s] of Object.entries(before.swarms)) {
        beforeUpdatedAt[id] = s.updatedAt;
      }

      // No cast at the call site — `isValidTopology` / `isValidStrategy` above
      // are type predicates that narrow `topology` / `strategy` to the
      // handler's literal-union shape (`SwarmTopology` / `SwarmStrategy`).
      // TypeScript's flow analysis carries the narrowing into this dispatch
      // payload (no `as` lie, no double-validation).
      await (await getProcessArchivist()).dispatch('swarm_init', {
        topology,
        maxAgents,
        strategy,
        config,
        force,
        ...(reason !== undefined ? { reason } : {}),
      });

      // Re-read the persisted store and locate the mutation's result. Two cases:
      //   1. Reuse — an existing swarmId's `updatedAt` advanced (the handler
      //      bumped it; init.ts:154). Pick the entry whose updatedAt changed.
      //   2. Mint — a swarmId appears that wasn't in `beforeIds`. Pick that.
      // Both cases are well-defined under the substrate's per-write atomic
      // rename (substrates/fs-json-store.ts) + the archivist's withWrite
      // serialization. A concurrent third party writing during dispatch is out
      // of scope for Phase 5 (no concurrent swarm-state writers in the cli's
      // own surfaces; the archivist's O_EXCL lock blocks external writers).
      const after = loadSwarmStore();
      let result: SwarmState | null = null;
      let reused = false;
      for (const [id, s] of Object.entries(after.swarms)) {
        if (!beforeIds.has(id)) {
          result = s;
          reused = false;
          break;
        }
      }
      if (result === null) {
        for (const [id, s] of Object.entries(after.swarms)) {
          if (beforeUpdatedAt[id] !== undefined && beforeUpdatedAt[id] !== s.updatedAt) {
            result = s;
            reused = true;
            break;
          }
        }
      }
      if (result === null) {
        // Fail loud — the dispatch returned without throwing, so the handler
        // must have produced an observable mutation. A null result here means
        // the substrate write didn't land or the diff logic is wrong; either
        // way it's a bug to surface, not to mask (feedback-no-fallbacks).
        throw new Error(
          'archivist: swarm_init dispatched without throwing but no swarm record was ' +
          'created or updated in .swarm/swarm-state.json. The archivist handler and the ' +
          'cli response-shaping have diverged — fix the diff, do not paper over it.',
        );
      }

      return {
        success: true,
        swarmId: result.swarmId,
        topology: result.topology,
        strategy: (result.config as { strategy?: string }).strategy ?? strategy,
        maxAgents: result.maxAgents,
        initializedAt: result.createdAt,
        config: result.config,
        persisted: true,
        reused,
      };
    },
  },
  {
    name: 'swarm_status',
    description: 'Get swarm status from persistent state',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID (omit for most recent)' },
      },
    },
    handler: async (input) => {
      const store = loadSwarmStore();
      const swarmId = input.swarmId as string;

      if (swarmId && store.swarms[swarmId]) {
        const swarm = store.swarms[swarmId];
        return {
          swarmId: swarm.swarmId,
          status: swarm.status,
          topology: swarm.topology,
          maxAgents: swarm.maxAgents,
          agentCount: swarm.agents.length,
          taskCount: swarm.tasks.length,
          config: swarm.config,
          createdAt: swarm.createdAt,
          updatedAt: swarm.updatedAt,
        };
      }

      // Return most recent swarm if no ID specified
      const swarmIds = Object.keys(store.swarms);
      if (swarmIds.length === 0) {
        return {
          status: 'no_swarm',
          message: 'No active swarms. Use swarm_init to create one.',
          totalSwarms: 0,
        };
      }

      const latest = swarmIds
        .map(id => store.swarms[id])
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];

      return {
        swarmId: latest.swarmId,
        status: latest.status,
        topology: latest.topology,
        maxAgents: latest.maxAgents,
        agentCount: latest.agents.length,
        taskCount: latest.tasks.length,
        config: latest.config,
        createdAt: latest.createdAt,
        updatedAt: latest.updatedAt,
        totalSwarms: swarmIds.length,
      };
    },
  },
  {
    name: 'swarm_shutdown',
    description: 'Shutdown a swarm and update persistent state',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID to shutdown' },
        graceful: { type: 'boolean', description: 'Graceful shutdown (default: true)' },
      },
    },
    handler: async (input) => {
      const swarmId = input.swarmId as string | undefined;
      const graceful = (input.graceful as boolean) ?? true;

      // ADR-0181 Phase 5 F4-3: dispatch through archivist. The handler's target-
      // resolution logic (handlers/swarm/shutdown.ts:85-94) mirrors the cli's
      // own (explicit swarmId else most-recently-updated running). To project
      // the legacy response envelope after a Promise<void> dispatch, the cli
      // pre-resolves the same target under the same rules, then re-reads the
      // store after dispatch and confirms the terminated state.
      //
      // The handler throws on "not found" / "already terminated" / "no running
      // swarms" — these are the SAME conditions the legacy cli surfaced as
      // `{success: false, error}`. We translate those known throws back to the
      // legacy envelope (boundary contract preservation); any other throw
      // propagates (e.g. substrate I/O failure, guard veto, invariant
      // violation).
      const beforeStore = loadSwarmStore();
      let preTarget: SwarmState | undefined;
      if (swarmId && beforeStore.swarms[swarmId]) {
        preTarget = beforeStore.swarms[swarmId];
      } else if (!swarmId) {
        const running = Object.values(beforeStore.swarms)
          .filter((s) => s.status === 'running')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        preTarget = running[0];
      }

      try {
        await (await getProcessArchivist()).dispatch('swarm_shutdown', {
          ...(swarmId !== undefined ? { swarmId } : {}),
          graceful,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Translate the handler's known business-logic throws back to the
        // legacy cli error envelope. The exact prefixes are stable (see
        // handlers/swarm/shutdown.ts:100-112). Anything else (audit-write
        // failure, guard veto, substrate I/O fault) rethrows — feedback-no-
        // fallbacks: don't paper over unexpected faults at the MCP boundary.
        if (msg.includes('archivist: swarm_shutdown — swarm not found')) {
          return { success: false, error: `Swarm ${swarmId} not found` };
        }
        if (msg.includes('archivist: swarm_shutdown — no running swarms')) {
          return { success: false, error: 'No running swarms to shutdown' };
        }
        if (msg.includes('archivist: swarm_shutdown — swarm already terminated')) {
          return {
            success: false,
            swarmId: preTarget?.swarmId,
            error: 'Swarm already terminated',
          };
        }
        throw err;
      }

      // Dispatch succeeded; re-read the store to project the response. The
      // target's identity is fixed pre-dispatch under the handler's same
      // selection rule — we look it up post-write to get the canonical
      // terminated `updatedAt` timestamp the handler stamped.
      if (!preTarget) {
        // Should be unreachable — dispatch would have thrown "no running
        // swarms" or "swarm not found" before reaching here. Fail loud rather
        // than fabricate.
        throw new Error(
          'archivist: swarm_shutdown succeeded but the cli could not resolve a target ' +
          'pre-dispatch. The handler\'s target-resolution and the cli\'s pre-resolution ' +
          'have diverged — fix the rule, do not paper over it.',
        );
      }
      const afterStore = loadSwarmStore();
      const terminated = afterStore.swarms[preTarget.swarmId];
      if (!terminated) {
        throw new Error(
          `archivist: swarm_shutdown succeeded but swarm '${preTarget.swarmId}' is no ` +
          'longer present in .swarm/swarm-state.json. The substrate write semantics or ' +
          'cli response-shaping have diverged — fix the path, do not paper over it.',
        );
      }

      return {
        success: true,
        swarmId: terminated.swarmId,
        terminated: true,
        graceful,
        agentsTerminated: terminated.agents.length,
        terminatedAt: terminated.updatedAt,
      };
    },
  },
  {
    // ADR-0244 site #9: register the `swarm_scale` handler that the
    // CLI command `swarm scale` (commands/swarm.ts ADR-0244 site #3)
    // expects to find. Previously the tool was advertised at
    // mcp.ts:503 ("Scale swarm size") but had zero handler
    // implementation in mcp-tools/. The CLI now wires through here
    // and surfaces failures honestly.
    //
    // Shape parity with swarm_status / swarm_health: NOT in the
    // archivist `ToolPayloadMap` (no audit-chain handler exists);
    // stays cli-authoritative — mutates `.swarm/swarm-state.json`
    // directly via loadSwarmStore + saveSwarmStore.
    //
    // Semantics: set the target's `maxAgents` to the requested
    // count. Actual agent spawning is the responsibility of the
    // orchestrator (CLI Task tool / hive-mind spawn); this tool
    // updates the persisted scaling intent so subsequent
    // `swarm_status` reads reflect the new target.
    name: 'swarm_scale',
    description: 'Scale a swarm to a new agent target. Updates the persisted maxAgents on the named swarm; orchestrators read the new target on next coordination cycle.',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID to scale' },
        agents: { type: 'number', description: 'Target agent count (1-50)' },
        type: { type: 'string', description: 'Optional agent type filter (advisory; orchestrators may honour)' },
      },
      required: ['swarmId', 'agents'],
    },
    handler: async (input) => {
      const swarmId = input.swarmId as string;
      const agents = input.agents as number;
      const type = input.type as string | undefined;

      if (!swarmId || typeof swarmId !== 'string') {
        return { success: false, error: 'swarmId is required (string)' };
      }
      if (!Number.isFinite(agents) || agents < 1 || agents > 50) {
        return { success: false, error: `agents must be a number in [1, 50]; got ${String(agents)}` };
      }

      const store = loadSwarmStore();
      const target = store.swarms[swarmId];
      if (!target) {
        return { success: false, error: `Swarm ${swarmId} not found` };
      }
      if (target.status !== 'running') {
        return { success: false, error: `Swarm ${swarmId} is not running (status: ${target.status})` };
      }

      const previousMaxAgents = target.maxAgents;
      target.maxAgents = agents;
      target.updatedAt = new Date().toISOString();
      // Record advisory scaling intent in config so orchestrators can
      // honour the requested type filter on next coordination cycle.
      if (type !== undefined) {
        const cfg = target.config as Record<string, unknown>;
        cfg.scaleTypeFilter = type;
      }

      try {
        saveSwarmStore(store);
      } catch (err) {
        return {
          success: false,
          error: `Failed to persist swarm state: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return {
        success: true,
        swarmId,
        previousMaxAgents,
        maxAgents: agents,
        ...(type !== undefined ? { typeFilter: type } : {}),
        updatedAt: target.updatedAt,
      };
    },
  },
  {
    name: 'swarm_health',
    description: 'Check swarm health status with real state inspection',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID to check' },
      },
    },
    handler: async (input) => {
      const store = loadSwarmStore();
      const swarmId = input.swarmId as string;

      // Find the swarm
      let target: SwarmState | undefined;
      if (swarmId) {
        target = store.swarms[swarmId];
        if (!target) {
          return {
            status: 'not_found',
            healthy: false,
            checks: [
              { name: 'swarm_exists', status: 'fail', message: `Swarm ${swarmId} not found` },
            ],
            checkedAt: new Date().toISOString(),
          };
        }
      } else {
        const running = Object.values(store.swarms)
          .filter(s => s.status === 'running')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        target = running[0];
      }

      if (!target) {
        return {
          status: 'no_swarm',
          healthy: false,
          checks: [
            { name: 'swarm_exists', status: 'fail', message: 'No active swarm found' },
          ],
          checkedAt: new Date().toISOString(),
        };
      }

      const isRunning = target.status === 'running';
      const stateFileExists = existsSync(getSwarmStatePath());

      const checks = [
        {
          name: 'coordinator',
          status: isRunning ? 'ok' : 'warn',
          message: isRunning ? 'Coordinator active' : `Swarm status: ${target.status}`,
        },
        {
          name: 'agents',
          status: target.agents.length > 0 ? 'ok' : 'info',
          message: `${target.agents.length} agents registered (max: ${target.maxAgents})`,
        },
        {
          name: 'persistence',
          status: stateFileExists ? 'ok' : 'warn',
          message: stateFileExists ? 'State file persisted' : 'State file missing',
        },
        {
          name: 'topology',
          status: 'ok',
          message: `Topology: ${target.topology}`,
        },
      ];

      const healthy = isRunning && stateFileExists;

      return {
        status: healthy ? 'healthy' : 'degraded',
        healthy,
        swarmId: target.swarmId,
        topology: target.topology,
        agentCount: target.agents.length,
        checks,
        checkedAt: new Date().toISOString(),
      };
    },
  },
];
