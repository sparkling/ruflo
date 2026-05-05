---
name: hive-mind-advanced
description: Hive Mind orchestration patterns — queen-led multi-agent coordination with Byzantine/Raft/Gossip/CRDT consensus, typed collective memory, dialectic council, and session checkpoint/resume. Use for decision-bearing work; use swarm-advanced for parallel execution without consensus.
version: 2.0.0
category: coordination
tags: [hive-mind, council, dialectic, consensus, byzantine, raft, gossip, crdt, queen-worker, multi-agent, fault-tolerance]
author: Ruflo Fork Team
allowed-tools: Bash(npx *) Read Write Edit Grep Glob Task mcp__ruflo__hive-mind_init mcp__ruflo__hive-mind_spawn mcp__ruflo__hive-mind_status mcp__ruflo__hive-mind_join mcp__ruflo__hive-mind_leave mcp__ruflo__hive-mind_consensus mcp__ruflo__hive-mind_broadcast mcp__ruflo__hive-mind_shutdown mcp__ruflo__hive-mind_memory mcp__ruflo__memory_store mcp__ruflo__memory_search
---

# Hive Mind Advanced

Hive Mind is the queen-led coordination capability for tasks that need a **decision** — a verdict, a vote, a ratified design. It complements `swarm-advanced` (which is for parallel execution without consensus). Pick a Hive Mind pattern when the goal is "reach agreement on X" or "produce a council-shaped review of Y." Pick swarm-advanced when the goal is "do parallel work and compose the artefacts."

This skill covers four concrete patterns. Each is a real recipe with verified MCP tool calls — not a feature list.

## Quick Start

### Prerequisites

The Ruflo MCP server must be registered (one-time, in shell):

```bash
claude mcp add claude-flow -- npx -y @sparkleideas/cli@latest mcp start
```

Tools resolve under `mcp__ruflo__*` (per ADR-0117 marketplace MCP server registration, Accepted/Implemented 2026-05-05). Use `mcp__ruflo__*` in invocations and worker contracts.

### Basic pattern (Pattern 1 — minimal Council)

```javascript
// Phase 1: Substrate
mcp__ruflo__hive-mind_init({
  topology: "hierarchical-mesh",
  consensus: "byzantine",
  maxAgents: 3,
  persist: true,
  memoryBackend: "hybrid"
})

// Phase 2: Register slot registry
mcp__ruflo__hive-mind_spawn({
  count: 3,
  role: "worker",
  agentTypes: ["researcher", "researcher", "researcher"],
  prefix: "council"
})

// Phase 3: Workforce — Claude's Agent tool, ONE message, parallel
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: <persona-1 worker contract> })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: <persona-2 worker contract> })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: <persona-3 worker contract — Devil's Advocate> })

// Phase 4: Resolve consensus (after workers return)
mcp__ruflo__hive-mind_consensus({
  action: "propose",
  type: "council-verdict",
  value: <topic>,
  strategy: "byzantine"
})
// then per-vote calls + final tally

// Phase 5: Persist verdict
mcp__ruflo__hive-mind_memory({
  action: "set",
  type: "consensus",
  key: <session-id>,
  value: <transcript>
})

// Phase 6: Status / shutdown
mcp__ruflo__hive-mind_status({ verbose: true })
mcp__ruflo__hive-mind_shutdown({ graceful: true })
```

## Calling convention (read this first)

**Queen calls MCP tools directly.** Same convention as `swarm-advanced`:

```javascript
mcp__ruflo__hive-mind_init({...})       // ← preferred
mcp__ruflo__hive-mind_spawn({...})      // ← preferred
mcp__ruflo__hive-mind_consensus({...})  // ← preferred
```

**Sub-agents (Agent-tool spawns) also call MCP directly.** Per ADR-0144 Amendment §arm B (verified empirically 2026-05-04, 30ms server-side), sub-agents spawned via Claude's `Agent` tool can invoke `mcp__ruflo__*` without a `ToolSearch` preamble. The earlier prohibition was rescinded.

