/**
 * Hive-Mind MCP Tools for CLI
 *
 * Tool definitions for collective intelligence and swarm coordination.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  unlinkSync,
  statSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, findProjectRoot } from './types.js';
import { validateWorkerType, WORKER_TYPES } from './validate-input.js';
// ADR-0121 (T3): state-based CRDT primitives for the 'crdt' strategy.
import {
  GCounter,
  ORSet,
  LWWRegister,
  emptyCRDTState,
  mergeCRDTState,
  type CRDTState,
} from './crdt-types.js';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const HIVE_DIR = 'hive-mind';
const HIVE_FILE = 'state.json';

// ── ADR-0122 (T4): typed memory entries with TTL ──────────────────────
//
// USERGUIDE block "Collective Memory Types:" advertises 8 distinct memory
// types each with documented TTL. Pre-T4 the runtime stored everything as
// a flat `state.sharedMemory[key] = rawValue` with no type or TTL. This is
// the type discriminator + TTL infrastructure; eviction is lazy-on-read AND
// a periodic sweep, both under withHiveStoreLock.
//
// Per feedback-no-fallbacks.md: a missing/unknown `type` argument throws
// rather than silently defaulting to 'system' (permanent retention) — the
// soft default would mis-route a caller who forgot `type: 'task'` (30-min
// TTL) into permanent retention.

export type MemoryType =
  | 'knowledge'
  | 'context'
  | 'task'
  | 'result'
  | 'error'
  | 'metric'
  | 'consensus'
  | 'system';

export interface MemoryEntry {
  value: unknown;
  type: MemoryType;
  ttlMs: number | null;        // null = permanent
  expiresAt: number | null;    // null = permanent; epoch ms otherwise
  createdAt: number;           // epoch ms (set on first write)
  updatedAt: number;           // epoch ms (refreshed on every write)
}

// Exported so the CLI memory subcommand can offer --type with the same
// fixed enum surfaced at the MCP boundary (no drift).
export const MEMORY_TYPES: readonly MemoryType[] = [
  'knowledge',
  'context',
  'task',
  'result',
  'error',
  'metric',
  'consensus',
  'system',
] as const;

// Per-type defaults derived from USERGUIDE "Collective Memory Types:" table.
// `null` means permanent (never expires).
export const DEFAULT_TTL_MS_BY_TYPE: Record<MemoryType, number | null> = {
  knowledge: null,
  context: 3_600_000,    // 1 hour
  task: 1_800_000,       // 30 minutes
  result: null,
  error: 86_400_000,     // 24 hours
  metric: 3_600_000,     // 1 hour
  consensus: null,
  system: null,
};

// Custom error classes for fail-loud validation per feedback-no-fallbacks.md.
export class MissingMemoryTypeError extends Error {
  constructor() {
    super(
      `hive-mind_memory.set: \`type\` is required (one of: ${MEMORY_TYPES.join(', ')})`,
    );
    this.name = 'MissingMemoryTypeError';
  }
}

export class InvalidMemoryTypeError extends Error {
  constructor(type: unknown) {
    super(
      `hive-mind_memory.set: invalid type ${JSON.stringify(type)} (one of: ${MEMORY_TYPES.join(', ')})`,
    );
    this.name = 'InvalidMemoryTypeError';
  }
}

export class InvalidTTLError extends Error {
  constructor(ttlMs: unknown) {
    super(
      `hive-mind_memory.set: ttlMs must be a finite number, got ${JSON.stringify(ttlMs)}`,
    );
    this.name = 'InvalidTTLError';
  }
}

function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v);
}

// Eviction predicate. Same predicate is used by lazy eviction (get/list)
// and the periodic sweep — no behavioural divergence.
//
// `now` defaults to Date.now(); injectable for fake-timer tests.
function isExpired(entry: MemoryEntry, now: number = Date.now()): boolean {
  return entry.expiresAt !== null && now >= entry.expiresAt;
}

// Detect the four required-presence keys of a MemoryEntry. Used by
// loadHiveState() to distinguish a typed entry from a legacy raw value
// during migration. Documented limitation per ADR-0122 §Refinement: a
// legacy user-stored object that happens to contain all four top-level
// keys would be misread as a MemoryEntry. Probability is low (legacy
// storage stores raw user value at sharedMemory[key], not in a `.value`
// sub-key) but non-zero. Tests assert the four-key shape boundary.
function isMemoryEntryShape(v: unknown): v is MemoryEntry {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    'type' in obj &&
    'ttlMs' in obj &&
    'expiresAt' in obj &&
    'createdAt' in obj
  );
}

// ADR-0124 (T6) / H6 row 32 fold-in: `queenType` persisted on the queen
// object in state.json, surfaced via hive-mind_status, captured at
// checkpoint, restored before queen re-spawn at resume. Per ADR-0125 §Review
// notes #1, this fold closes the orphan ADR-0107 Option D step 3 (state
// persistence + status surfacing) that ADR-0125 §Reconciliation declared
// out of scope. `undefined` is permitted for older hives spawned without an
// explicit queen type.
export type HiveQueenType = 'strategic' | 'tactical' | 'adaptive';

export interface HiveQueenRecord {
  agentId: string;
  electedAt: string;
  term: number;
  queenType?: HiveQueenType;
}

export interface HiveState {
  initialized: boolean;
  topology: 'mesh' | 'hierarchical' | 'ring' | 'star';
  queen?: HiveQueenRecord;
  workers: string[];
  // ADR-0131 (T12): per-worker failure metadata. Keyed by worker ID.
  // Both fields are independently nullable:
  //   - failedAt: ms-since-epoch when worker was marked absent; null while live
  //   - retryOf:  original worker's ID when this entry is a retry; null otherwise
  // Legacy state files load with this map empty; loadHiveState defaults each
  // worker's metadata to { failedAt: null, retryOf: null } on first lookup
  // via the workerMetaFor() helper.
  //
  // Per ADR-0131 §Decision Outcome: failure marking is one-way
  // (failedAt: null → number is the only legal transition; reverse throws).
  // Per ADR-0131 §Specification: retryOf is a single pointer (NOT a chain
  // depth); chain reconstruction is the consumer's job via recursive lookup.
  workerMeta?: Record<string, WorkerMeta>;
  consensus: {
    pending: ConsensusProposal[];
    history: ConsensusResult[];
  };
  // ADR-0122 (T4): typed memory entries with TTL. Legacy raw values are
  // migrated to `system`/permanent on first read (loadHiveState).
  sharedMemory: Record<string, MemoryEntry>;
  createdAt: string;
  updatedAt: string;
}

/**
 * ADR-0131 (T12) — per-worker failure metadata.
 *
 * Stored on `HiveState.workerMeta[<workerId>]`; defaulted to
 * `{ failedAt: null, retryOf: null }` on first lookup for legacy state.
 *
 * `failedAt`: epoch-ms when the queen marked this worker absent (via
 *   the §6 prompt protocol writing `worker-<id>-status: 'absent'`).
 *   `null` while the worker is live. Forward-only: once set, attempts
 *   to revert to `null` MUST throw (use a new worker ID + `retryOf`
 *   pointer to record a retry).
 *
 * `retryOf`: original worker's ID when this entry is a retry-spawn;
 *   `null` for direct-queen-spawned workers. Single pointer per ADR-0131
 *   §Decision Outcome — not a chain depth or graph.
 */
export interface WorkerMeta {
  failedAt: number | null;
  retryOf: string | null;
}

const HIVE_QUEEN_TYPES: ReadonlyArray<HiveQueenType> = ['strategic', 'tactical', 'adaptive'];

/**
 * ADR-0124 §Specification: validate a runtime-supplied queenType. Per
 * `feedback-no-fallbacks.md`, an unknown value throws rather than silently
 * defaulting. Used by `hive-mind_init` (set) and `sessions import`/`resume`
 * (restore from archive).
 */
export function isHiveQueenType(value: unknown): value is HiveQueenType {
  return typeof value === 'string' && (HIVE_QUEEN_TYPES as readonly string[]).includes(value);
}

// ADR-0120 (T2): 'gossip' added — push-style epidemic propagation with
// eventual-consistency settling. See ADR-0120 §Specification for the
// settle predicate, fanout function, and round-budget contract.
// ADR-0121 (T3): 'crdt' added — state-based CRDT (CvRDT) merge over
// G-Counter, OR-Set, LWW-Register primitives. Convergence is mathematical,
// not arithmetic — there is NO vote-count threshold (calculateRequiredVotes
// short-circuits 'crdt' before reaching the strategy switch).
// See ADR-0121 §Specification + crdt-types.ts.
type ConsensusStrategy = 'bft' | 'raft' | 'quorum' | 'weighted' | 'gossip' | 'crdt';
type QuorumPreset = 'unanimous' | 'majority' | 'supermajority';

/**
 * ADR-0120 (T2): default per-round timeout for gossip rounds (ms).
 *
 * Bounds settling latency in the presence of a slow voter that never sends.
 * Without a per-round timeout, a single non-voting worker would block
 * `currentRoundBroadcastSet` from ever covering all voters, so `gossipRound`
 * never advances and settling never fires (per §Refinement edge case
 * "Slow voter that never sends").
 *
 * Configurable per-proposal via the `roundTimeoutMs` input on the `propose`
 * action (Row 6 DEFER-TO-IMPL: gossip-only knob, defaulted here).
 */
export const GOSSIP_ROUND_TIMEOUT_MS_DEFAULT = 5000;

/**
 * Compute fanout size for gossip: `ceil(log2(N))` for N >= 2, with 0 for N=1.
 *
 * Per ADR-0120 §Specification "Fanout function". The N=1 short-circuit is
 * handled at vote-time (no peers to broadcast to) and at settle-time
 * (predicate's second clause has an `N == 1` short-circuit).
 */
export function gossipFanout(totalNodes: number): number {
  if (totalNodes <= 1) return 0;
  return Math.ceil(Math.log2(totalNodes));
}

/**
 * Deterministic-per-round target selection for gossip re-broadcast.
 *
 * Two voters seeing the same `(proposalId, gossipRound, voterSet)` MUST pick
 * the same target subset, otherwise the `O(log N)` convergence bound does
 * not hold (per ADR-0120 §Risks). The voter set is canonicalised
 * (lexicographic sort) before the seeded shuffle.
 *
 * Implementation: simple Fisher-Yates with a string-hash seed derived from
 * `(proposalId, gossipRound)`. Determinism is the contract; cryptographic
 * randomness is not required.
 */
export function selectGossipTargets(
  proposalId: string,
  gossipRound: number,
  voterSet: string[],
  excludeIds: Set<string>,
  fanoutSize: number,
): string[] {
  // Canonicalise: lexicographic sort gives same input order across nodes.
  const candidates = [...voterSet].sort().filter(v => !excludeIds.has(v));
  if (candidates.length === 0 || fanoutSize === 0) return [];

  // Seeded RNG (mulberry32-style) keyed on (proposalId, gossipRound).
  // Hash the seed string to a 32-bit int.
  const seedStr = `${proposalId}:${gossipRound}`;
  let h = 2166136261 >>> 0;  // FNV-1a basis
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619) >>> 0;
  }
  // Fisher-Yates shuffle deriving each random pick from `h`.
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    const j = h % (i + 1);
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  return shuffled.slice(0, Math.min(fanoutSize, shuffled.length));
}

/**
 * QUEEN_WEIGHT — fixed multiplier applied to the queen's vote in the
 * 'weighted' consensus strategy. Pinned to 3 by the USERGUIDE contract
 * (`Weighted (Queen 3x)` in the Hive Mind §Consensus Mechanisms block).
 *
 * Per ADR-0119 §Decision Outcome: not configurable via MCP tool input,
 * not stored on `ConsensusProposal`. If retuning is ever required, write
 * a follow-up ADR (B/C options in ADR-0119 §Considered Options).
 */
const QUEEN_WEIGHT = 3;

/**
 * Thrown when a 'weighted' consensus operation runs without a queen elected.
 * Surface loudly per ADR-0119 §Decision Outcome (Queen-absent stance: throw,
 * not permissive math) — `state.queen === undefined` during weighted indicates
 * a caller bug (init race, dangling shutdown, queen nulled by error path).
 */
export class MissingQueenForWeightedConsensusError extends Error {
  constructor(action: string) {
    super(
      `Cannot ${action} with strategy 'weighted': no queen elected (state.queen === undefined). ` +
      `Per ADR-0119, weighted consensus requires an elected queen at propose- and vote-time.`,
    );
    this.name = 'MissingQueenForWeightedConsensusError';
  }
}

// ── ADR-0131 (T12): worker-failure protocol error classes ─────────────────

/**
 * Thrown by `_consensus({action:'vote'})` when a vote arrives from a worker
 * whose `failedAt !== null` (the worker has been marked absent by the §6
 * prompt protocol). Per ADR-0131 §Decision Outcome ("Worker-rejoin-after-
 * marked-failed stance: throw, not silent admission"), re-admitting a
 * previously-marked-absent voter would invalidate the `absentVoters`
 * snapshot already written to history; consistency wins over best-effort
 * rescue. Workers re-spawned via the §6 retry-once policy carry a
 * `retryOf` pointer back to the original; they are first-class voters
 * under their NEW ID, not re-admitted under the old one.
 */
export class WorkerAlreadyFailedError extends Error {
  constructor(voterId: string, failedAt: number) {
    super(
      `Vote rejected: worker ${voterId} was marked failed at ${new Date(failedAt).toISOString()}. ` +
      `Per ADR-0131, a marked-absent worker cannot be re-admitted to the same consensus round. ` +
      `Re-spawn with a new worker ID and a retryOf pointer per the §6 retry-once policy.`,
    );
    this.name = 'WorkerAlreadyFailedError';
  }
}

/**
 * Thrown by `_consensus({action:'vote'})` when a vote arrives against a
 * proposal whose `proposalId` resolves into `state.consensus.history`
 * (terminal state, including 'failed-quorum-not-reached'). Per ADR-0131
 * §Specification invariants, votes against terminal proposals MUST throw
 * synchronously rather than silently no-op or update history.
 */
export class ProposalAlreadyFailedError extends Error {
  constructor(proposalId: string, status: string) {
    super(
      `Vote rejected: proposal ${proposalId} is in terminal state '${status}'. ` +
      `Per ADR-0131, votes against proposals already moved to history are not accepted; ` +
      `start a new proposal if a fresh round is needed.`,
    );
    this.name = 'ProposalAlreadyFailedError';
  }
}

