/**
 * V3 CLI Hive Mind Command
 * Queen-led consensus-based multi-agent coordination
 *
 * Updated to support --claude flag for launching interactive Claude Code sessions
 * PR: Fix #955 - Implement --claude flag for hive-mind spawn command
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import {
  QUEEN_TYPES,
  validateQueenType,
  validateWorkerType,
  WORKER_TYPES,
  type QueenType,
} from '../mcp-tools/validate-input.js';
import { spawn as childSpawn, execSync } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

// Worker type definitions for prompt generation
interface HiveWorker {
  agentId: string;
  role: string;
  type?: string;
  joinedAt?: string;
}

interface WorkerGroups {
  [key: string]: HiveWorker[];
}

// Hive topologies
//
// ADR-0128 (T10) expands this enum from 4 to 6 entries by adding `ring` and
// `star`. The union of advertised topology surfaces (CLI / USERGUIDE diagram /
// ADR-0116 verification matrix) is six; per
// `feedback-no-value-judgements-on-features.md` we wire the full surface
// rather than picking the intersection.
//
// Behavioural enforcement lives at the dispatch site in
// `@claude-flow/swarm/src/unified-coordinator.ts` (`dispatchByTopology`). The
// CLI's job is to (1) validate the flag against `choices`, (2) substitute a
// topology-specific coordination-protocol block into the queen prompt via
// `renderTopologyProtocolBlock` below.
const TOPOLOGIES = [
  { value: 'hierarchical', label: 'Hierarchical', hint: 'Queen-led with worker agents' },
  { value: 'mesh', label: 'Mesh', hint: 'Peer-to-peer coordination' },
  { value: 'hierarchical-mesh', label: 'Hierarchical Mesh', hint: 'Queen + peer communication (recommended)' },
  { value: 'ring', label: 'Ring', hint: 'Deterministic ordered chain — worker N reads (N-1), writes for (N+1)' },
  { value: 'star', label: 'Star', hint: 'Hub-and-spoke — queen is sole memory writer' },
  { value: 'adaptive', label: 'Adaptive', hint: 'Dynamic topology based on task (delegates to T9 control loop)' }
];

/**
 * ADR-0128 T10 — render a topology-specific coordination-protocol block for
 * inlining into the queen prompt. Replaces the bare
 * `🔗 Topology: ${topology}` substring (prompt-only metadata) with a block
 * that describes peer-visibility and memory-write rules per topology.
 *
 * This is descriptive material in the queen prompt — the *enforcement* lives
 * at the worker-spawn dispatch site in
 * `@claude-flow/swarm/src/unified-coordinator.ts` (`dispatchByTopology`).
 * If the prompt and the protocol disagree, the protocol wins (the worker's
 * `hive-mind_broadcast` subscription set + `hive-mind_memory` permissions
 * are configured at spawn time and ignore the prompt body).
 *
 * Topology values are validated by `choices: TOPOLOGIES.map(t => t.value)` at
 * the option-parsing layer; an unknown value reaching this function indicates
 * a programming error and falls through to the loud default branch.
 *
 * Per `feedback-no-fallbacks.md` we throw on unknown topology rather than
 * silently substituting a default. The dispatch site does the same — both
 * surfaces fail loudly together.
 */
function renderTopologyProtocolBlock(topology: string): string {
  switch (topology) {
    case 'hierarchical':
      return `🔗 Topology: hierarchical (queen-only broadcast)
   Worker peer visibility: NONE — workers receive instructions from the queen via
   hive-mind_broadcast and surface outputs through hive-mind_status. Workers
   cannot subscribe to peer broadcasts and cannot read peer-private memory.
   Memory-write rule: each worker writes to its own queen-readable private
   namespace; peers cannot read each other's writes.`;
    case 'mesh':
      return `🔗 Topology: mesh (full peer visibility)
   Worker peer visibility: FULL — every worker receives every other worker's
   outputs via hive-mind_broadcast. Coordination cost is O(N²) in worker count.
   Memory-write rule: shared peer-visible namespace; all workers read and
   write the same memory keys.`;
    case 'hierarchical-mesh':
      return `🔗 Topology: hierarchical-mesh (sub-hive clustering)
   Worker peer visibility: FULL within sub-hive, sub-queen-summarised across.
   Workers partition into sub-hives with one sub-queen per cluster. Each
   sub-hive runs mesh internally; sub-queens report hierarchically upward.
   Recursion is capped at one nesting level (top queen + sub-queens — no
   sub-sub-queens).
   Memory-write rule: peer-visible per sub-hive; sub-queens summarise upward.`;
    case 'ring':
      return `🔗 Topology: ring (deterministic ordered chain)
   Worker peer visibility: PREVIOUS NEIGHBOUR ONLY. Workers numbered 0..N-1.
   Worker N reads worker (N-1 mod N)'s output from hive-mind_memory and writes
   its own output for worker (N+1 mod N) to consume. There are no
   broadcasts — coordination is strictly peer-to-peer along the ring edges.
   Memory-write rule: each worker writes only its own slot.`;
    case 'star':
      return `🔗 Topology: star (hub-and-spoke)
   Worker peer visibility: NONE (only queen-aggregated state). The queen is
   the only writer to hive-mind_memory. Workers (spokes) read from
   hive-mind_memory and surface outputs back through hive-mind_status for the
   queen to aggregate and write.
   Memory-write rule: queen-only. Worker memory writes are forbidden.`;
    case 'adaptive':
      return `🔗 Topology: adaptive (delegates to T9 control loop)
   The dispatch site invokes the ADR-0127 (T9) autoscaling control loop and
   recurses into the chosen concrete topology. Until T9 lands, dispatch
   throws \`Error("adaptive topology dispatch requires T9/ADR-0127")\` —
   queen prompts must not assume \`adaptive\` resolves at runtime yet.
   See ADR-0128 §Cross-task dependency posture for the contract.`;
    default:
      // Per `feedback-no-fallbacks.md` — never silently substitute a default.
      throw new Error(`unknown topology: ${topology}`);
  }
}

// Consensus strategies
const CONSENSUS_STRATEGIES = [
  { value: 'byzantine', label: 'Byzantine Fault Tolerant', hint: '2/3 majority, handles malicious actors' },
  { value: 'raft', label: 'Raft', hint: 'Leader-based consensus' },
  { value: 'gossip', label: 'Gossip', hint: 'Eventually consistent, scalable' },
  { value: 'crdt', label: 'CRDT', hint: 'Conflict-free replicated data' },
  { value: 'quorum', label: 'Quorum', hint: 'Simple majority voting' }
];

/**
 * Group workers by their type for prompt generation
 */
function groupWorkersByType(workers: HiveWorker[]): WorkerGroups {
  const groups: WorkerGroups = {};
  for (const worker of workers) {
    const type = worker.type || worker.role || 'worker';
    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(worker);
  }
  return groups;
}

/**
 * Context bag passed to per-queen-type prompt renderers.
 *
 * ADR-0125 §Specification: `Record<QueenType, (ctx: HiveMindPromptContext) => string>`.
 * Carries the substitution variables every variant interpolates. Per-variant
 * bodies pull only what they need from this struct.
 */
interface HiveMindPromptContext {
  swarmId: string;
  swarmName: string;
  objective: string;
  workers: HiveWorker[];
  workerGroups: WorkerGroups;
  consensusAlgorithm: string;
  topology: string;
  currentTime: string;
}

/**
 * The 8 USERGUIDE-advertised worker types. Source of truth: USERGUIDE
 * `**Worker Specializations (8 types):**` block. Validated as a
 * subset of the `WORKER_TYPES` enum in `validate-input.ts` (which also
 * carries non-USERGUIDE types — `specialist`, `coordinator`, `monitor`).
 *
 * Per ADR-0126 §Specification, `generateHiveMindPrompt` emits a per-type
 * prose block for any of these 8 types present in the worker pool; types
 * absent from the pool emit no block. Non-USERGUIDE types appearing in
 * the pool are tolerated by the count summary but NOT given a prose
 * block — see `renderWorkerTypeProseBlock` below for the throw.
 */
const USERGUIDE_WORKER_TYPES = [
  'researcher', 'coder', 'analyst', 'architect',
  'tester', 'reviewer', 'optimizer', 'documenter',
] as const;
type UserguideWorkerType = (typeof USERGUIDE_WORKER_TYPES)[number];

/**
 * ADR-0125 §Specification "Cross-ADR sentinel contract" — the queen-type
 * sentinel substring each per-worker-type prose block embeds in its
 * "Working with the active queen" section (per ADR-0126 §Specification
 * "Queen-prompt / worker cross-reference contract"). Renaming any of
 * these is a breaking change for ADR-0126's cross-reference test AND
 * ADR-0125's sentinel test — coordinated edits required.
 */
const QUEEN_TYPE_SENTINELS: Record<QueenType, string> = {
  strategic: 'written plan',
  tactical: 'spawned workers within',
  adaptive: 'named your chosen mode',
};

/**
 * ADR-0126 §Specification — per-worker-type prose block. Each block
 * carries three structural-contract sections in fixed order:
 *
 *   (a) `## Worker role: <type>` plus a one-sentence role description
 *   (b) `### Tools you should reach for first` plus a role-specific
 *       MCP-tool bullet list
 *   (c) `### Working with the active queen` plus the queen-type sentinel
 *       substring sourced from ADR-0125
 *
 * Section headings ARE the sentinels the structural-contract test asserts on
 * (per ADR-0126 §Specification). Drift detection lives in tests, not the
 * type system — adding/removing a section here without updating tests is
 * a contract violation.
 *
 * Per ADR-0126 §Pseudocode and `feedback-no-fallbacks.md`: an unknown
 * `AgentType` value (one of the non-USERGUIDE members `coordinator`,
 * `monitor`, `specialist`, `queen`, `worker`) reaching this function
 * throws — no silent fallback to a generic block. The aggregator filters
 * non-USERGUIDE types BEFORE this function sees them; the throw is a
 * defence-in-depth backstop for programmatic callers.
 */