**Inter-sub-agent messaging uses `SendMessage` (Agent Teams).** When a council pattern requires workers to exchange messages directly — see Pattern 1 §Transports (b) — spawn them with `team_name: "<council-id>"` and use `SendMessage({type:"message", recipient:"<peer>", content:"...", summary:"..."})`. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (typically pre-set in ruflo environments via `~/.claude/settings.json` `env` block; verify with `env | grep CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). This is the upstream-blessed inter-agent messaging primitive per USERGUIDE L1683.

Reserve `Bash("npx ... hive-mind ...")` for two cases only:
- The `--claude` subprocess-as-queen pattern (CLI Fallback in each Pattern below)
- Environments where the MCP server is not running (CI, daemon-less smoke). **Note:** the Bash CLI path hangs on flock contention against a running MCP server (per ADR-0140 §Amendment row D direct) — it is NOT a viable fallback inside an active session.

## Core concepts

### Queen types (3)

The active queen mode shapes the prompt the queen reads at launch. All three carry verbatim prose blocks at `forks/ruflo/v3/@sparkleideas/cli/src/commands/hive-mind.ts:617-744`. Sentinels (the "before declaring done verify" anchor):

| Queen type | Disposition | Sentinel | When to use |
|---|---|---|---|
| `strategic` | Architect-first; full plan tree before spawning workers | `"written plan"` | Research, planning, analysis. Long-horizon synthesis. |
| `tactical` | Dispatcher-first; spawn within first 3 cycles, ping every cycle | `"spawned workers within"` | Implementation, execution. Short-horizon decomposition. |
| `adaptive` | Mode-selecting; weighs subtask count, ambiguity, prior priors; calls `_consensus` before mid-run mode flips | `"named your chosen mode"` | Optimisation. Switches between Strategic and Tactical based on task complexity signals. |

Capability scoring (used by `QueenCoordinator` to assign work) is **queen-type-invariant**. Weights from `queen-coordinator.ts:1437-1442`: capability 0.30, performance 0.25, load 0.20, health 0.15, availability 0.10.

### Worker specialisations (8)

All 8 types share `subagent_type: researcher` when spawned via Claude's Agent tool — the persona is carried in the prompt body, not the type. The hive's per-type prose blocks are emitted by `renderWorkerTypeBlocks` at `commands/hive-mind.ts:240-345` and follow the ADR-0126 structural contract (3 fixed sections). Reference table:

| Type | One-line role | Primary tools |
|---|---|---|
| `researcher` | Gather context, surface prior art, recall similar past hives | `memory_search`, `embeddings_search`, `memory_retrieve` |
| `coder` | Implement planned changes; edit files, run tests, surface diffs | `Read/Write/Edit/Bash`, `task_assign`, `hive-mind_memory` |
| `analyst` | Profile, measure, surface bottlenecks | `performance_metrics`, `performance_bottleneck`, `performance_report` |
| `architect` | Author ADRs, weigh diff-level risk, define boundaries | `analyze_diff`, `analyze_diff-risk`, `Write (ADR)` |
| `tester` | Execute acceptance harness, write failing-first tests | `Bash (test runners)`, `task_status`, `hive-mind_memory` |
| `reviewer` | Audit changes for risk, recommend reviewers | `analyze_diff-risk`, `analyze_diff-reviewers`, `analyze_file-risk` |
| `optimizer` | Tune neural and runtime hot paths | `performance_bottleneck`, `neural_optimize`, `performance_optimize` |
| `documenter` | Update USERGUIDE/README/ADR cross-references | `Edit/Write (markdown)`, `markdown-editor` skill, `memory_search` |

Unknown types throw `Unknown worker-type for prompt: ${type}` per `feedback-no-fallbacks.md` — never silently falls through.

### Consensus algorithms (7)

The fork supports 7 algorithms (Majority was removed; it survives only as the formula Raft uses). Strategy is selected at `hive-mind_init` and per-`_consensus` call.

| Algorithm | Vote schema | Fault tolerance | Resolves | When to use |
|---|---|---|---|---|
| `weighted` | `Record<voterId, boolean>`; queen identified via `state.queen.agentId` | Requires queen present (`MissingQueenForWeightedConsensusError` if not). Denominator `(N-1) + 3` | `approved` / `rejected` / `pending` | Queen-led decisions where leader vote should dominate (USERGUIDE "Queen 3x" contract) |
| `byzantine` (alias `bft`) | `Map<voterId, vote>` | `f = floor((N-1)/3); requiredVotes = 2*f + 1` | `approved` / `rejected` / `pending` | Worker-unreliability tolerance (NOT adversarial — workers share auth) |
| `raft` | `Record<voterId, boolean>` + `term` uniqueness | Simple majority `floor(N/2)+1` | `approved` / `rejected` / `pending` | Leader-elected single-decision rounds with term ordering |
| `quorum` | `Record<voterId, boolean>` + `quorumPreset` | Preset-driven: `unanimous` / `majority` / `supermajority` | `approved` / `rejected` / `pending` | Caller-chosen threshold; configurable strictness |
| `gossip` | `ConsensusProposal` extended with `gossipRound`, `lastVoteChangedRound`, `totalNodes`, `currentRoundBroadcastSet[]` | No threshold; settles when `gossipRound >= ceil(log₂N) AND no recent vote change`. Hard budget `2·ceil(log₂N)` rounds | `{settled, result, round}` / `{exhausted, ...}` / `{settled:false, gossipRound, bound}` | Eventual-consistency advisory rounds for small N (4-32); tolerates voter dropouts |
| `crdt` | Per-voter `crdtState: { votes: GCounter, approvers: ORSet, verdict: LWWRegister }` | No threshold; mathematical convergence under any message order | Merged `{verdict.value(), approvers.elements(), votes.value()}` | Conflict-free state-merging; re-broadcast safety dominates |

**Note on `_status.consensus`**: per A2 finding, `hive-mind_status` returns `consensus: 'byzantine'` hardcoded regardless of init's persisted strategy. Read `state.config.consensus` from `state.json` directly if you need the truth.

### Memory types (8 typed buckets)

All 8 share one entry shape `{ value, type, ttlMs, expiresAt, createdAt, updatedAt }` keyed in `state.sharedMemory`. Eviction is lazy on `get`/`list` plus periodic sweep (`CLAUDE_FLOW_HIVE_SWEEP_MS`, default 60s). All 4 actions take `withHiveStoreLock`.

| Type | Default TTL | Purpose |
|---|---|---|
| `knowledge` | `null` (permanent) | Learned facts to retain across sessions |
| `context` | 1 hour | Per-session ambient state |
| `task` | 30 minutes | Task-scoped data; cleared after completion window |
| `result` | `null` (permanent) | Task completion outputs; durable artifacts |
| `error` | 24 hours | Failures, exceptions; post-mortem window |
| `metric` | 1 hour | Counters, latencies; observability rollups |
| `consensus` | `null` (permanent) | Ratified votes; consensus history |
| `system` | `null` (permanent) | Bookkeeping, legacy migrations |

Validation is fail-loud: missing `type` throws `MissingMemoryTypeError`, unknown type throws `InvalidMemoryTypeError`, non-finite `ttlMs` throws `InvalidTTLError`.

LRU cache: `RUFLO_HIVE_CACHE_MAX` default 1024 entries; classic move-to-front on hit. RVF is primary backend; per-write `appendFile` + `fdatasync` ensures power-loss durability on Linux (per ADR-0130). macOS is bounded by disk write cache.

### Topologies (6)

Selected at `hive-mind_init` via `topology` parameter. Wires the queen prompt (per-topology dispatch at `hive-mind.ts:91`) and worker visibility surface.

| Topology | Routing | Leader | When to use |
|---|---|---|---|
| `mesh` | Full peer broadcast; shared peer-visible memory | Static queen | Full peer collaboration; O(N²) acceptable |
| `hierarchical` | Queen-only broadcast; private worker namespaces | Static queen | Queen-summarised aggregation; no peer cross-talk needed |
| `hierarchical-mesh` | Mesh within sub-hive; sub-queens summarise to top queen | Top queen + 1 sub-queen per cluster (1-level cap) | Scale beyond mesh while keeping local cohesion |
| `ring` | Deterministic chain via `hive-mind_memory`; broadcasts disabled | Queen exists; coordination is P2P along ring edges | Deterministic ordered pipelines |
| `star` | Hub-and-spoke; queen sole memory writer | Queen as exclusive writer | Strict queen-writes-only audit/aggregation |
| `adaptive` | Meta-topology; defers to T9 control loop, resolves to one of the five at spawn time | Inherits from resolved target | Load-variable workloads |

Adaptive autoscale config: poll 5s, settle/dampen 30s, high-water queue depth >3, low-water 0, CoV thresholds 0.6 (→ mesh) / 0.3 (→ hierarchical), max 4 flips/hour per axis (circuit-breaker halts loud), 3 dampening windows mid-task switch deferral.

## Pattern 1: Council Hive (Dialectic)

### Purpose

Convene N named experts for dialectic review of a proposition. Each expert takes a clear stance citing their published methodology; one is the Devil's Advocate. Workers cross-engage by name with specific claims. Queen composes a structured transcript.

### Architecture

- **Substrate:** `hive-mind init` with `consensus: "byzantine"` (or `weighted` if queen vote should dominate), topology `hierarchical-mesh` (or `mesh` for ≤6 panellists)
- **Protocol layer:** project methodology file (e.g. ONT-0021) OR shipped `templates/generic-council-protocol.md` (see Piece 2)
- **Workforce:** N parallel `Agent` spawns, all `subagent_type: researcher`, persona in prompt body, `run_in_background: true`. ONE round of spawns.
- **Cross-talk:** queen-composed by default. For runtime cross-talk see "Transports" below.
- **Vote:** per-expert stance via `_consensus({action: "vote"})`; queen tallies via `_consensus({action: "status"})`.
- **Transcript:** queen composes from N return values. Every quotation traces to actual worker output (composition is legitimate; fabrication is illegitimate).

### Workflow

```javascript
// Phase 1: Substrate (queen)
mcp__ruflo__hive-mind_init({
  topology: "hierarchical-mesh",
  consensus: "byzantine",
  queenType: "strategic",
  maxAgents: 5,
  persist: true,
  memoryBackend: "hybrid"
})

// Phase 2: Read protocol layer (queen → Read tool)
// Read <project>/CLAUDE.md for the council-anchoring rule.
// Read <project>/<methodology>.md if the project ships one.
// Else read this skill's templates/generic-council-protocol.md.

// Phase 3: Register slot registry (queen)
mcp__ruflo__hive-mind_spawn({
  count: 5, role: "worker",
  agentTypes: ["researcher","researcher","researcher","researcher","researcher"],
  prefix: "council"
})

// Phase 4: Panellist spawn — ONE message, parallel
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: <persona-1 contract — see templates/worker-contract.md> })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: <persona-2 contract> })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: <persona-3 contract> })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: <persona-4 contract> })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: <persona-5 contract — Devil's Advocate flag set> })