/**
 * ADR-0131 (T12) — load-time-default helper. Returns the WorkerMeta for a
 * given worker ID, defaulting both fields to null when the entry is absent
 * (legacy state files OR direct-queen-spawned workers that have never
 * been marked failed). The returned object is the SAME reference as the
 * one in state.workerMeta — mutations through this helper are persisted
 * by the next saveHiveState.
 *
 * Per ADR-0131 §Specification "loadHiveState defaults failedAt/retryOf to
 * null on older state files".
 */
export function workerMetaFor(state: HiveState, workerId: string): WorkerMeta {
  if (!state.workerMeta) state.workerMeta = {};
  const existing = state.workerMeta[workerId];
  if (existing === undefined) {
    const fresh: WorkerMeta = { failedAt: null, retryOf: null };
    state.workerMeta[workerId] = fresh;
    return fresh;
  }
  // Defensive: if a legacy state file has a partial shape, fill the gaps.
  // Per ADR-0131 §Refinement edge case "Queen-failed during retry": partial
  // entries (id but no failedAt/retryOf populated) load with both fields
  // defaulted to null. The audit trail is lossy for that entry; documented.
  const writable = existing as Partial<WorkerMeta> & WorkerMeta;
  if (writable.failedAt === undefined) writable.failedAt = null;
  if (writable.retryOf === undefined) writable.retryOf = null;
  return writable;
}

/**
 * ADR-0131 (T12) — mark a worker failed by setting failedAt to the supplied
 * timestamp. Forward-only transition: re-marking an already-failed worker
 * is a no-op (idempotent). Per ADR-0131 §Specification invariants,
 * `failedAt: number → null` is illegal — use a new worker ID + retryOf
 * pointer to record a retry. The reverse-transition guard lives at the
 * caller layer (no API surface here exposes a `clearFailed()` action).
 */
export function markWorkerFailed(state: HiveState, workerId: string, at: number = Date.now()): void {
  const meta = workerMetaFor(state, workerId);
  if (meta.failedAt !== null) {
    // Idempotent — already marked. Per ADR-0131 §Refinement "Worker re-spawn
    // with same ID" the timestamp is preserved, not refreshed.
    return;
  }
  meta.failedAt = at;
}

/**
 * ADR-0131 (T12) — register a worker entry as a retry of `originalId`.
 * Sets the new entry's retryOf pointer; idempotent (re-registering the
 * same lineage is a no-op). Per ADR-0131 §Decision Outcome lineage stays
 * minimal (single pointer, no chains).
 */
export function registerWorkerRetry(state: HiveState, newWorkerId: string, originalId: string): void {
  const meta = workerMetaFor(state, newWorkerId);
  meta.retryOf = originalId;
}

/**
 * ADR-0131 (T12) — reconcile state.workerMeta with §6 prompt protocol
 * writes. The §6 protocol instructs the queen LLM to write
 * `worker-<id>-status: 'absent'` via _memory when a worker is detected as
 * absent. This helper scans state.sharedMemory for those marker keys
 * and propagates the absence into state.workerMeta[workerId].failedAt.
 *
 * Per ADR-0131 §Implementation plan step 5: "T12's primary failure-marking
 * path is the prompt → _memory → _consensus/_status chain; no separate
 * mark-failed action verb is added."
 *
 * Returns true if any worker was newly marked failed (caller saves state).
 */
export function reconcileFailedFromStatusKeys(state: HiveState, now: number = Date.now()): boolean {
  let mutated = false;
  for (const [key, entry] of Object.entries(state.sharedMemory)) {
    // Match the §6 marker key shape: worker-<id>-status with value 'absent'
    const m = key.match(/^worker-(.+)-status$/);
    if (!m) continue;
    if (!isMemoryEntryShape(entry)) continue;
    if (entry.value !== 'absent') continue;
    const workerId = m[1] as string;
    const meta = workerMetaFor(state, workerId);
    if (meta.failedAt === null) {
      meta.failedAt = now;
      mutated = true;
    }
  }
  return mutated;
}

export interface ConsensusProposal {
  proposalId: string;
  type: string;
  value: unknown;
  proposedBy: string;
  proposedAt: string;
  votes: Record<string, boolean>;
  // ADR-0131 (T12): status union widened with the literal
  // 'failed-quorum-not-reached' — verbatim contract per ADR-0131
  // §Specification. Set by the auto-transition in _consensus({action:'status'})
  // when `Date.now() >= timeoutAt && totalVotes < required`.
  status: 'pending' | 'approved' | 'rejected' | 'failed-quorum-not-reached';
  strategy: ConsensusStrategy;
  // ADR-0131 (T12): snapshot of state.workers IDs that didn't vote when the
  // auto-transition fired. Populated only on status='failed-quorum-not-reached'
  // proposals; frozen with the historical row.
  absentVoters?: string[];
  term?: number;              // Raft: term number
  quorumPreset?: QuorumPreset; // Quorum: threshold preset
  byzantineVoters?: string[]; // BFT: detected Byzantine voters
  timeoutAt?: string;         // Raft: timeout for re-proposal
  // ADR-0120 (T2): gossip-only fields. Snapshotted at propose-time and
  // mutated through the vote/status code path. Persisted in `state.json`
  // and survive process restarts (re-seeded on next vote per §Architecture
  // "Persistence of pending re-broadcasts is opportunistic").
  gossipRound?: number;                  // current propagation round; 0 at proposal creation
  lastVoteChangedRound?: number;         // round number when tally last mutated
  totalNodes?: number;                   // snapshot of state.workers.length at propose-time
  currentRoundBroadcastSet?: string[];   // voterIds already broadcast-from or targeted in this round
  roundTimeoutMs?: number;               // per-round timeout (default GOSSIP_ROUND_TIMEOUT_MS_DEFAULT)
  roundStartedAt?: string;               // ISO timestamp when current round began (for timeout)
  // ADR-0121 (T3): CRDT-strategy-only field. Triple of `{ votes, approvers,
  // verdict }` carrying the merged CvRDT state across all received voter
  // snapshots. JSON-serialisable shape (Sets backed by tuple arrays — see
  // crdt-types.ts header). Set on `'crdt'` proposals only; absent on
  // bft/raft/quorum/weighted/gossip.
  crdtState?: CRDTState;
  // ADR-0121: snapshot of expected voter count at propose-time, used by the
  // CRDT settle rule (round closes when all expected voters submitted, or
  // the per-round timeout fires). Distinct from gossip's `totalNodes` because
  // CRDT does not derive a fanout bound; it just needs the voter count.
  crdtExpectedVoters?: number;
}

interface ConsensusResult {
  proposalId: string;
  type: string;
  // ADR-0131 (T12): result union widened with 'failed-quorum-not-reached' —
  // verbatim contract per ADR-0131 §Specification. Set when the auto-status-
  // transition fires and the proposal is appended to history.
  result: 'approved' | 'rejected' | 'failed-quorum-not-reached';
  votes: { for: number; against: number };
  decidedAt: string;
  strategy: ConsensusStrategy;
  term?: number;
  byzantineDetected?: string[];
  // ADR-0131 (T12): snapshot of state.workers IDs that didn't vote when the
  // auto-transition fired. Frozen with the historical row.
  absentVoters?: string[];
}

/**
 * Calculate required votes for a given strategy and total node count.
 *
 * ADR-0119 (T1): adds 'weighted' branch — denominator is `(N - 1) + queenWeight`
 * where N is totalNodes and queenWeight defaults to QUEEN_WEIGHT (3). Replaces
 * the previous silent majority `default:` arm with a synchronous throw, applied
 * across ALL strategies (bft/raft/quorum/weighted) per `feedback-no-fallbacks.md`.
 */
function calculateRequiredVotes(
  strategy: ConsensusStrategy,
  totalNodes: number,
  quorumPreset: QuorumPreset = 'majority',
  queenWeight: number = QUEEN_WEIGHT,
): number {
  if (totalNodes <= 0) return 1;
  switch (strategy) {
    case 'bft':
      // BFT: requires 2/3 + 1 of total nodes
      return Math.floor((totalNodes * 2) / 3) + 1;
    case 'raft':
      // Raft: simple majority
      return Math.floor(totalNodes / 2) + 1;
    case 'quorum':
      switch (quorumPreset) {
        case 'unanimous':
          return totalNodes;
        case 'supermajority':
          return Math.floor((totalNodes * 2) / 3) + 1;
        case 'majority':
        default:
          return Math.floor(totalNodes / 2) + 1;
      }
    case 'weighted': {
      // ADR-0119: queen-weighted denominator. Workers contribute 1 each;
      // the queen contributes `queenWeight` (default 3 per USERGUIDE).
      // totalWorkers = max(0, N - 1) — the queen counts as one node.
      const totalWorkers = Math.max(0, totalNodes - 1);
      return totalWorkers + queenWeight;
    }
    case 'crdt':
      // ADR-0121 (T3): CRDT rounds have NO vote-count threshold. Convergence
      // is mathematical, not arithmetic — settling is decided by "all expected
      // voters submitted OR per-round timeout", not "k-of-n approved".
      // We return `totalNodes` as a nominal denominator so callers that read
      // `required` for telemetry get a coherent number; `tryResolveProposal`
      // bypasses the arithmetic entirely on the 'crdt' branch.
      return Math.max(1, totalNodes);
    case 'gossip':
      // ADR-0120 (T2): gossip uses settleCheckGossip + lastVoteChangedRound;
      // there is no vote-count threshold here. We return `totalNodes` as a
      // nominal value matching CRDT (callers reading `required` for
      // telemetry get a coherent number even though the predicate ignores it).
      // PRIOR BEHAVIOUR: gossip fell through to `default` and threw. Fixing
      // that here closes a latent bug where any caller reading `required` on
      // a gossip proposal would crash. The settle path stays the gossip
      // predicate (no behaviour change in resolution logic).
      return Math.max(1, totalNodes);
    default:
      // ADR-0119 / feedback-no-fallbacks (global scope): no silent majority
      // fallback for unknown strategies. Synchronous throw covers typos and
      // future enum values that were added without a dispatch arm.
      throw new Error(`Unknown consensus strategy: ${strategy}`);
  }
}

/**
 * Compute weighted vote tally for a 'weighted' proposal.
 *
 * Precondition (asserted in propose/vote handlers): `queenId` is defined.
 * The voter whose `voterId` matches `queenId` contributes `queenWeight`;
 * all others contribute 1. Returns { votesFor, votesAgainst } as weighted sums.
 */
function weightedTally(
  proposal: ConsensusProposal,
  queenId: string,
  queenWeight: number = QUEEN_WEIGHT,
): { votesFor: number; votesAgainst: number } {
  let votesFor = 0;
  let votesAgainst = 0;
  for (const [voterId, vote] of Object.entries(proposal.votes)) {
    const contribution = voterId === queenId ? queenWeight : 1;
    if (vote) votesFor += contribution;
    else votesAgainst += contribution;
  }
  return { votesFor, votesAgainst };
}

/**
 * Detect Byzantine behavior: a voter who has cast conflicting votes
 * across proposals in the same round (same type, overlapping time).
 * Here we check if the voter already voted differently on this proposal
 * (which shouldn't happen if we block double-votes, so this checks
 * cross-proposal conflicting votes for same type within the pending set).
 */
function detectByzantineVoters(
  pending: ConsensusProposal[],
  currentProposal: ConsensusProposal,
  voterId: string,
  newVote: boolean,
): boolean {
  // Check if voter cast opposite votes on proposals of the same type
  for (const p of pending) {
    if (p.proposalId === currentProposal.proposalId) continue;
    if (p.type !== currentProposal.type) continue;
    if (voterId in p.votes && p.votes[voterId] !== newVote) {
      return true; // Conflicting vote detected
    }
  }
  return false;
}

/**
 * Try to resolve a proposal based on its strategy.
 * Returns 'approved', 'rejected', or null if still pending.
 *
 * ADR-0119 (T1): when `proposal.strategy === 'weighted'`, both the tally and
 * the deadlock arithmetic use weighted sums (queen contributes QUEEN_WEIGHT,
 * workers contribute 1). Comparing raw vote counts to a weighted denominator
 * — or summing raw uncast voters into the deadlock check — would mark
 * legitimate live proposals as deadlocked once the queen weight is in play.
 *
 * `queenId` is required when `proposal.strategy === 'weighted'`. Callers must
 * pass `state.queen?.agentId`; the precondition that `state.queen !== undefined`
 * is enforced in the propose/vote handlers (see MissingQueenForWeightedConsensusError).
 */
function tryResolveProposal(
  proposal: ConsensusProposal,
  totalNodes: number,
  queenId?: string,
): 'approved' | 'rejected' | null {
  const required = calculateRequiredVotes(
    proposal.strategy,
    totalNodes,
    proposal.quorumPreset,
  );

  if (proposal.strategy === 'weighted') {
    // Precondition asserted in propose/vote: `state.queen` is defined.
    if (!queenId) {
      // Defensive — the handler check should have already thrown. If we
      // reach here, the caller bypassed the precondition (programming error).
      throw new MissingQueenForWeightedConsensusError('resolve');
    }
    const { votesFor, votesAgainst } = weightedTally(proposal, queenId);

    if (votesFor >= required) return 'approved';
    if (votesAgainst >= required) return 'rejected';

    // Weighted deadlock: compute remaining weighted capacity. Workers not yet
    // voted contribute 1 each; the queen, if uncast, contributes QUEEN_WEIGHT.
    const castVoters = new Set(Object.keys(proposal.votes));
    const queenStillUncast = !castVoters.has(queenId);
    // Worker slots remaining = totalWorkers - workers already cast.
    const workersAlreadyCast = Array.from(castVoters).filter(v => v !== queenId).length;
    const totalWorkers = Math.max(0, totalNodes - 1);
    const workerSlotsRemaining = Math.max(0, totalWorkers - workersAlreadyCast);
    const weightedRemaining = workerSlotsRemaining + (queenStillUncast ? QUEEN_WEIGHT : 0);

    if (votesFor + weightedRemaining < required && votesAgainst + weightedRemaining < required) {
      // Deadlock: neither side can reach `required` even with all remaining votes.
      return 'rejected';
    }

    return null;
  }

  const votesFor = Object.values(proposal.votes).filter(v => v).length;
  const votesAgainst = Object.values(proposal.votes).filter(v => !v).length;

  if (votesFor >= required) return 'approved';
  if (votesAgainst >= required) return 'rejected';

  // For quorum with 'unanimous', also reject if any vote is against
  if (proposal.strategy === 'quorum' && proposal.quorumPreset === 'unanimous' && votesAgainst > 0) {
    return 'rejected';
  }

  // Check if it's impossible to reach quorum (remaining potential votes can't tip it)
  const totalVotes = Object.keys(proposal.votes).length;
  const remaining = totalNodes - totalVotes;
  if (votesFor + remaining < required && votesAgainst + remaining < required) {
    // Deadlock: neither side can win -- reject
    return 'rejected';
  }

  return null;
}