function renderWorkerTypeProseBlock(
  type: string,
  count: number,
  queenType: QueenType,
): string {
  const queenSentinel = QUEEN_TYPE_SENTINELS[queenType];
  switch (type) {
    case 'researcher':
      return `## Worker role: researcher
The researcher worker(s) (${count} in pool) gather context, surface prior art, and recall similar past hives — they are the swarm's eyes on what already exists before any coding starts.

### Tools you should reach for first
• mcp__ruflo__memory_search        — recall similar past hives and decisions
• mcp__ruflo__embeddings_search    — semantic lookup across the corpus
• mcp__ruflo__memory_retrieve      — fetch a known memory entry by key

### Working with the active queen
The active queen mode names the sentinel "${queenSentinel}" — direct researchers to surface their findings into the queen's preferred coordination surface (memory store for Strategic; broadcast/status for Tactical; mode-tagged memory for Adaptive).
`;
    case 'coder':
      return `## Worker role: coder
The coder worker(s) (${count} in pool) implement the planned changes — they edit files, run test commands, and surface diffs back to the queen.

### Tools you should reach for first
• Read / Write / Edit / Bash      — direct file edits and test runs
• mcp__ruflo__task_assign          — pull the next coding subtask from the queue
• mcp__ruflo__hive-mind_memory     — surface intermediate results to the swarm

### Working with the active queen
The active queen mode names the sentinel "${queenSentinel}" — coders should consult the queen's plan-tree (Strategic), respond to dispatch directly (Tactical), or read the named-mode memory key first (Adaptive) before starting an edit.
`;
    case 'analyst':
      return `## Worker role: analyst
The analyst worker(s) (${count} in pool) profile, measure, and surface bottlenecks — they translate raw observations into the metrics the queen weighs.

### Tools you should reach for first
• mcp__ruflo__performance_metrics    — capture current performance baseline
• mcp__ruflo__performance_bottleneck — identify slow paths
• mcp__ruflo__performance_report     — surface findings to the queen

### Working with the active queen
The active queen mode names the sentinel "${queenSentinel}" — analysts should write findings into the queen's working memory shape (rationale block for Strategic; flight-cycle status for Tactical; mode-tagged for Adaptive).
`;
    case 'architect':
      return `## Worker role: architect
The architect worker(s) (${count} in pool) shape the structural decisions — they author ADRs, weigh diff-level risk, and define the boundaries the coder workers operate within.

### Tools you should reach for first
• mcp__ruflo__analyze_diff          — assess proposed changes against the codebase
• mcp__ruflo__analyze_diff-risk     — weigh structural risk before merge
• Write (ADR file)                  — author the design rationale

### Working with the active queen
The active queen mode names the sentinel "${queenSentinel}" — architects should produce ADRs that the queen can cite (Strategic plan trees), gate spawn fan-out (Tactical), or annotate as the chosen-mode rationale (Adaptive).
`;
    case 'tester':
      return `## Worker role: tester
The tester worker(s) (${count} in pool) execute the acceptance harness, write failing-first tests, and verify changes against the test pyramid.

### Tools you should reach for first
• Bash (test runners)               — invoke the acceptance harness
• mcp__ruflo__task_status           — track which subtasks need verification
• mcp__ruflo__hive-mind_memory      — surface pass/fail evidence to the swarm

### Working with the active queen
The active queen mode names the sentinel "${queenSentinel}" — testers should anchor on the queen's plan-tree subtasks (Strategic), confirm dispatch outcomes per cycle (Tactical), or run the consensus-gated checks before mode-flips (Adaptive).
`;
    case 'reviewer':
      return `## Worker role: reviewer
The reviewer worker(s) (${count} in pool) audit changes for risk, surface diff-level concerns, and recommend reviewers — they are the gate between coder output and merge.

### Tools you should reach for first
• mcp__ruflo__analyze_diff-risk      — risk-score the proposed changes
• mcp__ruflo__analyze_diff-reviewers — recommend human reviewers per file
• mcp__ruflo__analyze_file-risk      — per-file risk score

### Working with the active queen
The active queen mode names the sentinel "${queenSentinel}" — reviewers should hand findings back through the queen's chosen surface (rationale store for Strategic; broadcast for Tactical; consensus-tagged for Adaptive).
`;
    case 'optimizer':
      return `## Worker role: optimizer
The optimizer worker(s) (${count} in pool) tune neural and runtime hot paths — they trade off correctness against speed within the queen-defined constraints.

### Tools you should reach for first
• mcp__ruflo__performance_bottleneck — locate the bottleneck to act on
• mcp__ruflo__neural_optimize        — apply neural-side tuning
• mcp__ruflo__performance_optimize   — apply runtime-side tuning

### Working with the active queen
The active queen mode names the sentinel "${queenSentinel}" — optimizers should respect the queen's plan-tree budget (Strategic), batch their pings into queen cycles (Tactical), or mode-tag the optimization decision (Adaptive).
`;
    case 'documenter':
      return `## Worker role: documenter
The documenter worker(s) (${count} in pool) keep the user-facing surfaces honest — they update USERGUIDE, refresh ADR cross-references, and align README copy with shipped behaviour.

### Tools you should reach for first
• Edit / Write (markdown)             — author USERGUIDE / README updates
• Use the markdown-editor skill       — format-aware markdown edits
• mcp__ruflo__memory_search           — recall the canonical claim phrasing

### Working with the active queen
The active queen mode names the sentinel "${queenSentinel}" — documenters should land prose that matches the queen's framing (plan-first for Strategic; dispatch-first for Tactical; mode-named for Adaptive).
`;
    default:
      // Per `feedback-no-fallbacks.md` — never silently emit a generic
      // block for a non-USERGUIDE type. The aggregator's filter is the
      // first line of defence; this throw is the defence-in-depth backstop.
      throw new Error(`Unknown worker-type for prompt: ${type}`);
  }
}

/**
 * ADR-0126 §Pseudocode — aggregate per-type prose blocks for the worker
 * pool. For each USERGUIDE worker type present in `workerGroups`, emit one
 * prose block; non-USERGUIDE types (`coordinator`, `monitor`, `specialist`,
 * `queen`, `worker`) are tolerated in the pool (the count summary still
 * surfaces them) but do NOT receive a prose block — they are not
 * addressed in the USERGUIDE catalog and so have no role contract for the
 * queen-LLM to cite.
 */
function renderWorkerTypeBlocks(
  workerGroups: WorkerGroups,
  queenType: QueenType,
): string {
  const presentTypes = Object.keys(workerGroups).filter(
    (t): t is UserguideWorkerType =>
      (USERGUIDE_WORKER_TYPES as readonly string[]).includes(t),
  );
  if (presentTypes.length === 0) {
    return '';
  }
  const blocks = presentTypes.map(type =>
    renderWorkerTypeProseBlock(type, workerGroups[type].length, queenType),
  );
  return `\n🐝 WORKER ROLES IN THIS HIVE (per-type playbook):\n\n${blocks.join('\n')}\n`;
}

/**
 * Shared header rendered by all three queen-type prompts. Contains the
 * config block, worker distribution, and the MCP tool catalog. The per-type
 * mission framing, preferred-tool list, and self-check criteria are appended
 * by the queen-specific renderer below.
 *
 * Per ADR-0114, the queen prompt sits at the execution layer; only the body
 * shape (per-type sections) varies between the three renderers. The shared
 * header preserves layering: substrate (MCP catalog) and protocol (4-phase
 * coordination) are constant; only the queen's framing differs.
 *
 * ADR-0126 §Decision — between the count-only `WORKER DISTRIBUTION:` line
 * and the MCP tool catalog, the header now interpolates per-worker-type
 * prose blocks for any USERGUIDE type present in the pool. The count
 * summary remains (the queen-LLM still needs its census per
 * ADR-0126 §Refinement); the prose blocks anchor what each present type
 * does and how it cooperates with the active queen mode.
 */
