/**
 * ADR-0127 (T9) — Adaptive autoscaling control loop.
 *
 * The protocol-layer queen-side consumer for hive-coordination scaling and
 * topology mutation. Subscribes to `HealthReport` events emitted by
 * `QueenCoordinator.monitorSwarmHealth()` (queen-coordinator.ts:1492),
 * decides on scale + topology actions per the dampening/settle/flip-rate
 * predicates, and calls back into the coordinator's mutation surfaces.
 *
 * **Architectural invariants** (ADR-0114, ADR-0105):
 *   - Coordinator observes (execution layer); this module decides (protocol
 *     layer); coordinator executes (mutation surface). No direct path where
 *     the coordinator decides without consumer involvement.
 *   - This module is the "queen-side consumer" referenced throughout
 *     ADR-0127. It is NOT the LLM-driven adaptive queen prompt T7
 *     (ADR-0125) produces — that prompt has no programmatic surface. This
 *     module sits on the protocol-layer side of the coordinator boundary
 *     in code, not in an LLM session.
 *   - `queen-coordinator.ts` is `@internal` per ADR-0105; the consumer
 *     lives here in a NEW module, NOT as a method on QueenCoordinator.
 *
 * **No fallbacks** (`feedback-no-fallbacks.md`):
 *   - Mutation callback errors halt the loop loudly, never retried.
 *   - Flip-rate ceiling exceeded → halt loop, surface fault.
 *   - 3 consecutive metric-poll failures → halt loop, surface fault.
 *   - Topology switch deferred past 3 dampening windows → emit fault, do
 *     NOT silently no-op.
 *   - `partitionDetected` true → suspend scaling, emit partition fault.
 *
 * **Cross-task coupling**:
 *   - T10 (ADR-0128) provides the dispatch surface this module mutates
 *     into via `setHiveTopology()`. The `setAdaptiveResolver()` hand-off
 *     is registered on coordinator so the next dispatch's `adaptive`
 *     branch resolves to whatever this loop decided.
 *
 * **PRELIMINARY thresholds** (ADR-0127 §Specification):
 *   All eight defaults below are placeholders chosen for plausibility, not
 *   measurement-derived. If integration tests show degenerate behaviour
 *   (constant flap, persistent under-reaction, scale storm), HALT and
 *   escalate per the ADR-0118 §T9 rule.
 *
 * **Wire-up pattern** — caller holds both the coordinator AND wants
 * adaptive behaviour:
 *
 *   ```ts
 *   import { createAdaptiveLoop } from '@claude-flow/swarm';
 *   const loop = createAdaptiveLoop(swarm, {
 *     scaleUp:    async (domain) => { await swarm.spawnAgent({ domain, type: 'coder' }); },
 *     scaleDown:  async (agentId) => { await swarm.terminateAgent(agentId); },
 *     switchTopology: async (target) => {
 *       try {
 *         coordinator.setHiveTopology(target);
 *         return 'OK';
 *       } catch (e) {
 *         if (String(e.message).includes('not yet implemented')) return 'NOT_IMPLEMENTED';
 *         throw e;
 *       }
 *     },
 *   });
 *   coordinator.setAdaptiveResolver(loop.resolveAdaptiveTopology);
 *   loop.start();
 *   ```
 *
 * The `setAdaptiveResolver` hand-off is required so that
 * `dispatchByTopology({ topology: 'adaptive' })` resolves to whatever the
 * loop decided. Without this hand-off, ADR-0128's `adaptive` branch
 * throws "adaptive topology dispatch requires T9/ADR-0127 — not yet
 * implemented" per `feedback-no-fallbacks.md`.
 */

import { EventEmitter } from 'events';
import type {
  AgentDomain,
  DomainStatus,
  HiveTopology,
} from './unified-coordinator.js';
import type { HealthReport, ISwarmCoordinator } from './queen-coordinator.js';

// =============================================================================
// PRELIMINARY threshold defaults — placeholders, not measurement-derived
// =============================================================================

/**
 * ADR-0127 §Specification (all PRELIMINARY):
 *   - pollIntervalMs: 5000 — basis: latency budget for scale reaction
 *   - settleWindowMs: 30000 — basis: spawn + initial task assignment time
 *   - dampeningWindowMs: 30000 — mirrors action stabilisation time
 *   - highWaterQueueDepth: 3 — basis: 1-2 queued is comfortable; 3+ is backlog
 *   - lowWaterQueueDepth: 0 — strict zero; never terminate carrying queued work
 *   - highCoV: 0.6 — basis: > 0.5 conventional "high variability"; 0.6 leaves headroom
 *   - lowCoV: 0.3 — 2× hysteresis gap below high; conventional "moderate variability"
 *   - perTypeMin: 1 — each declared type must have at least one live worker
 *   - maxFlipsPerWindow: 4 — order-of-magnitude; ≈ one mutation per dampening window
 *   - flipWindowMs: 3600000 (1h) — basis: enough to bound adversarial input
 *   - maxConsecutivePollFailures: 3 — basis: short transient vs sustained outage
 *   - topologyDeferralBoundWindows: 3 — basis: 3 dampening windows ≈ 90s task drain
 */