// Phase 5: Vote (after all 5 return — queen tallies)
mcp__ruflo__hive-mind_consensus({
  action: "propose",
  type: "council-verdict",
  value: <proposition>,
  strategy: "byzantine",
  timeoutMs: 30000
})
// Per-voter ballots populated from worker return values:
mcp__ruflo__hive-mind_consensus({
  action: "vote", proposalId, voterId: "expert-1", vote: true
})
// ... × N
mcp__ruflo__hive-mind_consensus({
  action: "status", proposalId
})

// Phase 6: Transcript composition (queen → Write tool)
// 8-section format: agenda → positions → cross-expert discussion →
// vote table → findings → verdict → signatures.
// Use ONLY actual worker content. Each quotation traces to a return value.

// Phase 7: Persist verdict (queen)
mcp__ruflo__hive-mind_memory({
  action: "set",
  type: "consensus",
  key: `council-${sessionId}`,
  value: JSON.stringify({ transcript, verdict, signatures })
})

// Phase 8: Status / shutdown
mcp__ruflo__hive-mind_status({ verbose: true })
mcp__ruflo__hive-mind_shutdown({ graceful: true })
```

### Transports (pick ONE for cross-talk)

Listed in order of preference. Pick the first one whose preconditions are met for your task.

**(a) Queen-composed default — preferred for one-round councils.** Workers don't see each other at runtime; queen reads N return values and composes the inter-expert discussion in main thread. Composition is legitimate when every quotation traces to actual worker output. This is the canonical pattern that produced 250+ working pre-regression council sessions — workers were one-shot independent returners, queen composed transcripts from real content. Use when:
- Workers don't need to *revise* their position after seeing peers (most one-round dialectic fits this)
- Latency budget is tight (no barrier; bottleneck is the slowest worker, not crosstalk overhead)

**(b) `SendMessage` via Agent Teams — preferred for runtime cross-talk when workers must revise.** Spawn workers with `team_name: "<council-id>"`; workers exchange messages via `SendMessage({type:"message", recipient:"<peer-name>", content:"<text>", summary:"<one-line>"})`. Upstream-blessed inter-agent messaging primitive (USERGUIDE L1683 "Mailbox: SendMessage — Inter-agent messaging for coordination"). Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (typically pre-set in ruflo environments via `~/.claude/settings.json` `env` block). Use when:
- Workers must respond to peer claims before settling their final position
- You want the messaging surface that has hooks (`teammate-idle`, `task-completed`) and lifecycle (`TeamCreate`/`TeamDelete`) wired in

```javascript
// Queen sets up team
TeamCreate({ team_name: "council-2026-05-05", description: "ADR-0140 review" })