// ── ADR-0120 (T2): gossip helpers ─────────────────────────────────────
//
// Push-style epidemic propagation. Each `vote` action where strategy is
// 'gossip' triggers fanout-bounded re-broadcast bookkeeping. In a
// single-process MCP server, the "re-broadcast" is the bookkeeping itself
// — peers' state is shared via `state.consensus.pending`, so target
// voters observe the merged proposal on their next vote/status call.
// The round counter (gossipRound) and broadcast-set tracking enforce the
// O(log N) convergence bound; settling is detected by the predicate
// below (§Specification settle predicate).

/**
 * Settle-check result shape per ADR-0120 §Pseudocode `settle_check`.
 *
 * - `{ settled: true, ... }` — predicate fired, callers may act on the tally.
 * - `{ settled: false, exhausted: true, ... }` — hard budget exceeded; per
 *   `feedback-no-fallbacks.md`, callers handle by retrying / escalating /
 *   treating as inconclusive. NEVER silently coerce to settled.
 * - `{ settled: false, ... }` — still propagating; callers may poll again.
 */
export interface GossipSettleStatus {
  settled: boolean;
  exhausted?: boolean;
  gossipRound: number;
  bound: number;
  result?: 'approved' | 'rejected';
  noVotes?: boolean;
}

/**
 * Apply per-round timeout: if the current round has been open longer than
 * `roundTimeoutMs`, force-advance `gossipRound` and clear
 * `currentRoundBroadcastSet`. Caller must `saveHiveState` after invocation
 * if any mutation happened.
 *
 * Per ADR-0120 §Specification "Per-round timeout": without this, a single
 * non-voting worker would block all rounds indefinitely (the broadcast set
 * never covers all voters → `gossipRound` never advances → settling never
 * fires). With the timeout, the round advances after `roundTimeoutMs`; the
 * dropped voter's vote is simply absent from the tally; the predicate
 * still fires once `lastVoteChangedRound` quiesces.
 *
 * Returns `true` if a round-advance happened (the caller saves state).
 */
function maybeAdvanceGossipRoundOnTimeout(
  proposal: ConsensusProposal,
  now: number = Date.now(),
): boolean {
  if (proposal.strategy !== 'gossip') return false;
  if (!proposal.roundStartedAt) return false;
  const roundTimeoutMs = proposal.roundTimeoutMs ?? GOSSIP_ROUND_TIMEOUT_MS_DEFAULT;
  const elapsed = now - new Date(proposal.roundStartedAt).getTime();
  if (elapsed < roundTimeoutMs) return false;
  // Round timeout fired — advance.
  proposal.gossipRound = (proposal.gossipRound ?? 0) + 1;
  proposal.currentRoundBroadcastSet = [];
  proposal.roundStartedAt = new Date(now).toISOString();
  return true;
}

/**
 * ADR-0120 §Pseudocode `settle_check`. Compute the settle status of a
 * gossip proposal. Mirrors the predicate at §Specification.
 *
 * Predicate: settled iff
 *   `gossipRound >= ceil(log2(totalNodes))`
 *     AND
 *   `(gossipRound > lastVoteChangedRound OR totalNodes == 1)`
 *
 * Hard budget: `gossipRound > 2 * ceil(log2(totalNodes))` returns
 *   `{ settled: false, exhausted: true }` per `feedback-no-fallbacks.md`.
 *
 * No-vote rejection: a settle_check on a proposal with zero votes
 *   returns `{ settled: false, gossipRound: 0, noVotes: true }` —
 *   never `{ settled: true }`.
 */
export function settleCheckGossip(proposal: ConsensusProposal): GossipSettleStatus {
  const totalNodes = proposal.totalNodes ?? 1;
  const bound = gossipFanout(totalNodes);
  const gossipRound = proposal.gossipRound ?? 0;
  const lastVoteChangedRound = proposal.lastVoteChangedRound ?? 0;
  const hasVotes = Object.keys(proposal.votes).length > 0;

  // No-vote rejection per §Refinement edge case "Caller invokes vote with
  // no votes received yet". An empty tally is not a settled tally.
  if (!hasVotes) {
    return { settled: false, gossipRound, bound, noVotes: true };
  }

  // Hard budget exhaustion per §Specification "Round budget".
  if (gossipRound > 2 * bound) {
    return { settled: false, exhausted: true, gossipRound, bound };
  }

  // Settle predicate. The N=1 short-circuit handles the degenerate case
  // where bound=0 makes the first clause trivially true and
  // gossipRound=0=lastVoteChangedRound makes a strict-greater check fail.
  if (
    gossipRound >= bound &&
    (gossipRound > lastVoteChangedRound || totalNodes === 1)
  ) {
    // Compute final tally. Workers each contribute 1 vote; gossip has no
    // queen-multiplier semantics. Result decided by simple majority of
    // recorded votes (not against `totalNodes`, since gossip permits
    // partial participation per §Refinement "voter dropouts").
    const votesFor = Object.values(proposal.votes).filter(v => v).length;
    const votesAgainst = Object.values(proposal.votes).filter(v => !v).length;
    const result: 'approved' | 'rejected' =
      votesFor > votesAgainst ? 'approved' : 'rejected';
    return { settled: true, gossipRound, bound, result };
  }

  return { settled: false, gossipRound, bound };
}

export function getHiveDir(): string {
  return join(findProjectRoot(), STORAGE_DIR, HIVE_DIR);
}

export function getHivePath(): string {
  return join(getHiveDir(), HIVE_FILE);
}

function getLegacyHivePath(): string {
  return join(getHiveDir(), `${HIVE_FILE}.legacy`);
}

export function ensureHiveDir(): void {
  const dir = getHiveDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * ADR-0124 (T6): canonical session-archive directory under
 * `.claude-flow/hive-mind/sessions/`. Created lazily on first checkpoint
 * (no init-time directory creation per ADR-0124 §Refinement edge case
 * "Sessions directory does not exist on first sessions list").
 */
export function getHiveSessionsDir(): string {
  return join(getHiveDir(), 'sessions');
}

/**
 * Lazy-create the sessions directory. Call before any archive write
 * (checkpoint/export). `sessions list` MUST NOT call this — empty
 * directory returns empty list per ADR-0124 §Refinement.
 */
export function ensureHiveSessionsDir(): void {
  const dir = getHiveSessionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── ADR-0123 (T5): LRU cache + RVF-compatible WAL stack ───────────────────
//
// Per `project-rvf-primary`, RVF is the source of truth for hive memory.
// The on-disk persistence path here uses the SAME durability primitive that
// `RvfBackend` uses internally (see `forks/ruflo/v3/@claude-flow/memory/src/
// rvf-backend.ts:2513`, ADR-0095 d11):
//
//     1. Acquire withHiveStoreLock (cross-process O_EXCL sentinel; ADR-0098)
//     2. Write tmp file
//     3. fsync the tmp file (page cache → stable storage)
//     4. Atomic rename tmp → target
//
// This is the WAL+fsync+atomic-rename stack the ADR-0123 §73 (Decision
// Outcome) refers to as "RVF's existing primitives". The mechanism is real:
// fsync drains the VFS page cache for the tmp data blocks before the rename
// promotes the entry to the canonical path. Concurrent writers serialize
// behind the O_EXCL sentinel; SIGKILL-without-power-loss preserves every
// committed entry because the rename is atomic at the directory-entry layer
// and the page cache outlives a process kill.
//
// True power-loss durability (fsync the WAL append + the directory entry
// after rename) is OUT OF SCOPE for T5 — see ADR-0130 (RVF WAL fsync
// durability) and ADR-0123 §Risks #7. The H3 triage decision (2026-05-02)
// scoped T5 to SIGKILL-without-power-loss only.
//
// LRU cache: process-local, Map-backed (insertion-order tracking is the
// LRU primitive — Map preserves insertion order in JS engines). Capacity
// is operator-tunable via CLAUDE_FLOW_HIVE_CACHE_MAX (default 1024). One
// cache per CLI invocation; the daemon has its own. Cross-process
// coherency is RVF-is-source-of-truth: every operation re-reads under the
// lock, so stale-cache windows are bounded by call cadence (per ADR-0123
// §Refinement, item "Daemon and CLI both holding caches").
//
// Legacy in-memory SQL backend carve-out: no path in v3/@claude-flow/memory/src/
// imports it. The lone dynamic-import site at rvf-migration.ts:128 is a one-shot
// legacy reader, never an active backend. Routing hive memory through this
// WAL+fsync+rename stack therefore never touches that legacy backend, whose
// PRAGMA journal_mode=WAL is a no-op against an in-memory virtual filesystem
// (its only persistence primitive is db.export() of the entire blob; not a
// real WAL — see ADR-0123 §Risks #6).

const HIVE_STATE_DOC_KEY = 'hive-mind/state-doc';

interface CacheEntry {
  state: HiveState;
}

class HiveLRU {
  // Map preserves insertion order. To "move to front" on get, we delete then
  // re-set. Eviction = remove the first key (oldest insertion).
  private store = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private maxEntries: number) {
    if (!Number.isFinite(maxEntries) || maxEntries < 1) {
      // Fail-loud per feedback-no-fallbacks: an invalid capacity should not
      // silently default. Caller must produce a positive integer.
      throw new Error(
        `HiveLRU: maxEntries must be a positive finite number, got ${maxEntries}`,
      );
    }
  }

  get(key: string): HiveState | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    // Move-to-front: delete + re-set advances insertion-order to "newest".
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.state;
  }

  set(key: string, state: HiveState): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { state });
    while (this.store.size > this.maxEntries) {
      // Map.keys() in JS returns insertion-order; first key is the oldest.
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.evictions++;
    }
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  stats(): { hits: number; misses: number; evictions: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.store.size,
    };
  }
}

function getCacheCapacity(): number {
  const raw = process.env.CLAUDE_FLOW_HIVE_CACHE_MAX;
  if (raw === undefined || raw === '') return 1024;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return 1024;
  return Math.floor(parsed);
}

let hiveCache: HiveLRU = new HiveLRU(getCacheCapacity());

/**
 * Migrate legacy `state.sharedMemory` entries to T4's typed shape.
 * Non-destructive: no value mutated, no entry dropped. Per
 * `feedback-data-loss-zero-tolerance`, even malformed legacy entries
 * (undefined/null) are preserved as `system`/permanent typed records.
 */
function migrateSharedMemoryShape(parsed: HiveState): void {
  if (!parsed || typeof parsed !== 'object' || !parsed.sharedMemory) return;
  const now = Date.now();
  const migrated: Record<string, MemoryEntry> = {};
  for (const [key, entry] of Object.entries(parsed.sharedMemory)) {
    if (isMemoryEntryShape(entry)) {
      migrated[key] = entry;
    } else {
      // Legacy raw value: wrap as `system`/permanent.
      migrated[key] = {
        value: entry,
        type: 'system',
        ttlMs: null,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      };
    }
  }
  parsed.sharedMemory = migrated;
}