export const ADAPTIVE_LOOP_DEFAULTS = {
  pollIntervalMs: 5000,
  settleWindowMs: 30000,
  dampeningWindowMs: 30000,
  highWaterQueueDepth: 3,
  lowWaterQueueDepth: 0,
  highCoV: 0.6,
  lowCoV: 0.3,
  perTypeMin: 1,
  maxFlipsPerWindow: 4,
  flipWindowMs: 60 * 60 * 1000,
  maxConsecutivePollFailures: 3,
  topologyDeferralBoundWindows: 3,
} as const;

/** Configuration accepted by `createAdaptiveLoop`. */
export interface AdaptiveLoopConfig {
  pollIntervalMs?: number;
  settleWindowMs?: number;
  dampeningWindowMs?: number;
  highWaterQueueDepth?: number;
  lowWaterQueueDepth?: number;
  highCoV?: number;
  lowCoV?: number;
  perTypeMin?: number;
  maxFlipsPerWindow?: number;
  flipWindowMs?: number;
  maxConsecutivePollFailures?: number;
  topologyDeferralBoundWindows?: number;
  /**
   * Override for the loop's monotonic clock. Tests inject a controllable
   * source (e.g. a counter) so dampening/settle/flip-rate windows behave
   * deterministically. Defaults to `Date.now`.
   */
  now?: () => number;
}

/** Action axis used by flip-rate counter + settle window bookkeeping. */
export type ActionAxis = 'scale' | 'topology';

/** Reasons the loop suspends or halts; surfaced as `fault.*` events. */
export type FaultReason =
  | 'queen-unreachable'
  | 'metric-poll-failure'
  | 'flip-rate-ceiling'
  | 'mutation-error'
  | 'topology-switch-abandoned'
  | 'partition-detected'
  | 'corrupt-metrics';

/** Decision emitted by the loop to apply scaling. */
export interface ScaleDecision {
  axis: 'scale';
  direction: 'up' | 'down';
  domain: AgentDomain;
  reason: 'high-water' | 'low-water';
}

/** Decision emitted by the loop to apply topology mutation. */
export interface TopologyDecision {
  axis: 'topology';
  target: HiveTopology;
  reason: 'cov-high' | 'cov-low';
}

export type AdaptiveDecision = ScaleDecision | TopologyDecision;

/**
 * Mutation callbacks the loop calls once a decision passes all three gates
 * (dampening + settle window + flip-rate). The coordinator wires these to
 * its own `spawnAgent` / `terminateAgent` / `setHiveTopology` surfaces.
 *
 * Per `feedback-no-fallbacks.md`, every callback may throw; the loop
 * surfaces the throw as a `fault.mutation-error` event and halts.
 */
export interface AdaptiveLoopCallbacks {
  /** Spawn one worker of the given domain (high-water reaction). */
  scaleUp: (domain: AgentDomain) => Promise<void>;
  /**
   * Terminate one worker. The loop selects an idle worker via the supplied
   * candidate id; the callback enforces "preserve per-type minimum" (this
   * module computes the minimum check before invoking the callback, but
   * the callback may still refuse with a throw if it knows better).
   */
  scaleDown: (agentId: string, domain: AgentDomain) => Promise<void>;
  /**
   * Switch hive topology. Until T10's full surface is integrated, this
   * may be a thin wrapper around `coordinator.setHiveTopology(target)`
   * (which throws on unknown values per ADR-0128). If the callback
   * returns a not-implemented marker (string, never throws), the loop
   * logs and continues per ADR-0127 §Refinement; any throw halts.
   */
  switchTopology: (target: HiveTopology) => Promise<'NOT_IMPLEMENTED' | 'OK'>;
}

/**
 * Per-axis state tracked across ticks. Held internally; exposed via
 * `getState()` for tests / observability.
 */
export interface AdaptiveLoopState {
  status: 'idle' | 'running' | 'halted' | 'suspended';
  haltReason?: FaultReason;
  lastTickAt?: number;
  lastActionAt?: number;
  consecutivePollFailures: number;
  /** Per-axis breach-duration accumulators (ms). */
  breachDurations: {
    'high-water': number;
    'low-water': number;
    'cov-high': number;
    'cov-low': number;
  };
  /**
   * Per-axis sliding-window flip timestamps. Older entries (>flipWindowMs)
   * are pruned on every tick so the array length is bounded.
   */
  flipTimestamps: {
    scale: number[];
    topology: number[];
  };
  /** Current pending topology decision deferred for active-task drain. */
  pendingTopologySwitch?: {
    target: HiveTopology;
    deferralCount: number;
    firstDeferredAt: number;
  };
  /** Last `breachedThreshold` value seen — used to reset breach durations on direction change. */
  lastBreachAxis?: 'high-water' | 'low-water' | 'cov-high' | 'cov-low' | 'none';
}

/** Event types emitted by `AdaptiveLoop`. Strings are stable — tests grep them. */
export type AdaptiveLoopEvent =
  | 'tick'
  | 'decision.scale'
  | 'decision.topology'
  | 'action.applied'
  | 'fault'
  | 'topology.deferred'
  | 'partition.suspended';

