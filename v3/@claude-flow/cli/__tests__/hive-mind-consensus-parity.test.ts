/**
 * Parity harness — `buildConsensusResponse(...)` vs cli handler (ADR-0185 Wave 1)
 *
 * Drives the cli's pre-flip `hive-mind_consensus` handler (in
 * `hive-mind-tools.ts`) and the response-builder (`hive-mind-consensus-response.ts`)
 * against the same post-mutation state, and asserts the responses match.
 *
 * Coverage taxonomy (per ADR-0185 Wave 1 plan, DA-reviewed):
 *
 *   - propose × {bft, raft, quorum, weighted, gossip, crdt}      (6 cells)
 *   - vote × {bft, raft, quorum, weighted, gossip, crdt}         (6 cells)
 *   - status × {bft, raft, quorum, weighted, gossip, crdt}       (6 cells)
 *   - list                                                       (1 cell)
 *   - status × bft with `timeoutAt` in the past (ADR-0131)       (1 cell)
 *   - status × raft with `timeoutAt` in the past                  (1 cell)
 *   - status × any strategy against history-row                   (1 cell)
 *   - vote × gossip with `gossipExhausted` flag                   (1 cell)
 *   - vote × bft with pre-existing byzantineVoters                (1 cell)
 *   - vote × crdt with caller-supplied crdtSnapshot               (1 cell)
 *
 * Determinism strategy (per DA Wave 1 Axis 3 Block resolution):
 *   - vi.useFakeTimers + vi.setSystemTime(FIXED_EPOCH) per test.
 *   - vi.spyOn(Math, 'random').mockImplementation(seededMulberry32)
 *     (vi.spyOn restores via vi.restoreAllMocks in afterEach).
 *   - vi.unstubAllGlobals() + vi.unstubAllEnvs() in afterEach (defence-in-depth).
 *   - FNV-1a seed → fresh mulberry32 generator per test (no module-scope leak).
 *
 * Reshape error paths (RaftTermCollisionError / RaftVoteChangeError /
 * DuplicateVoteError / VoterIdRequiredError / ProposalNotFoundError) are
 * EXCLUDED from this harness because they surface from the Waves 2-5 try/catch
 * around `archivist.dispatch` — they are not produced by the response-builder.
 * Each subsequent wave adds its own error-path assertions.
 *
 * `crdtSemanticEqual` is vendored from
 * forks/agentdb/test/archivist/handlers/hive-mind/consensus/crdt.test.ts:228-248
 * — ORSet entry orderings differ between merge(a,b) and merge(b,a) so raw
 * deep-equal is unsafe for CRDT subfields. Promote to agentdb barrel only if
 * a second consumer emerges.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory fs mock — mirrors mcp-tools-deep.test.ts pattern. Must run before
// any code that imports `node:fs` to take effect.
vi.mock('node:fs', () => {
  const memStore = new Map<string, string>();
  // ADR-0185 Wave 3 — track fd → path → buffer so writeSync captures the
  // serialised state. saveHiveState (hive-mind-tools.ts:1247) uses
  // openSync/writeSync/closeSync/fsyncSync rather than writeFileSync; the
  // prior no-op writeSync silently dropped the data, so post-dispatch
  // invalidateHiveCache + loadHiveState read an empty `{}` file. After
  // Wave 3's cli flip dispatches and re-reads state, this matters.
  const fdToPath = new Map<number, string>();
  const fdBuffers = new Map<number, string>();
  let nextFd = 1;
  return {
    existsSync: vi.fn((p: string) => memStore.has(p)),
    readFileSync: vi.fn((p: string) => memStore.get(p) || '{}'),
    writeFileSync: vi.fn((p: string, d: string) => memStore.set(p, d)),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn((p: string) => memStore.delete(p)),
    statSync: vi.fn(() => ({ size: 100, isFile: () => true, isDirectory: () => false, mtimeMs: Date.now() })),
    renameSync: vi.fn((from: string, to: string) => {
      const v = memStore.get(from);
      if (v !== undefined) { memStore.set(to, v); memStore.delete(from); }
    }),
    openSync: vi.fn((p: string) => {
      const fd = nextFd++;
      fdToPath.set(fd, p);
      fdBuffers.set(fd, '');
      return fd;
    }),
    closeSync: vi.fn((fd: number) => {
      const path = fdToPath.get(fd);
      const buf = fdBuffers.get(fd);
      if (path !== undefined && buf !== undefined) memStore.set(path, buf);
      fdToPath.delete(fd);
      fdBuffers.delete(fd);
    }),
    writeSync: vi.fn((fd: number, data: string) => {
      const prev = fdBuffers.get(fd) ?? '';
      fdBuffers.set(fd, prev + data);
    }),
    fsyncSync: vi.fn(),
    constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0, O_TRUNC: 0 },
  };
});

// Stub archivist-init.js to avoid vitest transform-time resolution of
// `agentdb/archivist` (an optional dep that's externalized via the
// `externalize-optional-deps` plugin in vitest.config.ts, but the
// archivist-init.ts top-level import still triggers a transform attempt).
// The cli `hive-mind_consensus` handler does NOT call getProcessArchivist
// at Wave 1 (pre-flip); the dispatch wiring lands in Waves 2-5. But the
// harness's `freshHive` helper drives `hive-mind_init` / `hive-mind_spawn` /
// `hive-mind_shutdown` which DO call getProcessArchivist (lines 1555, 1753,
// 3037 of hive-mind-tools.ts). Mock returns a no-op archivist whose
// dispatch + dispatchRead resolve to undefined.
// ADR-0185 Wave 2b — singleton dispatch fn via vi.hoisted so test bodies
// can use `mockDispatch.mockRejectedValueOnce(...)` to override the default
// for a single test (e.g. term-collision throws RaftTermCollisionError).
// vi.hoisted runs before vi.mock factory hoisting, so the fns are defined
// when the factory references them.
const { mockDispatch, mockDispatchRead } = vi.hoisted(() => ({
  mockDispatch: vi.fn(async () => undefined),
  mockDispatchRead: vi.fn(async () => undefined),
}));

// ADR-0185 Wave 2b — stub `agentdb/archivist` so the test transformer can
// resolve `RaftTermCollisionError`. The package is optional-dep externalized
// via vitest.config's `externalize-optional-deps` plugin; at fork-dev-time
// it's not installed in node_modules, so vitest fails to resolve at runtime
// when the test file imports concrete classes. Stub provides a minimal
// class shape that the test + cli source can instanceof-check + construct.
vi.mock('agentdb/archivist', () => ({
  RaftTermCollisionError: class extends Error {
    constructor(public readonly term: number, public readonly existingProposalId: string) {
      super(`hive-mind_consensus.propose: Raft term ${term} already has a pending proposal: ${existingProposalId}`);
      this.name = 'RaftTermCollisionError';
    }
  },
  // ADR-0185 Wave 3 — 4 vote-side reshape error classes. Constructors mirror
  // agentdb's `_shared.ts:127-194` verbatim so the harness reshape cells can
  // construct + the cli's `instanceof` discrimination + field access works.
  DuplicateVoteError: class extends Error {
    constructor(public readonly voterId: string, public readonly proposalId: string, public readonly existingVote: boolean) {
      super(`hive-mind_consensus.vote: voter ${voterId} already cast the same vote on proposal ${proposalId}`);
      this.name = 'DuplicateVoteError';
    }
  },
  RaftVoteChangeError: class extends Error {
    constructor(public readonly voterId: string, public readonly term: number | undefined) {
      super(`hive-mind_consensus.vote: Raft voter ${voterId} cannot change vote in term ${term ?? '?'}`);
      this.name = 'RaftVoteChangeError';
    }
  },
  ProposalNotFoundError: class extends Error {
    constructor(public readonly proposalId: string, public readonly action: string) {
      super(`hive-mind_consensus.${action}: proposal ${proposalId} not found`);
      this.name = 'ProposalNotFoundError';
    }
  },
  VoterIdRequiredError: class extends Error {
    constructor() {
      super('hive-mind_consensus.vote: voterId is required');
      this.name = 'VoterIdRequiredError';
    }
  },
}));

vi.mock('../src/memory/archivist-init.js', () => ({
  getProcessArchivist: vi.fn(async () => ({
    dispatch: mockDispatch,
    dispatchRead: mockDispatchRead,
  })),
  initProcessArchivist: vi.fn(async () => ({
    dispatch: mockDispatch,
    dispatchRead: mockDispatchRead,
  })),
  ensureArchivistInitialized: vi.fn(async () => undefined),
  ensureRvfWired: vi.fn(async () => undefined),
  ensureSqliteWired: vi.fn(async () => undefined),
  __resetProcessArchivistForTests: vi.fn(async () => undefined),
  buildArchivistConfig: vi.fn(() => ({})),
}));

// ADR-0185 Wave 3 — `fs` (bare specifier) mock omitted intentionally.
// The cli imports from `node:fs` only (verified by grep); the prior
// duplicate `fs` mock had a separate closure-scoped memStore, which
// vitest's module resolution sometimes preferred over `node:fs`,
// causing post-saveHiveState reads to see empty state. Single mock at
// the `node:fs` specifier ensures all callers share one memStore +
// the fd-buffer capture for openSync/writeSync/closeSync.

import {
  hiveMindTools,
  loadHiveState,
  saveHiveState,
  _resetHiveCacheForTest,
  calculateRequiredVotes,
  type ConsensusStrategy,
  type ConsensusProposal,
  type HiveState,
} from '../src/mcp-tools/hive-mind-tools.js';
// ADR-0185 Wave 2b — RaftTermCollisionError is thrown by agentdb's raft
// propose handler (raft.ts:67); the harness's term-collision cell uses
// mockDispatch.mockRejectedValueOnce(new RaftTermCollisionError(...)) to
// drive the cli try/catch reshape arm under the singleton mock.
import {
  RaftTermCollisionError,
  DuplicateVoteError,
  RaftVoteChangeError,
} from 'agentdb/archivist';
import {
  buildConsensusResponse,
  type ConsensusResponse,
} from '../src/mcp-tools/hive-mind-consensus-response.js';
import {
  GCounter,
  ORSet,
  LWWRegister,
  type CRDTState,
} from '../src/mcp-tools/crdt-types.js';

// ── Determinism plumbing ────────────────────────────────────────────────────

const FIXED_EPOCH = 1715040000000; // 2024-05-07T00:00:00Z

/** FNV-1a 32-bit hash. Same as agentdb's pattern for property-test seeding. */
function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  return h;
}