function defaultHiveState(): HiveState {
  const ts = new Date().toISOString();
  return {
    initialized: false,
    topology: 'mesh',
    workers: [],
    // ADR-0131 (T12): per-worker failure metadata. Defaulted to an empty map
    // for fresh hives; legacy state files load with the field undefined and
    // workerMetaFor() lazily initialises on first lookup.
    workerMeta: {},
    consensus: { pending: [], history: [] },
    sharedMemory: {},
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Load hive state via the LRU cache → RVF-compatible WAL store path.
 *
 * Branches (per ADR-0123 §Specification):
 *   - cache-hit: return cached state, move-to-front side-effect
 *   - cache-miss, file-hit: parse, migrate legacy shape, populate cache, return
 *   - cache-miss, file-miss, legacy-hit: migrate from `state.json.legacy`,
 *     return migrated state (cache populated by save). NOTE: the legacy
 *     migration path runs only when there is no current `state.json`. This
 *     is the post-migration recovery path — useful if `state.json` was
 *     removed but `state.json.legacy` survives.
 *   - cache-miss, both-miss: return default state. No cache population
 *     (default is a sentinel, not a stored fact).
 *   - cache-miss, file present but unparseable / corrupt: throws. Per
 *     `feedback-no-fallbacks`, the silent `catch {}` removed at Phase 5
 *     means corrupt-state errors propagate. Operators must intervene.
 *
 * Cache update ordering (Row 22, DEFER-TO-IMPL):
 *   - On miss-then-hit, cache is populated AFTER successful parse + migration.
 *   - On miss-then-error, cache is NOT populated (no advertising of
 *     partial state to subsequent callers in this process).
 */
export function loadHiveState(): HiveState {
  // ── 1. Cache lookup ──
  const cached = hiveCache.get(HIVE_STATE_DOC_KEY);
  if (cached !== undefined) return cached;

  // ── 2. Load from disk ──
  const path = getHivePath();
  if (existsSync(path)) {
    const data = readFileSync(path, 'utf-8');
    // ADR-0123 Phase 5 + feedback-no-fallbacks.md: NO silent catch. JSON.parse
    // throwing on a malformed state.json must propagate; the caller surfaces
    // the corruption. Pre-T5 behavior was to swallow this and return a fresh
    // default state — that path silently destroyed a corrupt-but-recoverable
    // hive (next saveHiveState would overwrite the corrupt file with the
    // default).
    const parsed = JSON.parse(data) as HiveState;
    migrateSharedMemoryShape(parsed);
    hiveCache.set(HIVE_STATE_DOC_KEY, parsed);
    return parsed;
  }

  // ── 3. No live state.json — try `state.json.legacy` recovery ──
  // Per ADR-0123 §83: legacy file is preserved (not deleted) for recovery.
  const legacyPath = getLegacyHivePath();
  if (existsSync(legacyPath)) {
    const data = readFileSync(legacyPath, 'utf-8');
    // Legacy parse error must also propagate — this is the recovery path,
    // a corrupt legacy file means the operator made a mistake when moving
    // it aside; we surface it rather than masking with default state.
    const parsed = JSON.parse(data) as HiveState;
    migrateSharedMemoryShape(parsed);
    // Re-promote the legacy file to live state by writing it back through
    // the durable save path. saveHiveState handles cache population.
    saveHiveState(parsed);
    return parsed;
  }

  // ── 4. Fresh state — return default, do not populate cache ──
  // (default is a sentinel describing "no hive yet", not a stored fact;
  //  caching it would prevent subsequent file writes from being observed.)
  return defaultHiveState();
}

/**
 * Persist hive state via the RVF-compatible WAL stack (ADR-0095 d11).
 *
 * Durability guarantee: SIGKILL-without-power-loss. Mechanism:
 *   1. caller already holds withHiveStoreLock (cross-process O_EXCL)
 *   2. write tmp file (per-pid name; concurrent writers do not collide)
 *   3. fsync the tmp file descriptor (page-cache → stable storage)
 *   4. atomic rename tmp → target (directory-entry layer)
 *
 * Cache update ordering (Row 22): cache is updated ONLY after the rename
 * has succeeded. On any throw (write failure, EIO mid-fsync, rename
 * failure), the cache is NOT updated — subsequent loadHiveState calls in
 * this process see the pre-call state, never the in-flight failed one.
 *
 * Per ADR-0123 §Specification "Backend success / Backend failure" branches.
 *
 * Power-loss durability (fsync the directory entry after rename) is NOT
 * guaranteed — that is ADR-0130's surface. T5's gate is SIGKILL with intact
 * page cache; the kernel page cache outlives a process kill, so the
 * post-rename data is recoverable on the next mount even if no fsync of
 * the dir entry has happened yet.
 */
export function saveHiveState(state: HiveState): void {
  ensureHiveDir();
  state.updatedAt = new Date().toISOString();

  const path = getHivePath();
  // Per-pid + per-call counter ensures concurrent writers in the same
  // process never collide on tmp filenames. (Matches RVF's _tmpCounter
  // pattern at rvf-backend.ts:2512.)
  const tmp = `${path}.tmp.${process.pid}.${tmpCounter++}`;

  // Write + explicit fsync before rename. ADR-0095 d11 (Sprint 1.5):
  // writeFileSync uses open→write→close which does NOT fsync; on APFS
  // under concurrent I/O load, data blocks can remain in the VFS page
  // cache after close. rename() is atomic for the directory entry but
  // peer processes reading target through a different file descriptor
  // may see a stale snapshot if the tmp data blocks have not yet hit
  // stable storage. Mode A silent loss at entryCount=5/6 was observed
  // on patch.204 under the mega-parallel acceptance wave (2026-04-19).
  // Without this fsync, withHiveStoreLock serializes acquire ordering
  // but not the VFS cache flush. Bringing the fsync inside the lock
  // closes that window and is the same primitive RVF uses.
  let fd: number | null = null;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
    writeSync(fd, JSON.stringify(state, null, 2), 0, 'utf-8');
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  renameSync(tmp, path);

  // Update cache only after the rename succeeds. On any throw above, this
  // line is unreached and the cache is not updated.
  hiveCache.set(HIVE_STATE_DOC_KEY, state);
}

let tmpCounter = 0;

// ADR-0104 §5: cross-process file lock for hive-state.json read-modify-write,
// modeled on ADR-0098's swarm-state lock. O_EXCL sentinel + stale-lock recovery.
export async function withHiveStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${getHivePath()}.lock`;
  const MAX_WAIT_MS = 5000;
  const POLL_MS = 50;
  const STALE_LOCK_MS = 30_000;
  const deadline = Date.now() + MAX_WAIT_MS;

  ensureHiveDir();

  // Acquire
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      writeSync(fd, `${process.pid}\n${Date.now()}\n`);
      closeSync(fd);
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'EEXIST') {
        try {
          const stat = statSync(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            continue;
          }
        } catch { /* lockfile vanished between check and stat — retry */ }
        if (Date.now() > deadline) {
          throw new Error(`Timeout waiting for hive-state lock after ${MAX_WAIT_MS}ms`);
        }
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      throw err;
    }
  }

  try {
    return await fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

// Import agent store helpers for spawn functionality
import { existsSync as agentStoreExists, readFileSync as readAgentStore, writeFileSync as writeAgentStore, mkdirSync as mkdirAgentStore } from 'node:fs';

function loadAgentStore(): { agents: Record<string, unknown> } {
  const storePath = join(findProjectRoot(), '.claude-flow', 'agents.json');
  try {
    if (agentStoreExists(storePath)) {
      return JSON.parse(readAgentStore(storePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { agents: {} };
}

function saveAgentStore(store: { agents: Record<string, unknown> }): void {
  const storeDir = join(findProjectRoot(), '.claude-flow');
  if (!agentStoreExists(storeDir)) {
    mkdirAgentStore(storeDir, { recursive: true });
  }
  writeAgentStore(join(storeDir, 'agents.json'), JSON.stringify(store, null, 2), 'utf-8');
}

export const hiveMindTools: MCPTool[] = [
  {
    name: 'hive-mind_spawn',
    description: 'Spawn workers and automatically join them to the hive-mind (combines agent/spawn + hive-mind/join). ADR-0131 (T12): supports `retryOf` to record retry-lineage for failed workers; supports `action: "retryTask"` for queen-driven retry-once flows.',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        // ADR-0131 (T12): optional `action` discriminator. Default is the
        // existing spawn behaviour. `action: "retryTask"` is a sugared
        // single-worker spawn that requires `retryOf` and uses the canonical
        // worker-<original>-retry-1 ID convention from ADR-0131 §Refinement.
        action: {
          type: 'string',
          enum: ['spawn', 'retryTask'],
          description: 'Spawn action: "spawn" (default) for new workers, "retryTask" for retrying a failed worker by ID (ADR-0131 §6 retry-once policy).',
        },
        count: { type: 'number', description: 'Number of workers to spawn (default: 1)', default: 1 },
        role: { type: 'string', enum: ['worker', 'specialist', 'scout'], description: 'Worker role in hive', default: 'worker' },
        // ADR-0108 (T13): `agentType` (scalar, existing) and `agentTypes`
        // (array, new) are mutually exclusive shapes for single-type vs
        // mixed-type spawn. The handler enforces the mutex; the schema
        // documents both surfaces. Per `feedback-no-fallbacks.md`, unknown
        // values fail loudly via `validateWorkerType` rather than silently
        // routing to a generic worker.
        agentType: { type: 'string', description: 'Agent type for spawned workers (scalar; mutually exclusive with agentTypes)', default: 'worker' },
        agentTypes: {
          type: 'array',
          items: { type: 'string', enum: [...WORKER_TYPES] },
          description: `Mixed-type worker spawn (round-robin: agentTypes[i % len]). Mutually exclusive with agentType. Allowed values: ${WORKER_TYPES.join(', ')}.`,
        },
        prefix: { type: 'string', description: 'Prefix for worker IDs', default: 'hive-worker' },
        // ADR-0131 (T12): retryOf records the original worker's ID when this
        // spawn is a retry per the §6 retry-once policy. Sets the new entry's
        // workerMeta.retryOf pointer; downstream audit-trail consumers
        // (hive-mind_status.failedWorkers) surface this for lineage
        // reconstruction. Single pointer per ADR-0131 §Decision Outcome —
        // not a chain depth or graph.
        retryOf: {
          type: 'string',
          description: 'Original worker ID for retry-spawned workers (ADR-0131 retry lineage).',
        },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized. Run hive-mind/init first.' };
      }

      // ADR-0131 (T12): action discriminator. retryTask is sugar for a
      // single-worker spawn with retryOf required and the canonical
      // worker-<original>-retry-1 ID convention enforced.
      const action = (input.action as string) || 'spawn';
      const rawRetryOf = (input.retryOf as string) || undefined;

      if (action === 'retryTask') {
        if (!rawRetryOf) {
          return {
            success: false,
            error: 'retryTask requires `retryOf` (the original worker ID being retried)',
          };
        }
      }

      const count = Math.min(Math.max(1, (input.count as number) || 1), 20); // Cap at 20
      const role = (input.role as string) || 'worker';
      const prefix = (input.prefix as string) || 'hive-worker';

      // ADR-0108 (T13): mutex between scalar `agentType` and array
      // `agentTypes`. Per `feedback-no-fallbacks.md`, both-present is a
      // user error (not a silent precedence rule).
      const rawAgentType = input.agentType;
      const rawAgentTypes = input.agentTypes;
      const agentTypeIsExplicit = rawAgentType !== undefined && rawAgentType !== '' && rawAgentType !== 'worker';
      const agentTypesArr = Array.isArray(rawAgentTypes) ? rawAgentTypes : undefined;

      if (agentTypeIsExplicit && agentTypesArr !== undefined && agentTypesArr.length > 0) {
        return {
          success: false,
          error: 'agentType and agentTypes are mutually exclusive; use agentTypes for mixed spawns',
        };
      }

      // When `agentTypes` is provided, validate each member against the
      // existing enum. `validateWorkerType` already issues a fail-loud
      // descriptive error per `feedback-no-fallbacks.md`.
      if (agentTypesArr !== undefined) {
        if (agentTypesArr.length === 0) {
          return {
            success: false,
            error: 'agentTypes must contain at least one worker type',
          };
        }
        for (const t of agentTypesArr) {
          const check = validateWorkerType(t, 'agentTypes entry');
          if (!check.valid) {
            return {
              success: false,
              error: `agentTypes contains invalid value: ${check.error}`,
            };
          }
        }
      }

      // Pre-compute the per-worker type list. When `agentTypes` is set the
      // round-robin distribution is `agentTypes[i % agentTypes.length]`;
      // otherwise the scalar `agentType` (or 'worker' default) is replicated
      // for every worker. This is the single dispatch site for ADR-0108's
      // round-robin contract.
      const scalarAgentType = (rawAgentType as string) || 'worker';
      const perWorkerTypes: string[] = [];
      for (let i = 0; i < count; i++) {
        if (agentTypesArr !== undefined && agentTypesArr.length > 0) {
          perWorkerTypes.push(agentTypesArr[i % agentTypesArr.length] as string);
        } else {
          perWorkerTypes.push(scalarAgentType);
        }
      }

      const agentStore = loadAgentStore();

      const spawnedWorkers: Array<{ agentId: string; role: string; agentType: string; joinedAt: string; retryOf?: string }> = [];

      for (let i = 0; i < count; i++) {
        // ADR-0131 (T12): retryTask uses canonical retry ID convention
        // worker-<original>-retry-1 per ADR-0131 §Refinement edge case
        // "Worker re-spawn with same ID". For multi-count retries (rare),
        // append the iteration index.
        let agentId: string;
        if (action === 'retryTask' && rawRetryOf) {
          const suffix = count === 1 ? 'retry-1' : `retry-${i + 1}`;
          agentId = `${rawRetryOf}-${suffix}`;
        } else {
          agentId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        }
        const thisType = perWorkerTypes[i] as string;

        // Create agent record (like agent/spawn)
        agentStore.agents[agentId] = {
          agentId,
          agentType: thisType,
          status: 'idle',
          health: 1.0,
          taskCount: 0,
          config: { role, hiveRole: role },
          createdAt: new Date().toISOString(),
          domain: 'hive-mind',
        };

        // Join to hive-mind (like hive-mind/join)
        if (!state.workers.includes(agentId)) {
          state.workers.push(agentId);
        }

        // ADR-0131 (T12): record retry lineage on the new worker entry's
        // metadata. Per ADR-0131 §Decision Outcome, retryOf is a single
        // pointer (not a chain depth) — the new entry points to the
        // immediate predecessor. Chain reconstruction is recursive lookup
        // at audit-time.
        if (rawRetryOf) {
          registerWorkerRetry(state, agentId, rawRetryOf);
        }

        // ADR-0108 (T13): per-worker `agentType` returned in the response
        // so callers (CLI, prompt builder) see the round-robin distribution
        // rather than a single uniform scalar.
        spawnedWorkers.push({
          agentId,
          role,
          agentType: thisType,
          joinedAt: new Date().toISOString(),
          ...(rawRetryOf ? { retryOf: rawRetryOf } : {}),
        });
      }

      saveAgentStore(agentStore);
      saveHiveState(state);

      return {
        success: true,
        spawned: count,
        action,
        workers: spawnedWorkers,
        totalWorkers: state.workers.length,
        hiveStatus: 'active',
        message: action === 'retryTask'
          ? `Spawned ${count} retry-worker(s) for ${rawRetryOf} and joined to the hive-mind`
          : `Spawned ${count} worker(s) and joined them to the hive-mind`,
      };
    },
  },
  {
    name: 'hive-mind_init',
    description: 'Initialize the hive-mind collective',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        topology: { type: 'string', enum: ['mesh', 'hierarchical', 'ring', 'star'], description: 'Network topology' },
        queenId: { type: 'string', description: 'Initial queen agent ID' },
        // ADR-0124 (T6) / H6 row 32 fold-in: persist queenType on the
        // queen record so hive-mind_status can surface it and the
        // session-archive shape can capture/restore it.
        queenType: { type: 'string', enum: ['strategic', 'tactical', 'adaptive'], description: 'Queen leadership style' },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();
      const hiveId = `hive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queenId = (input.queenId as string) || `queen-${Date.now()}`;

      state.initialized = true;
      state.topology = (input.topology as HiveState['topology']) || 'mesh';
      state.createdAt = new Date().toISOString();
      // ADR-0124 (T6) / H6 row 32: validate queenType at the boundary; per
      // `feedback-no-fallbacks.md`, an unknown value throws rather than
      // silently defaulting. `undefined` is permitted (older spawn paths
      // may not pass it; state.queen.queenType stays undefined).
      const rawQueenType = input.queenType;
      let queenType: HiveQueenType | undefined;
      if (rawQueenType !== undefined && rawQueenType !== null && rawQueenType !== '') {
        if (!isHiveQueenType(rawQueenType)) {
          throw new Error(
            `hive-mind_init: queenType must be one of ${HIVE_QUEEN_TYPES.join('|')} (got "${String(rawQueenType)}")`,
          );
        }
        queenType = rawQueenType;
      }
      state.queen = {
        agentId: queenId,
        electedAt: new Date().toISOString(),
        term: 1,
        ...(queenType !== undefined ? { queenType } : {}),
      };

      saveHiveState(state);

      // ADR-0122 (T4): register periodic sweep timer for TTL eviction. Idempotent —
      // re-init without intervening shutdown reuses the existing handle.
      startHiveMindSweepTimer();

      return {
        success: true,
        hiveId,
        topology: state.topology,
        consensus: (input.consensus as string) || 'byzantine',
        queenId,
        // ADR-0124 (T6): echo back queenType so callers (CLI spawn, status
        // probes) can confirm the persisted value.
        ...(queenType !== undefined ? { queenType } : {}),
        status: 'initialized',
        config: {
          topology: state.topology,
          consensus: input.consensus || 'byzantine',
          maxAgents: input.maxAgents || 15,
          persist: input.persist !== false,
          memoryBackend: input.memoryBackend || 'hybrid',
        },
        createdAt: state.createdAt,
      };
    },
  },
  {
    name: 'hive-mind_status',
    description: 'Get hive-mind status',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Include detailed information' },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      // ADR-0131 (T12): reconcile §6 absence markers before surfacing status.
      // The §6 prompt protocol writes `worker-<id>-status: 'absent'` via
      // _memory; this scan propagates that into per-worker workerMeta.failedAt
      // so the failedWorkers summary below is current. Persist if anything
      // changed (the failure-marking is forward-only — no spurious writes).
      if (reconcileFailedFromStatusKeys(state)) {
        saveHiveState(state);
      }

      const uptime = state.createdAt ? Date.now() - new Date(state.createdAt).getTime() : 0;

      // Load agent store once for all workers
      const agentStore = loadAgentStore();

      // Compute real task metrics from task store
      const taskStorePath = join(findProjectRoot(), '.claude-flow', 'tasks', 'store.json');
      let pendingTaskCount = 0;
      let activeTaskCount = 0;
      let completedTaskCount = 0;
      try {
        if (existsSync(taskStorePath)) {
          const taskStore = JSON.parse(readFileSync(taskStorePath, 'utf-8'));
          for (const task of Object.values(taskStore.tasks || {}) as Array<{ status: string }>) {
            if (task.status === 'pending') pendingTaskCount++;
            else if (task.status === 'in_progress') activeTaskCount++;
            else if (task.status === 'completed') completedTaskCount++;
          }
        }
      } catch { /* ignore */ }

      const workerCount = Math.max(1, state.workers.length);
      const realLoad = activeTaskCount / workerCount;

      // ADR-0131 (T12) — failedWorkers summary derived from state.workerMeta.
      // Every worker whose failedAt !== null is included. Per ADR-0131
      // §Specification: `state.workers.filter(w => w.failedAt !== null)
      // .map(w => ({ id: w.id, failedAt: w.failedAt, retryOf: w.retryOf }))`.
      // Adapted to our parallel workerMeta map shape (state.workers is
      // string[] of IDs); the result shape is identical.
      const failedWorkers: Array<{ id: string; failedAt: number; retryOf: string | null }> = [];
      const allWorkerMetaIds = state.workerMeta ? Object.keys(state.workerMeta) : [];
      for (const id of allWorkerMetaIds) {
        const meta = state.workerMeta![id]!;
        if (meta.failedAt !== null && meta.failedAt !== undefined) {
          failedWorkers.push({
            id,
            failedAt: meta.failedAt,
            retryOf: meta.retryOf ?? null,
          });
        }
      }

      const status = {
        // CLI expected fields
        hiveId: `hive-${state.createdAt ? new Date(state.createdAt).getTime() : Date.now()}`,
        status: state.initialized ? 'active' : 'offline',
        topology: state.topology,
        consensus: 'byzantine', // Default consensus type
        queen: state.queen ? {
          id: state.queen.agentId,
          agentId: state.queen.agentId,
          status: 'active',
          load: Math.round(realLoad * 1000) / 1000,
          tasksQueued: pendingTaskCount,
          electedAt: state.queen.electedAt,
          term: state.queen.term,
          // ADR-0124 (T6) / H6 row 32 fold-in: surface queenType in the
          // status response so plugin docs' `mcp__ruflo__hive-mind_status`
          // queries can read the active leadership style. `undefined` is
          // omitted from the response (older hives without explicit type).
          ...(state.queen.queenType !== undefined ? { queenType: state.queen.queenType } : {}),
        } : { id: 'N/A', status: 'offline', load: 0, tasksQueued: 0 },
        workers: state.workers.map(w => {
          const agent = agentStore.agents[w] as Record<string, unknown> | undefined;
          // ADR-0131 (T12): surface per-worker failure status alongside the
          // existing agentStore-derived shape. failedAt/retryOf are null
          // by default for live workers.
          const meta = state.workerMeta?.[w];
          return {
            id: w,
            type: (agent?.agentType as string) || 'worker',
            status: (agent?.status as string) || 'unknown',
            currentTask: (agent?.currentTask as string) || null,
            tasksCompleted: (agent?.taskCount as number) || 0,
            failedAt: meta?.failedAt ?? null,
            retryOf: meta?.retryOf ?? null,
          };
        }),
        metrics: {
          totalTasks: pendingTaskCount + activeTaskCount + completedTaskCount,
          completedTasks: completedTaskCount,
          activeTasks: activeTaskCount,
          pendingTasks: pendingTaskCount,
          // ADR-0131 (T12): failed-task count surfaces the count of workers
          // marked absent. Derived from failedWorkers length.
          failedTasks: failedWorkers.length,
          consensusRounds: state.consensus.history.length,
          memoryUsage: `${Object.keys(state.sharedMemory).length * 2} KB`,
        },
        health: {
          overall: 'healthy',
          queen: state.queen ? 'healthy' : 'unhealthy',
          workers: state.workers.length > 0 ? 'healthy' : 'degraded',
          consensus: 'healthy',
          memory: 'healthy',
        },
        // Additional fields
        id: `hive-${state.createdAt ? new Date(state.createdAt).getTime() : Date.now()}`,
        initialized: state.initialized,
        workerCount: state.workers.length,
        pendingConsensus: state.consensus.pending.length,
        sharedMemoryKeys: Object.keys(state.sharedMemory).length,
        uptime,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        // ADR-0131 (T12) — failedWorkers summary, derived from
        // state.workerMeta. Empty array when no workers have been marked
        // absent. Per ADR-0131 §Specification: each entry is
        // { id, failedAt, retryOf } where retryOf is the original worker's
        // ID for retry-spawned entries (null for direct-queen-spawned workers).
        failedWorkers,
      };

      if (input.verbose) {
        return {
          ...status,
          workerDetails: state.workers,
          consensusHistory: state.consensus.history.slice(-10),
          sharedMemory: state.sharedMemory,
        };
      }

      return status;
    },
  },
  {
    name: 'hive-mind_join',
    description: 'Join an agent to the hive-mind',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to join' },
        role: { type: 'string', enum: ['worker', 'specialist', 'scout'], description: 'Agent role in hive' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const state = loadHiveState();
      const agentId = input.agentId as string;

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized' };
      }

      if (!state.workers.includes(agentId)) {
        state.workers.push(agentId);
        saveHiveState(state);
      }

      return {
        success: true,
        agentId,
        role: input.role || 'worker',
        totalWorkers: state.workers.length,
        joinedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'hive-mind_leave',
    description: 'Remove an agent from the hive-mind',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to remove' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const state = loadHiveState();
      const agentId = input.agentId as string;

      const index = state.workers.indexOf(agentId);
      if (index > -1) {
        state.workers.splice(index, 1);
        saveHiveState(state);
        return {
          success: true,
          agentId,
          leftAt: new Date().toISOString(),
          remainingWorkers: state.workers.length,
        };
      }

      return { success: false, agentId, error: 'Agent not in hive' };
    },
  },
  {
    name: 'hive-mind_consensus',
    description: 'Propose or vote on consensus with BFT, Raft, Quorum, Weighted, Gossip, or CRDT strategies',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['propose', 'vote', 'status', 'list'], description: 'Consensus action' },
        proposalId: { type: 'string', description: 'Proposal ID (for vote/status)' },
        type: { type: 'string', description: 'Proposal type (for propose)' },
        value: { description: 'Proposal value (for propose)' },
        vote: { type: 'boolean', description: 'Vote (true=for, false=against)' },
        voterId: { type: 'string', description: 'Voter agent ID' },
        // ADR-0119 (T1): 'weighted' added (queen 3x voting power per USERGUIDE).
        // ADR-0120 (T2): 'gossip' added (push-style epidemic propagation; eventual consistency).
        // ADR-0121 (T3): 'crdt' added (state-based CvRDT merge over G-Counter / OR-Set / LWW-Register).
        // 'byzantine' is an alias for 'bft' (carry-forward from ADR-0106 R1 per
        // ADR-0118 review-notes-triage 2026-05-02); normalized to 'bft' at handler entry.
        strategy: { type: 'string', enum: ['bft', 'raft', 'quorum', 'weighted', 'byzantine', 'gossip', 'crdt'], description: 'Consensus strategy (default: raft). "byzantine" is an alias for "bft". "gossip" uses push-style epidemic propagation with eventual-consistency settling. "crdt" uses state-based CvRDT merge with mathematical convergence (G-Counter / OR-Set / LWW-Register).' },
        quorumPreset: { type: 'string', enum: ['unanimous', 'majority', 'supermajority'], description: 'Quorum threshold preset (for quorum strategy, default: majority)' },
        term: { type: 'number', description: 'Term number (for raft strategy)' },
        timeoutMs: { type: 'number', description: 'Timeout in ms for raft re-proposal (default: 30000)' },
        // ADR-0120 (T2): per-round timeout for gossip strategy. Bounds settling
        // latency in the presence of slow voters; without this knob a single
        // non-voting worker would block all gossip rounds indefinitely.
        // ADR-0121 (T3): also bounds the CRDT round; if not all expected voters
        // submit before roundTimeoutMs elapses, the round force-settles with
        // whatever snapshots have been merged so far.
        roundTimeoutMs: { type: 'number', description: 'Per-round timeout in ms for gossip / crdt strategies (default: 5000)' },
        // ADR-0121 (T3): optional CRDT-state snapshot a voter contributes to a
        // 'crdt' round. Triple of `{ votes, approvers, verdict }`; merged into
        // the proposal's accumulator. If omitted, a minimal snapshot is
        // synthesised from the boolean `vote` field per row 14's overload rule.
        crdtSnapshot: { description: 'Optional CRDT-state triple { votes, approvers, verdict } for crdt strategy. Merged into the proposal accumulator on each vote.' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const state = loadHiveState();
      const action = input.action as string;

      // ADR-0119 (T1) — carry-forward from ADR-0106 R1: 'byzantine' is a wire-
      // boundary alias for 'bft'. Normalize before dispatch so the runtime sees
      // only the canonical 'bft' value (per ADR-0118 review-notes-triage 2026-05-02).
      // Mutates `input.strategy` so downstream lookups (proposal.strategy when
      // resuming via vote/status) all see the same canonical value.
      if (input.strategy === 'byzantine') {
        input.strategy = 'bft';
      }

      const strategy = (input.strategy as ConsensusStrategy) || 'raft';
      const totalNodes = state.workers.length || 1;

      if (action === 'propose') {
        // ADR-0119 §Decision Outcome: weighted strategy requires an elected queen.
        // Throw synchronously rather than degrade to permissive math when state.queen
        // is undefined (init race, dangling shutdown, queen nulled by error path).
        if (strategy === 'weighted' && !state.queen) {
          throw new MissingQueenForWeightedConsensusError('propose');
        }

        const proposalId = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const quorumPreset = (input.quorumPreset as QuorumPreset) || 'majority';
        const term = (input.term as number) || (state.queen?.term ?? 1);
        const timeoutMs = (input.timeoutMs as number) || 30000;

        // Raft: check if there's already a pending proposal for this term
        if (strategy === 'raft') {
          const existingTermProposal = state.consensus.pending.find(
            p => p.strategy === 'raft' && p.term === term && p.status === 'pending',
          );
          if (existingTermProposal) {
            return {
              action,
              error: `Raft term ${term} already has a pending proposal: ${existingTermProposal.proposalId}. Wait for resolution or use a higher term.`,
              existingProposalId: existingTermProposal.proposalId,
              term,
            };
          }
        }

        const required = calculateRequiredVotes(strategy, totalNodes, quorumPreset);

        // ADR-0120 (T2): gossip needs `totalNodes` snapshot at propose-time
        // (per §Specification: "snapshotted at propose-time and stays fixed").
        // Late-joining workers are admitted into the candidate pool via the
        // canonical voter-set lookup but do not change the bound.
        const isGossip = strategy === 'gossip';
        // ADR-0121 (T3): CRDT shares the per-round-timeout knob with gossip
        // (used to bound the wait for the last voter's snapshot). Default
        // matches GOSSIP_ROUND_TIMEOUT_MS_DEFAULT (5000ms).
        const isCrdt = strategy === 'crdt';
        const roundTimeoutMs = (isGossip || isCrdt)
          ? ((input.roundTimeoutMs as number) || GOSSIP_ROUND_TIMEOUT_MS_DEFAULT)
          : undefined;

        // ADR-0131 (T12): set `timeoutAt` for ALL threshold-based strategies
        // so the auto-status-transition predicate in _consensus({action:'status'})
        // can fire across bft/raft/quorum/weighted. Gossip and CRDT have their
        // own roundStartedAt/roundTimeoutMs settling mechanism — they retain
        // `timeoutAt: undefined` and bypass the auto-transition (their own
        // settle paths handle timeout-driven resolution per ADR-0120/ADR-0121).
        const isThresholdBased =
          strategy === 'bft' ||
          strategy === 'raft' ||
          strategy === 'quorum' ||
          strategy === 'weighted';
        const proposal: ConsensusProposal = {
          proposalId,
          type: (input.type as string) || 'general',
          value: input.value,
          proposedBy: (input.voterId as string) || 'system',
          proposedAt: new Date().toISOString(),
          votes: {},
          status: 'pending',
          strategy,
          term: strategy === 'raft' ? term : undefined,
          quorumPreset: strategy === 'quorum' ? quorumPreset : undefined,
          byzantineVoters: strategy === 'bft' ? [] : undefined,
          timeoutAt: isThresholdBased ? new Date(Date.now() + timeoutMs).toISOString() : undefined,
          // Gossip-only fields (ADR-0120 §Implementation §3).
          gossipRound: isGossip ? 0 : undefined,
          lastVoteChangedRound: isGossip ? 0 : undefined,
          totalNodes: isGossip ? totalNodes : undefined,
          currentRoundBroadcastSet: isGossip ? [] : undefined,
          roundTimeoutMs,
          roundStartedAt: (isGossip || isCrdt) ? new Date().toISOString() : undefined,
          // ADR-0121 (T3): CRDT triple is initialised empty at propose-time;
          // each subsequent vote merges the voter's snapshot into this
          // accumulator. `crdtExpectedVoters` snapshots the voter count so the
          // settle rule "all expected voters submitted" is stable across
          // workers joining mid-round (mirrors gossip's `totalNodes` snapshot).
          crdtState: isCrdt ? emptyCRDTState() : undefined,
          crdtExpectedVoters: isCrdt ? Math.max(1, totalNodes) : undefined,
        };

        state.consensus.pending.push(proposal);
        saveHiveState(state);

        return {
          action,
          proposalId,
          type: proposal.type,
          strategy,
          status: 'pending',
          required,
          totalNodes,
          term: proposal.term,
          quorumPreset: proposal.quorumPreset,
          timeoutAt: proposal.timeoutAt,
          // ADR-0120 (T2): expose gossip parameters so callers know the
          // expected round budget and timeout.
          gossipRound: proposal.gossipRound,
          gossipBound: isGossip ? gossipFanout(totalNodes) : undefined,
          roundTimeoutMs: proposal.roundTimeoutMs,
          // ADR-0121 (T3): expose CRDT round shape so callers know the
          // expected voter count and the empty-triple sentinel.
          crdtExpectedVoters: proposal.crdtExpectedVoters,
          crdtState: proposal.crdtState,
        };
      }

      if (action === 'vote') {
        // ADR-0131 (T12): reconcile §6 absence markers BEFORE evaluating
        // worker-failed status. The §6 contract writes
        // `worker-<id>-status: 'absent'` via _memory; this scan propagates
        // that into per-worker workerMeta.failedAt so the vote-time guard
        // observes the freshly-marked worker.
        if (reconcileFailedFromStatusKeys(state)) {
          saveHiveState(state);
        }

        const proposalId = input.proposalId as string;

        // ADR-0131 (T12) — ProposalAlreadyFailedError. A vote against a
        // proposal already moved to history (terminal state, including
        // 'failed-quorum-not-reached') throws synchronously. Per ADR-0131
        // §Specification invariants, votes against terminal proposals MUST
        // throw rather than silently no-op.
        const historicalRow = state.consensus.history.find(
          (h) => h.proposalId === proposalId,
        );
        if (historicalRow) {
          throw new ProposalAlreadyFailedError(
            proposalId,
            historicalRow.result,
          );
        }

        const proposal = state.consensus.pending.find(p => p.proposalId === proposalId);
        if (!proposal) {
          return { action, error: 'Proposal not found or already resolved' };
        }

        const voterId = input.voterId as string;
        if (!voterId) {
          return { action, error: 'voterId is required for voting' };
        }

        // ADR-0131 (T12) — WorkerAlreadyFailedError. A vote from a worker
        // whose failedAt !== null throws synchronously. Per ADR-0131
        // §Decision Outcome ("Worker-rejoin-after-marked-failed stance:
        // throw, not silent admission"), re-admitting a previously-marked-
        // absent voter would invalidate the absentVoters snapshot already
        // written to history. Re-spawn requires a NEW worker ID + retryOf.
        const voterMeta = workerMetaFor(state, voterId);
        if (voterMeta.failedAt !== null) {
          throw new WorkerAlreadyFailedError(voterId, voterMeta.failedAt);
        }

        const voteValue = input.vote as boolean;
        const proposalStrategy = proposal.strategy || 'raft';

        // ADR-0119 §Decision Outcome: weighted vote requires an elected queen
        // at vote-time too (not just propose-time). Covers the case where the
        // queen abdicated between propose and vote.
        if (proposalStrategy === 'weighted' && !state.queen) {
          throw new MissingQueenForWeightedConsensusError('vote');
        }

        // ────────────────────────────────────────────────────────────────
        // ADR-0121 (T3): CRDT vote branch.
        //
        // Per §Review-notes row 14 DEFER-TO-IMPL: the `vote` action overloads
        // its input shape — accepting an optional `crdtSnapshot` field
        // alongside (or in place of) the boolean `vote`. The boolean is
        // implicit: `true` if `crdtSnapshot.approvers.elements` contains the
        // voter, else derived from the explicit `vote` arg.
        //
        // Re-submission policy (row 12 DEFER-TO-IMPL — accept-and-let-LWW-
        // resolve): same voter writing twice is NOT rejected. The merge is
        // idempotent / the LWW tiebreaker handles same-millisecond collisions.
        // This contradicts the bft/raft/quorum double-vote rejection — we
        // short-circuit those checks for the CRDT branch below.
        //
        // Settle rule (row 10 DEFER-TO-IMPL — union of voter-count + timeoutMs):
        // round closes when DISTINCT voters submitted >= crdtExpectedVoters
        // OR the per-round timeout fires (mirrors gossip's bound + timeout
        // approach but with "all expected voters" as the bound rather than
        // ceil(log2(N))). Verdict comes from the LWW-Register's value().
        // ────────────────────────────────────────────────────────────────
        if (proposalStrategy === 'crdt') {
          // Validate optional crdtSnapshot shape per `feedback-no-fallbacks.md`.
          // If supplied, it MUST be a triple of `{ votes, approvers, verdict }`
          // — partial / malformed shapes throw rather than silently coerce.
          const rawSnapshot = (input.crdtSnapshot as unknown) ?? undefined;
          let snapshot: CRDTState | undefined;
          if (rawSnapshot !== undefined) {
            if (typeof rawSnapshot !== 'object' || rawSnapshot === null) {
              throw new Error(
                `hive-mind_consensus.vote: crdtSnapshot must be an object, got ${typeof rawSnapshot}`,
              );
            }
            const obj = rawSnapshot as Record<string, unknown>;
            if (!('votes' in obj) || !('approvers' in obj) || !('verdict' in obj)) {
              throw new Error(
                'hive-mind_consensus.vote: crdtSnapshot must contain { votes, approvers, verdict }',
              );
            }
            snapshot = obj as unknown as CRDTState;
          }

          // Build a local snapshot from the voter's contribution. Two paths:
          //   (a) caller provided crdtSnapshot — use it verbatim (already
          //       contains the voter's local state).
          //   (b) caller provided only `vote: boolean` — synthesise a
          //       minimal snapshot: GCounter increment for this voter,
          //       OR-Set add if approving, LWW-Register write of the proposal
          //       value as the verdict.
          const wallClockMs = Date.now();
          let voterSnapshot: CRDTState;
          if (snapshot !== undefined) {
            voterSnapshot = snapshot;
          } else {
            const g = new GCounter();
            g.increment(voterId);
            const aps = new ORSet<string>();
            const isApproving = voteValue === true;
            if (isApproving) aps.add(voterId, voterId);
            const reg = new LWWRegister<unknown>();
            // Write the proposal value as verdict only when approving;
            // a 'no' vote leaves the register untouched on this branch
            // (the proposal remains rejectable through the GCounter tally
            // if no approver writes overcome the empty verdict).
            if (isApproving) {
              reg.write(proposal.value, voterId, wallClockMs);
            }
            voterSnapshot = {
              votes: g.toJSON(),
              approvers: aps.toJSON(),
              verdict: reg.toJSON(),
            };
          }

          // Merge into the proposal's accumulator (initialised at propose-time).
          const before = proposal.crdtState ?? emptyCRDTState();
          proposal.crdtState = mergeCRDTState(before, voterSnapshot);

          // Track voter participation via the existing `votes` map.
          // Boolean is implicit per row 14: true if approvers contains voter,
          // else explicit `vote` value, else default false.
          const approverIds = ORSet.from<string>(proposal.crdtState.approvers).elements();
          const voterIsApprover = approverIds.includes(voterId);
          proposal.votes[voterId] = voterIsApprover ? true : (voteValue ?? false);

          // Settlement: all expected voters submitted, OR timeout fired.
          // Per ADR-0121 §Review-notes row 10 (DEFER-TO-IMPL): "round closes
          // when state.workers.length distinct voters have submitted, OR
          // after the same timeoutMs window the Raft strategy already uses".
          // We use crdtExpectedVoters (snapshot at propose-time) as the
          // distinct-voter bound — fixed across the round.
          const distinctVoters = Object.keys(proposal.votes).length;
          const expected = proposal.crdtExpectedVoters ?? Math.max(1, totalNodes);
          const allSubmitted = distinctVoters >= expected;

          // Per-round timeout (CRDT round timeout fires once roundTimeoutMs
          // has elapsed since proposal creation; we reuse roundStartedAt).
          let timedOut = false;
          if (proposal.roundStartedAt && proposal.roundTimeoutMs) {
            const elapsed = wallClockMs - new Date(proposal.roundStartedAt).getTime();
            if (elapsed >= proposal.roundTimeoutMs) timedOut = true;
          }

          let crdtResolution: 'approved' | 'rejected' | null = null;
          if (allSubmitted || timedOut) {
            // Resolution from the merged triple. Verdict = LWW-Register value;
            // approvers = OR-Set elements; vote count = GCounter value.
            // 'approved' iff approver count > 0 AND >= half of submitted votes
            // (simple majority of cast votes at settle time). Otherwise rejected.
            const approverCount = approverIds.length;
            const totalCast = distinctVoters;
            // Strict majority of cast votes were approvers, OR all approvers
            // when no dissent recorded. (Per §Pseudocode "verdict.value() is
            // the round's resolved verdict; approvers.elements() is the union
            // of approvers; votes.value() is the total approval count".)
            crdtResolution = approverCount > 0 && approverCount * 2 >= totalCast
              ? 'approved'
              : 'rejected';
            proposal.status = crdtResolution;
            state.consensus.history.push({
              proposalId: proposal.proposalId,
              type: proposal.type,
              result: crdtResolution,
              votes: { for: approverCount, against: Math.max(0, totalCast - approverCount) },
              decidedAt: new Date(wallClockMs).toISOString(),
              strategy: proposalStrategy,
            });
            state.consensus.pending = state.consensus.pending.filter(
              p => p.proposalId !== proposal.proposalId,
            );
          }

          saveHiveState(state);

          // Compute response telemetry.
          const verdictReg = LWWRegister.from(proposal.crdtState.verdict);
          const gcounter = GCounter.from(proposal.crdtState.votes);
          return {
            action,
            proposalId: proposal.proposalId,
            voterId,
            strategy: proposalStrategy,
            // Use approver count and dissent count (cast - approver) for
            // the response — analogous to votesFor/votesAgainst for other
            // strategies, but derived from the merged CRDT state.
            votesFor: approverIds.length,
            votesAgainst: Math.max(0, distinctVoters - approverIds.length),
            totalCast: distinctVoters,
            crdtExpectedVoters: expected,
            totalNodes,
            resolved: crdtResolution !== null,
            result: crdtResolution ?? undefined,
            status: proposal.status,
            // CRDT-specific telemetry surface.
            crdtState: proposal.crdtState,
            crdtVerdict: verdictReg.value(),
            crdtApprovers: approverIds,
            crdtVoteCount: gcounter.value(),
            crdtTimedOut: timedOut,
          };
        }

        const required = calculateRequiredVotes(
          proposalStrategy,
          totalNodes,
          proposal.quorumPreset,
        );

        // Prevent double-voting
        if (voterId in proposal.votes) {
          const previousVote = proposal.votes[voterId];
          if (previousVote === voteValue) {
            return {
              action,
              error: `Voter ${voterId} has already cast the same vote on this proposal`,
              proposalId: proposal.proposalId,
              existingVote: previousVote,
            };
          }
          // Conflicting vote from same voter
          if (proposalStrategy === 'bft') {
            // BFT: detect as Byzantine behavior
            if (!proposal.byzantineVoters) proposal.byzantineVoters = [];
            if (!proposal.byzantineVoters.includes(voterId)) {
              proposal.byzantineVoters.push(voterId);
            }
            // Remove their vote entirely -- Byzantine voter is excluded
            delete proposal.votes[voterId];
            saveHiveState(state);

            return {
              action,
              proposalId: proposal.proposalId,
              voterId,
              byzantineDetected: true,
              message: `Byzantine behavior detected: voter ${voterId} attempted conflicting vote. Vote invalidated.`,
              byzantineVoters: proposal.byzantineVoters,
              status: proposal.status,
            };
          }
          if (proposalStrategy === 'raft') {
            // Raft: only one vote per node per term, reject the change
            return {
              action,
              error: `Raft: voter ${voterId} already voted in term ${proposal.term}. Cannot change vote.`,
              proposalId: proposal.proposalId,
              term: proposal.term,
            };
          }
          // Quorum: reject double-vote
          return {
            action,
            error: `Voter ${voterId} has already voted on this proposal`,
            proposalId: proposal.proposalId,
          };
        }

        // BFT: check for cross-proposal Byzantine behavior
        if (proposalStrategy === 'bft') {
          const isByzantine = detectByzantineVoters(
            state.consensus.pending,
            proposal,
            voterId,
            voteValue,
          );
          if (isByzantine) {
            if (!proposal.byzantineVoters) proposal.byzantineVoters = [];
            if (!proposal.byzantineVoters.includes(voterId)) {
              proposal.byzantineVoters.push(voterId);
            }
            saveHiveState(state);
            return {
              action,
              proposalId: proposal.proposalId,
              voterId,
              byzantineDetected: true,
              message: `Byzantine behavior detected: voter ${voterId} cast conflicting votes across proposals of same type. Vote rejected.`,
              byzantineVoters: proposal.byzantineVoters,
              status: proposal.status,
            };
          }
        }

        // ADR-0120 (T2): gossip needs prior-tally snapshot to detect tally
        // mutation (drives lastVoteChangedRound). For non-gossip strategies
        // this is a no-op tracking variable.
        const priorVotesFor = Object.values(proposal.votes).filter(v => v).length;
        const priorVotesAgainst = Object.values(proposal.votes).filter(v => !v).length;

        // Record the vote
        proposal.votes[voterId] = voteValue;

        // ADR-0119 (T1): when proposalStrategy === 'weighted', report weighted
        // vote totals (queen contributes QUEEN_WEIGHT, workers contribute 1) so
        // the caller's view of `votesFor`/`votesAgainst` matches what
        // tryResolveProposal consumes against the weighted denominator.
        let votesFor: number;
        let votesAgainst: number;
        if (proposalStrategy === 'weighted') {
          // state.queen guaranteed defined by the precondition check above.
          const tally = weightedTally(proposal, state.queen!.agentId);
          votesFor = tally.votesFor;
          votesAgainst = tally.votesAgainst;
        } else {
          votesFor = Object.values(proposal.votes).filter(v => v).length;
          votesAgainst = Object.values(proposal.votes).filter(v => !v).length;
        }

        // ────────────────────────────────────────────────────────────────
        // ADR-0120 (T2): gossip propagation bookkeeping.
        //
        // On each vote (where strategy === 'gossip'):
        //   1. Update lastVoteChangedRound if the tally changed (drives the
        //      "quiescent round" clause of the settle predicate).
        //   2. Pick `fanout(N)` deterministic-per-round targets from the
        //      voter set, excluding self and already-broadcast set members.
        //   3. Add (voterId ∪ targets) to currentRoundBroadcastSet.
        //   4. If broadcastSet covers all voters, advance gossipRound and
        //      clear the set (round complete).
        //   5. Apply per-round timeout if elapsed > roundTimeoutMs.
        //   6. Settling decided by settleCheckGossip (NOT tryResolveProposal —
        //      gossip uses eventual-consistency semantics, not threshold-based
        //      resolution).
        //
        // Per ADR §Architecture: re-broadcasts in single-process MCP server
        // are bookkeeping only — peer voters observe the merged proposal on
        // their next vote/status call (state shared via state.consensus.pending).
        // ────────────────────────────────────────────────────────────────
        let resolution: 'approved' | 'rejected' | null = null;
        let resolved = false;
        let gossipSettleResult: GossipSettleStatus | undefined;

        if (proposalStrategy === 'gossip') {
          const gossipTotalNodes = proposal.totalNodes ?? Math.max(1, totalNodes);
          const gossipRound = proposal.gossipRound ?? 0;

          // (1) Update lastVoteChangedRound if tally changed.
          const tallyChanged =
            votesFor !== priorVotesFor || votesAgainst !== priorVotesAgainst;
          if (tallyChanged) {
            proposal.lastVoteChangedRound = gossipRound;
          }

          // (2) Voter set = all known workers AT VOTE-TIME (anti-entropy:
          // late joiners admitted into candidate pool but totalNodes is fixed).
          // Per §Refinement "Voter set changes mid-round": canonical voter set
          // is `state.workers`, so a worker that joined post-propose appears
          // in candidates without changing the round budget.
          const voterSet = [...state.workers];
          const fanoutSize = gossipFanout(gossipTotalNodes);
          const broadcastSet = new Set(proposal.currentRoundBroadcastSet ?? []);
          // (3) Always add the voter themselves to the round's broadcast set —
          // they have "broadcast from" their position by voting.
          broadcastSet.add(voterId);

          // Pick targets only when fanout > 0 (N > 1).
          if (fanoutSize > 0) {
            const targets = selectGossipTargets(
              proposal.proposalId,
              gossipRound,
              voterSet,
              broadcastSet,
              fanoutSize,
            );
            for (const t of targets) broadcastSet.add(t);
          }

          proposal.currentRoundBroadcastSet = [...broadcastSet];

          // (4) Round complete? Covers-all-voters check uses voterSet (not
          // totalNodes snapshot) so late joiners don't permanently block the
          // round. If voterSet is empty (no workers joined) the round trivially
          // completes.
          const voterSetCanonical = voterSet.length === 0 ? [] : [...voterSet].sort();
          const coversAll = voterSetCanonical.length === 0
            || voterSetCanonical.every(v => broadcastSet.has(v));
          if (coversAll) {
            proposal.gossipRound = gossipRound + 1;
            proposal.currentRoundBroadcastSet = [];
            proposal.roundStartedAt = new Date().toISOString();
          }

          // (5) Per-round timeout (force-advance if a round has been open too long).
          maybeAdvanceGossipRoundOnTimeout(proposal);

          // (6) Settle predicate.
          gossipSettleResult = settleCheckGossip(proposal);
          if (gossipSettleResult.settled && gossipSettleResult.result) {
            resolution = gossipSettleResult.result;
            resolved = true;
            proposal.status = resolution;
          } else if (gossipSettleResult.exhausted) {
            // Hard budget exhausted: per `feedback-no-fallbacks.md`, do NOT
            // silently coerce to a settled tally. Surface explicitly via the
            // response payload; status stays 'pending' so callers can decide
            // (retry / escalate / treat as inconclusive). Proposal is NOT
            // moved to history because it didn't resolve.
            // resolved stays false.
          }
        } else {
          // Non-gossip: existing tryResolveProposal path.
          resolution = tryResolveProposal(proposal, totalNodes, state.queen?.agentId);
        }

        // Move to history if resolved (unified for gossip + non-gossip).
        if (resolution !== null) {
          resolved = true;
          proposal.status = resolution;
          state.consensus.history.push({
            proposalId: proposal.proposalId,
            type: proposal.type,
            result: resolution,
            votes: { for: votesFor, against: votesAgainst },
            decidedAt: new Date().toISOString(),
            strategy: proposalStrategy,
            term: proposal.term,
            byzantineDetected: proposal.byzantineVoters?.length ? proposal.byzantineVoters : undefined,
          });
          state.consensus.pending = state.consensus.pending.filter(
            p => p.proposalId !== proposal.proposalId,
          );
        }

        saveHiveState(state);

        return {
          action,
          proposalId: proposal.proposalId,
          voterId,
          vote: voteValue,
          strategy: proposalStrategy,
          votesFor,
          votesAgainst,
          required,
          totalNodes,
          resolved,
          result: resolved ? resolution : undefined,
          status: proposal.status,
          term: proposal.term,
          byzantineVoters: proposal.byzantineVoters?.length ? proposal.byzantineVoters : undefined,
          // ADR-0120 (T2): gossip-only telemetry on vote response.
          gossipRound: proposal.gossipRound,
          lastVoteChangedRound: proposal.lastVoteChangedRound,
          gossipBound: proposalStrategy === 'gossip'
            ? gossipFanout(proposal.totalNodes ?? totalNodes)
            : undefined,
          settled: gossipSettleResult?.settled,
          exhausted: gossipSettleResult?.exhausted,
        };
      }

      if (action === 'status') {
        // ADR-0131 (T12) — reconcile §6 prompt-protocol absence markers BEFORE
        // looking at the proposal. The §6 contract instructs the queen LLM to
        // write `worker-<id>-status: 'absent'` via _memory; this scan
        // propagates that marker into per-worker workerMeta.failedAt so the
        // auto-transition's `absentVoters` snapshot is current.
        const reconciled = reconcileFailedFromStatusKeys(state);
        if (reconciled) {
          saveHiveState(state);
        }

        const proposal = state.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) {
          // Check history
          const historical = state.consensus.history.find(h => h.proposalId === input.proposalId);
          if (historical) {
            return {
              action,
              ...historical,
              historical: true,
              resolved: true,
              // ADR-0131 (T12): subsequent calls for an already-transitioned
              // proposal return the historical row with statusJustTransitioned: false.
              statusJustTransitioned: false,
            };
          }
          return { action, error: 'Proposal not found' };
        }

        const proposalStrategy = proposal.strategy || 'raft';
        // ADR-0119 (T1): mirror vote-handler accounting — when proposal is
        // weighted, report weighted tallies so callers get a coherent view of
        // votesFor/votesAgainst against the weighted `required` denominator.
        let votesFor: number;
        let votesAgainst: number;
        if (proposalStrategy === 'weighted' && state.queen) {
          const tally = weightedTally(proposal, state.queen.agentId);
          votesFor = tally.votesFor;
          votesAgainst = tally.votesAgainst;
        } else {
          votesFor = Object.values(proposal.votes).filter(v => v).length;
          votesAgainst = Object.values(proposal.votes).filter(v => !v).length;
        }
        const required = calculateRequiredVotes(
          proposalStrategy,
          totalNodes,
          proposal.quorumPreset,
        );

        // Raft: check timeout
        let timedOut = false;
        if (proposalStrategy === 'raft' && proposal.timeoutAt) {
          timedOut = new Date().getTime() > new Date(proposal.timeoutAt).getTime();
        }

        // ADR-0131 (T12) — auto-status-transition for ALL threshold-based
        // strategies (bft/raft/quorum/weighted). Predicate per
        // ADR-0131 §Specification:
        //   `Date.now() >= proposal.timeoutAt && totalVotes < required`
        // On trigger: status flips to 'failed-quorum-not-reached',
        // absentVoters populated, proposal moved from pending to history,
        // state saved.
        //
        // Strategy-agnostic at the dispatch boundary; the threshold is
        // already strategy-aware via calculateRequiredVotes (T1/T2/T3 extended
        // it to weighted/gossip/crdt). Gossip and CRDT have their own
        // settle paths and timeoutAt is undefined for them, so the predicate
        // never trips on those branches — the existing settle-check paths
        // handle their timeout-driven resolution.
        let statusJustTransitioned = false;
        if (
          proposal.timeoutAt &&
          Date.now() >= new Date(proposal.timeoutAt).getTime() &&
          proposal.status === 'pending' &&
          Object.keys(proposal.votes).length < required
        ) {
          // Compute absentVoters: workers in state.workers who didn't vote.
          // Per ADR-0131 §Specification: `state.workers.filter(w => !(w.id in proposal.votes))`
          // — the WorkerEntry shape is keyed by worker ID; state.workers is
          // string[] of IDs in the current schema, so filter by membership.
          const absentVoters = state.workers.filter(
            (workerId) => !(workerId in proposal.votes),
          );

          // Mutate proposal status to the verbatim contract literal per
          // ADR-0131 §Decision. Downstream tests assert on the exact literal.
          proposal.status = 'failed-quorum-not-reached';
          proposal.absentVoters = absentVoters;

          // Idempotency guard per ADR-0131 §Refinement edge case
          // "Concurrent transitions": dedupe on proposalId before pushing
          // to history. Two callers serialising via saveHiveState's lock —
          // the second observes the proposal already in history and skips.
          const alreadyInHistory = state.consensus.history.some(
            (h) => h.proposalId === proposal.proposalId,
          );
          if (!alreadyInHistory) {
            // Append to history with the failed-quorum-not-reached marker
            // and the absentVoters snapshot per ADR-0131 §Architecture data flow.
            state.consensus.history.push({
              proposalId: proposal.proposalId,
              type: proposal.type,
              result: 'failed-quorum-not-reached',
              votes: { for: votesFor, against: votesAgainst },
              decidedAt: new Date().toISOString(),
              strategy: proposalStrategy,
              term: proposal.term,
              absentVoters,
            });
          }

          // Remove from pending.
          state.consensus.pending = state.consensus.pending.filter(
            (p) => p.proposalId !== proposal.proposalId,
          );
          saveHiveState(state);
          statusJustTransitioned = true;
        }

        // ADR-0120 (T2): gossip settle_check folds into the status action
        // (per ADR-0120 §Review notes row 5 DEFER-TO-IMPL: extend `status` to
        // surface the predicate). Status invocation may mutate state via
        // maybeAdvanceGossipRoundOnTimeout — if a timeout fires, we must
        // persist + move to history if settled.
        let gossipSettleResult: GossipSettleStatus | undefined;
        let gossipResolved = false;
        let gossipResult: 'approved' | 'rejected' | undefined;
        if (proposalStrategy === 'gossip') {
          const advanced = maybeAdvanceGossipRoundOnTimeout(proposal);
          gossipSettleResult = settleCheckGossip(proposal);
          if (gossipSettleResult.settled && gossipSettleResult.result) {
            gossipResult = gossipSettleResult.result;
            gossipResolved = true;
            proposal.status = gossipResult;
            // Move to history (mirrors vote-action resolution path).
            state.consensus.history.push({
              proposalId: proposal.proposalId,
              type: proposal.type,
              result: gossipResult,
              votes: { for: votesFor, against: votesAgainst },
              decidedAt: new Date().toISOString(),
              strategy: proposalStrategy,
            });
            state.consensus.pending = state.consensus.pending.filter(
              p => p.proposalId !== proposal.proposalId,
            );
            saveHiveState(state);
          } else if (advanced) {
            // Timeout-driven mutation, no settle yet — still need to persist.
            saveHiveState(state);
          }
        }

        // ADR-0121 (T3): CRDT status surfaces the merged triple + a
        // timeout-driven force-settle path. Mirrors gossip's status branch
        // (row 10 DEFER-TO-IMPL: union of voter-count + timeoutMs).
        let crdtTimedOut = false;
        let crdtResolved = false;
        let crdtResult: 'approved' | 'rejected' | undefined;
        let crdtVerdictValue: unknown;
        let crdtApproverList: string[] = [];
        let crdtVoteTotal = 0;
        if (proposalStrategy === 'crdt' && proposal.crdtState) {
          const verdictReg = LWWRegister.from(proposal.crdtState.verdict);
          const approverSet = ORSet.from<string>(proposal.crdtState.approvers);
          const gcounter = GCounter.from(proposal.crdtState.votes);
          crdtVerdictValue = verdictReg.value();
          crdtApproverList = approverSet.elements();
          crdtVoteTotal = gcounter.value();

          // Timeout check.
          if (proposal.roundStartedAt && proposal.roundTimeoutMs) {
            const elapsed = Date.now() - new Date(proposal.roundStartedAt).getTime();
            if (elapsed >= proposal.roundTimeoutMs) crdtTimedOut = true;
          }

          // Force-settle if all expected voters submitted OR timeout fired.
          const distinctVoters = Object.keys(proposal.votes).length;
          const expected = proposal.crdtExpectedVoters ?? 1;
          if (distinctVoters >= expected || crdtTimedOut) {
            const approverCount = crdtApproverList.length;
            const totalCast = distinctVoters;
            crdtResult = approverCount > 0 && approverCount * 2 >= totalCast
              ? 'approved'
              : 'rejected';
            crdtResolved = true;
            proposal.status = crdtResult;
            state.consensus.history.push({
              proposalId: proposal.proposalId,
              type: proposal.type,
              result: crdtResult,
              votes: { for: approverCount, against: Math.max(0, totalCast - approverCount) },
              decidedAt: new Date().toISOString(),
              strategy: proposalStrategy,
            });
            state.consensus.pending = state.consensus.pending.filter(
              p => p.proposalId !== proposal.proposalId,
            );
            saveHiveState(state);
          }
        }

        return {
          action,
          proposalId: proposal.proposalId,
          type: proposal.type,
          strategy: proposalStrategy,
          status: proposal.status,
          votesFor,
          votesAgainst,
          totalVotes: Object.keys(proposal.votes).length,
          required,
          totalNodes,
          resolved: gossipResolved || crdtResolved || statusJustTransitioned,
          result: gossipResolved ? gossipResult : (crdtResolved ? crdtResult : undefined),
          term: proposal.term,
          quorumPreset: proposal.quorumPreset,
          byzantineVoters: proposal.byzantineVoters?.length ? proposal.byzantineVoters : undefined,
          timedOut,
          timeoutAt: proposal.timeoutAt,
          hint: timedOut ? `Raft timeout reached. Re-propose with term ${(proposal.term || 1) + 1}.` : undefined,
          // ADR-0131 (T12): auto-status-transition surface. statusJustTransitioned
          // is true on the call that fired the transition; false on subsequent
          // calls (proposal already in history). absentVoters is the snapshot
          // of state.workers IDs that didn't cast a vote when the predicate fired.
          statusJustTransitioned,
          absentVoters: statusJustTransitioned ? proposal.absentVoters : undefined,
          // ADR-0120 (T2): gossip-only telemetry on status response.
          gossipRound: proposal.gossipRound,
          lastVoteChangedRound: proposal.lastVoteChangedRound,
          gossipBound: gossipSettleResult?.bound,
          settled: gossipSettleResult?.settled,
          exhausted: gossipSettleResult?.exhausted,
          noVotes: gossipSettleResult?.noVotes,
          // ADR-0121 (T3): CRDT-only telemetry on status response.
          crdtState: proposalStrategy === 'crdt' ? proposal.crdtState : undefined,
          crdtVerdict: proposalStrategy === 'crdt' ? crdtVerdictValue : undefined,
          crdtApprovers: proposalStrategy === 'crdt' ? crdtApproverList : undefined,
          crdtVoteCount: proposalStrategy === 'crdt' ? crdtVoteTotal : undefined,
          crdtExpectedVoters: proposal.crdtExpectedVoters,
          crdtTimedOut: proposalStrategy === 'crdt' ? crdtTimedOut : undefined,
        };
      }

      if (action === 'list') {
        return {
          action,
          pending: state.consensus.pending.map(p => ({
            proposalId: p.proposalId,
            type: p.type,
            strategy: p.strategy || 'raft',
            proposedAt: p.proposedAt,
            totalVotes: Object.keys(p.votes).length,
            required: calculateRequiredVotes(
              p.strategy || 'raft',
              totalNodes,
              p.quorumPreset,
            ),
            term: p.term,
            status: p.status,
          })),
          recentHistory: state.consensus.history.slice(-5),
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    name: 'hive-mind_broadcast',
    description: 'Broadcast message to all workers',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to broadcast' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Message priority' },
        fromId: { type: 'string', description: 'Sender agent ID' },
      },
      required: ['message'],
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized' };
      }

      const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Store in shared memory (ADR-0122 T4: wrap broadcasts in typed entry).
      // Broadcasts are operational system state — type='system'/permanent — so
      // they survive sweeps unless cleared by the trim-to-100 logic below.
      const now = Date.now();
      const existing = state.sharedMemory.broadcasts;
      const priorMessages = (existing && isMemoryEntryShape(existing) && Array.isArray(existing.value))
        ? (existing.value as Array<unknown>)
        : [];
      priorMessages.push({
        messageId,
        message: input.message,
        priority: input.priority || 'normal',
        fromId: input.fromId || 'system',
        timestamp: new Date().toISOString(),
      });

      // Keep only last 100 broadcasts
      state.sharedMemory.broadcasts = {
        value: priorMessages.slice(-100),
        type: 'system',
        ttlMs: null,
        expiresAt: null,
        createdAt: existing && isMemoryEntryShape(existing) ? existing.createdAt : now,
        updatedAt: now,
      };
      saveHiveState(state);

      return {
        success: true,
        messageId,
        recipients: state.workers.length,
        priority: input.priority || 'normal',
        broadcastAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'hive-mind_shutdown',
    description: 'Shutdown the hive-mind and terminate all workers',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        graceful: { type: 'boolean', description: 'Graceful shutdown (wait for pending tasks)', default: true },
        force: { type: 'boolean', description: 'Force immediate shutdown', default: false },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized or already shut down' };
      }

      const graceful = input.graceful !== false;
      const force = input.force === true;
      const workerCount = state.workers.length;
      const pendingConsensus = state.consensus.pending.length;

      // If graceful and there are pending consensus items, warn (unless forced)
      if (graceful && pendingConsensus > 0 && !force) {
        return {
          success: false,
          error: `Cannot gracefully shutdown with ${pendingConsensus} pending consensus items. Use force: true to override.`,
          pendingConsensus,
          workerCount,
        };
      }

      // Clear workers from agent store
      const agentStore = loadAgentStore();
      for (const workerId of state.workers) {
        if (agentStore.agents[workerId]) {
          delete agentStore.agents[workerId];
        }
      }
      saveAgentStore(agentStore);

      // Reset hive state
      const shutdownTime = new Date().toISOString();
      const previousQueen = state.queen?.agentId;

      state.initialized = false;
      state.queen = undefined;
      state.workers = [];
      state.consensus.pending = [];
      // Keep history for reference
      state.sharedMemory = {};
      saveHiveState(state);

      // ADR-0122 (T4): clear the periodic sweep timer. MUST run on shutdown
      // or the timer leaks across hive sessions and re-init creates a duplicate.
      stopHiveMindSweepTimer();

      return {
        success: true,
        shutdownAt: shutdownTime,
        graceful,
        workersTerminated: workerCount,
        previousQueen,
        consensusCleared: pendingConsensus,
        message: `Hive-mind shutdown complete. ${workerCount} workers terminated.`,
      };
    },
  },
  {
    name: 'hive-mind_memory',
    description: 'Access hive shared memory (ADR-0122: 8 typed memory types with TTL)',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete', 'list'], description: 'Memory action' },
        key: { type: 'string', description: 'Memory key' },
        value: { description: 'Value to store (for set)' },
        // ADR-0122: required on `set`; missing/unknown throws (no silent default).
        type: {
          type: 'string',
          enum: ['knowledge', 'context', 'task', 'result', 'error', 'metric', 'consensus', 'system'],
          description: 'Memory type (required for set; one of 8 USERGUIDE types). Optional filter on list.',
        },
        ttlMs: {
          type: 'number',
          description: 'Override TTL in ms (default per type from USERGUIDE)',
        },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const action = input.action as string;
      const key = input.key as string;

      // ADR-0122 (T4): ALL four actions run inside withHiveStoreLock because
      // get/list mutate state.sharedMemory during lazy eviction. The previous
      // lock-free read fast path is forfeit — required for correctness when
      // eviction can race writers.

      if (action === 'get') {
        if (!key) return { action, error: 'Key required' };
        return withHiveStoreLock(async () => {
          const state = loadHiveState();
          const entry = state.sharedMemory[key];
          if (entry === undefined) {
            return { action, key, value: undefined, exists: false };
          }
          if (isExpired(entry)) {
            // Lazy eviction: drop and persist. Caller never observes expired data.
            delete state.sharedMemory[key];
            saveHiveState(state);
            return { action, key, value: undefined, exists: false, evicted: true };
          }
          return {
            action,
            key,
            value: entry.value,
            exists: true,
            type: entry.type,
            ttlMs: entry.ttlMs,
            expiresAt: entry.expiresAt,
          };
        });
      }

      if (action === 'list') {
        return withHiveStoreLock(async () => {
          const state = loadHiveState();
          const filterType = input.type as MemoryType | undefined;
          // Validate filter type if supplied (fail-loud per feedback-no-fallbacks).
          if (filterType !== undefined && !isMemoryType(filterType)) {
            throw new InvalidMemoryTypeError(filterType);
          }
          const keys: string[] = [];
          let mutated = false;
          const now = Date.now();
          for (const [k, entry] of Object.entries(state.sharedMemory)) {
            if (isExpired(entry, now)) {
              delete state.sharedMemory[k];
              mutated = true;
              continue;
            }
            if (filterType && entry.type !== filterType) continue;
            keys.push(k);
          }
          if (mutated) saveHiveState(state);
          return {
            action,
            keys,
            count: keys.length,
            ...(filterType ? { type: filterType } : {}),
          };
        });
      }

      // ADR-0104 §5: load → mutate → save under cross-process lock.
      // §6's parallel Task workers calling hive-mind_memory({action:'set'})
      // would race-clobber without this.
      //
      // ADR-0122 (T4): `type` is REQUIRED. A missing/unknown `type` argument
      // throws synchronously per feedback-no-fallbacks — silently defaulting
      // to 'system' (permanent) would mis-route a caller who forgot
      // `type: 'task'` (30-min TTL) into permanent retention.
      if (action === 'set') {
        if (!key) return { action, error: 'Key required' };

        // Validate BEFORE acquiring the lock. No partial write on either throw.
        const rawType = input.type;
        if (rawType === undefined) {
          throw new MissingMemoryTypeError();
        }
        if (!isMemoryType(rawType)) {
          throw new InvalidMemoryTypeError(rawType);
        }
        const memoryType: MemoryType = rawType;

        const rawTtlMs = input.ttlMs;
        if (rawTtlMs !== undefined && rawTtlMs !== null) {
          if (typeof rawTtlMs !== 'number' || !Number.isFinite(rawTtlMs)) {
            throw new InvalidTTLError(rawTtlMs);
          }
        }
        const ttlMs: number | null = (rawTtlMs === undefined || rawTtlMs === null)
          ? DEFAULT_TTL_MS_BY_TYPE[memoryType]
          : (rawTtlMs as number);

        return withHiveStoreLock(async () => {
          const state = loadHiveState();
          const now = Date.now();
          const expiresAt: number | null = ttlMs === null ? null : now + ttlMs;
          const prior = state.sharedMemory[key];
          state.sharedMemory[key] = {
            value: input.value,
            type: memoryType,
            ttlMs,
            expiresAt,
            createdAt: (prior && isMemoryEntryShape(prior)) ? prior.createdAt : now,
            updatedAt: now,
          };
          saveHiveState(state);
          return {
            action,
            key,
            success: true,
            type: memoryType,
            ttlMs,
            expiresAt,
            updatedAt: new Date(now).toISOString(),
          };
        });
      }

      if (action === 'delete') {
        if (!key) return { action, error: 'Key required' };
        return withHiveStoreLock(async () => {
          const state = loadHiveState();
          const existed = key in state.sharedMemory;
          delete state.sharedMemory[key];
          saveHiveState(state);
          return {
            action,
            key,
            deleted: existed,
          };
        });
      }

      return { action, error: 'Unknown action' };
    },
  },
];