function renderHiveMindHeader(ctx: HiveMindPromptContext, queenType: QueenType): string {
  const workerTypes = Object.keys(ctx.workerGroups);
  return `🧠 HIVE MIND COLLECTIVE INTELLIGENCE SYSTEM
═══════════════════════════════════════════════

You are the Queen coordinator of a Hive Mind swarm with collective intelligence capabilities.

HIVE MIND CONFIGURATION:
📌 Swarm ID: ${ctx.swarmId}
📌 Swarm Name: ${ctx.swarmName}
🎯 Objective: ${ctx.objective}
👑 Queen Type: ${queenType}
🐝 Worker Count: ${ctx.workers.length}
${renderTopologyProtocolBlock(ctx.topology)}
🤝 Consensus Algorithm: ${ctx.consensusAlgorithm}
⏰ Initialized: ${ctx.currentTime}

WORKER DISTRIBUTION:
${workerTypes.map(type => `• ${type}: ${ctx.workerGroups[type].length} agents`).join('\n')}
${renderWorkerTypeBlocks(ctx.workerGroups, queenType)}
🔧 AVAILABLE MCP TOOLS FOR HIVE MIND COORDINATION:

1️⃣ **COLLECTIVE INTELLIGENCE**
   mcp__ruflo__hive-mind_consensus    - Democratic decision making
   mcp__ruflo__hive-mind_memory       - Share knowledge across the hive
   mcp__ruflo__hive-mind_broadcast    - Broadcast to all workers
   mcp__ruflo__neural_patterns        - Neural pattern recognition

2️⃣ **QUEEN COORDINATION**
   mcp__ruflo__hive-mind_status       - Monitor swarm health
   mcp__ruflo__task_create            - Create and delegate tasks
   mcp__ruflo__coordination_orchestrate - Orchestrate task distribution
   mcp__ruflo__agent_spawn            - Spawn additional workers

3️⃣ **WORKER MANAGEMENT**
   mcp__ruflo__agent_list             - List all active agents
   mcp__ruflo__agent_status           - Check agent status
   mcp__ruflo__agent_health           - Check worker health
   mcp__ruflo__hive-mind_join         - Add agent to hive
   mcp__ruflo__hive-mind_leave        - Remove agent from hive

4️⃣ **TASK ORCHESTRATION**
   mcp__ruflo__task_assign            - Assign tasks to workers
   mcp__ruflo__task_status            - Track task progress
   mcp__ruflo__task_complete          - Mark tasks complete
   mcp__ruflo__workflow_create        - Create workflows

5️⃣ **MEMORY & LEARNING**
   mcp__ruflo__memory_store           - Store collective knowledge
   mcp__ruflo__memory_retrieve        - Access shared memory
   mcp__ruflo__memory_search          - Search memory patterns
   mcp__ruflo__neural_train           - Learn from experiences
   mcp__ruflo__hooks_intelligence_pattern-store - Store patterns

📋 HIVE MIND EXECUTION PROTOCOL:

1. **INITIALIZATION PHASE**
   - Verify all workers are online and responsive
   - Establish communication channels
   - Load previous session state if available
   - Initialize shared memory space

2. **TASK DISTRIBUTION PHASE**
   - Analyze the objective and decompose into subtasks
   - Assign tasks based on worker specializations
   - Set up task dependencies and ordering
   - Monitor parallel execution

3. **COORDINATION PHASE**
   - Use consensus for critical decisions
   - Aggregate results from workers
   - Resolve conflicts using ${ctx.consensusAlgorithm} consensus
   - Share learnings across the hive

4. **COMPLETION PHASE**
   - Verify all subtasks are complete
   - Consolidate results
   - Store learnings in collective memory
   - Report final status

🎯 YOUR OBJECTIVE:
${ctx.objective}

🛠️ TOOL USE (ADR-0104 §6 — reverses #1422):
• Use Claude Code's Task tool to spawn worker agents in this session.
• Use Ruflo MCP tools (mcp__ruflo__*) for hive coordination: shared memory
  (hive-mind_memory), consensus (hive-mind_consensus), broadcasts
  (hive-mind_broadcast), status (hive-mind_status).
• Native Claude tools (Read, Write, Edit, Bash, Grep, Glob) are available
  for orchestration logic.

📝 WORKER COORDINATION CONTRACT (v3):
When spawning a worker via Task tool, include this contract in its prompt
verbatim:
  "Before returning, write your structured output to hive shared memory:
   mcp__ruflo__hive-mind_memory({action:'set',
     key:'worker-<your-id>-result',
     value:<your output>})
   Then return a 1-line summary."
This contract replaces v2's 'coordinate via hooks' idiom — v3 hooks are
for learning, not coordination, so workers must write coordination state
explicitly via MCP.

💡 COORDINATION TIPS:
• Use mcp__ruflo__hive-mind_broadcast for swarm-wide announcements
• Check worker status regularly with mcp__ruflo__hive-mind_status
• Store important decisions in shared memory for persistence
• Use consensus for any decisions affecting multiple workers
• Use mcp__ruflo__task_assign to assign tasks to workers, then mcp__ruflo__task_complete when done
`;
}

/**
 * Strategic queen prompt — planning-first leadership style.
 *
 * Mission framing: invest in plan tree before delegating.
 * Preferred tools: planning + memory primitives.
 * Self-check sentinel: "written plan" — anchored by ADR-0125 §Specification
 * "Cross-ADR sentinel contract" and consumed by ADR-0126 (T8) worker prompts.
 *
 * Renaming the sentinel string is a breaking change for ADR-0126's
 * cross-reference test — coordinated edits required across both ADRs.
 */
function renderStrategicPrompt(ctx: HiveMindPromptContext): string {
  return `${renderHiveMindHeader(ctx, 'strategic')}
👑 QUEEN LEADERSHIP — STRATEGIC (planning-first):
You are an architect-first queen. Your primary disposition is to invest in a
full plan tree BEFORE spawning workers. You decompose the objective into
explicit subtasks, name dependencies between them, write decision rationale
to shared memory so workers can read prior context, and only THEN delegate.
Premature execution is your anti-pattern — the worker pool is your hands,
not your eyes; use them only after the plan is on paper.

🛠️ Tools you should reach for first:
• mcp__ruflo__task_create        — build the plan tree as concrete subtasks
• mcp__ruflo__memory_store       — record decision rationale and tradeoffs
• mcp__ruflo__memory_search      — recall similar past hives before planning
• mcp__ruflo__hive-mind_memory   — share the plan with the swarm

✅ Before declaring done, verify:
• You produced a written plan with explicit subtask decomposition before
  spawning workers. The plan lives in mcp__ruflo__task_create entries
  and/or mcp__ruflo__memory_store under a discoverable key.
• You stored at least one decision rationale to memory naming the
  trade-off you weighed (alternatives considered, why you chose this path).
• Worker outputs trace back to a subtask in the written plan, not to
  ad-hoc dispatch.

🚀 BEGIN HIVE MIND COORDINATION NOW!
Start with planning. Workers come second.
`;
}

/**
 * Tactical queen prompt — execution-first leadership style.
 *
 * Mission framing: dispatcher; bias toward agent_spawn early; shorter
 * planning preamble; frequent worker status pings.
 * Self-check sentinel: "spawned workers within" — ADR-0126 anchor.
 *
 * Renaming the sentinel is a breaking change for ADR-0126.
 */
function renderTacticalPrompt(ctx: HiveMindPromptContext): string {
  return `${renderHiveMindHeader(ctx, 'tactical')}
👑 QUEEN LEADERSHIP — TACTICAL (execution-first):
You are a dispatcher-first queen. Your primary disposition is to translate
the objective into worker assignments quickly and keep delegation throughput
high. Planning preamble is short; you bias toward agent_spawn and
task_assign within the first few coordination cycles. You ping worker
status at least once per cycle and rebalance when a worker stalls.
Over-planning is your anti-pattern — the swarm earns its keep by working,
not by waiting for a perfect plan.

🛠️ Tools you should reach for first:
• mcp__ruflo__agent_spawn         — bring workers online quickly
• mcp__ruflo__task_assign         — push work to active workers
• mcp__ruflo__hooks_worker-status — poll worker progress every cycle
• mcp__ruflo__hive-mind_broadcast — coordinate the swarm in flight

✅ Before declaring done, verify:
• You spawned workers within the first three coordination cycles
  (don't sit on the objective for an extended planning preamble).
• You pinged worker status at least once per cycle via
  mcp__ruflo__hooks_worker-status, and rebalanced load when a worker
  stalled or lagged.
• You used mcp__ruflo__hive-mind_broadcast for swarm-wide direction
  changes rather than rewriting individual task descriptions one by one.

🚀 BEGIN HIVE MIND COORDINATION NOW!
Start with delegation. Refine the plan in flight.
`;
}

/**
 * Adaptive queen prompt — complexity-driven mode-switch.
 *
 * Mission framing: pick Strategic or Tactical based on objective complexity;
 * if mid-run signals say the wrong mode was picked, run a consensus check
 * before switching.
 * Self-check sentinel: "named your chosen mode" — ADR-0126 anchor.
 *
 * Tool list is the union of Strategic + Tactical with the consensus tool
 * added (per ADR-0125 Phase 2). Adaptive is the longest variant by design.
 */
function renderAdaptivePrompt(ctx: HiveMindPromptContext): string {
  return `${renderHiveMindHeader(ctx, 'adaptive')}
👑 QUEEN LEADERSHIP — ADAPTIVE (mode-switching by complexity):
You are a mode-selecting queen. Your primary disposition is to read the
objective's complexity first, pick Strategic (planning-first) or Tactical
(execution-first) mode based on observed signals, AND name your choice
explicitly in shared memory so workers can read which mode the hive is
operating under. Signals to weigh:
  • Number of subtasks discovered during initial analysis (>5 → leans Strategic)
  • Ambiguity in the objective text (vague → leans Strategic)
  • Sharpness of acceptance criteria (crisp → leans Tactical)
  • Presence of prior similar hives in memory (lots of priors → Tactical
    can ride the priors; few priors → Strategic to build them).

If mid-run you detect that the wrong mode was picked (e.g. you started
Tactical but workers keep hitting unspecified edges), call
mcp__ruflo__hive-mind_consensus to confirm a strategy switch with the
swarm BEFORE flipping mode. Don't switch unilaterally — consensus on
strategy change is the contract the workers depend on.

🛠️ Tools you should reach for first:
• mcp__ruflo__hive-mind_consensus — confirm mode switches with the swarm
• mcp__ruflo__task_create         — build a plan tree (Strategic mode)
• mcp__ruflo__memory_store        — record decision rationale
• mcp__ruflo__memory_search       — recall similar past hives
• mcp__ruflo__hive-mind_memory    — share the chosen mode with the swarm
• mcp__ruflo__agent_spawn         — bring workers online (Tactical mode)
• mcp__ruflo__task_assign         — push work to active workers
• mcp__ruflo__hooks_worker-status — poll worker progress
• mcp__ruflo__hive-mind_broadcast — coordinate the swarm in flight

✅ Before declaring done, verify:
• You explicitly named your chosen mode (Strategic or Tactical) and
  your reason, stored to mcp__ruflo__hive-mind_memory under a key
  workers can discover. "Adaptive" is not a runnable mode — it is
  your meta-disposition; the swarm needs to know which concrete
  mode you picked.
• If you switched mid-run, you ran mcp__ruflo__hive-mind_consensus
  to confirm the strategy switch BEFORE flipping behaviour. Record
  the consensus result alongside the mode-switch decision.
• Your final report names the mode you finished in (it can differ
  from the mode you started in — that is the point of Adaptive).

🚀 BEGIN HIVE MIND COORDINATION NOW!
Start by reading the objective and naming your chosen mode.
`;
}