/** Mulberry32 — seeded PRNG that returns [0, 1) floats. */
function makeMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── crdtSemanticEqual — vendored from agentdb/test/archivist/handlers/hive-mind/consensus/crdt.test.ts:228-248
//
// ORSet's `.elements()` is unordered relative to merge order; GCounter slot
// map IS deterministic; LWWRegister `.value()` is the winning lexicographic
// value. Direct toJSON deep-equal would be unsafe across merge orderings.

function crdtSemanticEqual(a: CRDTState | undefined, b: CRDTState | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aCounts = GCounter.from(a.votes).toJSON().counts;
  const bCounts = GCounter.from(b.votes).toJSON().counts;
  if (Object.keys(aCounts).length !== Object.keys(bCounts).length) return false;
  for (const k of Object.keys(aCounts)) {
    if (aCounts[k] !== bCounts[k]) return false;
  }
  const aElements = ORSet.from<string>(a.approvers).elements().sort();
  const bElements = ORSet.from<string>(b.approvers).elements().sort();
  if (aElements.length !== bElements.length) return false;
  for (let i = 0; i < aElements.length; i++) {
    if (aElements[i] !== bElements[i]) return false;
  }
  const aValue = LWWRegister.from(a.verdict).value();
  const bValue = LWWRegister.from(b.verdict).value();
  // Use JSON-canonical structural equality for LWWRegister values — the
  // ADR-0185 fixture values are objects (e.g. `{v: 'crdt'}`) and `===`
  // is reference-equal for objects. JSON.stringify is safe here because
  // the LWWRegister value is a serialisable proposal-value.
  return JSON.stringify(aValue) === JSON.stringify(bValue);
}

