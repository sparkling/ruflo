/**
 * Hive-Mind Consensus Response Builder (ADR-0185 Wave 1)
 *
 * This module is purely additive at Wave 1. The cli `hive-mind_consensus`
 * handler at `hive-mind-tools.ts` continues to construct its responses
 * inline; this builder produces the SAME response shape from post-mutation
 * state and is verified via the parity harness at
 * `__tests__/hive-mind-consensus-parity.test.ts`.
 *
 * Waves 2-5 (per ADR-0185 §Execution Plan) flip each action branch in the
 * handler to:
 *   1. `await archivist.dispatch('hive-mind_consensus', { ...payload, proposalId })`
 *   2. Re-read state via `archivist.dispatchRead('hive-mind_status', ...)`
 *   3. `return buildConsensusResponse(action, strategy, proposalId, state, input)`
 *
 * Wave 6 deletes the 6 mutation-only helpers that become dead after the flip.
 *
 * Sourcing decisions (per ADR-0185 §Architecture + Wave 1 DA review):
 *
 *  - `exhausted` (vote × gossip):
 *      Reads `proposal.gossipExhausted ?? false`. The flag is persisted by
 *      agentdb's gossip handler per ADR-0184 Wave 4 DA Concern 2 resolution.
 *      We do NOT re-invoke `settleCheckGossip` here — the builder is a pure
 *      projection over post-dispatch state.
 *
 *  - `gossipBound`, `noVotes`, `settled`, `exhausted` (status × gossip):
 *      Re-invokes `settleCheckGossip(proposal)` against post-dispatch state.
 *      The cli's pre-flip status handler runs `maybeAdvanceGossipRoundOnTimeout`
 *      then `settleCheckGossip`; both round-counter mutations are persisted
 *      by the dispatch before this builder runs, so re-invoking
 *      `settleCheckGossip` against the post-dispatch proposal produces the
 *      same four telemetry fields the cli's call-site captured. Safe
 *      because `settleCheckGossip` is pure-read math over proposal fields.
 *      (DA Wave 1 open-item resolution: Option A.)
 *
 *  - `absentVoters` (status × any threshold strategy after auto-transition):
 *      Looked up from `state.consensus.history.find(...)?.absentVoters`.
 *      The cli's pre-flip handler reads `proposal.absentVoters` post-
 *      mutation; that proposal object is the same one pushed to history,
 *      so reading from history is equivalent and safer (the proposal is
 *      filtered out of pending by the auto-transition path).
 *
 *  - Reshape errors (`RaftTermCollisionError`, `RaftVoteChangeError`,
 *    `DuplicateVoteError`, `VoterIdRequiredError`, `ProposalNotFoundError`)
 *    are NEVER produced by the response-builder — they surface from the
 *    Waves 2-5 try/catch wrappers around `archivist.dispatch`. The builder
 *    only operates on POST-dispatch state (i.e. dispatch succeeded).
 */

import {
  type ConsensusProposal,
  type ConsensusStrategy,
  type HiveState,
  calculateRequiredVotes,
  gossipFanout,
  settleCheckGossip,
  weightedTally,
} from './hive-mind-tools.js';
import {
  GCounter,
  ORSet,
  LWWRegister,
  type CRDTState,
} from './crdt-types.js';

// ── ConsensusResponse discriminated union ───────────────────────────────────
//
// This is the formal cli response spec for the `hive-mind_consensus` MCP tool
// per ADR-0185 §Architecture: ProposeResponse | VoteResponse | StatusResponse
// | ListResponse discriminated on `action`. Strategy-conditional fields are
// optional members. The shape must round-trip exactly through the pre-flip
// cli handler — the parity harness asserts this across all 24+ cells.