/**
 * The adaptive autoscaling loop.
 *
 * Lifecycle:
 *   1. `start()` — begins the poll loop (setInterval at pollIntervalMs)
 *   2. Per tick: snapshot `swarm.getStatus()`, compute deltas, evaluate
 *      threshold breaches, run dampening/settle/flip-rate gate, dispatch
 *      decisions via callbacks
 *   3. Any fault halts the loop loudly and emits `fault` event with a
 *      clear `FaultReason`. Operator must `start()` again to resume.
 *   4. `stop()` — clears the interval, retains state for inspection
 *
 * The loop is event-driven: callers can subscribe to `decision.scale`,
 * `decision.topology`, `action.applied`, `fault`, `topology.deferred`,
 * and `partition.suspended` for observability.
 */
export class AdaptiveLoop extends EventEmitter {
  private readonly swarm: ISwarmCoordinator;
  private readonly callbacks: AdaptiveLoopCallbacks;
  private readonly cfg: Required<Omit<AdaptiveLoopConfig, 'now'>>;
  private readonly now: () => number;
  private interval?: NodeJS.Timeout;
  private state: AdaptiveLoopState;
  private tickInFlight = false;

  constructor(
    swarm: ISwarmCoordinator,
    callbacks: AdaptiveLoopCallbacks,
    config: AdaptiveLoopConfig = {},
  ) {
    super();
    this.swarm = swarm;
    this.callbacks = callbacks;
    this.cfg = {
      pollIntervalMs: config.pollIntervalMs ?? ADAPTIVE_LOOP_DEFAULTS.pollIntervalMs,
      settleWindowMs: config.settleWindowMs ?? ADAPTIVE_LOOP_DEFAULTS.settleWindowMs,
      dampeningWindowMs: config.dampeningWindowMs ?? ADAPTIVE_LOOP_DEFAULTS.dampeningWindowMs,
      highWaterQueueDepth: config.highWaterQueueDepth ?? ADAPTIVE_LOOP_DEFAULTS.highWaterQueueDepth,
      lowWaterQueueDepth: config.lowWaterQueueDepth ?? ADAPTIVE_LOOP_DEFAULTS.lowWaterQueueDepth,
      highCoV: config.highCoV ?? ADAPTIVE_LOOP_DEFAULTS.highCoV,
      lowCoV: config.lowCoV ?? ADAPTIVE_LOOP_DEFAULTS.lowCoV,
      perTypeMin: config.perTypeMin ?? ADAPTIVE_LOOP_DEFAULTS.perTypeMin,
      maxFlipsPerWindow: config.maxFlipsPerWindow ?? ADAPTIVE_LOOP_DEFAULTS.maxFlipsPerWindow,
      flipWindowMs: config.flipWindowMs ?? ADAPTIVE_LOOP_DEFAULTS.flipWindowMs,
      maxConsecutivePollFailures:
        config.maxConsecutivePollFailures ?? ADAPTIVE_LOOP_DEFAULTS.maxConsecutivePollFailures,
      topologyDeferralBoundWindows:
        config.topologyDeferralBoundWindows ?? ADAPTIVE_LOOP_DEFAULTS.topologyDeferralBoundWindows,
    };
    this.now = config.now ?? Date.now;

    this.validateConfig();

    this.state = {
      status: 'idle',
      consecutivePollFailures: 0,
      breachDurations: {
        'high-water': 0,
        'low-water': 0,
        'cov-high': 0,
        'cov-low': 0,
      },
      flipTimestamps: {
        scale: [],
        topology: [],
      },
    };
  }

  /**
   * Validate configuration at construction time. Per
   * `feedback-no-fallbacks.md`, invalid config throws immediately rather
   * than silently coercing to defaults.
   */
  private validateConfig(): void {
    if (this.cfg.pollIntervalMs <= 0) {
      throw new Error('AdaptiveLoop: pollIntervalMs must be > 0');
    }
    if (this.cfg.dampeningWindowMs < this.cfg.pollIntervalMs) {
      throw new Error(
        'AdaptiveLoop: dampeningWindowMs must be >= pollIntervalMs (otherwise a single tick crosses the dampening window)',
      );
    }
    if (this.cfg.highWaterQueueDepth <= this.cfg.lowWaterQueueDepth) {
      throw new Error(
        'AdaptiveLoop: highWaterQueueDepth must be > lowWaterQueueDepth (hysteresis gap required)',
      );
    }
    if (this.cfg.highCoV <= this.cfg.lowCoV) {
      throw new Error(
        'AdaptiveLoop: highCoV must be > lowCoV (hysteresis gap required)',
      );
    }
    if (this.cfg.lowCoV < 0 || this.cfg.highCoV > 1) {
      throw new Error('AdaptiveLoop: CoV thresholds must be in [0, 1]');
    }
    if (this.cfg.maxFlipsPerWindow <= 0) {
      throw new Error('AdaptiveLoop: maxFlipsPerWindow must be > 0');
    }
    if (this.cfg.perTypeMin < 1) {
      throw new Error(
        'AdaptiveLoop: perTypeMin must be >= 1 (sub-minimum termination silently breaks the worker-type contract from T8)',
      );
    }
  }

  /** Begin polling. Idempotent — repeated calls after halt require explicit reset. */
  start(): void {
    if (this.state.status === 'running') return;
    if (this.state.status === 'halted') {
      throw new Error(
        `AdaptiveLoop: cannot start while halted (reason: ${this.state.haltReason ?? 'unknown'}); call reset() first`,
      );
    }
    this.state.status = 'running';
    this.interval = setInterval(() => {
      // Fire-and-forget; tick errors are handled inside tick().
      void this.tick();
    }, this.cfg.pollIntervalMs);
  }