// Spawn teammates with team_name
Task({ subagent_type: "researcher", team_name: "council-2026-05-05",
       name: "strategist", run_in_background: true,
       prompt: "<persona contract; messages peers via SendMessage>" })
// ... × N

// Inside each worker prompt, the agent uses:
//   SendMessage({ type:"message", recipient:"realist",
//                 content:"On Q3 you said X — I think Y because...",
//                 summary:"counter on Q3" })
//   (peer agent receives the message via its own mailbox)

// Queen cleanup
TeamDelete()
```

**(c) Direct MCP `_memory` — preferred when you need durable, typed, cross-session crosstalk.** Workers call `mcp__ruflo__hive-mind_memory({action:"set", type:"context", key:"<persona>-pos", value:"..."})` and `({action:"get", key:"<peer>-pos"})`. Typed buckets (8 types with TTLs), atomic under `withHiveStoreLock`, RVF-backed durable, 100% concurrent-write durability bar (ADR-0123). Verified working from sub-agent 2026-05-04 (ADR-0144 arm B). Use when:
- Verdict needs to survive session restart (transport (a)/(b) lose state)
- Long-running multi-round councils where memory of prior rounds matters
- You want the typed-bucket model (`type:"context"` for in-flight; `type:"consensus"` for final verdict)

**(d) File-based via `/tmp/<hive-id>/` — fallback only.** Workers `Write pos-<name>.md` → `sleep 60` barrier → `Read pos-<peer>.md` → `Write reaction-<name>.md`. Validated empirically 2026-05-04 (memory `reference-hive-runtime-crosstalk-pattern.md`). Use only when:
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is not enabled AND
- The MCP server is unreliable AND
- Observability (`ls /tmp/<hive-id>/`) is more valuable than performance

This was the 2026-05-04 default before `SendMessage` and arm-B-verified MCP were considered. It's now demoted: the barrier sleep adds wall-clock latency without functional value over (b)/(c).

### Transport selection cheat-sheet

| Need | Transport |
|---|---|
| One-round dialectic; queen synthesises | (a) queen-composed |
| Workers must revise after seeing peers | (b) `SendMessage` |
| Cross-session durability; typed buckets | (c) `_memory` |
| MCP server down + Agent Teams unavailable | (d) file-based |

### CLI Fallback (subprocess-as-queen)

Use only when running this skill from a fresh terminal AND the spawned-claude-as-queen flow is specifically desired:

```bash
npx @sparkleideas/cli@latest hive-mind spawn -n 5 \
  --queen-type strategic --consensus byzantine \
  --worker-types researcher,researcher,researcher,researcher,researcher \
  --claude --objective "<council question>"