export interface ProposeResponse {
  action: 'propose';
  proposalId: string;
  type: string;
  strategy: ConsensusStrategy;
  status: ConsensusProposal['status'];
  required: number;
  totalNodes: number;
  term?: number;
  quorumPreset?: string;
  timeoutAt?: string;
  // Gossip-only telemetry.
  gossipRound?: number;
  gossipBound?: number;
  roundTimeoutMs?: number;
  // CRDT-only telemetry.
  crdtExpectedVoters?: number;
  crdtState?: CRDTState;
}

/**
 * VoteResponse — happy-path vote response shape produced by
 * `buildConsensusResponse`. Strategy-conditional optional fields described
 * inline below.
 *
 * BYZANTINE SUB-PATHS — IMPORTANT WAVE 3 BOUNDARY (DA Wave 1 Block resolution):
 *
 *  (a) CROSS-PROPOSAL Byzantine detection (BFT) — detected at vote-time
 *      across PENDING proposals of the same type. Mutates
 *      `proposal.byzantineVoters` and DOES NOT record the vote
 *      (`proposal.votes[voterId]` is NOT set). The response-builder reads
 *      from post-dispatch state and surfaces `byzantineDetected: true` +
 *      `byzantineVoters` + `message` via the union fields below. This is
 *      the BUILDER's responsibility — `VoteResponse` covers it.
 *
 *  (b) SAME-VOTER-CONFLICT (BFT) — detected at vote-time when the SAME
 *      voter writes the SAME proposal with a DIFFERENT vote. Cli pre-flip
 *      soft-returns `{action, error, proposalId, existingVote}` (an envelope
 *      shape DIFFERENT from VoteResponse). Agentdb's bft.ts handler
 *      currently throws a plain `Error` for this path (NOT one of the 8
 *      typed reshape classes). Per Wave 3 try/catch contract, this means
 *      EITHER (i) agentdb's bft.ts must be amended to throw a new typed
 *      class that the Wave 3 cli wrapper can `instanceof`-discriminate
 *      and reshape into the `{action, error, ...}` envelope; OR (ii) the
 *      Wave 3 cli wrapper must catch the plain `Error` by message-prefix
 *      and reshape, which is a fragile pattern.
 *
 *  This `VoteResponse` union does NOT cover sub-path (b)'s envelope shape.
 *  Sub-path (b) is constructed inline at the Wave 3 try/catch site, NOT
 *  by `buildConsensusResponse`. Wave 3 implementer: resolve the
 *  typed-error-vs-plain-Error question before writing the try/catch.
 *
 *  TODO(Wave 3): forks/agentdb/src/archivist/handlers/hive-mind/consensus/
 *  bft.ts:150 throws a plain `Error` for same-voter-conflict re-submission.
 *  Wave 3 try/catch site at cli vote-flip MUST EITHER (1) catch by
 *  `e.message.startsWith('hive-mind_consensus.vote: voter ')` (fragile) OR
 *  (2) require agentdb amend bft.ts to throw a NEW typed class (e.g.
 *  `SameVoterConflictError`) added to the 8 existing reshape classes in
 *  agentdb's `_shared.ts`. Option (2) is the principled fix.
 */
export interface VoteResponse {
  action: 'vote';
  proposalId: string;
  voterId: string;
  vote?: boolean;
  strategy: ConsensusStrategy;
  votesFor: number;
  votesAgainst: number;
  required?: number;
  totalNodes: number;
  resolved?: boolean;
  result?: 'approved' | 'rejected' | 'failed-quorum-not-reached';
  status: ConsensusProposal['status'];
  term?: number;
  // BFT cross-proposal Byzantine detection (sub-path (a) above). Surfaces
  // from post-dispatch `proposal.byzantineVoters` + the absence of `voterId`
  // in `proposal.votes`. Same-voter-conflict (sub-path (b)) is NOT covered
  // here — it surfaces via the Wave 3 try/catch envelope, not the builder.
  byzantineDetected?: boolean;
  byzantineVoters?: string[];
  message?: string;
  // Gossip-only telemetry.
  gossipRound?: number;
  lastVoteChangedRound?: number;
  gossipBound?: number;
  settled?: boolean;
  exhausted?: boolean;
  // CRDT-only telemetry.
  totalCast?: number;
  crdtState?: CRDTState;
  crdtVerdict?: unknown;
  crdtApprovers?: string[];
  crdtVoteCount?: number;
  crdtTimedOut?: boolean;
  crdtExpectedVoters?: number;
}