// ── ADR-0122 (T4): periodic sweep timer lifecycle ──────────────────────
//
// Bounds memory growth for entries no caller touches between TTL expiry
// and the next get/list. Default 60s, env-overridable via
// CLAUDE_FLOW_HIVE_SWEEP_MS (per ADR-0118 review-notes-triage row 19;
// CLAUDE_FLOW_* is the runtime convention, NOT RUFLO_*).
//
// Lifecycle: registered by startHiveMindSweepTimer() on hive-mind_init,
// cleared by stopHiveMindSweepTimer() on hive-mind_shutdown. Handle is
// module-scoped so the timer persists across handler invocations within
// the same process. Multiple init calls without intervening shutdown
// reuse the existing handle (no duplicate timer).

let sweepHandle: ReturnType<typeof setInterval> | null = null;

function getSweepIntervalMs(): number {
  const raw = process.env.CLAUDE_FLOW_HIVE_SWEEP_MS;
  if (raw === undefined || raw === '') return 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60_000;
  return parsed;
}

async function performSweep(): Promise<void> {
  await withHiveStoreLock(async () => {
    const state = loadHiveState();
    let mutated = false;
    const now = Date.now();
    for (const [key, entry] of Object.entries(state.sharedMemory)) {
      if (isExpired(entry, now)) {
        delete state.sharedMemory[key];
        mutated = true;
      }
    }
    if (mutated) saveHiveState(state);
  });
}