// ── Per-cell parity diff ────────────────────────────────────────────────────

/**
 * Compare cli and builder responses field-by-field. CRDT-state subfields
 * (`crdtState`, the merged triple) use `crdtSemanticEqual` to absorb ORSet
 * ordering. Every other field uses deep-equal via assertion failure.
 *
 * Returns `{}` on parity; otherwise the throwing expect call surfaces the diff.
 */
function assertParity(label: string, cli: any, builder: ConsensusResponse): void {
  // CRDT subfield — assert semantic equality, then strip from both before
  // deep-equal of the remaining fields. Same treatment for both vote- and
  // status-shape responses.
  const cliClone = JSON.parse(JSON.stringify(cli));
  const builderClone = JSON.parse(JSON.stringify(builder));
  if ('crdtState' in cliClone || 'crdtState' in builderClone) {
    const ok = crdtSemanticEqual(cliClone.crdtState, builderClone.crdtState);
    if (!ok) {
      throw new Error(
        `[${label}] crdtState semantic-equality failed: ` +
          `cli=${JSON.stringify(cliClone.crdtState)} ` +
          `builder=${JSON.stringify(builderClone.crdtState)}`,
      );
    }
    delete cliClone.crdtState;
    delete builderClone.crdtState;
  }

  // Strip undefined keys for ordering-agnostic comparison. JSON.parse(JSON.stringify(...))
  // already strips undefined values, so both shapes are canonicalised.
  expect({ label, ...builderClone }).toEqual({ label, ...cliClone });
}

// ── Per-test harness setup ──────────────────────────────────────────────────

let rngState: { next: () => number };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_EPOCH));
  const seed = fnv1a('adr-0185-wave-1-parity');
  rngState = { next: makeMulberry32(seed) };
  // vi.spyOn(Math, 'random') is automatically restored by vi.restoreAllMocks()
  // in afterEach. Returns a fresh mulberry32 sequence per test.
  vi.spyOn(Math, 'random').mockImplementation(() => rngState.next());
  // ADR-0183 A0 + feedback-singleton-frozen-state-desync: scope cli singletons
  // (getProcessHiveMindStore et al.) per-test via env injection.
  vi.stubEnv('CLAUDE_FLOW_CWD', `/tmp/adr0185-parity-${seed}`);
  vi.stubEnv('HOME', `/tmp/adr0185-parity-home-${seed}`);
  _resetHiveCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // ADR-0185 Wave 2b — restore singleton dispatch fns to the no-op default
  // after any per-test mockRejectedValueOnce / mockResolvedValueOnce. The
  // hoisted vi.fn survives vi.restoreAllMocks (which only restores spies);
  // one-shot overrides drain themselves after fire, but defensive reset
  // protects against tests that set up an override and never invoke it.
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue(undefined);
  mockDispatchRead.mockReset();
  mockDispatchRead.mockResolvedValue(undefined);
});

// ── Per-cell helpers ────────────────────────────────────────────────────────

const consensusTool = () => hiveMindTools.find(t => t.name === 'hive-mind_consensus')!;

/**
 * Synthesise a fresh HiveState directly via `saveHiveState` rather than
 * driving cli's hive-mind_init + hive-mind_spawn handlers. The init/spawn
 * handlers depend on archivist dispatch (mocked above to no-op), so going
 * through them leaves state.workers empty + state.queen undefined.
 *
 * Direct state synthesis isolates the consensus-handler-under-test from
 * the archivist plumbing — the consensus handler does NOT call the
 * archivist at Wave 1 (pre-flip), so this faithfully exercises the
 * consensus code path with realistic state.
 *
 * Returns the worker IDs + queen ID for use as voterIds in vote actions.
 */
