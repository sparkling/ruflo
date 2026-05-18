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
  return {
    existsSync: vi.fn((p: string) => memStore.has(p)),
    readFileSync: vi.fn((p: string) => memStore.get(p) || '{}'),
    writeFileSync: vi.fn((p: string, d: string) => memStore.set(p, d)),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn((p: string) => memStore.delete(p)),
    statSync: vi.fn(() => ({ size: 100, isFile: () => true, isDirectory: () => false })),
    renameSync: vi.fn((from: string, to: string) => {
      const v = memStore.get(from);
      if (v !== undefined) { memStore.set(to, v); memStore.delete(from); }
    }),
    openSync: vi.fn(() => 0),
    closeSync: vi.fn(),
    writeSync: vi.fn(),
    fsyncSync: vi.fn(),
    constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
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
vi.mock('../src/memory/archivist-init.js', () => ({
  getProcessArchivist: vi.fn(async () => ({
    dispatch: vi.fn(async () => undefined),
    dispatchRead: vi.fn(async () => undefined),
  })),
  initProcessArchivist: vi.fn(async () => ({
    dispatch: vi.fn(async () => undefined),
    dispatchRead: vi.fn(async () => undefined),
  })),
  ensureArchivistInitialized: vi.fn(async () => undefined),
  ensureRvfWired: vi.fn(async () => undefined),
  ensureSqliteWired: vi.fn(async () => undefined),
  __resetProcessArchivistForTests: vi.fn(async () => undefined),
  buildArchivistConfig: vi.fn(() => ({})),
}));

vi.mock('fs', () => {
  const memStore = new Map<string, string>();
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
    openSync: vi.fn(() => 0),
    closeSync: vi.fn(),
    writeSync: vi.fn(),
    fsyncSync: vi.fn(),
    constants: { O_CREAT: 0, O_EXCL: 0, O_WRONLY: 0 },
  };
});

import {
  hiveMindTools,
  loadHiveState,
  saveHiveState,
  _resetHiveCacheForTest,
  type ConsensusStrategy,
  type HiveState,
} from '../src/mcp-tools/hive-mind-tools.js';
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
  return aValue === bValue;
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
});

// ── Per-cell helpers ────────────────────────────────────────────────────────

const consensusTool = () => hiveMindTools.find(t => t.name === 'hive-mind_consensus')!;
const initTool = () => hiveMindTools.find(t => t.name === 'hive-mind_init')!;
const spawnTool = () => hiveMindTools.find(t => t.name === 'hive-mind_spawn')!;
const shutdownTool = () => hiveMindTools.find(t => t.name === 'hive-mind_shutdown')!;

/** Fresh hive with N workers + queen. totalNodes = workers.length. */
async function freshHive(workerCount: number = 4): Promise<{ queenId: string; workerIds: string[] }> {
  await shutdownTool().handler({ force: true });
  const initOut: any = await initTool().handler({ topology: 'mesh' });
  const spawnOut: any = await spawnTool().handler({ count: workerCount, role: 'worker' });
  return {
    queenId: initOut.queenId as string,
    workerIds: spawnOut.workers.map((w: any) => w.agentId as string),
  };
}