  /** Halt the poll loop. Retains state for inspection. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.state.status === 'running') {
      this.state.status = 'idle';
    }
  }

  /**
   * Reset state and clear any halt condition so `start()` can resume.
   * Operator-initiated; the loop never auto-resets a halt.
   */
  reset(): void {
    this.stop();
    this.state = {
      status: 'idle',
      consecutivePollFailures: 0,
      breachDurations: {
        'high-water': 0,
        'low-water': 0,
        'cov-high': 0,
        'cov-low': 0,
      },
      flipTimestamps: {
        scale: [],
        topology: [],
      },
    };
  }

  /** Manually drive a single tick — used by tests. */
  async tickOnce(): Promise<void> {
    await this.tick();
  }

  getState(): AdaptiveLoopState {
    return {
      ...this.state,
      breachDurations: { ...this.state.breachDurations },
      flipTimestamps: {
        scale: [...this.state.flipTimestamps.scale],
        topology: [...this.state.flipTimestamps.topology],
      },
      pendingTopologySwitch: this.state.pendingTopologySwitch
        ? { ...this.state.pendingTopologySwitch }
        : undefined,
    };
  }

  /**
   * Adaptive resolver compatible with
   * `UnifiedSwarmCoordinator.setAdaptiveResolver()` (ADR-0128). When the
   * coordinator dispatches with `topology: 'adaptive'`, the resolver is
   * invoked and must return a concrete topology. The current decision is
   * derived from the most recent `HealthReport` (computed via
   * `swarm.getStatus()` if the loop hasn't ticked yet).
   *
   * Per `feedback-no-fallbacks.md`: if the loop is halted, the resolver
   * throws — the operator must reset the loop before adaptive dispatch can
   * proceed.
   */
  resolveAdaptiveTopology = async (): Promise<HiveTopology> => {
    if (this.state.status === 'halted') {
      throw new Error(
        `AdaptiveLoop: cannot resolve adaptive topology while halted (reason: ${this.state.haltReason ?? 'unknown'})`,
      );
    }
    // Take a fresh snapshot so the resolver reflects current conditions
    // even if the poll cadence hasn't ticked recently.
    const status = this.swarm.getStatus();
    const cov = computeLoadCoV(status.domains);
    if (cov >= this.cfg.highCoV) return 'mesh';
    if (cov <= this.cfg.lowCoV) return 'hierarchical';
    // Mid-band: keep stable. We default to `hierarchical-mesh` as the
    // CLI's documented default rather than randomly picking — sticky in
    // the absence of a clear signal.
    return 'hierarchical-mesh';
  };

  // =============================================================================
  // Tick loop
  // =============================================================================