/**
 * Per-queen-type prompt dispatch table. ADR-0125 §Specification:
 * `Record<QueenType, (ctx: HiveMindPromptContext) => string>`.
 *
 * Adding a fourth queen type without an enum extension in
 * `validate-input.ts` (`QUEEN_TYPES`) is a contract violation — the
 * `default:` case in the switch below is the runtime backstop, but the
 * type-system layer (`QueenType` union) is the first defence.
 */
const QUEEN_PROMPT_RENDERERS: Record<QueenType, (ctx: HiveMindPromptContext) => string> = {
  strategic: renderStrategicPrompt,
  tactical: renderTacticalPrompt,
  adaptive: renderAdaptivePrompt,
};

/**
 * Generate comprehensive Hive Mind prompt for Claude Code.
 *
 * Per ADR-0125 §Decision: dispatches to a per-queen-type renderer keyed by
 * `flags.queenType`. Each renderer carries:
 *   1. Mission framing (planning-first / execution-first / mode-switch)
 *   2. "Tools you should reach for first" — per-type MCP tool list
 *   3. "Before declaring done, verify" — per-type acceptance criteria
 *      (each variant carries the sentinel substring named in ADR-0125
 *      §Specification "Cross-ADR sentinel contract").
 *
 * Unknown values throw — no silent fallback per `feedback-no-fallbacks.md`.
 * The CLI-boundary validation in the `spawn` action surfaces a clean error
 * before this function is reached; the `default:` arm here is a
 * defence-in-depth backstop for non-CLI callers (programmatic invocations
 * that bypass the flag parser).
 *
 * Exported so the ADR-0125 unit + integration tests can call directly.
 */
export function generateHiveMindPrompt(
  swarmId: string,
  swarmName: string,
  objective: string,
  workers: HiveWorker[],
  workerGroups: WorkerGroups,
  flags: Record<string, unknown>
): string {
  const queenType = ((flags.queenType as string) || 'strategic') as QueenType;
  const ctx: HiveMindPromptContext = {
    swarmId,
    swarmName,
    objective,
    workers,
    workerGroups,
    consensusAlgorithm: (flags.consensus as string) || 'byzantine',
    topology: (flags.topology as string) || 'hierarchical-mesh',
    currentTime: new Date().toISOString(),
  };

  // Switch is the runtime backstop; the prompt map (above) is the typed
  // manifest the ADR-0125 §Specification declares. They agree by design —
  // adding a queen type means extending QUEEN_TYPES, the renderer map, AND
  // a `case` arm, which is the intended cost of evolution.
  switch (queenType) {
    case 'strategic':
    case 'tactical':
    case 'adaptive':
      return QUEEN_PROMPT_RENDERERS[queenType](ctx);
    default:
      // Defence-in-depth backstop. The CLI-boundary validation in the
      // `spawn` action throws a user-friendly error before reaching here;
      // this arm catches programmatic callers that bypass the parser.
      // Per `feedback-no-fallbacks.md`, no silent fallback to 'strategic'.
      throw new Error(`unknown queenType: ${String(queenType)}`);
  }
}

/**
 * Spawn Claude Code with Hive Mind coordination instructions
 * Ported from v2.7.47 spawnClaudeCodeInstances function
 */