/** Run a propose action through cli, capture cli response + post-state. */
async function runProposeCell(strategy: 'bft' | 'raft' | 'quorum' | 'weighted' | 'gossip' | 'crdt'): Promise<{
  cliResponse: any;
  postState: HiveState;
}> {
  const cliResponse: any = await consensusTool().handler({
    action: 'propose',
    type: `parity-${strategy}`,
    value: { v: strategy },
    strategy,
  });
  const postState = loadHiveState();
  return { cliResponse, postState };
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('ADR-0185 Wave 1 — parity: buildConsensusResponse vs cli handler', () => {
  // ──────────────────────────────────────────────────────────────────────
  // propose × {bft, raft, quorum, weighted, gossip, crdt}
  // ──────────────────────────────────────────────────────────────────────
  describe('propose action', () => {
    for (const strategy of ['bft', 'raft', 'quorum', 'gossip', 'crdt'] as const) {
      it(`propose × ${strategy} — builder matches cli`, async () => {
        await freshHive(4);
        const { cliResponse, postState } = await runProposeCell(strategy);

        const builderResponse = buildConsensusResponse(
          'propose',
          strategy,
          cliResponse.proposalId,
          postState,
          { action: 'propose', strategy, type: `parity-${strategy}`, value: { v: strategy } },
        );

        assertParity(`propose-${strategy}`, cliResponse, builderResponse);
      });
    }

    it('propose × weighted — builder matches cli (queen-elected)', async () => {
      await freshHive(4); // 4 workers + queen = totalNodes 4; denom 6
      const { cliResponse, postState } = await runProposeCell('weighted');

      const builderResponse = buildConsensusResponse(
        'propose',
        'weighted',
        cliResponse.proposalId,
        postState,
        { action: 'propose', strategy: 'weighted', type: 'parity-weighted', value: { v: 'weighted' } },
      );
      assertParity('propose-weighted', cliResponse, builderResponse);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // vote × {bft, raft, quorum, weighted, gossip, crdt} happy
  // ──────────────────────────────────────────────────────────────────────
  describe('vote action — happy paths', () => {
    it('vote × bft — builder matches cli (single vote, not yet resolved)', async () => {
      const { workerIds } = await freshHive(7); // bft requires ceil(2N/3)+1 = 5/7
      const { cliResponse: proposeOut } = await runProposeCell('bft');

      const voteOut: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: true,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'vote',
        'bft',
        proposeOut.proposalId,
        postState,
        { action: 'vote', strategy: 'bft', voterId: workerIds[0], vote: true },
      );
      assertParity('vote-bft', voteOut, builder);
    });

    it('vote × raft — builder matches cli', async () => {
      const { workerIds } = await freshHive(3);
      const { cliResponse: proposeOut } = await runProposeCell('raft');

      const voteOut: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: true,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'vote',
        'raft',
        proposeOut.proposalId,
        postState,
        { action: 'vote', strategy: 'raft', voterId: workerIds[0], vote: true },
      );
      assertParity('vote-raft', voteOut, builder);
    });

    it('vote × quorum — builder matches cli', async () => {
      const { workerIds } = await freshHive(4);
      const { cliResponse: proposeOut } = await runProposeCell('quorum');

      const voteOut: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: true,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'vote',
        'quorum',
        proposeOut.proposalId,
        postState,
        { action: 'vote', strategy: 'quorum', voterId: workerIds[0], vote: true },
      );
      assertParity('vote-quorum', voteOut, builder);
    });

    it('vote × weighted — builder matches cli (queen-elected; weighted tally)', async () => {
      const { queenId } = await freshHive(4);
      const { cliResponse: proposeOut } = await runProposeCell('weighted');

      const voteOut: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: queenId,
        vote: true,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'vote',
        'weighted',
        proposeOut.proposalId,
        postState,
        { action: 'vote', strategy: 'weighted', voterId: queenId, vote: true },
      );
      assertParity('vote-weighted', voteOut, builder);
    });

    it('vote × gossip — builder matches cli', async () => {
      const { workerIds } = await freshHive(4);
      const { cliResponse: proposeOut } = await runProposeCell('gossip');

      const voteOut: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: true,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'vote',
        'gossip',
        proposeOut.proposalId,
        postState,
        { action: 'vote', strategy: 'gossip', voterId: workerIds[0], vote: true },
      );
      assertParity('vote-gossip', voteOut, builder);
    });

    it('vote × crdt — builder matches cli (synthesised crdtSnapshot path)', async () => {
      const { workerIds } = await freshHive(3);
      const { cliResponse: proposeOut } = await runProposeCell('crdt');

      const voteOut: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: true,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'vote',
        'crdt',
        proposeOut.proposalId,
        postState,
        { action: 'vote', strategy: 'crdt', voterId: workerIds[0], vote: true },
      );
      assertParity('vote-crdt', voteOut, builder);
    });

    it('vote × crdt — caller-supplied crdtSnapshot (real merge path)', async () => {
      const { workerIds } = await freshHive(3);
      const { cliResponse: proposeOut } = await runProposeCell('crdt');

      // Construct a real triple with one approver + one tally + LWW verdict.
      const g = new GCounter();
      g.increment(workerIds[0]);
      const aps = new ORSet<string>();
      aps.add(workerIds[0], workerIds[0]);
      const reg = new LWWRegister<unknown>();
      reg.write('approve', workerIds[0], FIXED_EPOCH);
      const crdtSnapshot: CRDTState = {
        votes: g.toJSON(),
        approvers: aps.toJSON(),
        verdict: reg.toJSON(),
      };

      const voteOut: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: true,
        crdtSnapshot,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'vote',
        'crdt',
        proposeOut.proposalId,
        postState,
        { action: 'vote', strategy: 'crdt', voterId: workerIds[0], vote: true, crdtSnapshot },
      );
      assertParity('vote-crdt-snapshot', voteOut, builder);
    });

    it('vote × bft — cross-proposal Byzantine inference from post-dispatch state (DA Wave 1 Concern #2)', async () => {
      // Cross-proposal Byzantine: voter casts conflicting votes across two
      // pending proposals of the SAME type. Cli bft branch (lines 2447-2470)
      // mutates proposal.byzantineVoters but DOES NOT record the vote
      // (proposal.votes[voterId] is NOT set). Builder must infer
      // byzantineDetected: true from `proposal.byzantineVoters.includes(voterId)`
      // when voterId is NOT in proposal.votes. DA's Concern #2 follow-up.
      const { workerIds } = await freshHive(5);
      // Propose 2 of the same type so cross-proposal detection has a peer.
      const p1: any = await consensusTool().handler({
        action: 'propose',
        type: 'cross-byz',
        value: 'a',
        strategy: 'bft',
      });
      const p2: any = await consensusTool().handler({
        action: 'propose',
        type: 'cross-byz',
        value: 'b',
        strategy: 'bft',
      });
      // Voter casts YES on p1, then attempts NO on p2 — same voter, same type,
      // conflicting votes → byzantine cross-proposal detection on p2.
      await consensusTool().handler({
        action: 'vote',
        proposalId: p1.proposalId,
        voterId: workerIds[0],
        vote: true,
      });
      const byzOut: any = await consensusTool().handler({
        action: 'vote',
        proposalId: p2.proposalId,
        voterId: workerIds[0],
        vote: false,
      });
      const postState = loadHiveState();

      expect(byzOut.byzantineDetected).toBe(true);
      expect(byzOut.byzantineVoters).toContain(workerIds[0]);

      const builder = buildConsensusResponse(
        'vote',
        'bft',
        p2.proposalId,
        postState,
        { action: 'vote', strategy: 'bft', voterId: workerIds[0], vote: false },
      ) as any;
      // Builder must surface byzantineVoters from post-mutation state.
      expect(builder.byzantineVoters).toContain(workerIds[0]);
      // Voter is NOT in proposal.votes (cli path doesn't record on detection).
      const p2Post = postState.consensus.pending.find(p => p.proposalId === p2.proposalId);
      expect(p2Post?.votes[workerIds[0]]).toBeUndefined();
    });

    it('vote × bft — pre-existing byzantineVoters round-trips', async () => {
      const { workerIds } = await freshHive(5);
      const { cliResponse: proposeOut } = await runProposeCell('bft');

      // First vote — clean. Second vote — byzantine equivocation (same voter,
      // different vote). Cli soft-returns {byzantineDetected: true, ...}.
      await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: true,
      });
      const byzOut: any = await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: false,
      });
      const postState = loadHiveState();

      // The cli's byzantine return shape (lines 2420-2429) carries a
      // `byzantineDetected: true` + `message` field that is NOT in the
      // builder's response shape. The builder reads from post-mutation state.
      // For this cell we only assert that the builder's `byzantineVoters`
      // field includes the byzantine voter — the soft-return-only fields
      // are reshape-territory (Wave 3) and out of Wave 1 scope.
      const builder = buildConsensusResponse(
        'vote',
        'bft',
        proposeOut.proposalId,
        postState,
        { action: 'vote', strategy: 'bft', voterId: workerIds[0], vote: false },
      );
      expect(byzOut.byzantineDetected).toBe(true);
      expect((builder as any).byzantineVoters).toContain(workerIds[0]);
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
      const { workerIds } = await freshHive(2); // raft majority = 2 of 2
      const { cliResponse: proposeOut } = await runProposeCell('raft');

      // Force resolution via majority vote.
      await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[0],
        vote: true,
      });
      await consensusTool().handler({
        action: 'vote',
        proposalId: proposeOut.proposalId,
        voterId: workerIds[1],
        vote: true,
      });

      const statusOut: any = await consensusTool().handler({
        action: 'status',
        proposalId: proposeOut.proposalId,
      });
      const postState = loadHiveState();

      const builder = buildConsensusResponse(
        'status',
        'raft',
        proposeOut.proposalId,
        postState,
        { action: 'status', strategy: 'raft' },
      );

      expect(statusOut.historical).toBe(true);
      // DA Wave 1 post-commit Concern #3: full parity diff (not spot-checks)
      // — the cli's history-fallback uses `{action, ...historical, historical:
      // true, resolved: true, statusJustTransitioned: false}` (cli line
      // 2657-2665). The builder enumerates those fields explicitly; only a
      // full deep-equal catches missing or extra fields.
      assertParity('status-history-row', statusOut, builder);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // list × strategy-agnostic
  // ──────────────────────────────────────────────────────────────────────
  describe('list action', () => {
    it('list — builder matches cli with mixed-strategy pending', async () => {
      await freshHive(4);
      // Seed pending with two proposals of different strategies.
      await consensusTool().handler({
        action: 'propose',
        type: 'list-cell-bft',
        value: 'a',
        strategy: 'bft',
      });
      await consensusTool().handler({
        action: 'propose',
        type: 'list-cell-quorum',
        value: 'b',
        strategy: 'quorum',
      });

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