export function startHiveMindSweepTimer(): void {
  if (sweepHandle !== null) return; // already running
  const intervalMs = getSweepIntervalMs();
  sweepHandle = setInterval(() => {
    // Sweep errors are logged: lazy eviction guarantees correctness, sweep
    // is hygiene-only.
    performSweep().catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[hive-mind] sweep cycle failed:', err instanceof Error ? err.message : String(err));
    });
  }, intervalMs);
  // Don't keep Node alive on sweep timer alone (relevant for short-lived MCP runners).
  if (typeof sweepHandle.unref === 'function') sweepHandle.unref();
}

export function stopHiveMindSweepTimer(): void {
  if (sweepHandle !== null) {
    clearInterval(sweepHandle);
    sweepHandle = null;
  }
}

// Test-only accessor for the active sweep handle.
export function _getSweepHandleForTest(): unknown {
  return sweepHandle;
}

// Test-only export for direct sweep invocation (lets tests advance fake
// timers and observe sweep behaviour without scheduling jitter).
export async function _performSweepForTest(): Promise<void> {
  return performSweep();
}

// ── ADR-0123 (T5): cache test/operator surface ────────────────────────────
//
// Exposed for: test fixtures (reset between cases), operator metrics, and
// daemon-side cross-process invalidation hints (a future ADR-side feature).