```

Add `--non-interactive` when invoking from inside an existing claude session (TTY-inherit will fail otherwise — falls back to stream-json print mode).

### Test backing

`p3-hm-init` / `p3-hm-spawn` / `p3-hm-consensus` / `p3-hm-memory` / `p3-hm-shutdown` smoke checks; `mcp-tools-deep.test.ts` behavioural; `adr0119-weighted-consensus.test.mjs` for weighted. Lifecycle chain via `p3-hm-lifecycle`.

## Pattern 2: Consensus Decision Hive (BFT)

### Purpose

Reach agreement on a discrete decision (architecture pattern, technology choice, release readiness) using formal consensus. No dialectic; just propose → vote → resolve. The decision is the artefact.

### Architecture

- **Substrate:** `hive-mind init` with chosen consensus algorithm
- **Workforce:** N parallel `Agent` spawns, each receives the proposal and returns a vote with rationale
- **Vote:** strategy determines fault-tolerance (Byzantine `2f+1`, Weighted queen×3, Raft simple majority, Quorum preset, Gossip eventual, CRDT convergent)
- **No transcript.** No protocol layer. The verdict + per-voter rationale are the deliverables.

### Workflow

```javascript
// Phase 1: Substrate
mcp__ruflo__hive-mind_init({
  topology: "mesh",
  consensus: "byzantine",
  queenType: "tactical",
  maxAgents: 5
})

// Phase 2: Slot registry
mcp__ruflo__hive-mind_spawn({ count: 5, role: "worker" })

// Phase 3: Propose
mcp__ruflo__hive-mind_consensus({
  action: "propose",
  type: "decision",
  value: { question: <Q>, options: [<A>, <B>, <C>] },
  strategy: "byzantine",
  timeoutMs: 60000
})

// Phase 4: Workforce — voters
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: `Vote on: <Q>. Options: <A>/<B>/<C>. Return choice + rationale.
                 Then call mcp__ruflo__hive-mind_consensus with
                 action:"vote", proposalId:"${proposalId}", voterId:"<id>",
                 vote:<true if A else false>.` })
// ... × N

// Phase 5: Resolve + persist
const result = mcp__ruflo__hive-mind_consensus({
  action: "status", proposalId
})
mcp__ruflo__hive-mind_memory({
  action: "set", type: "consensus",
  key: `decision-${proposalId}`, value: JSON.stringify(result)
})

// Phase 6: Shutdown
mcp__ruflo__hive-mind_shutdown({ graceful: true })
```

### Consensus algorithm selection guidance

- Use **byzantine** when `N ≥ 4` and you want fault-tolerant agreement (`f < N/3` workers can fail).
- Use **weighted** when the queen is the authoritative voice and worker votes are advisory (queen counts ×3).
- Use **raft** when the proposition has term ordering (sequential decisions where each supersedes the prior).
- Use **quorum** when you need configurable strictness (`unanimous` for safety-critical; `supermajority` for governance; `majority` for default).
- Use **gossip** for eventually-consistent advisory rounds with small `N` (4-32) where voter dropouts are common.
- Use **crdt** when re-broadcast safety dominates (network partitions; out-of-order delivery).

### CLI Fallback

```bash
npx @sparkleideas/cli@latest hive-mind spawn -n 5 \
  --queen-type tactical --consensus byzantine \
  --claude --objective "<decision question>"
```

### Test backing

`adr0119-weighted-consensus`, `adr0120-gossip-consensus`, `adr0121-crdt-consensus`, plus `mcp-tools-deep.test.ts` consensus block. `byzantine.ts:177` is the BFT formula.

## Pattern 3: Implementation Hive (Coordinated Development)

### Purpose

Coordinated development of a feature across N specialists, with consensus checkpoints on architectural decisions during execution. Hybrid pattern: consensus for the design vote → parallel specialist execution → consensus for the review vote.

### Architecture

- **Substrate:** `hive-mind init` with `consensus: "weighted"` (queen guides; team executes)
- **Workforce:** mixed-type via `agentTypes` (architect + coders + tester + reviewer)
- **Phase pattern:** Architect-vote → parallel-build → review-vote → consensus on merge
- Decision points use `_consensus`; execution uses Agent-tool spawns.

### Workflow

```javascript
// Phase 1: Substrate
mcp__ruflo__hive-mind_init({
  topology: "hierarchical-mesh",
  consensus: "weighted",
  queenType: "tactical",
  maxAgents: 6
})

// Phase 2: Architect produces design
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<architect persona — produce ADR + design rationale>" })