export interface StatusResponse {
  action: 'status';
  proposalId: string;
  type?: string;
  strategy?: ConsensusStrategy;
  status?: ConsensusProposal['status'] | string;
  votesFor?: number;
  votesAgainst?: number;
  totalVotes?: number;
  required?: number;
  totalNodes?: number;
  resolved?: boolean;
  result?: 'approved' | 'rejected' | 'failed-quorum-not-reached';
  term?: number;
  quorumPreset?: string;
  byzantineVoters?: string[];
  timedOut?: boolean;
  timeoutAt?: string;
  hint?: string;
  statusJustTransitioned?: boolean;
  absentVoters?: string[];
  historical?: boolean;
  // Gossip-only telemetry.
  gossipRound?: number;
  lastVoteChangedRound?: number;
  gossipBound?: number;
  settled?: boolean;
  exhausted?: boolean;
  noVotes?: boolean;
  // CRDT-only telemetry.
  crdtState?: CRDTState;
  crdtVerdict?: unknown;
  crdtApprovers?: string[];
  crdtVoteCount?: number;
  crdtExpectedVoters?: number;
  crdtTimedOut?: boolean;
  // History-row passthrough fields (when proposal lives in `state.consensus.history`).
  votes?: { for: number; against: number };
  decidedAt?: string;
  byzantineDetected?: string[];
}

export interface ListResponsePendingRow {
  proposalId: string;
  type: string;
  strategy: ConsensusStrategy;
  proposedAt: string;
  totalVotes: number;
  required: number;
  term?: number;
  status: ConsensusProposal['status'];
}

export interface ListResponse {
  action: 'list';
  pending: ListResponsePendingRow[];
  recentHistory: unknown[];
}

export type ConsensusResponse =
  | ProposeResponse
  | VoteResponse
  | StatusResponse
  | ListResponse;