async function spawnClaudeCodeInstance(
  swarmId: string,
  swarmName: string,
  objective: string,
  workers: HiveWorker[],
  flags: Record<string, unknown>
): Promise<{ success: boolean; promptFile?: string; error?: string }> {
  output.writeln();
  output.writeln(output.bold('🚀 Launching Claude Code with Hive Mind Coordination'));
  output.writeln(output.dim('─'.repeat(60)));

  const spinner = output.createSpinner({ text: 'Preparing Hive Mind coordination prompt...', spinner: 'dots' });
  spinner.start();

  try {
    // Generate comprehensive Hive Mind prompt
    const workerGroups = groupWorkersByType(workers);
    const hiveMindPrompt = generateHiveMindPrompt(
      swarmId,
      swarmName,
      objective,
      workers,
      workerGroups,
      flags
    );

    spinner.succeed('Hive Mind coordination prompt ready!');

    // Display coordination summary
    output.writeln();
    output.writeln(output.bold('🧠 Hive Mind Configuration'));
    output.writeln(output.dim('─'.repeat(60)));
    output.printList([
      `Swarm ID: ${output.highlight(swarmId)}`,
      `Objective: ${output.highlight(objective)}`,
      `Queen Type: ${output.highlight((flags.queenType as string) || 'strategic')}`,
      `Worker Count: ${output.highlight(String(workers.length))}`,
      `Worker Types: ${output.highlight(Object.keys(workerGroups).join(', '))}`,
      `Consensus: ${output.highlight((flags.consensus as string) || 'byzantine')}`,
      `MCP Tools: ${output.success('Full Claude-Flow integration enabled')}`
    ]);

    // Ensure sessions directory exists
    const sessionsDir = join('.hive-mind', 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const promptFile = join(sessionsDir, `hive-mind-prompt-${swarmId}.txt`);
    await writeFile(promptFile, hiveMindPrompt, 'utf8');
    output.writeln();
    output.printSuccess(`Hive Mind prompt saved to: ${promptFile}`);

    // Check if claude command exists
    let claudeAvailable = false;
    try {
      execSync('which claude', { stdio: 'ignore' });
      claudeAvailable = true;
    } catch {
      output.writeln();
      output.printWarning('Claude Code CLI not found in PATH');
      output.writeln(output.dim('Install it with: npm install -g @anthropic-ai/claude-code'));
      output.writeln(output.dim('Falling back to displaying instructions...'));
    }

    const dryRun = flags.dryRun || flags['dry-run'];

    if (claudeAvailable && !dryRun) {
      // Build arguments - flags first, then prompt
      const claudeArgs: string[] = [];

      // Check for non-interactive mode
      const isNonInteractive = flags['non-interactive'] || flags.nonInteractive;
      if (isNonInteractive) {
        claudeArgs.push('-p'); // Print mode
        claudeArgs.push('--output-format', 'stream-json');
        claudeArgs.push('--verbose');
        output.printInfo('Running in non-interactive mode');
      }

      // HIGH-02: Strict boolean check (=== true) instead of loose truthiness (!== false)
      // to prevent undefined/null from being treated as "skip permissions".
      // Behavior change: only explicit --dangerously-skip-permissions flag triggers skip.
      const skipPermissions = flags['dangerously-skip-permissions'] === true && !flags['no-auto-permissions'];
      if (skipPermissions) {
        claudeArgs.push('--dangerously-skip-permissions');
        if (!isNonInteractive) {
          output.printWarning('Using --dangerously-skip-permissions for seamless hive-mind execution');
        }
      }

      // Add the prompt as the LAST argument
      claudeArgs.push(hiveMindPrompt);

      output.writeln();
      output.printInfo('Launching Claude Code...');
      output.writeln(output.dim('Press Ctrl+C to pause the session'));

      // Spawn claude with properly ordered arguments
      const claudeProcess = childSpawn('claude', claudeArgs, {
        stdio: 'inherit',
        shell: false,
      });

      // Set up SIGINT handler for session management
      let isExiting = false;
      const sigintHandler = () => {
        if (isExiting) return;
        isExiting = true;

        output.writeln();
        output.writeln();
        output.printWarning('Pausing session and terminating Claude Code...');

        if (claudeProcess && !claudeProcess.killed) {
          claudeProcess.kill('SIGTERM');
        }

        output.writeln();
        output.printSuccess('Session paused');
        output.writeln(output.dim(`Prompt file saved at: ${promptFile}`));
        output.writeln(output.dim('To resume, run claude with the saved prompt file'));

        process.exit(0);
      };

      process.on('SIGINT', sigintHandler);
      process.on('SIGTERM', sigintHandler);

      // Handle process exit
      claudeProcess.on('exit', (code) => {
        // Clean up signal handlers
        process.removeListener('SIGINT', sigintHandler);
        process.removeListener('SIGTERM', sigintHandler);

        if (code === 0) {
          output.writeln();
          output.printSuccess('Claude Code completed successfully');
        } else if (code !== null) {
          output.writeln();
          output.printError(`Claude Code exited with code ${code}`);
        }
      });

      output.writeln();
      output.printSuccess('Claude Code launched with Hive Mind coordination');
      output.printInfo('The Queen coordinator will orchestrate all worker agents');
      output.writeln(output.dim(`Prompt file saved at: ${promptFile}`));

      return { success: true, promptFile };
    } else if (dryRun) {
      output.writeln();
      output.printInfo('Dry run - would execute Claude Code with prompt:');
      output.writeln(output.dim(`Prompt length: ${hiveMindPrompt.length} characters`));
      output.writeln();
      output.writeln(output.dim('First 500 characters of prompt:'));
      output.writeln(output.highlight(hiveMindPrompt.substring(0, 500) + '...'));
      output.writeln();
      output.writeln(output.dim(`Full prompt saved to: ${promptFile}`));

      return { success: true, promptFile };
    } else {
      // Claude not available - show instructions
      output.writeln();
      output.writeln(output.bold('📋 Manual Execution Instructions:'));
      output.writeln(output.dim('─'.repeat(50)));
      output.printList([
        'Install Claude Code: npm install -g @anthropic-ai/claude-code',
        `Run with saved prompt: claude < ${promptFile}`,
        `Or copy manually: cat ${promptFile} | claude`,
        `With auto-permissions: claude --dangerously-skip-permissions < ${promptFile}`
      ]);

      return { success: true, promptFile };
    }
  } catch (error) {
    spinner.fail('Failed to prepare Claude Code coordination');
    const errorMessage = error instanceof Error ? error.message : String(error);
    output.printError(`Error: ${errorMessage}`);

    // Try to save prompt as fallback
    try {
      const promptFile = `hive-mind-prompt-${swarmId}-fallback.txt`;
      const workerGroups = groupWorkersByType(workers);
      const hiveMindPrompt = generateHiveMindPrompt(swarmId, swarmName, objective, workers, workerGroups, flags);
      await writeFile(promptFile, hiveMindPrompt, 'utf8');
      output.writeln();
      output.printSuccess(`Prompt saved to: ${promptFile}`);
      output.writeln(output.dim('You can run Claude Code manually with the saved prompt'));
      return { success: false, promptFile, error: errorMessage };
    } catch {
      return { success: false, error: errorMessage };
    }
  }
}

// Init subcommand
const initCommand: Command = {
  name: 'init',
  description: 'Initialize a hive mind',
  options: [
    {
      name: 'topology',
      short: 't',
      description: 'Hive topology',
      type: 'string',
      choices: TOPOLOGIES.map(t => t.value),
      default: 'hierarchical-mesh'
    },
    {
      name: 'consensus',
      short: 'c',
      description: 'Consensus strategy',
      type: 'string',
      choices: CONSENSUS_STRATEGIES.map(s => s.value),
      default: 'byzantine'
    },
    {
      name: 'max-agents',
      short: 'm',
      description: 'Maximum agents',
      type: 'number',
      default: 15
    },
    {
      name: 'persist',
      short: 'p',
      description: 'Enable persistent state',
      type: 'boolean',
      default: true
    },
    {
      name: 'memory-backend',
      description: 'Memory backend (agentdb, sqlite, hybrid)',
      type: 'string',
      default: 'hybrid'
    }
  ],
  examples: [
    { command: 'claude-flow hive-mind init -t hierarchical-mesh', description: 'Init hierarchical mesh' },
    { command: 'claude-flow hive-mind init -c byzantine -m 20', description: 'Init with Byzantine consensus' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let topology = ctx.flags.topology as string;
    let consensus = ctx.flags.consensus as string;

    if (ctx.interactive && !ctx.flags.topology) {
      topology = await select({
        message: 'Select hive topology:',
        options: TOPOLOGIES,
        default: 'hierarchical-mesh'
      });
    }

    if (ctx.interactive && !ctx.flags.consensus) {
      consensus = await select({
        message: 'Select consensus strategy:',
        options: CONSENSUS_STRATEGIES,
        default: 'byzantine'
      });
    }

    const config = {
      topology: topology || 'hierarchical-mesh',
      consensus: consensus || 'byzantine',
      maxAgents: ctx.flags.maxAgents as number || 15,
      persist: ctx.flags.persist as boolean,
      memoryBackend: ctx.flags.memoryBackend as string || 'hybrid'
    };

    output.writeln();
    output.writeln(output.bold('Initializing Hive Mind'));

    const spinner = output.createSpinner({ text: 'Setting up hive infrastructure...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        hiveId: string;
        topology: string;
        consensus: string;
        queenId: string;
        status: 'initialized' | 'ready';
        config: typeof config;
      }>('hive-mind_init', config);

      spinner.succeed('Hive Mind initialized');

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Hive ID: ${result.hiveId ?? 'default'}`,
          `Queen ID: ${result.queenId ?? 'N/A'}`,
          `Topology: ${result.topology ?? config.topology}`,
          `Consensus: ${result.consensus ?? config.consensus}`,
          `Max Agents: ${config.maxAgents}`,
          `Memory: ${config.memoryBackend}`,
          `Status: ${output.success(result.status ?? 'initialized')}`
        ].join('\n'),
        'Hive Mind Configuration'
      );

      output.writeln();
      output.printInfo('Queen agent is ready to coordinate worker agents');
      output.writeln(output.dim('  Use "claude-flow hive-mind spawn" to add workers'));
      output.writeln(output.dim('  Use "claude-flow hive-mind spawn --claude" to launch Claude Code'));

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Failed to initialize');
      if (error instanceof MCPClientError) {
        output.printError(`Init error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Spawn subcommand - UPDATED with --claude flag
const spawnCommand: Command = {
  name: 'spawn',
  description: 'Spawn worker agents into the hive (use --claude to launch Claude Code)',
  options: [
    {
      name: 'count',
      short: 'n',
      description: 'Number of workers to spawn',
      type: 'number',
      default: 1
    },
    {
      name: 'role',
      short: 'r',
      description: 'Worker role (worker, specialist, scout)',
      type: 'string',
      choices: ['worker', 'specialist', 'scout'],
      default: 'worker'
    },
    {
      name: 'type',
      short: 't',
      description: 'Agent type',
      type: 'string',
      default: 'worker'
    },
    // ADR-0108 (T13): V2-parity comma-separated worker types for mixed-type
    // spawn. Distribution is round-robin (`types[i % types.length]`) across
    // `--n`. Mutually exclusive with `--type` (when `--type` is explicitly
    // provided): the action surfaces a fail-loud error per
    // `feedback-no-fallbacks.md` rather than silently picking one.
    //
    // Per `feedback-no-value-judgements-on-features.md`, the validation set
    // is the existing `WORKER_TYPES` constant in validate-input.ts (11 types
    // — 8 USERGUIDE domain values + 3 role labels). ADR-0108 §R5 nominally
    // restricts to 8 domain values; widening to the full validator surface
    // matches the "wire all features" memory rule.
    {
      name: 'worker-types',
      description: `Comma-separated worker types for mixed-type spawn (one of: ${WORKER_TYPES.join(', ')}). Mutually exclusive with --type. Round-robin distribution: types[i % types.length].`,
      type: 'string'
    },
    {
      name: 'prefix',
      short: 'p',
      description: 'Prefix for worker IDs',
      type: 'string',
      default: 'hive-worker'
    },
    // NEW: --claude flag for launching Claude Code
    {
      name: 'claude',
      description: 'Launch Claude Code with hive-mind coordination prompt',
      type: 'boolean',
      default: false
    },
    {
      name: 'objective',
      short: 'o',
      description: 'Objective for the hive mind (used with --claude)',
      type: 'string'
    },
    {
      name: 'dangerously-skip-permissions',
      description: 'Skip permission prompts in Claude Code (use with caution)',
      type: 'boolean',
      default: true
    },
    {
      name: 'no-auto-permissions',
      description: 'Disable automatic permission skipping',
      type: 'boolean',
      default: false
    },
    {
      name: 'dry-run',
      description: 'Show what would be done without launching Claude Code',
      type: 'boolean',
      default: false
    },
    {
      name: 'non-interactive',
      description: 'Run Claude Code in non-interactive mode',
      type: 'boolean',
      default: false
    },
    // ADR-0125 §Specification: declare --queen-type as a known flag with the
    // QUEEN_TYPES enum surfaced as `choices`. The parser already accepted
    // this flag implicitly via allowUnknownFlags; making it explicit here
    // gives `--help` a discoverable surface and lets the renderer assume
    // a well-typed value alongside the action-time validation below.
    {
      name: 'queen-type',
      description: `Queen leadership style (${QUEEN_TYPES.join(', ')}). Differentiation is prompt-shaped, not algorithmic.`,
      type: 'string',
      choices: [...QUEEN_TYPES],
      default: 'strategic'
    }
  ],
  examples: [
    { command: 'claude-flow hive-mind spawn -n 5', description: 'Spawn 5 workers' },
    { command: 'claude-flow hive-mind spawn -n 3 -r specialist', description: 'Spawn 3 specialists' },
    { command: 'claude-flow hive-mind spawn -t coder -p my-coder', description: 'Spawn coder with custom prefix' },
    { command: 'claude-flow hive-mind spawn -n 6 --worker-types researcher,coder,tester', description: 'V2-parity mixed spawn (round-robin: 2 researcher + 2 coder + 2 tester)' },
    { command: 'claude-flow hive-mind spawn --claude -o "Build a REST API"', description: 'Launch Claude Code with objective' },
    { command: 'claude-flow hive-mind spawn -n 5 --claude -o "Research AI patterns"', description: 'Spawn workers and launch Claude Code' },
    { command: 'claude-flow hive-mind spawn --claude -o "Optimize" --queen-type adaptive', description: 'Adaptive queen (mode-switching by complexity)' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Parse count with fallback to default
    const count = (ctx.flags.count as number) || 1;
    const role = (ctx.flags.role as string) || 'worker';
    const agentType = (ctx.flags.type as string) || 'worker';
    const prefix = (ctx.flags.prefix as string) || 'hive-worker';
    const launchClaude = ctx.flags.claude as boolean;
    let objective = (ctx.flags.objective as string) || ctx.args.join(' ');

    // ADR-0125 §Specification: CLI-boundary validation of --queen-type.
    // Per `feedback-no-fallbacks.md`, unknown values must fail loudly with a
    // user-visible error before reaching `generateHiveMindPrompt`. The
    // `default:` arm inside `generateHiveMindPrompt` is a defence-in-depth
    // backstop for non-CLI callers; this is the user-facing failure surface.
    //
    // The exact error message is part of the CLI contract — acceptance tests
    // assert against it verbatim.
    const rawQueenType = ctx.flags.queenType ?? ctx.flags['queen-type'];
    if (rawQueenType !== undefined && rawQueenType !== null && rawQueenType !== '') {
      const qtCheck = validateQueenType(rawQueenType);
      if (!qtCheck.valid) {
        throw new Error(
          `--queen-type must be one of ${QUEEN_TYPES.join('|')} (got "${String(rawQueenType)}")`
        );
      }
    }

    // ADR-0108 (T13): parse `--worker-types` (comma-separated mixed-type spawn).
    // Per `feedback-no-fallbacks.md`, every value is validated against the
    // existing `validateWorkerType` enum (one of WORKER_TYPES). Unknown values
    // produce a user-visible error before any spawn happens.
    //
    // Mutex rule: `--type` and `--worker-types` are mutually exclusive when
    // `--type` is set to a non-default value. The CLI parser populates
    // `--type`'s default 'worker' even when the user did not pass it, so the
    // mutex check fires only when the user provides a non-default `--type`.
    // Per ADR-0108 §Backward compatibility, `--type researcher -n 5` continues
    // to work as the degenerate one-element round-robin case.
    const rawWorkerTypes = ctx.flags.workerTypes ?? ctx.flags['worker-types'];
    let agentTypes: string[] | undefined;
    if (rawWorkerTypes !== undefined && rawWorkerTypes !== null && rawWorkerTypes !== '') {
      if (typeof rawWorkerTypes !== 'string') {
        throw new Error(
          `--worker-types must be a comma-separated string of worker types (got ${typeof rawWorkerTypes})`
        );
      }
      const parsed = rawWorkerTypes
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      if (parsed.length === 0) {
        throw new Error(
          `--worker-types must contain at least one worker type (got "${rawWorkerTypes}")`
        );
      }
      // Validate every member against the enum — fail loudly on the first
      // unknown value per `feedback-no-fallbacks.md`. No silent skip.
      for (const t of parsed) {
        const check = validateWorkerType(t, '--worker-types entry');
        if (!check.valid) {
          throw new Error(
            `--worker-types must be one of ${WORKER_TYPES.join('|')} (got "${t}")`
          );
        }
      }
      // Mutex against an explicit non-default --type. The CLI parser fills
      // `agentType` with the default 'worker' even when the user didn't pass
      // --type, so the test must be against that default. Passing
      // `--type worker --worker-types coder,tester` is allowed (worker is the
      // sentinel for "no explicit type"); passing
      // `--type coder --worker-types coder,tester` errors.
      const typeWasExplicit = agentType !== 'worker';
      if (typeWasExplicit) {
        throw new Error(
          `--type and --worker-types are mutually exclusive; use --worker-types for mixed spawns`
        );
      }
      agentTypes = parsed;
    }

    output.printInfo(`Spawning ${count} ${role} agent(s)...`);

    try {
      const result = await callMCPTool<{
        success: boolean;
        spawned: number;
        workers: Array<{
          agentId: string;
          role: string;
          joinedAt: string;
          agentType?: string;
        }>;
        totalWorkers: number;
        hiveStatus: string;
        hiveId?: string;
        message: string;
        error?: string;
      }>('hive-mind_spawn', {
        count,
        role,
        // ADR-0108: forward either the scalar (existing) or the array
        // (new mixed-type) shape. The MCP tool handler at
        // `hive-mind-tools.ts:hive-mind_spawn` enforces the same mutex via
        // its schema (oneOf agentType / agentTypes) and round-robins inside
        // the spawn loop.
        ...(agentTypes !== undefined ? { agentTypes } : { agentType }),
        prefix,
      });

      // Check for errors from MCP tool
      if (!result.success) {
        output.printError(result.error || 'Failed to spawn workers');
        return { success: false, exitCode: 1 };
      }

      if (ctx.flags.format === 'json' && !launchClaude) {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();

      // Transform workers array to display format
      const displayData = (result.workers || []).map(w => ({
        id: w.agentId,
        role: w.role,
        status: 'idle',
        joinedAt: new Date(w.joinedAt).toLocaleTimeString()
      }));

      output.printTable({
        columns: [
          { key: 'id', header: 'Agent ID', width: 30 },
          { key: 'role', header: 'Role', width: 12 },
          { key: 'status', header: 'Status', width: 10, format: formatAgentStatus },
          { key: 'joinedAt', header: 'Joined', width: 12 }
        ],
        data: displayData
      });

      output.writeln();
      output.printSuccess(`Registered ${result.spawned} worker slot(s) in hive state`);
      output.writeln(output.dim(`  Total worker slots: ${result.totalWorkers}`));
      output.writeln(output.dim('  Note: slots are state records — actual worker processes are launched by the Queen via --claude'));

      // NEW: Handle --claude flag
      if (launchClaude) {
        // Get objective if not provided
        if (!objective && ctx.interactive) {
          objective = await input({
            message: 'Enter the objective for the hive mind:',
            validate: (v) => v.length > 0 || 'Objective is required when using --claude'
          });
        }

        if (!objective) {
          output.writeln();
          output.printError('Objective is required when using --claude.');
          output.writeln(output.dim('  Provide an objective via -o/--objective="..." (recommended) or as a positional argument.'));
          output.writeln(output.dim('  Note: positional objectives must come BEFORE flags, otherwise the parser may consume them as flag values.'));
          output.writeln(output.dim('  Example: claude-flow hive-mind spawn -o "Build a REST API" --claude --non-interactive'));
          return { success: false, exitCode: 1 };
        }

        // Get hive status for swarm info
        let swarmId = result.hiveId || 'default';
        let swarmName = 'Hive Mind Swarm';

        try {
          const statusResult = await callMCPTool<{
            hiveId?: string;
            topology?: string;
            consensus?: string;
          }>('hive-mind_status', { includeWorkers: false });
          swarmId = statusResult.hiveId || swarmId;
        } catch {
          // Use defaults if status call fails
        }

        // Convert workers to expected format. ADR-0108 (T13): respect the
        // per-worker agentType the MCP handler emits when round-robin
        // distribution applies. Falls back to the scalar `agentType` for
        // legacy single-type spawns.
        const workers: HiveWorker[] = (result.workers || []).map(w => ({
          agentId: w.agentId,
          role: w.role,
          type: w.agentType ?? agentType,
          joinedAt: w.joinedAt
        }));

        // Launch Claude Code with hive mind prompt
        const claudeResult = await spawnClaudeCodeInstance(
          swarmId,
          swarmName,
          objective,
          workers,
          ctx.flags as Record<string, unknown>
        );

        if (!claudeResult.success) {
          return { success: false, exitCode: 1, data: { spawn: result, claude: claudeResult } };
        }

        return { success: true, data: { spawn: result, claude: claudeResult } };
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Spawn error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Status subcommand
const statusCommand: Command = {
  name: 'status',
  description: 'Show hive mind status',
  options: [
    {
      name: 'detailed',
      short: 'd',
      description: 'Show detailed metrics',
      type: 'boolean',
      default: false
    },
    {
      name: 'watch',
      short: 'w',
      description: 'Watch for changes',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const detailed = ctx.flags.detailed as boolean;

    try {
      const result = await callMCPTool<{
        hiveId?: string;
        id?: string;
        initialized?: boolean;
        status?: 'active' | 'idle' | 'degraded' | 'offline' | 'running' | 'stopped';
        topology?: string;
        consensus?: string;
        queen?: {
          id?: string;
          agentId?: string;
          status?: string;
          load?: number;
          tasksQueued?: number;
        };
        workers?: Array<{
          id?: string;
          agentId?: string;
          type?: string;
          agentType?: string;
          status?: string;
          currentTask?: string;
          tasksCompleted?: number;
        } | string>;
        metrics?: {
          totalTasks?: number;
          completedTasks?: number;
          failedTasks?: number;
          avgTaskTime?: number;
          consensusRounds?: number;
          memoryUsage?: string;
        };
        health?: {
          overall?: string;
          queen?: string;
          workers?: string;
          consensus?: string;
          memory?: string;
        };
      }>('hive-mind_status', {
        includeMetrics: detailed,
        includeWorkers: true,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      // Handle both simple and complex response formats - cast to flexible type
      const flexResult = result as Record<string, unknown>;
      const hiveId = result.hiveId ?? (flexResult.id as string) ?? 'default';
      const status = result.status ?? ((flexResult.initialized as boolean) ? 'running' : 'stopped');
      const queen = result.queen ?? { id: 'N/A', status: 'unknown', load: 0, tasksQueued: 0 };
      const flexQueen = queen as Record<string, unknown>;
      const queenId = typeof queen === 'object' ? (queen.id ?? (flexQueen.agentId as string) ?? 'N/A') : String(queen);
      const queenLoad = typeof queen === 'object' ? (queen.load ?? 0) : 0;
      const queenTasks = typeof queen === 'object' ? (queen.tasksQueued ?? 0) : 0;
      const queenStatus = typeof queen === 'object' ? (queen.status ?? 'active') : 'active';

      output.writeln();
      output.printBox(
        [
          `Hive ID: ${hiveId}`,
          `Status: ${formatHiveStatus(String(status))}`,
          `Topology: ${result.topology ?? 'mesh'}`,
          `Consensus: ${result.consensus ?? 'byzantine'}`,
          '',
          `Queen: ${queenId}`,
          `  Status: ${formatAgentStatus(queenStatus)}`,
          `  Load: ${(queenLoad * 100).toFixed(1)}%`,
          `  Queued Tasks: ${queenTasks}`
        ].join('\n'),
        'Hive Mind Status'
      );

      // Handle workers array - could be worker objects or just IDs
      const workers = result.workers ?? [];
      const workerData = Array.isArray(workers) ? workers.map(w => {
        if (typeof w === 'string') {
          return { id: w, type: 'worker', status: 'idle', currentTask: '-', tasksCompleted: 0 };
        }
        const flexWorker = w as Record<string, unknown>;
        return {
          id: w.id ?? (flexWorker.agentId as string) ?? 'unknown',
          type: w.type ?? (flexWorker.agentType as string) ?? 'worker',
          status: w.status ?? 'idle',
          currentTask: w.currentTask ?? '-',
          tasksCompleted: w.tasksCompleted ?? 0
        };
      }) : [];

      output.writeln();
      output.writeln(output.bold('Worker Agents'));
      if (workerData.length === 0) {
        output.printInfo('No workers in hive. Use "claude-flow hive-mind spawn" to add workers.');
      } else {
        output.printTable({
          columns: [
            { key: 'id', header: 'ID', width: 20 },
            { key: 'type', header: 'Type', width: 12 },
            { key: 'status', header: 'Status', width: 10, format: formatAgentStatus },
            { key: 'currentTask', header: 'Current Task', width: 20, format: (v: unknown) => String(v || '-') },
            { key: 'tasksCompleted', header: 'Completed', width: 10, align: 'right' }
          ],
          data: workerData
        });
      }

      if (detailed) {
        const metrics = result.metrics ?? { totalTasks: 0, completedTasks: 0, failedTasks: 0, avgTaskTime: 0, consensusRounds: 0, memoryUsage: '0 MB' };
        output.writeln();
        output.writeln(output.bold('Metrics'));
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 20 },
            { key: 'value', header: 'Value', width: 15, align: 'right' }
          ],
          data: [
            { metric: 'Total Tasks', value: metrics.totalTasks ?? 0 },
            { metric: 'Completed', value: metrics.completedTasks ?? 0 },
            { metric: 'Failed', value: metrics.failedTasks ?? 0 },
            { metric: 'Avg Task Time', value: `${(metrics.avgTaskTime ?? 0).toFixed(1)}ms` },
            { metric: 'Consensus Rounds', value: metrics.consensusRounds ?? 0 },
            { metric: 'Memory Usage', value: metrics.memoryUsage ?? '0 MB' }
          ]
        });

        const health = result.health ?? { overall: 'healthy', queen: 'healthy', workers: 'healthy', consensus: 'healthy', memory: 'healthy' };
        output.writeln();
        output.writeln(output.bold('Health'));
        output.printList([
          `Overall: ${formatHealth(health.overall ?? 'healthy')}`,
          `Queen: ${formatHealth(health.queen ?? 'healthy')}`,
          `Workers: ${formatHealth(health.workers ?? 'healthy')}`,
          `Consensus: ${formatHealth(health.consensus ?? 'healthy')}`,
          `Memory: ${formatHealth(health.memory ?? 'healthy')}`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Status error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Task subcommand
const taskCommand: Command = {
  name: 'task',
  description: 'Submit tasks to the hive',
  options: [
    {
      name: 'description',
      short: 'd',
      description: 'Task description',
      type: 'string'
    },
    {
      name: 'priority',
      short: 'p',
      description: 'Task priority',
      type: 'string',
      choices: ['low', 'normal', 'high', 'critical'],
      default: 'normal'
    },
    {
      name: 'require-consensus',
      short: 'c',
      description: 'Require consensus for completion',
      type: 'boolean',
      default: false
    },
    {
      name: 'timeout',
      description: 'Task timeout in seconds',
      type: 'number',
      default: 300
    }
  ],
  examples: [
    { command: 'claude-flow hive-mind task -d "Implement auth module"', description: 'Submit task' },
    { command: 'claude-flow hive-mind task -d "Security review" -p critical -c', description: 'Critical task with consensus' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let description = ctx.flags.description as string || ctx.args.join(' ');

    if (!description && ctx.interactive) {
      description = await input({
        message: 'Task description:',
        validate: (v) => v.length > 0 || 'Description is required'
      });
    }

    if (!description) {
      output.printError('Task description is required');
      return { success: false, exitCode: 1 };
    }

    const priority = ctx.flags.priority as string;
    const requireConsensus = ctx.flags.requireConsensus as boolean;
    const timeout = ctx.flags.timeout as number;

    output.printInfo('Submitting task to hive...');

    try {
      const result = await callMCPTool<{
        taskId: string;
        description: string;
        status: string;
        assignedTo: string[];
        priority: string;
        requiresConsensus: boolean;
        estimatedTime: string;
      }>('hive-mind_task', {
        description,
        priority,
        requireConsensus,
        timeout,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Task ID: ${result.taskId}`,
          `Status: ${formatAgentStatus(result.status)}`,
          `Priority: ${formatPriority(priority)}`,
          `Assigned: ${result.assignedTo.join(', ')}`,
          `Consensus: ${result.requiresConsensus ? 'Yes' : 'No'}`,
          `Est. Time: ${result.estimatedTime}`
        ].join('\n'),
        'Task Submitted'
      );

      output.writeln();
      output.printSuccess('Task submitted to hive');
      output.writeln(output.dim(`  Track with: claude-flow hive-mind task-status ${result.taskId}`));

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Task submission error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Optimize memory subcommand
const optimizeMemoryCommand: Command = {
  name: 'optimize-memory',
  description: 'Optimize hive memory and patterns',
  options: [
    {
      name: 'aggressive',
      short: 'a',
      description: 'Aggressive optimization',
      type: 'boolean',
      default: false
    },
    {
      name: 'threshold',
      description: 'Quality threshold for pattern retention',
      type: 'number',
      default: 0.7
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const aggressive = ctx.flags.aggressive as boolean;
    const threshold = ctx.flags.threshold as number;

    output.printInfo('Optimizing hive memory...');

    const spinner = output.createSpinner({ text: 'Analyzing patterns...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        optimized: boolean;
        before: { patterns: number; memory: string };
        after: { patterns: number; memory: string };
        removed: number;
        consolidated: number;
        timeMs: number;
      }>('hive-mind_optimize-memory', {
        aggressive,
        qualityThreshold: threshold,
      });

      spinner.succeed('Memory optimized');

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'before', header: 'Before', width: 15, align: 'right' },
          { key: 'after', header: 'After', width: 15, align: 'right' }
        ],
        data: [
          { metric: 'Patterns', before: result.before.patterns, after: result.after.patterns },
          { metric: 'Memory', before: result.before.memory, after: result.after.memory }
        ]
      });

      output.writeln();
      output.printList([
        `Patterns removed: ${result.removed}`,
        `Patterns consolidated: ${result.consolidated}`,
        `Optimization time: ${result.timeMs}ms`
      ]);

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Optimization failed');
      if (error instanceof MCPClientError) {
        output.printError(`Optimization error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Join subcommand
const joinCommand: Command = {
  name: 'join',
  description: 'Join an agent to the hive mind',
  options: [
    { name: 'agent-id', short: 'a', description: 'Agent ID to join', type: 'string' },
    { name: 'role', short: 'r', description: 'Agent role (worker, specialist, scout)', type: 'string', default: 'worker' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agentId = ctx.args[0] || ctx.flags['agent-id'] as string || ctx.flags.agentId as string;
    if (!agentId) {
      output.printError('Agent ID is required. Use --agent-id or -a flag, or provide as argument.');
      return { success: false, exitCode: 1 };
    }
    try {
      const result = await callMCPTool<{ success: boolean; agentId: string; totalWorkers: number; error?: string }>('hive-mind_join', { agentId, role: ctx.flags.role });
      if (!result.success) { output.printError(result.error || 'Failed'); return { success: false, exitCode: 1 }; }
      output.printSuccess(`Agent ${agentId} joined hive (${result.totalWorkers} workers)`);
      return { success: true, data: result };
    } catch (error) { output.printError(`Join error: ${error instanceof MCPClientError ? error.message : String(error)}`); return { success: false, exitCode: 1 }; }
  }
};

// Leave subcommand
const leaveCommand: Command = {
  name: 'leave',
  description: 'Remove an agent from the hive mind',
  options: [{ name: 'agent-id', short: 'a', description: 'Agent ID to remove', type: 'string' }],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agentId = ctx.args[0] || ctx.flags['agent-id'] as string || ctx.flags.agentId as string;
    if (!agentId) { output.printError('Agent ID required.'); return { success: false, exitCode: 1 }; }
    try {
      const result = await callMCPTool<{ success: boolean; agentId: string; remainingWorkers: number; error?: string }>('hive-mind_leave', { agentId });
      if (!result.success) { output.printError(result.error || 'Failed'); return { success: false, exitCode: 1 }; }
      output.printSuccess(`Agent ${agentId} left hive (${result.remainingWorkers} remaining)`);
      return { success: true, data: result };
    } catch (error) { output.printError(`Leave error: ${error instanceof MCPClientError ? error.message : String(error)}`); return { success: false, exitCode: 1 }; }
  }
};

// Consensus subcommand
const consensusCommand: Command = {
  name: 'consensus',
  description: 'Manage consensus proposals and voting',
  options: [
    { name: 'action', short: 'a', description: 'Consensus action', type: 'string', choices: ['propose', 'vote', 'status', 'list'], default: 'list' },
    { name: 'proposal-id', short: 'p', description: 'Proposal ID', type: 'string' },
    { name: 'type', short: 't', description: 'Proposal type', type: 'string' },
    { name: 'value', description: 'Proposal value', type: 'string' },
    { name: 'vote', short: 'v', description: 'Vote (yes/no)', type: 'string' },
    { name: 'voter-id', description: 'Voter agent ID', type: 'string' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const action = ctx.flags.action as string || 'list';
    try {
      const result = await callMCPTool<Record<string, unknown>>('hive-mind_consensus', { action, proposalId: ctx.flags.proposalId, type: ctx.flags.type, value: ctx.flags.value, vote: ctx.flags.vote === 'yes', voterId: ctx.flags.voterId });
      if (ctx.flags.format === 'json') { output.printJson(result); return { success: true, data: result }; }
      if (action === 'list') {
        output.writeln(output.bold('\nPending Proposals'));
        const pending = (result.pending as Array<Record<string, unknown>>) || [];
        if (pending.length === 0) output.printInfo('No pending proposals');
        else output.printTable({ columns: [{ key: 'proposalId', header: 'ID', width: 30 }, { key: 'type', header: 'Type', width: 12 }], data: pending });
      } else if (action === 'propose') { output.printSuccess(`Proposal created: ${result.proposalId}`); }
      else if (action === 'vote') { output.printSuccess(`Vote recorded (For: ${result.votesFor}, Against: ${result.votesAgainst})`); }
      return { success: true, data: result };
    } catch (error) { output.printError(`Consensus error: ${error instanceof MCPClientError ? error.message : String(error)}`); return { success: false, exitCode: 1 }; }
  }
};

// Broadcast subcommand
const broadcastCommand: Command = {
  name: 'broadcast',
  description: 'Broadcast a message to all workers in the hive',
  options: [
    { name: 'message', short: 'm', description: 'Message to broadcast', type: 'string', required: true },
    { name: 'priority', short: 'p', description: 'Message priority', type: 'string', choices: ['low', 'normal', 'high', 'critical'], default: 'normal' },
    { name: 'from', short: 'f', description: 'Sender agent ID', type: 'string' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const message = ctx.args.join(' ') || ctx.flags.message as string;
    if (!message) { output.printError('Message required. Use --message or -m flag.'); return { success: false, exitCode: 1 }; }
    try {
      const result = await callMCPTool<{ success: boolean; messageId: string; recipients: number; error?: string }>('hive-mind_broadcast', { message, priority: ctx.flags.priority, fromId: ctx.flags.from });
      if (!result.success) { output.printError(result.error || 'Failed'); return { success: false, exitCode: 1 }; }
      output.printSuccess(`Message broadcast to ${result.recipients} workers (ID: ${result.messageId})`);
      return { success: true, data: result };
    } catch (error) { output.printError(`Broadcast error: ${error instanceof MCPClientError ? error.message : String(error)}`); return { success: false, exitCode: 1 }; }
  }
};

// Memory subcommand
const memorySubCommand: Command = {
  name: 'memory',
  description: 'Access hive shared memory',
  options: [
    { name: 'action', short: 'a', description: 'Memory action', type: 'string', choices: ['get', 'set', 'delete', 'list'], default: 'list' },
    { name: 'key', short: 'k', description: 'Memory key', type: 'string' },
    { name: 'value', short: 'v', description: 'Value to store', type: 'string' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const action = ctx.flags.action as string || 'list';
    const key = ctx.flags.key as string;
    const value = ctx.flags.value as string;
    if ((action === 'get' || action === 'delete') && !key) { output.printError('Key required for get/delete.'); return { success: false, exitCode: 1 }; }
    if (action === 'set' && (!key || value === undefined)) { output.printError('Key and value required for set.'); return { success: false, exitCode: 1 }; }
    try {
      const result = await callMCPTool<Record<string, unknown>>('hive-mind_memory', { action, key, value });
      if (ctx.flags.format === 'json') { output.printJson(result); return { success: true, data: result }; }
      if (action === 'list') {
        const keys = (result.keys as string[]) || [];
        output.writeln(output.bold(`\nShared Memory (${result.count} keys)`));
        if (keys.length === 0) output.printInfo('No keys in shared memory');
        else output.printList(keys.map(k => output.highlight(k)));
      } else if (action === 'get') {
        output.writeln(output.bold(`\nKey: ${key}`));
        output.writeln(result.exists ? `Value: ${JSON.stringify(result.value, null, 2)}` : 'Key not found');
      } else if (action === 'set') { output.printSuccess(`Set ${key} in shared memory`); }
      else if (action === 'delete') { output.printSuccess(result.deleted ? `Deleted ${key}` : `Key ${key} did not exist`); }
      return { success: true, data: result };
    } catch (error) { output.printError(`Memory error: ${error instanceof MCPClientError ? error.message : String(error)}`); return { success: false, exitCode: 1 }; }
  }
};

// Shutdown subcommand
const shutdownCommand: Command = {
  name: 'shutdown',
  description: 'Shutdown the hive mind',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force shutdown',
      type: 'boolean',
      default: false
    },
    {
      name: 'save-state',
      short: 's',
      description: 'Save state before shutdown',
      type: 'boolean',
      default: true
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;
    const saveState = ctx.flags.saveState as boolean;

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: 'Shutdown the hive mind? All agents will be terminated.',
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    output.printInfo('Shutting down hive mind...');

    const spinner = output.createSpinner({ text: 'Graceful shutdown in progress...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        shutdown: boolean;
        agentsTerminated: number;
        stateSaved: boolean;
        shutdownTime: string;
      }>('hive-mind_shutdown', {
        force,
        saveState,
      });

      spinner.succeed('Hive mind shutdown complete');

      output.writeln();
      output.printList([
        `Agents terminated: ${result.agentsTerminated}`,
        `State saved: ${result.stateSaved ? 'Yes' : 'No'}`,
        `Shutdown time: ${result.shutdownTime}`
      ]);

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Shutdown failed');
      if (error instanceof MCPClientError) {
        output.printError(`Shutdown error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Main hive-mind command
export const hiveMindCommand: Command = {
  name: 'hive-mind',
  aliases: ['hive'],
  description: 'Queen-led consensus-based multi-agent coordination',
  subcommands: [initCommand, spawnCommand, statusCommand, taskCommand, joinCommand, leaveCommand, consensusCommand, broadcastCommand, memorySubCommand, optimizeMemoryCommand, shutdownCommand],
  options: [],
  examples: [
    { command: 'claude-flow hive-mind init -t hierarchical-mesh', description: 'Initialize hive' },
    { command: 'claude-flow hive-mind spawn -n 5', description: 'Spawn workers' },
    { command: 'claude-flow hive-mind spawn --claude -o "Build a feature"', description: 'Launch Claude Code with hive mind' },
    { command: 'claude-flow hive-mind task -d "Build feature"', description: 'Submit task' }
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Hive Mind - Consensus-Based Multi-Agent Coordination'));
    output.writeln();
    output.writeln('Usage: claude-flow hive-mind <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}            - Initialize hive mind`,
      `${output.highlight('spawn')}           - Spawn worker agents (use --claude to launch Claude Code)`,
      `${output.highlight('status')}          - Show hive status`,
      `${output.highlight('task')}            - Submit task to hive`,
      `${output.highlight('join')}            - Join an agent to the hive`,
      `${output.highlight('leave')}           - Remove an agent from the hive`,
      `${output.highlight('consensus')}       - Manage consensus proposals`,
      `${output.highlight('broadcast')}       - Broadcast message to workers`,
      `${output.highlight('memory')}          - Access shared memory`,
      `${output.highlight('optimize-memory')} - Optimize patterns and memory`,
      `${output.highlight('shutdown')}        - Shutdown the hive`
    ]);
    output.writeln();
    output.writeln('Features:');
    output.printList([
      'Queen-led hierarchical coordination',
      'Byzantine fault tolerant consensus',
      'HNSW-accelerated pattern matching',
      'Cross-session memory persistence',
      'Automatic load balancing',
      output.success('NEW: --claude flag to launch interactive Claude Code sessions')
    ]);
    output.writeln();
    output.writeln('Quick Start with Claude Code:');
    output.writeln(output.dim('  claude-flow hive-mind init'));
    output.writeln(output.dim('  claude-flow hive-mind spawn -n 5 --claude -o "Your objective here"'));

    return { success: true };
  }
};

// Helper functions
function formatAgentStatus(status: unknown): string {
  const statusStr = String(status);
  switch (statusStr) {
    case 'active':
    case 'ready':
    case 'running':
      return output.success(statusStr);
    case 'idle':
    case 'waiting':
      return output.dim(statusStr);
    case 'busy':
      return output.highlight(statusStr);
    case 'error':
    case 'failed':
      return output.error(statusStr);
    default:
      return statusStr;
  }
}

function formatHiveStatus(status: string): string {
  switch (status) {
    case 'active':
      return output.success(status);
    case 'idle':
      return output.dim(status);
    case 'degraded':
      return output.warning(status);
    case 'offline':
      return output.error(status);
    default:
      return status;
  }
}

function formatHealth(health: string): string {
  switch (health) {
    case 'healthy':
    case 'good':
      return output.success(health);
    case 'warning':
    case 'degraded':
      return output.warning(health);
    case 'critical':
    case 'unhealthy':
      return output.error(health);
    default:
      return health;
  }
}

function formatPriority(priority: string): string {
  switch (priority) {
    case 'critical':
      return output.error(priority.toUpperCase());
    case 'high':
      return output.warning(priority);
    case 'normal':
      return priority;
    case 'low':
      return output.dim(priority);
    default:
      return priority;
  }
}

export default hiveMindCommand;