// Phase 3: Consensus on architecture
mcp__ruflo__hive-mind_consensus({
  action: "propose",
  type: "architecture",
  value: { adr: <path>, rationale: <text> },
  strategy: "weighted"
})
// ... vote calls × N
mcp__ruflo__hive-mind_consensus({ action: "status", proposalId: <archId> })

// Phase 4: Parallel implementation (mixed worker types)
mcp__ruflo__hive-mind_spawn({
  count: 4, role: "worker",
  agentTypes: ["coder", "coder", "tester", "documenter"],
  prefix: "impl"
})
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<coder persona — backend>" })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<coder persona — frontend>" })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<tester persona — acceptance harness>" })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<documenter persona — USERGUIDE updates>" })

// Phase 5: Reviewer surfaces concerns
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<reviewer persona — risk assessment via analyze_diff-risk>" })

// Phase 6: Consensus on merge readiness
mcp__ruflo__hive-mind_consensus({
  action: "propose",
  type: "merge-readiness",
  value: { changes: <summary>, riskScore: <n> },
  strategy: "weighted"
})

// Phase 7: Persist outcome
mcp__ruflo__hive-mind_memory({
  action: "set", type: "result",
  key: `impl-${featureId}`,
  value: JSON.stringify({ archDecision, reviewVerdict, artefacts })
})

mcp__ruflo__hive-mind_status({ verbose: true })
mcp__ruflo__hive-mind_shutdown({ graceful: true })
```

### CLI Fallback

```bash
npx @sparkleideas/cli@latest hive-mind spawn -n 6 \
  --queen-type tactical --consensus weighted \
  --worker-types coder,coder,tester,architect,reviewer,documenter \
  --claude --objective "<feature description>"
```

### Test backing

`adr0108-mixed-type-spawn.test.mjs` (round-robin + mutex), `adr0126-worker-type-prompts.test.mjs`, plus the consensus tests above.

## Pattern 4: Review Hive (Multi-perspective)

### Purpose

Review existing code, design, or decision from N independent perspectives (security / performance / accessibility / architecture / etc.) with consensus on severity and required actions. Like Pattern 1 but reviewers cite their own checklists rather than published methodologies.

### Architecture

- **Substrate:** `hive-mind init` with `consensus: "quorum"` (use `quorumPreset: "majority"` for default; `"unanimous"` if zero-tolerance; `"supermajority"` for governance). **Note:** `consensus: "majority"` is NOT a valid `_consensus.strategy` enum value (Majority was removed per ADR-0119 — survives only as the formula Raft uses). Use `quorum` with the `majority` preset instead.
- **Workforce:** N reviewers, each carrying a perspective brief (security / performance / accessibility / etc.)
- **Findings:** categorised `VIOLATION` / `WARNING` / `OBSERVATION`
- **Per-finding consensus:** severity vote per finding; final verdict aggregates

### Workflow

```javascript
// Phase 1: Substrate
mcp__ruflo__hive-mind_init({
  topology: "mesh",
  consensus: "quorum",
  queenType: "strategic",
  maxAgents: 4
})

// Phase 2: Slot registry
mcp__ruflo__hive-mind_spawn({
  count: 4, role: "worker",
  agentTypes: ["reviewer", "reviewer", "reviewer", "reviewer"],
  prefix: "review"
})

// Phase 3: Reviewer spawn — ONE message, parallel
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<security perspective — checklist + worker contract>" })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<performance perspective>" })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<accessibility perspective>" })
Agent({ subagent_type: "researcher", run_in_background: true,
        prompt: "<architectural perspective>" })

// Phase 4: Per-finding cross-engagement (transport b — file-based)
// Workers cross-reference each other's findings via /tmp/<hive-id>/finding-*.md.

// Phase 5: Severity vote per finding
for (const finding of findings) {
  mcp__ruflo__hive-mind_consensus({
    action: "propose",
    type: "finding-severity",
    value: { finding: finding.id, candidates: ["VIOLATION","WARNING","OBSERVATION"] },
    strategy: "quorum",
    quorumPreset: "majority"
  })
  // ... per-voter ballots ...
}

// Phase 6: Findings table + verdict
mcp__ruflo__hive-mind_memory({
  action: "set", type: "result",
  key: `review-${reviewId}`,
  value: JSON.stringify({ findings, verdicts, recommendations })
})
```

### CLI Fallback

```bash
npx @sparkleideas/cli@latest hive-mind spawn -n 4 \
  --queen-type strategic --consensus quorum \
  --worker-types reviewer,reviewer,reviewer,reviewer \
  --claude --objective "Review <target>"