async function freshHive(workerCount: number = 4): Promise<{ queenId: string; workerIds: string[] }> {
  _resetHiveCacheForTest();
  const queenId = `queen-${workerCount}`;
  const workerIds: string[] = Array.from({ length: workerCount }, (_, i) => `worker-${i}`);
  const state: HiveState = {
    initialized: true,
    topology: 'mesh',
    queen: {
      agentId: queenId,
      queenType: 'strategic',
      term: 1,
      electedAt: new Date().toISOString(),
    },
    workers: workerIds,
    workerMeta: Object.fromEntries(workerIds.map(w => [w, { failedAt: null, retryOf: null }])),
    consensus: { pending: [], history: [] },
    sharedMemory: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveHiveState(state);
  return { queenId, workerIds };
}

/**
 * Build a fully-typed `ConsensusProposal` for a synthetic post-propose state.
 * Field shapes mirror agentdb's per-strategy propose handlers (raft.ts:75-98,
 * bft.ts:63-98, etc.) which set non-strategy fields to explicit `undefined`
 * per ADR-0184 Wave 2 DA Axis h (prevent stale-field leakage).
 *
 * Module-scope so both `runProposeCell` (Wave 2b vote/status/list setup) and
 * the propose shape-contract cells share the same fixture builder.
 */
function makePendingProposal(
  strategy: 'bft' | 'raft' | 'quorum' | 'weighted' | 'gossip' | 'crdt',
  overrides: Partial<{ term: number; quorumPreset: 'unanimous' | 'majority' | 'supermajority'; totalNodes: number }> = {},
): ConsensusProposal {
  const proposalId = `proposal-${FIXED_EPOCH}-${strategy}cell`;
  const isGossip = strategy === 'gossip';
  const isCrdt = strategy === 'crdt';
  const isThresholdBased =
    strategy === 'bft' || strategy === 'raft' || strategy === 'quorum' || strategy === 'weighted';
  const totalNodes = overrides.totalNodes ?? 4;
  return {
    proposalId,
    type: `parity-${strategy}`,
    value: { v: strategy },
    proposedBy: 'system',
    proposedAt: new Date(FIXED_EPOCH).toISOString(),
    votes: {},
    status: 'pending',
    strategy,
    term: strategy === 'raft' ? (overrides.term ?? 1) : undefined,
    quorumPreset: strategy === 'quorum' ? (overrides.quorumPreset ?? 'majority') : undefined,
    byzantineVoters: strategy === 'bft' ? [] : undefined,
    timeoutAt: isThresholdBased ? new Date(FIXED_EPOCH + 30000).toISOString() : undefined,
    gossipRound: isGossip ? 0 : undefined,
    lastVoteChangedRound: isGossip ? 0 : undefined,
    totalNodes: isGossip ? totalNodes : undefined,
    currentRoundBroadcastSet: isGossip ? [] : undefined,
    roundTimeoutMs: (isGossip || isCrdt) ? 5000 : undefined,
    roundStartedAt: (isGossip || isCrdt) ? new Date(FIXED_EPOCH).toISOString() : undefined,
    crdtState: isCrdt
      ? { votes: { counts: {} }, approvers: { entries: [], tombstones: [] }, verdict: {} }
      : undefined,
    crdtExpectedVoters: isCrdt ? Math.max(1, totalNodes) : undefined,
  };
}

/**
 * Push a fully-typed proposal into pending and return its id. The
 * `saveHiveState` call updates the in-process hiveCache (per
 * hive-mind-tools.ts:1241 `hiveCache.set(HIVE_STATE_DOC_KEY, state)`); a
 * subsequent `loadHiveState()` returns the updated state without hitting
 * disk. DA Wave 2a cache-update sequence clarification.
 */
function pushSyntheticProposal(
  strategy: 'bft' | 'raft' | 'quorum' | 'weighted' | 'gossip' | 'crdt',
  overrides: Partial<{ term: number; quorumPreset: 'unanimous' | 'majority' | 'supermajority'; totalNodes: number }> = {},
): string {
  const proposal = makePendingProposal(strategy, overrides);
  const state = loadHiveState();
  state.consensus.pending.push(proposal);
  saveHiveState(state);
  return proposal.proposalId;
}

/**
 * Set up a pending proposal in state directly. Wave 2b conversion: the cli's
 * propose branch now dispatches to agentdb (mocked to no-op), so driving the
 * cli handler here would leave state.consensus.pending empty. Synthesise the
 * proposal directly via saveHiveState.
 *
 * Returns a minimal `cliResponse` shape: only `proposalId` (the only field
 * the 20 downstream vote/status/list cells consume from this helper —
 * verified by grep of `proposeOut\.` across the cell bodies). Plus `action`
 * for shape consistency. DA Wave 2b verdict on field-selection trimming.
 */
async function runProposeCell(strategy: 'bft' | 'raft' | 'quorum' | 'weighted' | 'gossip' | 'crdt'): Promise<{
  cliResponse: { action: 'propose'; proposalId: string };
  postState: HiveState;
}> {
  const proposalId = pushSyntheticProposal(strategy);
  return {
    cliResponse: { action: 'propose', proposalId },
    postState: loadHiveState(),
  };
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('ADR-0185 Wave 1 — parity: buildConsensusResponse vs cli handler', () => {
  // ──────────────────────────────────────────────────────────────────────
  // propose × {bft, raft, quorum, weighted, gossip, crdt}
  // ──────────────────────────────────────────────────────────────────────
  describe('propose action — builder shape contracts (Wave 2a pivot)', () => {
    // ADR-0185 Wave 2a — DA Path Z verdict: the 6 propose × strategy cells
    // pivot from "cli vs builder parity" to builder shape-contract tests.
    // The cli's propose branch flips to `archivist.dispatch` in Wave 2b;
    // the archivist mock in this harness no-ops dispatch, so a cli-vs-builder
    // parity test would fail post-Wave-2b (proposal never lands in pending).
    //
    // These cells synthesise the post-propose state directly via
    // `saveHiveState`, then call `buildConsensusResponse` and assert the
    // shape with `toMatchObject`. Wave 1's correctness validation (builder
    // shape matches cli pre-flip shape, 26/26 green at patch.193) is FROZEN.
    // What we verify here is that the builder's response shape remains
    // STABLE for known inputs through Waves 2-6.

    // ADR-0185 Wave 2b — `makePendingProposal` + `pushSyntheticProposal`
    // lifted to module scope (above the suite) so `runProposeCell` can
    // reuse them. Both helpers preserve the same typed-fixture +
    // cache-update behaviour as Wave 2a.

    it('propose × bft — builder shape contract', async () => {
      await freshHive(4); // totalNodes=4, bft required = floor(2*4/3)+1 = 3
      const proposalId = pushSyntheticProposal('bft');
      const builder = buildConsensusResponse(
        'propose', 'bft', proposalId, loadHiveState(),
        { action: 'propose', strategy: 'bft', type: 'parity-bft', value: { v: 'bft' } },
      );
      expect(builder).toMatchObject({
        action: 'propose',
        proposalId,
        type: 'parity-bft',
        strategy: 'bft',
        status: 'pending',
        required: 3,
        totalNodes: 4,
      });
    });

    it('propose × raft — builder shape contract', async () => {
      await freshHive(4); // raft required = floor(4/2)+1 = 3
      const proposalId = pushSyntheticProposal('raft');
      const builder = buildConsensusResponse(
        'propose', 'raft', proposalId, loadHiveState(),
        { action: 'propose', strategy: 'raft', type: 'parity-raft', value: { v: 'raft' } },
      );
      expect(builder).toMatchObject({
        action: 'propose',
        proposalId,
        type: 'parity-raft',
        strategy: 'raft',
        status: 'pending',
        required: 3,
        totalNodes: 4,
        term: 1,
      });
    });

    it('propose × quorum — builder shape contract', async () => {
      await freshHive(4); // quorum majority required = floor(4/2)+1 = 3
      const proposalId = pushSyntheticProposal('quorum');
      const builder = buildConsensusResponse(
        'propose', 'quorum', proposalId, loadHiveState(),
        { action: 'propose', strategy: 'quorum', type: 'parity-quorum', value: { v: 'quorum' } },
      );
      expect(builder).toMatchObject({
        action: 'propose',
        proposalId,
        type: 'parity-quorum',
        strategy: 'quorum',
        status: 'pending',
        required: 3,
        totalNodes: 4,
        quorumPreset: 'majority',
      });
    });

    it('propose × weighted — builder shape contract (queen-elected)', async () => {
      await freshHive(4); // weighted required = max(0, 4-1) + 3 = 6 (QUEEN_WEIGHT default)
      const proposalId = pushSyntheticProposal('weighted');
      const builder = buildConsensusResponse(
        'propose', 'weighted', proposalId, loadHiveState(),
        { action: 'propose', strategy: 'weighted', type: 'parity-weighted', value: { v: 'weighted' } },
      );
      expect(builder).toMatchObject({
        action: 'propose',
        proposalId,
        type: 'parity-weighted',
        strategy: 'weighted',
        status: 'pending',
        required: 6,
        totalNodes: 4,
      });
    });

    it('propose × gossip — builder shape contract', async () => {
      await freshHive(4); // gossip required = max(1, totalNodes) = 4; bound = ceil(log2(4)) = 2
      const proposalId = pushSyntheticProposal('gossip');
      const builder = buildConsensusResponse(
        'propose', 'gossip', proposalId, loadHiveState(),
        { action: 'propose', strategy: 'gossip', type: 'parity-gossip', value: { v: 'gossip' } },
      );
      expect(builder).toMatchObject({
        action: 'propose',
        proposalId,
        type: 'parity-gossip',
        strategy: 'gossip',
        status: 'pending',
        required: 4,
        totalNodes: 4,
        gossipRound: 0,
        gossipBound: 2,
        roundTimeoutMs: 5000,
      });
    });

    it('propose × crdt — builder shape contract', async () => {
      await freshHive(4); // crdt required = max(1, totalNodes) = 4
      const proposalId = pushSyntheticProposal('crdt');
      const builder = buildConsensusResponse(
        'propose', 'crdt', proposalId, loadHiveState(),
        { action: 'propose', strategy: 'crdt', type: 'parity-crdt', value: { v: 'crdt' } },
      );
      expect(builder).toMatchObject({
        action: 'propose',
        proposalId,
        type: 'parity-crdt',
        strategy: 'crdt',
        status: 'pending',
        required: 4,
        totalNodes: 4,
        crdtExpectedVoters: 4,
      });
    });

    // ── 2 new error-path cells (DA Wave 2 v2 verdict) ────────────────────

    it('propose × raft term-collision — cli reshape envelope (Wave 2 contract)', async () => {
      // Wave 2b — cli's propose branch now dispatches; the real agentdb
      // raft.ts:67 throws RaftTermCollisionError on detection. The harness
      // mock dispatch is no-op by default; override for this single call
      // via `mockRejectedValueOnce` so the cli's try/catch reshape arm
      // fires under the singleton mock dispatch.
      await freshHive(4);
      const injectedProposalId = pushSyntheticProposal('raft', { term: 1 });
      mockDispatch.mockRejectedValueOnce(
        new RaftTermCollisionError(1, injectedProposalId),
      );
      const result: any = await consensusTool().handler({
        action: 'propose',
        type: 'parity-raft-collision',
        value: { v: 'collision' },
        strategy: 'raft',
        term: 1,
      });
      // Envelope shape: `{ action: 'propose', error: '...', existingProposalId, term }`.
      expect(result).toMatchObject({
        action: 'propose',
        error: expect.stringMatching(/[Rr]aft term 1 already has/),
        existingProposalId: injectedProposalId,
        term: 1,
      });
    });

    it('propose × weighted missing-queen — pre-flight throws (Wave 2 contract)', async () => {
      // Pre-Wave 2b: cli throws synchronously at line 2067-2069.
      // Post-Wave 2b: cli pre-flight throws same error BEFORE dispatch.
      // Both states pass this cell.
      _resetHiveCacheForTest();
      const state: HiveState = {
        initialized: true,
        topology: 'mesh',
        queen: undefined, // The setup the pre-flight guard catches.
        workers: ['w0', 'w1', 'w2'],
        workerMeta: {},
        consensus: { pending: [], history: [] },
        sharedMemory: {},
        createdAt: new Date(FIXED_EPOCH).toISOString(),
        updatedAt: new Date(FIXED_EPOCH).toISOString(),
      };
      saveHiveState(state);
      await expect(
        consensusTool().handler({
          action: 'propose',
          type: 'parity-weighted-noqueen',
          value: { v: 'noqueen' },
          strategy: 'weighted',
        }),
      ).rejects.toThrow(/weighted .* requires an elected queen|state\.queen is undefined/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // vote × {bft, raft, quorum, weighted, gossip, crdt} happy
  // ──────────────────────────────────────────────────────────────────────
  describe('vote action — builder shape contracts (Wave 3 pivot)', () => {
    // ADR-0185 Wave 3 — DA Path Z verdict (same as Wave 2a's propose pivot):
    // the cli's vote branch dispatches to agentdb; the harness mock is no-op,
    // so a cli-vs-builder parity test would fail. Pivot to shape-contract.
    //
    // Wave 1's correctness validation (builder shape matches cli pre-flip
    // shape, 26/26 green at patch.193) is FROZEN. Wave 3 verifies the
    // builder's vote-response shape stays stable for known post-vote states.
    //
    // Dropped from Wave 1: 2 bft-byzantine cells (covered by in-fork
    // mcp-tools-deep.test.ts T1 byzantine block + acceptance-hive-mind-checks.sh
    // BFT byzantine acceptance) and 1 crdt-snapshot cell (covered by
    // acceptance-hive-mind-checks.sh T3 crdtSnapshot validation acceptance).
    // Net: 6 shape-contracts + 1 crdt-snapshot shape-contract + 2 reshape
    // error-paths = 9. Was 9 vote cells; net 0 change. Sentinel stays at 28.

    /**
     * Synthesise a post-vote state: pushes a proposal into pending with
     * `votes: { [voterId]: voteValue }` already populated. Mirrors what
     * agentdb's per-strategy vote handlers write to state.consensus.pending
     * after a successful vote (e.g. raft.ts:158-180 / quorum.ts:131-150).
     */
    function pushSyntheticPostVoteProposal(
      strategy: 'bft' | 'raft' | 'quorum' | 'weighted' | 'gossip' | 'crdt',
      voterId: string,
      voteValue: boolean,
      overrides: Partial<{ term: number; quorumPreset: 'unanimous' | 'majority' | 'supermajority' }> = {},
    ): string {
      const proposal = makePendingProposal(strategy, overrides);
      proposal.votes[voterId] = voteValue;
      const state = loadHiveState();
      state.consensus.pending.push(proposal);
      saveHiveState(state);
      return proposal.proposalId;
    }

    it('vote × bft — builder shape contract (single vote, not yet resolved)', async () => {
      await freshHive(7); // bft required = floor(2*7/3)+1 = 5
      const proposalId = pushSyntheticPostVoteProposal('bft', 'worker-0', true);
      const builder = buildConsensusResponse(
        'vote', 'bft', proposalId, loadHiveState(),
        { action: 'vote', strategy: 'bft', voterId: 'worker-0', vote: true },
      );
      expect(builder).toMatchObject({
        action: 'vote',
        proposalId,
        voterId: 'worker-0',
        strategy: 'bft',
        votesFor: 1,
        votesAgainst: 0,
        required: 5,
        totalNodes: 7,
        status: 'pending',
        resolved: false,
      });
    });

    it('vote × raft — builder shape contract', async () => {
      await freshHive(3); // raft required = floor(3/2)+1 = 2
      const proposalId = pushSyntheticPostVoteProposal('raft', 'worker-0', true);
      const builder = buildConsensusResponse(
        'vote', 'raft', proposalId, loadHiveState(),
        { action: 'vote', strategy: 'raft', voterId: 'worker-0', vote: true },
      );
      expect(builder).toMatchObject({
        action: 'vote',
        proposalId,
        voterId: 'worker-0',
        strategy: 'raft',
        votesFor: 1,
        votesAgainst: 0,
        required: 2,
        totalNodes: 3,
        term: 1,
        resolved: false,
      });
    });

    it('vote × quorum — builder shape contract', async () => {
      await freshHive(4);
      const proposalId = pushSyntheticPostVoteProposal('quorum', 'worker-0', true);
      const builder = buildConsensusResponse(
        'vote', 'quorum', proposalId, loadHiveState(),
        { action: 'vote', strategy: 'quorum', voterId: 'worker-0', vote: true },
      );
      expect(builder).toMatchObject({
        action: 'vote',
        proposalId,
        voterId: 'worker-0',
        strategy: 'quorum',
        votesFor: 1,
        votesAgainst: 0,
        required: 3,
        totalNodes: 4,
        resolved: false,
      });
    });

    it('vote × weighted — builder shape contract (queen-elected; queen vote)', async () => {
      const { queenId } = await freshHive(4);
      // Push a weighted proposal with queen's vote already recorded.
      const proposal = makePendingProposal('weighted');
      proposal.votes[queenId] = true;
      const state = loadHiveState();
      state.consensus.pending.push(proposal);
      saveHiveState(state);
      const builder = buildConsensusResponse(
        'vote', 'weighted', proposal.proposalId, loadHiveState(),
        { action: 'vote', strategy: 'weighted', voterId: queenId, vote: true },
      );
      expect(builder).toMatchObject({
        action: 'vote',
        proposalId: proposal.proposalId,
        voterId: queenId,
        strategy: 'weighted',
        // weightedTally: queen=3 vote-for; no workers voted → votesAgainst=0.
        votesFor: 3,
        votesAgainst: 0,
        required: 6,
        totalNodes: 4,
        resolved: false,
      });
    });

    it('vote × gossip — builder shape contract', async () => {
      await freshHive(4);
      const proposalId = pushSyntheticPostVoteProposal('gossip', 'worker-0', true);
      const builder = buildConsensusResponse(
        'vote', 'gossip', proposalId, loadHiveState(),
        { action: 'vote', strategy: 'gossip', voterId: 'worker-0', vote: true },
      );
      expect(builder).toMatchObject({
        action: 'vote',
        proposalId,
        voterId: 'worker-0',
        strategy: 'gossip',
        votesFor: 1,
        votesAgainst: 0,
        totalNodes: 4,
        gossipRound: 0,
        gossipBound: 2,
        resolved: false,
      });
    });

    it('vote × crdt — builder shape contract', async () => {
      await freshHive(3);
      // makePendingProposal('crdt') uses overrides.totalNodes ?? 4 for the
      // crdtExpectedVoters snapshot (not state.workers.length). The builder
      // emits both totalNodes (from state.workers.length = 3) and
      // crdtExpectedVoters (from proposal field = 4). Per ADR-0121 §Specification,
      // crdtExpectedVoters is the voter-count snapshot at propose-time, fixed
      // across the round; in production it's `Math.max(1, totalNodes)` set
      // at propose time, but our fixture's makePendingProposal default sees
      // overrides.totalNodes (defaults to 4) independent of freshHive's
      // worker count. The shape-contract asserts the values as wired.
      const proposalId = pushSyntheticPostVoteProposal('crdt', 'worker-0', true);
      const builder = buildConsensusResponse(
        'vote', 'crdt', proposalId, loadHiveState(),
        { action: 'vote', strategy: 'crdt', voterId: 'worker-0', vote: true },
      );
      expect(builder).toMatchObject({
        action: 'vote',
        proposalId,
        voterId: 'worker-0',
        strategy: 'crdt',
        totalCast: 1,
        crdtExpectedVoters: 4,
        totalNodes: 3,
        resolved: false,
      });
    });

    // ── 3 new error-path cells (DA Wave 3 verdict — Axis 2 reshape coverage) ──

    it('vote × quorum DuplicateVote (same-value) — cli reshape envelope with existingVote', async () => {
      // Cli pre-flip same-value envelope (line 2401-2407) carries `existingVote`.
      // Agentdb throws DuplicateVoteError(voterId, proposalId, existingVote);
      // cli reshape arm compares input.vote === e.existingVote → emit same-value
      // envelope. DA Wave 3 Axis 2 Concern resolution.
      await freshHive(4);
      const proposal = makePendingProposal('quorum');
      proposal.votes['worker-0'] = true; // already voted true
      const state = loadHiveState();
      state.consensus.pending.push(proposal);
      saveHiveState(state);
      mockDispatch.mockRejectedValueOnce(
        new DuplicateVoteError('worker-0', proposal.proposalId, true),
      );
      const result: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposal.proposalId,
        voterId: 'worker-0',
        vote: true,  // same as existing → same-value envelope
        strategy: 'quorum',
      });
      expect(result).toMatchObject({
        action: 'vote',
        error: expect.stringMatching(/already cast the same vote/),
        proposalId: proposal.proposalId,
        existingVote: true,
      });
    });

    it('vote × quorum DuplicateVote (value-change) — cli reshape envelope without existingVote', async () => {
      // Cli pre-flip quorum value-change envelope (line 2440-2444) does NOT
      // carry `existingVote`. Both paths share agentdb's DuplicateVoteError
      // throw; cli reshape distinguishes via input.vote !== e.existingVote.
      await freshHive(4);
      const proposal = makePendingProposal('quorum');
      proposal.votes['worker-0'] = true; // already voted true
      const state = loadHiveState();
      state.consensus.pending.push(proposal);
      saveHiveState(state);
      mockDispatch.mockRejectedValueOnce(
        new DuplicateVoteError('worker-0', proposal.proposalId, true),
      );
      const result: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposal.proposalId,
        voterId: 'worker-0',
        vote: false,  // different from existing → value-change envelope
        strategy: 'quorum',
      });
      expect(result).toMatchObject({
        action: 'vote',
        error: expect.stringMatching(/already voted on this proposal/),
        proposalId: proposal.proposalId,
      });
      expect(result.existingVote).toBeUndefined();
    });

    it('vote × raft RaftVoteChange — cli reshape envelope', async () => {
      await freshHive(3);
      const proposal = makePendingProposal('raft');
      proposal.votes['worker-0'] = true;
      const state = loadHiveState();
      state.consensus.pending.push(proposal);
      saveHiveState(state);
      mockDispatch.mockRejectedValueOnce(
        new RaftVoteChangeError('worker-0', 1),
      );
      const result: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposal.proposalId,
        voterId: 'worker-0',
        vote: false,
        strategy: 'raft',
      });
      expect(result).toMatchObject({
        action: 'vote',
        error: expect.stringMatching(/Raft: voter worker-0 already voted in term 1/),
        proposalId: proposal.proposalId,
        term: 1,
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // status × {bft, raft, quorum, weighted, gossip, crdt} happy
  // ──────────────────────────────────────────────────────────────────────
  describe('status action — happy paths', () => {
    for (const strategy of ['bft', 'raft', 'quorum', 'gossip', 'crdt'] as const) {
      it(`status × ${strategy} — builder matches cli (still pending)`, async () => {
        await freshHive(4);
        const { cliResponse: proposeOut } = await runProposeCell(strategy);

        const statusOut: any = await consensusTool().handler({
          action: 'status',
          proposalId: proposeOut.proposalId,
        });
        const postState = loadHiveState();

        const builder = buildConsensusResponse(
          'status',
          strategy,
          proposeOut.proposalId,
          postState,
          { action: 'status', strategy },
        );
        assertParity(`status-${strategy}`, statusOut, builder);
      });
    }

    it('status × weighted — builder matches cli', async () => {
      await freshHive(4);
      const { cliResponse: proposeOut } = await runProposeCell('weighted');

      const statusOut: any = await consensusTool().handler({
        action: 'status',
        proposalId: proposeOut.proposalId,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'status',
        'weighted',
        proposeOut.proposalId,
        postState,
        { action: 'status', strategy: 'weighted' },
      );
      assertParity('status-weighted', statusOut, builder);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // status × any-threshold-strategy with timeoutAt in the past (ADR-0131)
  // ──────────────────────────────────────────────────────────────────────
  describe('status action — ADR-0131 auto-transition', () => {
    for (const strategy of ['bft', 'raft'] as const) {
      it(`status × ${strategy} — timeout fires, absentVoters surfaces from history`, async () => {
        await freshHive(4);
        const { cliResponse: proposeOut } = await runProposeCell(strategy);

        // Advance past the default 30s timeout.
        vi.advanceTimersByTime(60_000);

        const statusOut: any = await consensusTool().handler({
          action: 'status',
          proposalId: proposeOut.proposalId,
        });
        const postState = loadHiveState();

        // Cli flips status to 'failed-quorum-not-reached', moves the
        // proposal to history, and populates absentVoters. The builder's
        // history-fallback lookup must reproduce this.
        expect(statusOut.statusJustTransitioned).toBe(true);
        expect(statusOut.status).toBe('failed-quorum-not-reached');
        expect(Array.isArray(statusOut.absentVoters)).toBe(true);

        const builder = buildConsensusResponse(
          'status',
          strategy,
          proposeOut.proposalId,
          postState,
          { action: 'status', strategy },
        ) as any;
        // Note: cli's auto-transition path returns `statusJustTransitioned: true`
        // BUT the builder is invoked AFTER the cli's mutation; from the
        // builder's perspective the proposal is in history (resolved=true).
        // We assert the builder produces the history-row shape.
        expect(builder.action).toBe('status');
        expect(builder.historical).toBe(true);
        expect(builder.absentVoters).toEqual(statusOut.absentVoters);
        expect(builder.result).toBe('failed-quorum-not-reached');
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // status query against an already-resolved proposal in history
  // ──────────────────────────────────────────────────────────────────────
  describe('status action — history-row lookup', () => {
    it('status × resolved proposal — historical=true round-trips', async () => {
      // ADR-0185 Wave 3 — votes dispatch to no-op mock; can't drive
      // resolution via cli vote calls. Synthesise the post-resolution
      // state directly: push the resolved proposal to history (not
      // pending). The cli status handler's pending-then-history lookup
      // (line 2655-2666) finds it in history and returns
      // `{action, ...historical, historical: true, resolved: true,
      // statusJustTransitioned: false}`.
      await freshHive(2);
      const proposalId = `proposal-${FIXED_EPOCH}-historytest`;
      const state = loadHiveState();
      state.consensus.history.push({
        proposalId,
        type: 'parity-raft',
        result: 'approved',
        votes: { for: 2, against: 0 },
        decidedAt: new Date(FIXED_EPOCH).toISOString(),
        strategy: 'raft',
        term: 1,
      });
      saveHiveState(state);

      const statusOut: any = await consensusTool().handler({
        action: 'status',
        proposalId,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'status',
        'raft',
        proposalId,
        postState,
        { action: 'status', strategy: 'raft' },
      );

      expect(statusOut.historical).toBe(true);
      // DA Wave 1 post-commit Concern #3: full parity diff (not spot-checks).
      assertParity('status-history-row', statusOut, builder);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // list × strategy-agnostic
  // ──────────────────────────────────────────────────────────────────────
  describe('list action', () => {
    it('list — builder matches cli with mixed-strategy pending', async () => {
      await freshHive(4);
      // ADR-0185 Wave 2b — propose dispatches to no-op mock; synthesise
      // both proposals directly. The list cell's invariant is "builder
      // emits the same rows as cli for whatever's in pending"; we don't
      // care HOW they got there.
      const bftBase = makePendingProposal('bft');
      const quorumBase = makePendingProposal('quorum');
      const seedState = loadHiveState();
      seedState.consensus.pending.push(
        { ...bftBase, proposalId: `${bftBase.proposalId}-list1`, type: 'list-cell-bft', value: 'a' },
        { ...quorumBase, proposalId: `${quorumBase.proposalId}-list2`, type: 'list-cell-quorum', value: 'b' },
      );
      saveHiveState(seedState);

      const cliOut: any = await consensusTool().handler({ action: 'list' });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'list',
        // strategy is degenerate for list; pass any valid value
        'raft',
        '',
        postState,
        { action: 'list' },
      ) as any;

      // For list, the response is strategy-agnostic — assert the pending
      // rows match by proposalId order + same `recentHistory` slice.
      expect(builder.action).toBe('list');
      expect(builder.pending.length).toBe(cliOut.pending.length);
      for (let i = 0; i < cliOut.pending.length; i++) {
        expect(builder.pending[i].proposalId).toBe(cliOut.pending[i].proposalId);
        expect(builder.pending[i].strategy).toBe(cliOut.pending[i].strategy);
        expect(builder.pending[i].required).toBe(cliOut.pending[i].required);
        expect(builder.pending[i].totalVotes).toBe(cliOut.pending[i].totalVotes);
        expect(builder.pending[i].status).toBe(cliOut.pending[i].status);
      }
      expect(builder.recentHistory).toEqual(cliOut.recentHistory);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Gossip flag-sourcing cross-check (DA Wave 1 Concern #3)
  // ──────────────────────────────────────────────────────────────────────
  describe('gossipExhausted flag-sourcing', () => {
    it('builder reads proposal.gossipExhausted via ADR-0184 Wave 4 persisted flag', async () => {
      const { workerIds } = await freshHive(4);
      const { cliResponse: proposeOut } = await runProposeCell('gossip');

      // Drive enough rounds to hit fanout-bound exhaustion. The cli's vote
      // path advances gossipRound on each call until coverage is reached;
      // hard-budget exhaustion fires only after fanout(N) rounds without
      // tally change. For this cell we artificially set proposal.gossipExhausted
      // = true in state and assert the builder surfaces it.
      const stateBefore = loadHiveState();
      const proposal = stateBefore.consensus.pending.find(
        p => p.proposalId === proposeOut.proposalId,
      );
      // ADR-0184 Wave 4 added `gossipExhausted?: boolean` to ConsensusProposal.
      // This is the cli's view of the flag; setting it here mimics agentdb's
      // dispatch having persisted it on a real exhaustion event.
      (proposal as any).gossipExhausted = true;
      saveHiveState(stateBefore);

      // Now drive a vote to refresh the post-state context.
      await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: true,
      });
      const postState = loadHiveState();

      // The builder should surface `exhausted: true` regardless of whether
      // the cli vote response carries it (which depends on settleCheckGossip's
      // call-site computation at vote-time).
      const builder = buildConsensusResponse(
        'vote',
        'gossip',
        proposeOut.proposalId,
        postState,
        { action: 'vote', strategy: 'gossip', voterId: workerIds[0], vote: true },
      ) as any;

      // If the proposal is still pending, the persisted flag must round-trip.
      const stillPending = postState.consensus.pending.some(
        p => p.proposalId === proposeOut.proposalId,
      );
      if (stillPending) {
        expect(builder.exhausted).toBe(true);
      }
    });
  });
});