// ── Input payload (mirrors the cli handler's `input` shape) ─────────────────
//
// Only the fields the response-builder reads are typed. Other fields the
// handler consumes (vote, voterId, crdtSnapshot, etc.) flow through the
// archivist dispatch and surface on the post-dispatch proposal — not on the
// input.
export interface BuildConsensusResponseInput {
  action: 'propose' | 'vote' | 'status' | 'list';
  proposalId?: string;
  type?: string;
  value?: unknown;
  voterId?: string;
  vote?: boolean;
  strategy?: ConsensusStrategy | 'byzantine';
  quorumPreset?: string;
  term?: number;
  timeoutMs?: number;
  roundTimeoutMs?: number;
  crdtSnapshot?: CRDTState;
  includeProvenance?: boolean;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Build a ConsensusResponse from the post-dispatch state. Pure projection;
 * no I/O, no mutation, no error generation. See module header for sourcing
 * decisions.
 *
 * Signature follows ADR-0185 §Architecture: `(action, strategy, proposalId,
 * state, input) → ConsensusResponse`. `totalNodes` is derived from
 * `state.workers.length || 1` (matching the cli handler's derivation at
 * line 2061).
 */
export function buildConsensusResponse(
  action: 'propose' | 'vote' | 'status' | 'list',
  strategy: ConsensusStrategy,
  proposalId: string,
  state: HiveState,
  input: BuildConsensusResponseInput,
): ConsensusResponse {
  const totalNodes = state.workers.length || 1;

  switch (action) {
    case 'propose':
      return buildProposeResponse(strategy, proposalId, state, input, totalNodes);
    case 'vote':
      return buildVoteResponse(strategy, proposalId, state, input, totalNodes);
    case 'status':
      return buildStatusResponse(proposalId, state, totalNodes);
    case 'list':
      return buildListResponse(state, totalNodes);
    default: {
      const _exhaustive: never = action;
      throw new Error(
        `buildConsensusResponse: unknown action ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

// ── Per-action builders ─────────────────────────────────────────────────────

function buildProposeResponse(
  strategy: ConsensusStrategy,
  proposalId: string,
  state: HiveState,
  input: BuildConsensusResponseInput,
  totalNodes: number,
): ProposeResponse {
  const proposal = state.consensus.pending.find(p => p.proposalId === proposalId);
  if (!proposal) {
    // Per `feedback-no-fallbacks`: propose-action responses come from a freshly
    // created proposal. If it is not in pending after dispatch, the dispatch
    // semantics were violated. Throw rather than emit a degenerate response.
    throw new Error(
      `buildConsensusResponse.propose: proposal ${proposalId} not found in state.consensus.pending after dispatch`,
    );
  }

  const isGossip = strategy === 'gossip';
  const quorumPreset = (input.quorumPreset as ConsensusProposal['quorumPreset']) ?? proposal.quorumPreset;
  const required = calculateRequiredVotes(strategy, totalNodes, quorumPreset);

  return {
    action: 'propose',
    proposalId,
    type: proposal.type,
    strategy,
    status: proposal.status,
    required,
    totalNodes,
    term: proposal.term,
    quorumPreset: proposal.quorumPreset,
    timeoutAt: proposal.timeoutAt,
    gossipRound: proposal.gossipRound,
    gossipBound: isGossip ? gossipFanout(totalNodes) : undefined,
    roundTimeoutMs: proposal.roundTimeoutMs,
    crdtExpectedVoters: proposal.crdtExpectedVoters,
    crdtState: proposal.crdtState,
  };
}

function buildVoteResponse(
  strategy: ConsensusStrategy,
  proposalId: string,
  state: HiveState,
  input: BuildConsensusResponseInput,
  totalNodes: number,
): VoteResponse {
  // Locate the proposal: pending first, history second. A vote response may
  // refer to a proposal still pending (vote did not resolve) OR one moved to
  // history (vote resolved the proposal and the dispatch filtered it out of
  // pending). The cli's pre-flip vote handler returns the proposal's POST-
  // mutation status in either case (lines 2615-2638).
  const pending = state.consensus.pending.find(p => p.proposalId === proposalId);
  const historyRow = state.consensus.history.find(h => h.proposalId === proposalId);
  if (!pending && !historyRow) {
    throw new Error(
      `buildConsensusResponse.vote: proposal ${proposalId} not found in pending or history after dispatch`,
    );
  }

  const voterId = input.voterId ?? '';
  const voteValue = input.vote;

  // CRDT branch — telemetry sourced from `proposal.crdtState`. Matches the
  // cli vote-handler crdt-branch return at lines 2367-2389.
  if (strategy === 'crdt') {
    const proposal = pending ?? null; // CRDT keeps proposal in pending until settle (matches cli line 2357-2359 filter)
    const crdtState: CRDTState | undefined = proposal?.crdtState ?? undefined;
    const expected = proposal?.crdtExpectedVoters ?? Math.max(1, totalNodes);
    const distinctVoters = proposal ? Object.keys(proposal.votes).length : 0;

    let approverIds: string[] = [];
    let crdtVerdict: unknown = undefined;
    let crdtVoteCount = 0;
    if (crdtState) {
      approverIds = ORSet.from<string>(crdtState.approvers).elements();
      crdtVerdict = LWWRegister.from(crdtState.verdict).value();
      crdtVoteCount = GCounter.from(crdtState.votes).value();
    }

    const resolved = !!historyRow;
    const result = historyRow?.result as 'approved' | 'rejected' | undefined;

    // crdtTimedOut: derived from `roundStartedAt + roundTimeoutMs` vs Date.now()
    // — same comparison the cli uses (lines 2327-2331). Post-dispatch state
    // preserves `roundStartedAt`, so the builder reproduces the cli's
    // call-site computation exactly. DA Wave 1 post-commit Block resolution.
    let crdtTimedOut: boolean | undefined = undefined;
    if (proposal?.roundStartedAt && proposal?.roundTimeoutMs) {
      const elapsed = Date.now() - new Date(proposal.roundStartedAt).getTime();
      crdtTimedOut = elapsed >= proposal.roundTimeoutMs;
    }

    return {
      action: 'vote',
      proposalId,
      voterId,
      strategy,
      votesFor: approverIds.length,
      votesAgainst: Math.max(0, distinctVoters - approverIds.length),
      totalCast: distinctVoters,
      crdtExpectedVoters: expected,
      totalNodes,
      resolved,
      result,
      status: proposal?.status ?? (historyRow?.result as ConsensusProposal['status']),
      crdtState,
      crdtVerdict,
      crdtApprovers: approverIds,
      crdtVoteCount,
      crdtTimedOut,
    };
  }

  // Non-CRDT branches: shared shape per cli lines 2615-2638.
  const proposal = pending ?? null;
  const proposalStrategy: ConsensusStrategy =
    (proposal?.strategy as ConsensusStrategy | undefined) ??
    (historyRow?.strategy as ConsensusStrategy | undefined) ??
    strategy;
  const term = proposal?.term ?? historyRow?.term;

  // Tally: cli weighted branch uses `weightedTally(proposal, queenId)`;
  // others use plain vote-count. Post-mutation the proposal may not exist
  // (resolved → history); fall back to the history-row's persisted tally.
  let votesFor: number;
  let votesAgainst: number;
  if (proposal && proposalStrategy === 'weighted' && state.queen) {
    const tally = weightedTally(proposal, state.queen.agentId);
    votesFor = tally.votesFor;
    votesAgainst = tally.votesAgainst;
  } else if (proposal) {
    votesFor = Object.values(proposal.votes).filter(v => v).length;
    votesAgainst = Object.values(proposal.votes).filter(v => !v).length;
  } else {
    votesFor = historyRow!.votes.for;
    votesAgainst = historyRow!.votes.against;
  }

  const required = calculateRequiredVotes(
    proposalStrategy,
    totalNodes,
    proposal?.quorumPreset ?? input.quorumPreset as ConsensusProposal['quorumPreset'],
  );

  const resolved = !!historyRow;
  const result = historyRow?.result as 'approved' | 'rejected' | 'failed-quorum-not-reached' | undefined;
  const status = proposal?.status ?? (result as ConsensusProposal['status']);

  // BFT byzantineVoters telemetry. Cli emits `byzantineVoters` when the
  // proposal's list is non-empty (line 2629).
  const byzantineVoters = proposal?.byzantineVoters?.length
    ? proposal.byzantineVoters
    : (historyRow?.byzantineDetected as string[] | undefined);

  // Gossip telemetry. `exhausted` sourcing per DA Wave 1 Concern #3
  // resolution: read `proposal.gossipExhausted` (ADR-0184 Wave 4 persisted
  // flag), not a re-invocation of `settleCheckGossip`.
  const isGossip = proposalStrategy === 'gossip';
  const gossipBound = isGossip
    ? gossipFanout((proposal?.totalNodes ?? totalNodes))
    : undefined;
  // `proposal.gossipExhausted` is added to ConsensusProposal in ADR-0184 Wave
  // 4 (currently `unknown` at the type level via the cast — TS exact shape
  // is updated when the agentdb-side change syncs). Read defensively.
  // Cli emits `exhausted: gossipSettleResult?.exhausted` — which is
  // `undefined` (not `false`) when `settleCheckGossip` doesn't return an
  // `exhausted` key (it only sets the key on hard-budget-exhausted state).
  // The builder must mirror this: emit `true` if persisted, `undefined`
  // otherwise. Plain `Boolean(undefined) === false` would diverge from
  // the cli's undefined and surface as a parity diff.
  const gossipExhaustedFlag = (proposal as unknown as { gossipExhausted?: boolean } | null)?.gossipExhausted;
  const exhausted = isGossip
    ? (gossipExhaustedFlag === true ? true : undefined)
    : undefined;
  // `settled`: gossip proposals move to history ONLY on settle (per cli vote
  // branch line 2594-2611 — `tryResolveProposal` returns non-null only on
  // settle). Exhaustion does NOT move to history (cli lines 2581-2588 keep
  // exhausted proposals in pending). So `settled === !!historyRow` is
  // correct for gossip vote responses. DA Wave 1 post-commit Concern #2.
  const settled = isGossip ? resolved : undefined;

  return {
    action: 'vote',
    proposalId,
    voterId,
    vote: voteValue,
    strategy: proposalStrategy,
    votesFor,
    votesAgainst,
    required,
    totalNodes,
    resolved,
    result: resolved ? result : undefined,
    status,
    term,
    byzantineVoters,
    gossipRound: proposal?.gossipRound,
    lastVoteChangedRound: proposal?.lastVoteChangedRound,
    gossipBound,
    settled,
    exhausted,
  };
}

function buildStatusResponse(
  proposalId: string,
  state: HiveState,
  totalNodes: number,
): StatusResponse {
  const pending = state.consensus.pending.find(p => p.proposalId === proposalId);
  const historyRow = state.consensus.history.find(h => h.proposalId === proposalId);

  // History-only path: the proposal lives in history (resolved or auto-
  // transitioned to failed-quorum-not-reached). Matches cli line 2655-2666
  // verbatim: `return { action, ...historical, historical: true, resolved:
  // true, statusJustTransitioned: false }`. The history row carries `result`
  // not `status` — the cli's spread therefore emits no `status` field.
  // The builder enumerates the history row's actual fields (per ConsensusResult
  // interface at hive-mind-tools.ts:570-584: proposalId, type, result, votes,
  // decidedAt, strategy, term?, byzantineDetected?, absentVoters?).
  if (!pending && historyRow) {
    return {
      action: 'status',
      proposalId,
      type: historyRow.type,
      strategy: historyRow.strategy as ConsensusStrategy,
      votes: historyRow.votes,
      decidedAt: historyRow.decidedAt,
      term: historyRow.term,
      byzantineDetected: historyRow.byzantineDetected,
      absentVoters: historyRow.absentVoters,
      result: historyRow.result,
      historical: true,
      resolved: true,
      statusJustTransitioned: false,
    };
  }

  if (!pending) {
    // Per cli line 2667 — soft error envelope. The response-builder is invoked
    // for the successful dispatch path; if proposal is missing in BOTH pending
    // and history, dispatch contract was violated.
    throw new Error(
      `buildConsensusResponse.status: proposal ${proposalId} not found in pending or history after dispatch`,
    );
  }

  const proposal = pending;
  const proposalStrategy = (proposal.strategy ?? 'raft') as ConsensusStrategy;

  // Tally — weighted requires queen.
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

  // Raft timeout — cli line 2691-2694.
  let timedOut = false;
  if (proposalStrategy === 'raft' && proposal.timeoutAt) {
    timedOut = Date.now() > new Date(proposal.timeoutAt).getTime();
  }

  // CRDT telemetry — sourced from proposal.crdtState. Matches cli lines 2803-2814.
  let crdtVerdictValue: unknown = undefined;
  let crdtApproverList: string[] = [];
  let crdtVoteTotal = 0;
  let crdtTimedOut: boolean | undefined = undefined;
  if (proposalStrategy === 'crdt' && proposal.crdtState) {
    const verdictReg = LWWRegister.from(proposal.crdtState.verdict);
    const approverSet = ORSet.from<string>(proposal.crdtState.approvers);
    const gcounter = GCounter.from(proposal.crdtState.votes);
    crdtVerdictValue = verdictReg.value();
    crdtApproverList = approverSet.elements();
    crdtVoteTotal = gcounter.value();
    crdtTimedOut = false;
    if (proposal.roundStartedAt && proposal.roundTimeoutMs) {
      const elapsed = Date.now() - new Date(proposal.roundStartedAt).getTime();
      if (elapsed >= proposal.roundTimeoutMs) crdtTimedOut = true;
    }
  }

  const isGossip = proposalStrategy === 'gossip';
  const isCrdt = proposalStrategy === 'crdt';

  // Gossip-strategy telemetry. DA Wave 1 open-item resolution (Option A):
  // re-invoke `settleCheckGossip` on the post-dispatch proposal for the
  // status path. The cli's pre-flip status handler invokes settleCheckGossip
  // AFTER maybeAdvanceGossipRoundOnTimeout, both of which are persisted by
  // the dispatch before this builder runs — so the post-dispatch proposal's
  // round counters are exactly what the cli's call-site observed. Safe
  // because settleCheckGossip is pure-read (lines 857-894 of hive-mind-tools.ts).
  //
  // Vote path uses different sourcing (`proposal.gossipExhausted`) because
  // agentdb's gossip.ts writes the flag at exhaustion but doesn't always
  // advance round counters in a way that settleCheckGossip would re-derive
  // safely mid-vote. The asymmetry mirrors the cli's pre-flip semantics.
  const gossipSettle = isGossip ? settleCheckGossip(proposal) : undefined;
  const gossipBound = gossipSettle?.bound;
  const noVotes = gossipSettle?.noVotes;
  const settled = gossipSettle?.settled;
  const exhausted = gossipSettle?.exhausted;

  // ADR-0131 (T12) post-transition path: if the proposal transitioned during
  // dispatch, it is now in history, not pending. The history-only branch
  // above handles that. The pending branch here returns `statusJustTransitioned: false`
  // because the call observed a still-pending proposal.

  return {
    action: 'status',
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
    result: undefined,
    term: proposal.term,
    quorumPreset: proposal.quorumPreset,
    byzantineVoters: proposal.byzantineVoters?.length ? proposal.byzantineVoters : undefined,
    timedOut,
    timeoutAt: proposal.timeoutAt,
    hint: timedOut ? `Raft timeout reached. Re-propose with term ${(proposal.term ?? 1) + 1}.` : undefined,
    statusJustTransitioned: false,
    absentVoters: undefined,
    gossipRound: proposal.gossipRound,
    lastVoteChangedRound: proposal.lastVoteChangedRound,
    gossipBound,
    settled,
    exhausted,
    noVotes,
    crdtState: isCrdt ? proposal.crdtState : undefined,
    crdtVerdict: isCrdt ? crdtVerdictValue : undefined,
    crdtApprovers: isCrdt ? crdtApproverList : undefined,
    crdtVoteCount: isCrdt ? crdtVoteTotal : undefined,
    crdtExpectedVoters: proposal.crdtExpectedVoters,
    crdtTimedOut: isCrdt ? crdtTimedOut : undefined,
  };
}

function buildListResponse(state: HiveState, totalNodes: number): ListResponse {
  return {
    action: 'list',
    pending: state.consensus.pending.map(p => ({
      proposalId: p.proposalId,
      type: p.type,
      strategy: (p.strategy ?? 'raft') as ConsensusStrategy,
      proposedAt: p.proposedAt,
      totalVotes: Object.keys(p.votes).length,
      required: calculateRequiredVotes(
        (p.strategy ?? 'raft') as ConsensusStrategy,
        totalNodes,
        p.quorumPreset,
      ),
      term: p.term,
      status: p.status,
    })),
    recentHistory: state.consensus.history.slice(-5),
  };
}