```

## Failure handling

The fork ships two verbatim protocol blocks at `commands/hive-mind.ts:495-595` that the queen reads on launch. They are load-bearing — workers transitioning to `failed-quorum-not-reached` do so via runtime auto-status transitions, and sub-queen escalation in `hierarchical-mesh` follows a data-driven hybrid (promote-worker if ≥1 healthy in sub-hive; else escalate-to-root).

### WORKER FAILURE PROTOCOL (commands/hive-mind.ts:495-536)

Sentinels: `'absent'`, `60s`, `retry-once`, `worker-<id>-status`. Behaviour:

1. **Immediate readback** — after spawn, queen reads `worker-<id>-status` keys at every coordination cycle.
2. **Record absence** — 60s with no result key → mark `'absent'`. Never wait indefinitely.
3. **Retry-once OR proceed** — at most one retry (`retryOf` lineage pointer; ID convention `worker-<original-id>-retry-1`). No `retry-2`.
4. **Quorum handling** — runtime auto-transitions: when `Date.now() >= proposal.timeoutAt && totalVotes < requiredVotes`, status moves `pending → failed-quorum-not-reached` with `absentVoters` snapshot. Queen does NOT mark manually.

Worker rejoin after failure throws `WorkerAlreadyFailedError` (synchronous; never silently re-admits).

### SUB-QUEEN FAILURE PROTOCOL (commands/hive-mind.ts:538-595)

Triggers: missing summary key >60s, Task error, or unresponsive `hive-mind_status` probe. Strategy is data-driven, not policy-driven:

- **promote-worker** if ≥1 healthy worker remains in sub-hive — longest-lineage worker promoted; sub-hive boundary preserved.
- **escalate-to-root** if zero healthy workers — entire subtree marked FAILED; orphaned workers absorbed into top tier.

Recursion cap: 1 nesting level (no sub-sub-queens). Both paths emit `queen.subqueen.failure` event + persist `SubQueenFailureRecord` to `hive-mind/<top-queen>/sub-queen-failures/<subQueenId>`. Handler is idempotent.

### Lock-wrap caveats (open follow-up)

`hive-mind_init`, `_spawn`, `_memory` are wrapped in `withHiveStoreLock`. `_join`, `_leave`, `_broadcast`, `_shutdown` are NOT. If you race these against `_init` or `_spawn` you may see torn writes — serialise externally where it matters.

## Session lifecycle

The session model is simpler than the prose suggests: a single live `state.json` file plus zero-or-more immutable archives. **There are no `paused`, `stopped`, `completed`, or `archived` states.** Five subcommands:

```bash
npx @sparkleideas/cli@latest hive-mind sessions list
npx @sparkleideas/cli@latest hive-mind sessions checkpoint
npx @sparkleideas/cli@latest hive-mind sessions export <id> --output <path>
npx @sparkleideas/cli@latest hive-mind sessions import <path>
npx @sparkleideas/cli@latest hive-mind resume <id>
```

### Archive schema (v1)

```typescript
interface SessionArchiveV1 {
  schemaVersion: 1;
  hiveState: HiveState;          // typed memory shape per ADR-0122
  queenPrompt: string;           // non-empty, required
  queenType?: HiveQueenType;     // "strategic" | "tactical" | "adaptive"
  workerManifest: { id: string; type: string; manifest?: Record<string, unknown> }[];
  timestamp: string;             // iso8601
}
```

Format: gzipped JSON at `.claude-flow/hive-mind/sessions/<sessionId>-<sanitised-iso>.json.gz`. Mismatch on `schemaVersion !== 1` throws `SessionArchiveSchemaMismatchError`.

### Resume semantics

`resume` re-spawns via detached `child_process.spawn('claude', [queenPrompt, '--continuation', sessionId], { detached, unref })`. Spawnability is probed BEFORE state mutation. `queenType`, `queenPrompt`, and `workerManifest` are restored verbatim into typed memory at well-known keys (`hive-mind/queen-prompt`, `hive-mind/worker-manifest`).

`import` does NOT auto-resume — it places the archive under a fresh `imported-<ts>-<rand>` sessionId. Call `resume` separately if needed.

## Best practices

1. **Queen calls MCP tools directly** (`mcp__ruflo__hive-mind_*({...})`) — same convention as `swarm-advanced`. Reserve `npx` for CLI-Fallback subsections and rare subprocess-as-queen scenarios.
2. **Pick the right pattern.** Don't shoehorn a Council Hive (Pattern 1) into a BFT decision (Pattern 2 fits) and don't run Pattern 2 when you need dialectic (Pattern 1 fits). Implementation work uses Pattern 3; reviews use Pattern 4.
3. **Always spawn workers in ONE message.** Parallel spawn = sync barrier. Sequential `Agent` calls serialise needlessly.
4. **Sub-agents call MCP directly** (post-ADR-0144 arm B). The Bash CLI fallback is structurally broken when the MCP server is running (flock contention).
5. **The queen composes; the queen does not fabricate.** Every expert quotation in a transcript traces to actual worker output.
6. **Devil's Advocate must explicitly withdraw or hold.** No vague "all agreed" closes — the DA either acknowledges the rationale won the argument or holds principled dissent.
7. **Persist verdicts via `_memory` with `type: "consensus"`** (or `type: "result"` for non-vote outputs). The TTL is permanent; survives session restart.
8. **Honour the WORKER FAILURE PROTOCOL.** 60s timeout, retry-once, never silently drop.

## Real-world examples

- Pre-regression source — `forks/ruflo/v3/@sparkleideas/cli/src/commands/hive-mind.ts` at commit `0590bf29c` (the substrate-only queen prompt that produced 250+ working council sessions before the late-March 2026 regression).
- File-based crosstalk validation 2026-05-04 — memory `reference-hive-runtime-crosstalk-pattern.md` (iter2/iter3 with Karpathy/Norman/Kambhampati personas; all 3 reactions cross-referenced peers by name with specific claims).
- Live `_consensus` strategy verification — `adr0119-weighted-consensus.test.mjs`, `adr0120-gossip-consensus.test.mjs`, `adr0121-crdt-consensus.test.mjs`.

## Troubleshooting

### Sub-agent MCP call hangs 600s

Tool-name mismatch. Use `mcp__ruflo__*` (registered). `mcp__ruflo__*` is not registered until ADR-0117 lands; calls to it dispatch to nothing and trigger the per-Agent watchdog.

### `--claude` fails from inside an existing claude session

Add `--non-interactive`. The default TTY-inherit subprocess pattern requires a fresh terminal; from inside an active session, fall back to stream-json print mode.

### `_status.consensus` shows `'byzantine'` but I configured `weighted`

Known: `hive-mind_status` returns `consensus: 'byzantine'` hardcoded. Read `state.config.consensus` from `state.json` directly for the persisted strategy.

### `hive-mind_broadcast` doesn't reach my Agent-tool workers

Two distinct workforces: `hive-mind spawn` registers slots that broadcast reaches; Agent-tool spawns are NOT bridged. Single-round Agent spawns + queen-composition is the canonical pattern. Use `_memory` writes from inside worker prompts if you need cross-worker state visibility.

### No consensus reached (Byzantine deadlock)

Drop to `weighted` (queen ×3) or `quorum` with `majority` preset. Or restructure the proposition to be binary rather than n-ary.

### CLI flags accepted but not persisted

Inspect `.claude-flow/hive-mind/state.json` after init. The `topology` / `consensus` / `memoryBackend` fields land in `state.config` (per ADR-0140 §Piece 3 row 3c, fixed in commit `b7181aa89`).

## Related skills

- `swarm-advanced` — multi-agent coordination without consensus; pick this when you need parallel work and don't need a verdict.
- `claude-flow-swarm` — swarm CLI-first patterns.
- `reasoningbank-agentdb` — adaptive learning from hive outcomes.

## Swarm vs Hive — when to use which

| Dimension | Swarm | Hive |
|---|---|---|
| Architecture | Topology of peer agents (mesh / hierarchical / hybrid) | **Queen-led** hierarchy with strategic/tactical/adaptive coordinator |
| Coordination | Shared memory + `parallel_execute` + `task_orchestrate` | Queen prompts workers; **consensus algorithm** resolves decisions |
| Decision-making | Not a first-class concern | **Primary feature** — Byzantine / Raft / Gossip / CRDT / Weighted / Quorum |
| Memory | Per-namespace `memory_usage` with TTLs | **Typed buckets** (8 types) per ADR-0122; LRU + WAL |
| Failure handling | Implicit per-task retry | **Worker-failure protocol** (ADR-0131): retry-once, quorum-with-loss, lineage |
| Output | Distributed work artefacts (report, code, tests) | A **verdict or vote**, plus the work artefacts |
| Best canonical analogy | A team of contractors working in parallel | A jury (or panel of experts) reaching a ruling |

**Use Swarm when:** parallel work where the goal is throughput, not consensus. Research / development / testing / analysis where each agent contributes a distinct artefact.

**Use Hive when:** you need a decision (architecture pattern, technology choice, code review approval, release readiness, severity vote on a finding). Multiple perspectives must reconcile into a single verdict. Fault tolerance matters.

**Overlap (judgment call):** Implementation work with mid-task design decisions → Pattern 3 (Implementation Hive) — start as a hive for the design vote, parallel-execute, return to hive for review consensus.

## References

- [ADR-0139](../../../docs/adr/ADR-0139-hive-mind-advanced-canonical-spec.md) — canonical spec from upstream guidance registry
- [ADR-0140](../../../docs/adr/ADR-0140-hive-mind-advanced-implementation-outline.md) — implementation outline
- [ADR-0145](../../../docs/adr/ADR-0145-hive-mind-advanced-research-collection.md) — research collection that this skill consumes
- [ADR-0118](../../../docs/adr/ADR-0118-hive-mind-runtime-gaps-tracker.md) — T1-T14 runtime closure (all complete)
- ADR-0119–0128, ADR-0130, ADR-0131, ADR-0132, ADR-0108 — per-task contracts
- ADR-0144 §Amendment — sub-agent MCP transport rule (post-arm-B)
- Memory `reference-hive-runtime-crosstalk-pattern` — file-based fallback transport
- Memory `feedback-hive-discussion-mechanics` — 5-point dialectic criteria

---

**Skill version:** 2.0.0
**Last updated:** 2026-05-05
**Maintained by:** Ruflo Fork Team
**License:** MIT
