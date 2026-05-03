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
  unlinkSync,
  statSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, findProjectRoot } from './types.js';

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

const MEMORY_TYPES: readonly MemoryType[] = [
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

interface HiveState {
  initialized: boolean;
  topology: 'mesh' | 'hierarchical' | 'ring' | 'star';
  queen?: {
    agentId: string;
    electedAt: string;
    term: number;
  };
  workers: string[];
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

type ConsensusStrategy = 'bft' | 'raft' | 'quorum' | 'weighted';
type QuorumPreset = 'unanimous' | 'majority' | 'supermajority';

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

interface ConsensusProposal {
  proposalId: string;
  type: string;
  value: unknown;
  proposedBy: string;
  proposedAt: string;
  votes: Record<string, boolean>;
  status: 'pending' | 'approved' | 'rejected';
  strategy: ConsensusStrategy;
  term?: number;              // Raft: term number
  quorumPreset?: QuorumPreset; // Quorum: threshold preset
  byzantineVoters?: string[]; // BFT: detected Byzantine voters
  timeoutAt?: string;         // Raft: timeout for re-proposal
}

interface ConsensusResult {
  proposalId: string;
  type: string;
  result: 'approved' | 'rejected';
  votes: { for: number; against: number };
  decidedAt: string;
  strategy: ConsensusStrategy;
  term?: number;
  byzantineDetected?: string[];
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

function getHiveDir(): string {
  return join(findProjectRoot(), STORAGE_DIR, HIVE_DIR);
}

function getHivePath(): string {
  return join(getHiveDir(), HIVE_FILE);
}

function ensureHiveDir(): void {
  const dir = getHiveDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadHiveState(): HiveState {
  try {
    const path = getHivePath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(data) as HiveState;
      // ADR-0122 (T4): migrate legacy untyped entries on read. Non-destructive:
      // no value mutated, no entry dropped. Per feedback-data-loss-zero-tolerance,
      // even malformed legacy entries (undefined/null) are preserved as
      // `{ value: <that>, type: 'system', ttlMs: null, expiresAt: null, ... }`.
      if (parsed && typeof parsed === 'object' && parsed.sharedMemory) {
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
      return parsed;
    }
  } catch {
    // Return default state on error
  }
  return {
    initialized: false,
    topology: 'mesh',
    workers: [],
    consensus: { pending: [], history: [] },
    sharedMemory: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function saveHiveState(state: HiveState): void {
  ensureHiveDir();
  state.updatedAt = new Date().toISOString();
  // ADR-0104 §5: atomic write (tmp + rename) — prevents partial writes / torn JSON
  // when contended with concurrent readers. Pairs with withHiveStoreLock for writers.
  const path = getHivePath();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, path);
}

// ADR-0104 §5: cross-process file lock for hive-state.json read-modify-write,
// modeled on ADR-0098's swarm-state lock. O_EXCL sentinel + stale-lock recovery.
async function withHiveStoreLock<T>(fn: () => Promise<T>): Promise<T> {
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
    description: 'Spawn workers and automatically join them to the hive-mind (combines agent/spawn + hive-mind/join)',
    category: 'hive-mind',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of workers to spawn (default: 1)', default: 1 },
        role: { type: 'string', enum: ['worker', 'specialist', 'scout'], description: 'Worker role in hive', default: 'worker' },
        agentType: { type: 'string', description: 'Agent type for spawned workers', default: 'worker' },
        prefix: { type: 'string', description: 'Prefix for worker IDs', default: 'hive-worker' },
      },
    },
    handler: async (input) => {
      const state = loadHiveState();

      if (!state.initialized) {
        return { success: false, error: 'Hive-mind not initialized. Run hive-mind/init first.' };
      }

      const count = Math.min(Math.max(1, (input.count as number) || 1), 20); // Cap at 20
      const role = (input.role as string) || 'worker';
      const agentType = (input.agentType as string) || 'worker';
      const prefix = (input.prefix as string) || 'hive-worker';
      const agentStore = loadAgentStore();

      const spawnedWorkers: Array<{ agentId: string; role: string; joinedAt: string }> = [];

      for (let i = 0; i < count; i++) {
        const agentId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Create agent record (like agent/spawn)
        agentStore.agents[agentId] = {
          agentId,
          agentType,
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

        spawnedWorkers.push({
          agentId,
          role,
          joinedAt: new Date().toISOString(),
        });
      }

      saveAgentStore(agentStore);
      saveHiveState(state);

      return {
        success: true,
        spawned: count,
        workers: spawnedWorkers,
        totalWorkers: state.workers.length,
        hiveStatus: 'active',
        message: `Spawned ${count} worker(s) and joined them to the hive-mind`,
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
      },
    },
    handler: async (input) => {
      const state = loadHiveState();
      const hiveId = `hive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const queenId = (input.queenId as string) || `queen-${Date.now()}`;

      state.initialized = true;
      state.topology = (input.topology as HiveState['topology']) || 'mesh';
      state.createdAt = new Date().toISOString();
      state.queen = {
        agentId: queenId,
        electedAt: new Date().toISOString(),
        term: 1,
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
        } : { id: 'N/A', status: 'offline', load: 0, tasksQueued: 0 },
        workers: state.workers.map(w => {
          const agent = agentStore.agents[w] as Record<string, unknown> | undefined;
          return {
            id: w,
            type: (agent?.agentType as string) || 'worker',
            status: (agent?.status as string) || 'unknown',
            currentTask: (agent?.currentTask as string) || null,
            tasksCompleted: (agent?.taskCount as number) || 0,
          };
        }),
        metrics: {
          totalTasks: pendingTaskCount + activeTaskCount + completedTaskCount,
          completedTasks: completedTaskCount,
          activeTasks: activeTaskCount,
          pendingTasks: pendingTaskCount,
          failedTasks: 0,
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
    description: 'Propose or vote on consensus with BFT, Raft, or Quorum strategies',
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
        // 'byzantine' is an alias for 'bft' (carry-forward from ADR-0106 R1 per
        // ADR-0118 review-notes-triage 2026-05-02); normalized to 'bft' at handler entry.
        strategy: { type: 'string', enum: ['bft', 'raft', 'quorum', 'weighted', 'byzantine'], description: 'Consensus strategy (default: raft). "byzantine" is an alias for "bft".' },
        quorumPreset: { type: 'string', enum: ['unanimous', 'majority', 'supermajority'], description: 'Quorum threshold preset (for quorum strategy, default: majority)' },
        term: { type: 'number', description: 'Term number (for raft strategy)' },
        timeoutMs: { type: 'number', description: 'Timeout in ms for raft re-proposal (default: 30000)' },
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
          timeoutAt: strategy === 'raft' ? new Date(Date.now() + timeoutMs).toISOString() : undefined,
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
        };
      }

      if (action === 'vote') {
        const proposal = state.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) {
          return { action, error: 'Proposal not found or already resolved' };
        }

        const voterId = input.voterId as string;
        if (!voterId) {
          return { action, error: 'voterId is required for voting' };
        }

        const voteValue = input.vote as boolean;
        const proposalStrategy = proposal.strategy || 'raft';

        // ADR-0119 §Decision Outcome: weighted vote requires an elected queen
        // at vote-time too (not just propose-time). Covers the case where the
        // queen abdicated between propose and vote.
        if (proposalStrategy === 'weighted' && !state.queen) {
          throw new MissingQueenForWeightedConsensusError('vote');
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

        // Try to resolve — pass queenId for the weighted branch (ignored otherwise).
        const resolution = tryResolveProposal(proposal, totalNodes, state.queen?.agentId);
        let resolved = false;

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
        };
      }

      if (action === 'status') {
        const proposal = state.consensus.pending.find(p => p.proposalId === input.proposalId);
        if (!proposal) {
          // Check history
          const historical = state.consensus.history.find(h => h.proposalId === input.proposalId);
          if (historical) {
            return { action, ...historical, historical: true, resolved: true };
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
          resolved: false,
          term: proposal.term,
          quorumPreset: proposal.quorumPreset,
          byzantineVoters: proposal.byzantineVoters?.length ? proposal.byzantineVoters : undefined,
          timedOut,
          timeoutAt: proposal.timeoutAt,
          hint: timedOut ? `Raft timeout reached. Re-propose with term ${(proposal.term || 1) + 1}.` : undefined,
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