/**
 * Reset the LRU cache and re-read CLAUDE_FLOW_HIVE_CACHE_MAX. Test fixtures
 * call this between cases to guarantee a clean cache state. Production code
 * should never need this — cache invalidation happens via saveHiveState
 * write-through.
 */
export function _resetHiveCacheForTest(): void {
  hiveCache = new HiveLRU(getCacheCapacity());
  tmpCounter = 0;
}

/**
 * Snapshot the LRU cache stats. Hits/misses/evictions counters are
 * cumulative across the process lifetime; size is current.
 *
 * Per ADR-0123 §92 "eviction-rate metric makes the under-sizing case
 * observable": operators tune CLAUDE_FLOW_HIVE_CACHE_MAX based on the
 * evictions/hits ratio.
 */
export function getHiveCacheStats(): { hits: number; misses: number; evictions: number; size: number } {
  return hiveCache.stats();
}

/**
 * Invalidate the cached doc. Called when external state may have shifted
 * out from under us (e.g., a daemon-side write that this CLI process did
 * not perform). T5 currently has no cross-process invalidation channel —
 * this hook exists for completeness and is unused on the happy path.
 *
 * Per ADR-0123 §50 "Cross-process cache coherency is punted": this is
 * documentation that the hook exists for the future, not a load-bearing
 * mechanism today.
 */
export function invalidateHiveCache(): void {
  hiveCache.delete(HIVE_STATE_DOC_KEY);
}