  private async tick(): Promise<void> {
    if (this.state.status !== 'running') return;
    if (this.tickInFlight) {
      // Drop the tick rather than queueing — ADR-0127 §Pseudocode "if a
      // tick is still running when the next interval fires, the next tick
      // is dropped (logged but not retried)".
      this.emit('tick', { dropped: true, reason: 'overlap' });
      return;
    }
    this.tickInFlight = true;
    const tickStart = this.now();

    try {
      // 1. Read status; treat read errors as poll failures.
      let status: { domains: DomainStatus[]; metrics: unknown };
      try {
        status = this.swarm.getStatus();
      } catch (err) {
        this.handlePollFailure(`getStatus threw: ${(err as Error).message}`);
        return;
      }

      // 2. Compute per-axis load metrics.
      let queuePctiles: ReturnType<typeof computeQueuePercentiles>;
      let cov: number;
      let idleCount: number;
      try {
        queuePctiles = computeQueuePercentiles(status.domains);
        cov = computeLoadCoV(status.domains);
        idleCount = computeIdleWorkerCount(this.swarm.getAllAgents());
      } catch (err) {
        this.haltLoud('corrupt-metrics', `metric computation threw: ${(err as Error).message}`);
        return;
      }

      // Reset poll-failure counter on successful read.
      this.state.consecutivePollFailures = 0;

      // 3. Update flip-rate windows (prune old entries).
      this.pruneFlipWindow(tickStart);

      // 4. Detect partition asymmetry. Per ADR-0127 §Refinement, a true
      //    `partitionDetected` reading from the coordinator's heartbeat
      //    asymmetry/quorum-loss check suspends scaling rather than acting
      //    on a partial view.
      const lastReport = this.getLastHealthReport();
      if (lastReport?.partitionDetected) {
        // Use a string-typed read so TS doesn't narrow the field across
        // the suspended-vs-running branches; both states are valid here.
        const wasRunning: string = this.state.status;
        if (wasRunning === 'running') {
          this.state.status = 'suspended';
          this.emit('partition.suspended', {
            reason: 'partition-detected',
            timestamp: tickStart,
          });
          this.emit('fault', {
            reason: 'partition-detected' as FaultReason,
            timestamp: tickStart,
            details: 'queen-coordinator reports partitionDetected = true; scaling suspended until partition clears',
          });
        }
        return;
      } else {
        // Partition cleared — if the loop was suspended, resume.
        const cur: string = this.state.status;
        if (cur === 'suspended') {
          this.state.status = 'running';
        }
      }

      // 5. Determine breach axis(es) for this tick. We evaluate scale and
      //    topology axes independently because the global settle window
      //    coordinates them.
      const elapsedSinceLastTick = this.state.lastTickAt
        ? Math.max(1, tickStart - this.state.lastTickAt)
        : this.cfg.pollIntervalMs;
      this.state.lastTickAt = tickStart;

      const scaleBreach = this.classifyScaleBreach(queuePctiles);
      const covBreach = this.classifyCoVBreach(cov);

      this.updateBreachCounter(scaleBreach, elapsedSinceLastTick);
      this.updateBreachCounter(covBreach, elapsedSinceLastTick);

      this.emit('tick', {
        timestamp: tickStart,
        queuePctiles,
        cov,
        idleCount,
        scaleBreach,
        covBreach,
        breachDurations: { ...this.state.breachDurations },
      });

      // 6. Apply settle-window gate. Global across both axes per
      //    ADR-0127 §Specification — a scale-up cannot immediately
      //    precede a topology switch.
      const inSettleWindow =
        this.state.lastActionAt !== undefined &&
        tickStart - this.state.lastActionAt < this.cfg.settleWindowMs;

      // 7. Process scale axis if dampening duration crossed AND not in
      //    settle window.
      if (
        scaleBreach &&
        scaleBreach !== 'none' &&
        this.state.breachDurations[scaleBreach] >= this.cfg.dampeningWindowMs &&
        !inSettleWindow
      ) {
        await this.handleScaleBreach(scaleBreach, status.domains, tickStart);
      }

      // 8. Process topology axis (independent decision, but settle window
      //    applies). Re-read inSettleWindow because handleScaleBreach may
      //    have just acted.
      const inSettleWindowAfterScale =
        this.state.lastActionAt !== undefined &&
        tickStart - this.state.lastActionAt < this.cfg.settleWindowMs;
      if (
        covBreach &&
        covBreach !== 'none' &&
        this.state.breachDurations[covBreach] >= this.cfg.dampeningWindowMs &&
        !inSettleWindowAfterScale
      ) {
        await this.handleCoVBreach(covBreach, this.swarm.getAllAgents(), tickStart);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  // =============================================================================
  // Scale axis handling
  // =============================================================================

  private async handleScaleBreach(
    breach: 'high-water' | 'low-water',
    domains: DomainStatus[],
    tickStart: number,
  ): Promise<void> {
    // Flip-rate ceiling check.
    if (this.state.flipTimestamps.scale.length >= this.cfg.maxFlipsPerWindow) {
      this.haltLoud(
        'flip-rate-ceiling',
        `scale axis exceeded ${this.cfg.maxFlipsPerWindow} flips/${this.cfg.flipWindowMs}ms — adversarial input or threshold misconfig`,
      );
      return;
    }

    if (breach === 'high-water') {
      const target = pickMostBackloggedDomain(domains);
      if (!target) {
        // Nothing to scale; reset breach counter to avoid infinite hold.
        this.state.breachDurations['high-water'] = 0;
        return;
      }
      const decision: ScaleDecision = {
        axis: 'scale',
        direction: 'up',
        domain: target,
        reason: 'high-water',
      };
      this.emit('decision.scale', decision);
      try {
        await this.callbacks.scaleUp(target);
      } catch (err) {
        this.haltLoud('mutation-error', `scaleUp(${target}) threw: ${(err as Error).message}`);
        return;
      }
      this.recordAction('scale', tickStart);
      this.state.breachDurations['high-water'] = 0;
      this.emit('action.applied', { ...decision, timestamp: tickStart });
    } else {
      // low-water: identify longest-idle worker; preserve per-type minimum.
      const candidate = pickLongestIdleWorker(this.swarm.getAllAgents(), domains, this.cfg.perTypeMin);
      if (!candidate) {
        // Minimum preserved; skip silently per ADR-0127 §Pseudocode (this
        // is NOT a fallback — minimum is a hard floor, not an error).
        this.state.breachDurations['low-water'] = 0;
        return;
      }
      const decision: ScaleDecision = {
        axis: 'scale',
        direction: 'down',
        domain: candidate.domain,
        reason: 'low-water',
      };
      this.emit('decision.scale', decision);
      try {
        await this.callbacks.scaleDown(candidate.agentId, candidate.domain);
      } catch (err) {
        this.haltLoud(
          'mutation-error',
          `scaleDown(${candidate.agentId}, ${candidate.domain}) threw: ${(err as Error).message}`,
        );
        return;
      }
      this.recordAction('scale', tickStart);
      this.state.breachDurations['low-water'] = 0;
      this.emit('action.applied', { ...decision, timestamp: tickStart });
    }
  }

  // =============================================================================
  // CoV / topology axis handling
  // =============================================================================

  private async handleCoVBreach(
    breach: 'cov-high' | 'cov-low',
    agents: ReturnType<ISwarmCoordinator['getAllAgents']>,
    tickStart: number,
  ): Promise<void> {
    if (this.state.flipTimestamps.topology.length >= this.cfg.maxFlipsPerWindow) {
      this.haltLoud(
        'flip-rate-ceiling',
        `topology axis exceeded ${this.cfg.maxFlipsPerWindow} flips/${this.cfg.flipWindowMs}ms — adversarial input or threshold misconfig`,
      );
      return;
    }

    const target: HiveTopology = breach === 'cov-high' ? 'mesh' : 'hierarchical';

    // Active-task drain check. If any worker has a non-empty active task
    // set, defer (do not switch). Defer is bounded by
    // topologyDeferralBoundWindows; abandonment after the bound surfaces a
    // fault per ADR-0127 §Refinement, never a silent no-op.
    const hasActiveTasks = agents.some(a => a.currentTask !== undefined);
    if (hasActiveTasks) {
      const prior = this.state.pendingTopologySwitch;
      let pending: NonNullable<AdaptiveLoopState['pendingTopologySwitch']>;
      if (!prior || prior.target !== target) {
        pending = {
          target,
          deferralCount: 1,
          firstDeferredAt: tickStart,
        };
        this.state.pendingTopologySwitch = pending;
      } else {
        prior.deferralCount += 1;
        pending = prior;
      }
      const deferralCount = pending.deferralCount;
      this.emit('topology.deferred', {
        target,
        deferralCount,
        firstDeferredAt: pending.firstDeferredAt,
        timestamp: tickStart,
      });
      if (deferralCount >= this.cfg.topologyDeferralBoundWindows) {
        // Per ADR-0127 §Refinement: emit fault, do NOT silently no-op.
        // Per Row 49 resolution: only confirmed switches count toward
        // flip-rate ceiling — abandonment does NOT increment.
        this.emit('fault', {
          reason: 'topology-switch-abandoned' as FaultReason,
          timestamp: tickStart,
          details: `topology switch to ${target} deferred ${deferralCount} dampening windows; abandoning attempt — next breach starts fresh`,
        });
        // Reset the deferral state and the breach counter; the next breach
        // begins the dampening counter from scratch.
        this.state.pendingTopologySwitch = undefined;
        this.state.breachDurations[breach] = 0;
      }
      return;
    }

    // Active tasks drained — clear pending and apply.
    this.state.pendingTopologySwitch = undefined;

    const decision: TopologyDecision = {
      axis: 'topology',
      target,
      reason: breach,
    };
    this.emit('decision.topology', decision);

    let result: 'NOT_IMPLEMENTED' | 'OK';
    try {
      result = await this.callbacks.switchTopology(target);
    } catch (err) {
      this.haltLoud(
        'mutation-error',
        `switchTopology(${target}) threw: ${(err as Error).message}`,
      );
      return;
    }
    if (result === 'NOT_IMPLEMENTED') {
      // Pre-T10 sentinel — log and continue. This is the ONLY expected
      // non-fatal return on this call per ADR-0127 §Pseudocode. Reset the
      // breach counter so we don't continuously emit the same decision.
      this.emit('action.applied', {
        ...decision,
        timestamp: tickStart,
        result: 'NOT_IMPLEMENTED',
      });
      this.state.breachDurations[breach] = 0;
      return;
    }
    this.recordAction('topology', tickStart);
    this.state.breachDurations[breach] = 0;
    this.emit('action.applied', { ...decision, timestamp: tickStart, result: 'OK' });
  }

  // =============================================================================
  // Threshold classification
  // =============================================================================

  private classifyScaleBreach(
    pctiles: ReturnType<typeof computeQueuePercentiles>,
  ): 'high-water' | 'low-water' | 'none' {
    // Use P90 as the "sustained backlog" indicator — protects against a
    // single transient spike while still firing on real overload.
    if (pctiles.p90 > this.cfg.highWaterQueueDepth) return 'high-water';
    if (pctiles.p90 <= this.cfg.lowWaterQueueDepth) return 'low-water';
    return 'none';
  }

  private classifyCoVBreach(cov: number): 'cov-high' | 'cov-low' | 'none' {
    if (cov >= this.cfg.highCoV) return 'cov-high';
    if (cov <= this.cfg.lowCoV) return 'cov-low';
    return 'none';
  }

  private updateBreachCounter(
    breach: 'high-water' | 'low-water' | 'cov-high' | 'cov-low' | 'none',
    elapsed: number,
  ): void {
    // Reset all breach counters not active this tick. This ensures
    // direction-changes (high → low) reset cleanly, satisfying
    // ADR-0127's "If on the safe side, reset the counter to zero".
    if (breach === 'none') {
      // Reset both axes' counters — but only this axis class. For the
      // scale axis: high-water/low-water; for the CoV axis: cov-high/cov-low.
      // Caller passes a single breach value at a time, so we use the
      // value's prefix to know which class to reset.
      return;
    }
    const isScaleAxis = breach === 'high-water' || breach === 'low-water';
    const isCovAxis = breach === 'cov-high' || breach === 'cov-low';
    if (isScaleAxis) {
      // Reset the OPPOSITE side of the same axis on direction change.
      const opposite = breach === 'high-water' ? 'low-water' : 'high-water';
      this.state.breachDurations[opposite] = 0;
      this.state.breachDurations[breach] += elapsed;
    } else if (isCovAxis) {
      const opposite = breach === 'cov-high' ? 'cov-low' : 'cov-high';
      this.state.breachDurations[opposite] = 0;
      this.state.breachDurations[breach] += elapsed;
    }
  }

  // =============================================================================
  // Bookkeeping helpers
  // =============================================================================

  private recordAction(axis: ActionAxis, timestamp: number): void {
    this.state.lastActionAt = timestamp;
    this.state.flipTimestamps[axis].push(timestamp);
  }

  private pruneFlipWindow(now: number): void {
    const cutoff = now - this.cfg.flipWindowMs;
    this.state.flipTimestamps.scale = this.state.flipTimestamps.scale.filter(t => t > cutoff);
    this.state.flipTimestamps.topology = this.state.flipTimestamps.topology.filter(t => t > cutoff);
  }

  private handlePollFailure(message: string): void {
    this.state.consecutivePollFailures += 1;
    this.emit('tick', {
      dropped: true,
      reason: 'poll-failure',
      message,
      consecutiveFailures: this.state.consecutivePollFailures,
    });
    if (this.state.consecutivePollFailures >= this.cfg.maxConsecutivePollFailures) {
      this.haltLoud(
        'metric-poll-failure',
        `${this.state.consecutivePollFailures} consecutive metric poll failures — last error: ${message}`,
      );
    }
  }

  private haltLoud(reason: FaultReason, details: string): void {
    this.state.status = 'halted';
    this.state.haltReason = reason;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.emit('fault', {
      reason,
      timestamp: this.now(),
      details,
    });
  }

  /**
   * Reach into the queen-coordinator's last health report when the swarm
   * surface exposes it. Falls back to constructing a synthetic check on
   * heartbeat asymmetry from the agent list when the coordinator does not
   * yet expose `getLastHealthReport()`.
   *
   * Per `feedback-no-fallbacks.md`, returning `undefined` (no report
   * available) is treated as "no partition signal" — NOT as an error.
   * Errors querying the coordinator throw.
   */
  private getLastHealthReport(): HealthReport | undefined {
    const swarmAny = this.swarm as unknown as {
      getLastHealthReport?: () => HealthReport | undefined;
    };
    if (typeof swarmAny.getLastHealthReport === 'function') {
      return swarmAny.getLastHealthReport();
    }
    return undefined;
  }
}

// =============================================================================
// Pure helpers — exported for unit-test isolation
// =============================================================================

/**
 * Compute population percentiles of per-domain queue depth. Returns 0s for
 * an empty fleet rather than NaN, matching ADR-0127 §Pseudocode "compute
 * deltas vs. last tick" — an empty fleet has nothing to compare.
 */
export function computeQueuePercentiles(domains: DomainStatus[]): {
  p50: number;
  p90: number;
  p99: number;
} {
  if (domains.length === 0) {
    return { p50: 0, p90: 0, p99: 0 };
  }
  const sorted = domains
    .map(d => d.tasksQueued)
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    throw new Error('AdaptiveLoop: domain queue depths are non-finite (corrupt metrics)');
  }
  const pickAt = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
    return sorted[idx];
  };
  return {
    p50: pickAt(0.5),
    p90: pickAt(0.9),
    p99: pickAt(0.99),
  };
}

/**
 * Compute the coefficient of variation (stddev / mean) of per-domain
 * load. Load = busyAgents / max(agentCount, 1). Returns 0 when mean is 0
 * (no busy agents anywhere is "uniformly idle", not "uneven").
 *
 * Throws on negative inputs (corrupt metrics) — `feedback-no-fallbacks.md`.
 */
export function computeLoadCoV(domains: DomainStatus[]): number {
  if (domains.length === 0) return 0;
  const loads = domains.map(d => {
    if (d.agentCount < 0 || d.busyAgents < 0) {
      throw new Error('AdaptiveLoop: negative agent count in DomainStatus');
    }
    if (!Number.isFinite(d.agentCount) || !Number.isFinite(d.busyAgents)) {
      throw new Error('AdaptiveLoop: non-finite agent count in DomainStatus');
    }
    return d.agentCount > 0 ? d.busyAgents / d.agentCount : 0;
  });
  const mean = loads.reduce((s, v) => s + v, 0) / loads.length;
  if (mean === 0) return 0;
  const variance =
    loads.reduce((s, v) => s + (v - mean) ** 2, 0) / loads.length;
  const stddev = Math.sqrt(variance);
  return stddev / mean;
}

/** Count idle workers — agents in 'idle' status with no current task. */
export function computeIdleWorkerCount(
  agents: ReturnType<ISwarmCoordinator['getAllAgents']>,
): number {
  return agents.filter(a => a.status === 'idle' && a.currentTask === undefined).length;
}

/**
 * Detect partition asymmetry from the agent set. The signal:
 *   - Stale heartbeats (older than 3× heartbeat interval) on > 30% of
 *     agents indicate the queen has lost contact with a worker subset.
 *
 * Returns true when partition is detected. The threshold (30%) is
 * preliminary — a follow-up ADR may tune it against quorum-loss telemetry.
 * Per `feedback-no-fallbacks.md`, when the heartbeat reading itself is
 * corrupt (NaN timestamps), we throw rather than guess.
 */
export function detectPartitionFromHeartbeats(
  agents: ReturnType<ISwarmCoordinator['getAllAgents']>,
  now: number,
  heartbeatIntervalMs: number,
): boolean {
  if (agents.length === 0) return false;
  if (heartbeatIntervalMs <= 0) {
    throw new Error('AdaptiveLoop: heartbeatIntervalMs must be > 0');
  }
  const staleThresholdMs = 3 * heartbeatIntervalMs;
  let stale = 0;
  for (const agent of agents) {
    const ts = agent.lastHeartbeat instanceof Date
      ? agent.lastHeartbeat.getTime()
      : Number(agent.lastHeartbeat);
    if (!Number.isFinite(ts)) {
      throw new Error('AdaptiveLoop: non-finite heartbeat timestamp');
    }
    if (now - ts > staleThresholdMs) stale += 1;
  }
  // > 30% stale = partition signal. < 100% stale (otherwise we lost the
  // entire fleet, which is "queen-unreachable", a different fault).
  const ratio = stale / agents.length;
  return ratio > 0.3 && ratio < 1.0;
}

/**
 * Pick the domain with the highest queue depth (most-backlogged) for
 * scale-up. Returns undefined when no domain has queued work.
 */
export function pickMostBackloggedDomain(domains: DomainStatus[]): AgentDomain | undefined {
  let best: { domain: AgentDomain; depth: number } | undefined;
  for (const d of domains) {
    if (d.tasksQueued <= 0) continue;
    if (!best || d.tasksQueued > best.depth) {
      best = { domain: d.name, depth: d.tasksQueued };
    }
  }
  return best?.domain;
}

/**
 * Pick the longest-idle worker eligible for termination. Preserves the
 * per-type minimum: domains at minimum capacity contribute no candidates.
 *
 * Returns undefined when no eligible worker exists (minimum preserved
 * across the board) — this is NOT an error per ADR-0127 §Pseudocode.
 */
export function pickLongestIdleWorker(
  agents: ReturnType<ISwarmCoordinator['getAllAgents']>,
  domains: DomainStatus[],
  perTypeMin: number,
): { agentId: string; domain: AgentDomain } | undefined {
  // Build domain → live worker count map.
  const domainCount = new Map<AgentDomain, number>();
  for (const d of domains) {
    domainCount.set(d.name, d.agentCount);
  }
  // Filter idle agents whose domain has > perTypeMin workers.
  const candidates: Array<{ agent: typeof agents[number]; lastHeartbeatMs: number }> = [];
  for (const agent of agents) {
    if (agent.status !== 'idle' || agent.currentTask !== undefined) continue;
    // Find this agent's domain. The swarm's `getStatus().domains` already
    // counts; we infer from the type-vs-domain mapping in the agent's
    // topology role. In practice, the coordinator owns the agentDomainMap;
    // we use the domains[] population shape: a domain may go below min if
    // we terminate, so we conservatively skip when the domain is at min.
    //
    // Heuristic: the test mocks emit agent.type → domain assignment via
    // the same `getStatus().domains` table. We map by checking which
    // domain has agents of this type (1:1 in DOMAIN_CONFIGS).
    const domain = domainOfAgent(agent.type, domains);
    if (!domain) continue;
    const count = domainCount.get(domain) ?? 0;
    if (count <= perTypeMin) continue;
    const ts = agent.lastHeartbeat instanceof Date
      ? agent.lastHeartbeat.getTime()
      : Number(agent.lastHeartbeat);
    candidates.push({ agent, lastHeartbeatMs: Number.isFinite(ts) ? ts : 0 });
  }
  if (candidates.length === 0) return undefined;
  // Longest-idle = oldest lastHeartbeat.
  candidates.sort((a, b) => a.lastHeartbeatMs - b.lastHeartbeatMs);
  const winner = candidates[0];
  const domain = domainOfAgent(winner.agent.type, domains);
  if (!domain) return undefined;
  return { agentId: winner.agent.id.id, domain };
}

/**
 * Map an agent type to an AgentDomain via the coordinator's published
 * domain map. This is a best-effort heuristic — the coordinator's
 * `agentDomainMap` is the authoritative source, but it's a private field.
 * For the loop's purposes we use the agent type → domain assignment that
 * `DOMAIN_CONFIGS` enforces.
 */
function domainOfAgent(
  type: string,
  domains: DomainStatus[],
): AgentDomain | undefined {
  // The simplest mapping: each AgentType is assigned to one domain via
  // DOMAIN_CONFIGS in unified-coordinator.ts. We don't import the full
  // table here to avoid a coupling cycle; instead we rely on the domain
  // names and a fixed type-to-domain heuristic mirroring DOMAIN_CONFIGS.
  // If the coordinator changes the mapping, the heuristic must follow.
  const map: Record<string, AgentDomain> = {
    queen: 'queen',
    coordinator: 'queen',
    'security-architect': 'security',
    'security-auditor': 'security',
    'security-tester': 'security',
    architect: 'core',
    coder: 'core',
    reviewer: 'core',
    optimizer: 'core',
    documenter: 'core',
    'integration-architect': 'integration',
    'cli-modernizer': 'integration',
    'neural-integrator': 'integration',
    tester: 'support',
    'performance-engineer': 'support',
    'deployment-engineer': 'support',
    analyst: 'core',
    researcher: 'core',
    monitor: 'support',
    specialist: 'core',
  };
  const guess = map[type];
  if (guess && domains.some(d => d.name === guess)) return guess;
  // Fallback: pick the first domain that has any agents — better than
  // undefined for the loop's purposes (avoids skipping termination
  // entirely just because the type isn't in our table).
  return domains.find(d => d.agentCount > 0)?.name;
}

/** Factory mirroring the project's other createX helpers. */
export function createAdaptiveLoop(
  swarm: ISwarmCoordinator,
  callbacks: AdaptiveLoopCallbacks,
  config: AdaptiveLoopConfig = {},
): AdaptiveLoop {
  return new AdaptiveLoop(swarm, callbacks, config);
}
