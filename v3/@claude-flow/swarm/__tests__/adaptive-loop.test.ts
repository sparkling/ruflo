/**
 * ADR-0127 (T9) — Adaptive autoscaling control loop tests.
 *
 * Covers the full §Validation matrix:
 *   Unit tests:
 *     - dampening-predicate
 *     - threshold-math edge cases
 *     - health-report-delta correctness
 *     - flip-rate-ceiling sliding window
 *     - abandoned-switch-surfaces (fault, not silence)
 *
 *   Integration tests:
 *     - oscillation-flap (zero actions across the flap window)
 *     - sustained-scale-up (exactly one spawn after dampening)
 *     - sustained-scale-down (exactly one terminate, never below per-type min)
 *     - topology-switch (cov-high → mesh decision; pre-T10 NOT_IMPLEMENTED OK)
 *     - adversarial-flip-rate (4 flips → halt loud)
 *     - partition-asymmetric (loop suspends scaling, surfaces fault)
 *
 * London-school style: every external dep mocked. The loop's pure helpers
 * are exported so percentile/CoV/idle math is testable in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AdaptiveLoop,
  createAdaptiveLoop,
  computeQueuePercentiles,
  computeLoadCoV,
  computeIdleWorkerCount,
  detectPartitionFromHeartbeats,
  pickMostBackloggedDomain,
  pickLongestIdleWorker,
  ADAPTIVE_LOOP_DEFAULTS,
  type AdaptiveLoopCallbacks,
  type AdaptiveDecision,
} from '../src/adaptive-loop.js';
import type { ISwarmCoordinator, HealthReport } from '../src/queen-coordinator.js';
import type { AgentDomain, DomainStatus } from '../src/unified-coordinator.js';
import type { AgentState, AgentType, AgentMetrics, AgentCapabilities } from '../src/types.js';

// =============================================================================
// Mock factories
// =============================================================================

function mkAgent(
  id: string,
  type: AgentType,
  status: AgentState['status'] = 'idle',
  lastHeartbeat: Date = new Date(),
  hasCurrentTask = false,
): AgentState {
  return {
    id: { id, swarmId: 'swarm', type, instance: 1 },
    name: `agent-${id}`,
    type,
    status,
    capabilities: {} as AgentCapabilities,
    metrics: {} as AgentMetrics,
    workload: status === 'busy' ? 0.8 : 0,
    health: 1,
    lastHeartbeat,
    topologyRole: 'worker',
    connections: [],
    currentTask: hasCurrentTask
      ? { id: 't', swarmId: 'swarm', sequence: 1, priority: 'normal' }
      : undefined,
  };
}

function mkDomain(
  name: AgentDomain,
  agentCount: number,
  busyAgents = 0,
  tasksQueued = 0,
): DomainStatus {
  return {
    name,
    agentCount,
    availableAgents: agentCount - busyAgents,
    busyAgents,
    tasksQueued,
    tasksCompleted: 0,
  };
}

function mkSwarm(
  agents: AgentState[] = [],
  domains: DomainStatus[] = [],
  lastHealth?: Partial<HealthReport>,
): ISwarmCoordinator & { getLastHealthReport?: () => HealthReport | undefined } {
  return {
    getAgentsByDomain: vi.fn().mockReturnValue([]),
    getAllAgents: vi.fn().mockReturnValue(agents),
    getAvailableAgents: vi.fn().mockReturnValue(agents.filter(a => a.status === 'idle')),
    getMetrics: vi.fn().mockReturnValue({
      uptime: 0, activeAgents: 0, totalTasks: 0, completedTasks: 0, failedTasks: 0,
      avgTaskDurationMs: 0, messagesPerSecond: 0, consensusSuccessRate: 0,
      coordinationLatencyMs: 0, memoryUsageBytes: 0,
    }),
    getDomainConfigs: vi.fn().mockReturnValue(new Map()),
    getStatus: vi.fn().mockReturnValue({
      domains,
      metrics: {
        uptime: 0, activeAgents: 0, totalTasks: 0, completedTasks: 0, failedTasks: 0,
        avgTaskDurationMs: 0, messagesPerSecond: 0, consensusSuccessRate: 0,
        coordinationLatencyMs: 0, memoryUsageBytes: 0,
      },
    }),
    assignTaskToDomain: vi.fn().mockResolvedValue('agent_1'),
    proposeConsensus: vi.fn().mockResolvedValue({}),
    broadcastMessage: vi.fn().mockResolvedValue(undefined),
    ...(lastHealth ? { getLastHealthReport: () => ({ ...mkHealthReport(), ...lastHealth }) as HealthReport } : {}),
  };
}

function mkHealthReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    reportId: 'r1',
    timestamp: new Date(),
    overallHealth: 1,
    domainHealth: new Map(),
    agentHealth: [],
    bottlenecks: [],
    alerts: [],
    metrics: {} as any,
    recommendations: [],
    partitionDetected: false,
    queueDepthP50: 0,
    queueDepthP90: 0,
    queueDepthP99: 0,
    idleWorkerCount: 0,
    loadCoV: 0,
    breachedThreshold: 'none',
    breachDurationMs: 0,
    pollTimestamp: 0,
    flipsInWindow: { scale: 0, topology: 0 },
    ...overrides,
  };
}

function mkCallbacks(overrides: Partial<AdaptiveLoopCallbacks> = {}): AdaptiveLoopCallbacks {
  return {
    scaleUp: vi.fn().mockResolvedValue(undefined),
    scaleDown: vi.fn().mockResolvedValue(undefined),
    switchTopology: vi.fn().mockResolvedValue('OK' as const),
    ...overrides,
  };
}

// =============================================================================
// Pure helper tests — math + classification + selection
// =============================================================================

describe('AdaptiveLoop helpers — threshold math', () => {
  it('queue percentiles on empty fleet are zero', () => {
    expect(computeQueuePercentiles([])).toEqual({ p50: 0, p90: 0, p99: 0 });
  });

  it('queue percentiles compute monotonic p50 ≤ p90 ≤ p99', () => {
    const r = computeQueuePercentiles([
      mkDomain('queen', 1, 0, 0),
      mkDomain('security', 3, 0, 1),
      mkDomain('core', 5, 0, 5),
      mkDomain('integration', 3, 0, 10),
      mkDomain('support', 3, 0, 12),
    ]);
    expect(r.p50).toBeLessThanOrEqual(r.p90);
    expect(r.p90).toBeLessThanOrEqual(r.p99);
  });

  it('non-finite queue depths throw loud', () => {
    expect(() => computeQueuePercentiles([
      { ...mkDomain('core', 1, 0, 0), tasksQueued: NaN },
    ])).toThrow(/non-finite/);
  });

  it('load CoV is 0 for uniformly-idle fleet', () => {
    expect(computeLoadCoV([
      mkDomain('queen', 1, 0, 0),
      mkDomain('core', 3, 0, 0),
    ])).toBe(0);
  });

  it('load CoV is high when one domain saturated and others idle', () => {
    const cov = computeLoadCoV([
      mkDomain('queen', 1, 1, 0),    // load = 1.0
      mkDomain('security', 3, 0, 0), // load = 0
      mkDomain('core', 5, 0, 0),     // load = 0
    ]);
    expect(cov).toBeGreaterThan(0.6);
  });

  it('load CoV throws on negative agent count', () => {
    expect(() => computeLoadCoV([
      { ...mkDomain('core', -1, 0, 0) },
    ])).toThrow(/negative/);
  });

  it('idle worker count excludes busy + with-task agents', () => {
    const agents = [
      mkAgent('a1', 'coder', 'idle'),
      mkAgent('a2', 'coder', 'busy'),
      mkAgent('a3', 'coder', 'idle', new Date(), true),
    ];
    expect(computeIdleWorkerCount(agents)).toBe(1);
  });

  it('partition detection triggers when >30% of workers have stale heartbeats', () => {
    const now = 1_000_000;
    const stale = new Date(now - 100_000);
    const fresh = new Date(now);
    const agents = [
      mkAgent('a1', 'coder', 'idle', stale),
      mkAgent('a2', 'coder', 'idle', stale),
      mkAgent('a3', 'coder', 'idle', fresh),
      mkAgent('a4', 'coder', 'idle', fresh),
    ];
    expect(detectPartitionFromHeartbeats(agents, now, 5_000)).toBe(true);
  });

  it('partition detection returns false when 100% stale (queen-unreachable, different fault)', () => {
    const now = 1_000_000;
    const stale = new Date(now - 100_000);
    const agents = [
      mkAgent('a1', 'coder', 'idle', stale),
      mkAgent('a2', 'coder', 'idle', stale),
    ];
    expect(detectPartitionFromHeartbeats(agents, now, 5_000)).toBe(false);
  });

  it('partition detection throws on non-finite heartbeat', () => {
    const a = mkAgent('a1', 'coder', 'idle');
    a.lastHeartbeat = new Date(NaN);
    expect(() => detectPartitionFromHeartbeats([a], 0, 5_000)).toThrow(/non-finite/);
  });

  it('pickMostBackloggedDomain returns the deepest queue', () => {
    expect(
      pickMostBackloggedDomain([
        mkDomain('core', 5, 0, 4),
        mkDomain('integration', 3, 0, 9),
        mkDomain('support', 3, 0, 1),
      ]),
    ).toBe('integration');
  });

  it('pickLongestIdleWorker preserves perTypeMin', () => {
    const agents = [mkAgent('a1', 'coder', 'idle', new Date(0))];
    const domains = [mkDomain('core', 1, 0, 0)];
    expect(pickLongestIdleWorker(agents, domains, 1)).toBeUndefined();
  });

  it('pickLongestIdleWorker returns oldest heartbeat when above min', () => {
    const oldest = new Date(0);
    const newer = new Date(10_000);
    const agents = [
      mkAgent('a1', 'coder', 'idle', newer),
      mkAgent('a2', 'coder', 'idle', oldest),
    ];
    const domains = [mkDomain('core', 5, 0, 0)];
    const r = pickLongestIdleWorker(agents, domains, 1);
    expect(r?.agentId).toBe('a2');
  });
});

// =============================================================================
// Constructor / config validation tests
// =============================================================================

describe('AdaptiveLoop construction / config validation', () => {
  it('default config matches ADAPTIVE_LOOP_DEFAULTS', () => {
    const loop = createAdaptiveLoop(mkSwarm(), mkCallbacks());
    expect(ADAPTIVE_LOOP_DEFAULTS.pollIntervalMs).toBe(5000);
    expect(ADAPTIVE_LOOP_DEFAULTS.maxFlipsPerWindow).toBe(4);
    expect(loop.getState().status).toBe('idle');
  });

  it('rejects pollIntervalMs <= 0', () => {
    expect(() => createAdaptiveLoop(mkSwarm(), mkCallbacks(), { pollIntervalMs: 0 }))
      .toThrow(/pollIntervalMs/);
  });

  it('rejects dampening < poll', () => {
    expect(() => createAdaptiveLoop(mkSwarm(), mkCallbacks(), {
      pollIntervalMs: 100, dampeningWindowMs: 50,
    })).toThrow(/dampeningWindowMs/);
  });

  it('rejects highWaterQueueDepth <= lowWaterQueueDepth (no hysteresis gap)', () => {
    expect(() => createAdaptiveLoop(mkSwarm(), mkCallbacks(), {
      highWaterQueueDepth: 1, lowWaterQueueDepth: 1,
    })).toThrow(/hysteresis/);
  });

  it('rejects highCoV <= lowCoV', () => {
    expect(() => createAdaptiveLoop(mkSwarm(), mkCallbacks(), {
      highCoV: 0.3, lowCoV: 0.6,
    })).toThrow(/hysteresis/);
  });

  it('rejects perTypeMin < 1', () => {
    expect(() => createAdaptiveLoop(mkSwarm(), mkCallbacks(), { perTypeMin: 0 }))
      .toThrow(/perTypeMin/);
  });
});

// =============================================================================
// Dampening predicate tests
// =============================================================================

describe('AdaptiveLoop dampening — threshold + duration', () => {
  it('threshold crossing under dampening duration produces zero actions', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('core', 5, 0, 10)]), // p90 > highWater (3)
      callbacks,
      {
        pollIntervalMs: 1000,
        dampeningWindowMs: 5000,
        settleWindowMs: 5000,
        now: () => now,
      },
    );
    loop.start();
    // Tick 4 times — 4000ms < 5000ms dampening
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(callbacks.scaleUp).not.toHaveBeenCalled();
    loop.stop();
  });

  it('sustained crossing for full dampening produces exactly one action', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('core', 5, 0, 10)]),
      callbacks,
      {
        pollIntervalMs: 1000,
        dampeningWindowMs: 3000,
        settleWindowMs: 10000,
        now: () => now,
      },
    );
    loop.start();
    // 4 ticks — 3000+ accumulated breach duration; settle window prevents
    // a second action within 10000ms.
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(callbacks.scaleUp).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('flap below + above threshold (oscillation) produces zero actions', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    // Each tick we flip the queue depth from 0 to 10 and back.
    let high = true;
    const swarm = mkSwarm();
    (swarm.getStatus as any) = vi.fn(() => ({
      domains: [mkDomain('core', 5, 0, high ? 10 : 0)],
      metrics: {} as any,
    }));
    const loop = createAdaptiveLoop(swarm, callbacks, {
      pollIntervalMs: 1000,
      dampeningWindowMs: 5000,
      settleWindowMs: 5000,
      now: () => now,
    });
    loop.start();
    for (let i = 0; i < 20; i++) {
      now += 1000;
      high = !high;
      await loop.tickOnce();
    }
    expect(callbacks.scaleUp).not.toHaveBeenCalled();
    expect(callbacks.scaleDown).not.toHaveBeenCalled();
    loop.stop();
  });
});

// =============================================================================
// Scale-up / scale-down behaviour
// =============================================================================

describe('AdaptiveLoop scale axis', () => {
  it('scale-up fires once after dampening with most-backlogged domain', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('integration', 3, 0, 15), mkDomain('core', 5, 0, 4)]),
      callbacks,
      {
        pollIntervalMs: 1000, dampeningWindowMs: 2000, settleWindowMs: 100000,
        now: () => now,
      },
    );
    loop.start();
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(callbacks.scaleUp).toHaveBeenCalledTimes(1);
    expect(callbacks.scaleUp).toHaveBeenCalledWith('integration');
    loop.stop();
  });

  it('scale-down does not fire below per-type minimum', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const idleAgent = mkAgent('a1', 'coder', 'idle', new Date(0));
    // Domain has only 1 agent → below perTypeMin=1 termination is forbidden
    const loop = createAdaptiveLoop(
      mkSwarm([idleAgent], [mkDomain('core', 1, 0, 0)]),
      callbacks,
      {
        pollIntervalMs: 1000, dampeningWindowMs: 2000, settleWindowMs: 10000,
        perTypeMin: 1, now: () => now,
      },
    );
    loop.start();
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(callbacks.scaleDown).not.toHaveBeenCalled();
    loop.stop();
  });

  it('scale-down picks oldest-heartbeat idle worker above per-type min', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const idle1 = mkAgent('a1', 'coder', 'idle', new Date(10_000));
    const idle2 = mkAgent('a2', 'coder', 'idle', new Date(0)); // older
    const loop = createAdaptiveLoop(
      mkSwarm([idle1, idle2], [mkDomain('core', 5, 0, 0)]),
      callbacks,
      {
        pollIntervalMs: 1000, dampeningWindowMs: 2000, settleWindowMs: 10000,
        perTypeMin: 1, now: () => now,
      },
    );
    loop.start();
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(callbacks.scaleDown).toHaveBeenCalledTimes(1);
    expect(callbacks.scaleDown).toHaveBeenCalledWith('a2', 'core');
    loop.stop();
  });
});

// =============================================================================
// Topology axis behaviour
// =============================================================================

describe('AdaptiveLoop topology axis', () => {
  it('cov-high emits topology decision targeting mesh after dampening', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const decisions: AdaptiveDecision[] = [];
    const loop = createAdaptiveLoop(
      mkSwarm([], [
        mkDomain('queen', 1, 1, 0),
        mkDomain('core', 5, 0, 0),
      ]),
      callbacks,
      {
        pollIntervalMs: 1000, dampeningWindowMs: 2000, settleWindowMs: 10000,
        now: () => now,
      },
    );
    loop.on('decision.topology', d => decisions.push(d));
    loop.start();
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(callbacks.switchTopology).toHaveBeenCalledTimes(1);
    expect(callbacks.switchTopology).toHaveBeenCalledWith('mesh');
    expect(decisions.some(d => d.axis === 'topology' && (d as any).target === 'mesh')).toBe(true);
    loop.stop();
  });

  it('topology switch defers when active tasks present', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const busy = mkAgent('a1', 'coder', 'busy', new Date(), true);
    const loop = createAdaptiveLoop(
      mkSwarm([busy], [mkDomain('queen', 1, 1, 0), mkDomain('core', 5, 0, 0)]),
      callbacks,
      {
        pollIntervalMs: 1000, dampeningWindowMs: 2000, settleWindowMs: 10000,
        topologyDeferralBoundWindows: 100, // never abandon during this test
        now: () => now,
      },
    );
    const deferrals: any[] = [];
    loop.on('topology.deferred', d => deferrals.push(d));
    loop.start();
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(callbacks.switchTopology).not.toHaveBeenCalled();
    expect(deferrals.length).toBeGreaterThan(0);
    loop.stop();
  });

  it('topology switch deferred past bound emits fault, not silent no-op', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const busy = mkAgent('a1', 'coder', 'busy', new Date(), true);
    const loop = createAdaptiveLoop(
      mkSwarm([busy], [mkDomain('queen', 1, 1, 0), mkDomain('core', 5, 0, 0)]),
      callbacks,
      {
        pollIntervalMs: 1000, dampeningWindowMs: 2000, settleWindowMs: 10000,
        topologyDeferralBoundWindows: 2,
        now: () => now,
      },
    );
    const faults: any[] = [];
    loop.on('fault', f => faults.push(f));
    loop.start();
    for (let i = 0; i < 6; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(faults.some(f => f.reason === 'topology-switch-abandoned')).toBe(true);
    loop.stop();
  });

  it('NOT_IMPLEMENTED return from switchTopology logs and continues (pre-T10)', async () => {
    let now = 0;
    const callbacks = mkCallbacks({
      switchTopology: vi.fn().mockResolvedValue('NOT_IMPLEMENTED' as const),
    });
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('queen', 1, 1, 0), mkDomain('core', 5, 0, 0)]),
      callbacks,
      { pollIntervalMs: 1000, dampeningWindowMs: 2000, settleWindowMs: 10000, now: () => now },
    );
    const applied: any[] = [];
    loop.on('action.applied', a => applied.push(a));
    loop.start();
    for (let i = 0; i < 4; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(callbacks.switchTopology).toHaveBeenCalled();
    expect(applied.some(a => a.result === 'NOT_IMPLEMENTED')).toBe(true);
    expect(loop.getState().status).toBe('running');
    loop.stop();
  });
});

// =============================================================================
// Flip-rate ceiling tests
// =============================================================================

describe('AdaptiveLoop flip-rate ceiling — adversarial input', () => {
  it('halts loud when scale axis exceeds maxFlipsPerWindow', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    let high = true;
    const swarm = mkSwarm();
    (swarm.getStatus as any) = vi.fn(() => ({
      domains: [mkDomain('core', 5, 0, high ? 10 : 0)],
      metrics: {} as any,
    }));
    // Settle window short so flips can fire repeatedly within the test.
    const loop = createAdaptiveLoop(swarm, callbacks, {
      pollIntervalMs: 1000,
      dampeningWindowMs: 1000,
      settleWindowMs: 1000,
      maxFlipsPerWindow: 3,
      flipWindowMs: 60_000,
      now: () => now,
    });
    const faults: any[] = [];
    loop.on('fault', f => faults.push(f));
    loop.start();
    // Drive sustained-then-released cycles. Each "high" tick after settle
    // window is a scale-up; each "low" tick after settle is a scale-down.
    for (let i = 0; i < 30; i++) {
      now += 1000;
      // Hold "high" for 2 ticks (dampening), settle, then "low" for 2 ticks.
      const phase = Math.floor(i / 4) % 2;
      high = phase === 0;
      await loop.tickOnce();
      if (loop.getState().status === 'halted') break;
    }
    expect(loop.getState().status).toBe('halted');
    expect(faults.some(f => f.reason === 'flip-rate-ceiling')).toBe(true);
    loop.stop();
  });

  it('flips spanning the window boundary do NOT halt', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const swarm = mkSwarm();
    let queue = 10;
    (swarm.getStatus as any) = vi.fn(() => ({
      domains: [mkDomain('core', 5, 0, queue)],
      metrics: {} as any,
    }));
    // 3-second flip window — old flips age out quickly.
    const loop = createAdaptiveLoop(swarm, callbacks, {
      pollIntervalMs: 1000,
      dampeningWindowMs: 1000,
      settleWindowMs: 1000,
      maxFlipsPerWindow: 3,
      flipWindowMs: 3_000,
      now: () => now,
    });
    loop.start();
    // 2 flips, then advance 4s so they age out, then 2 more flips.
    for (let i = 0; i < 2; i++) {
      queue = 10;
      now += 1000;
      await loop.tickOnce();
      now += 1000;
      await loop.tickOnce();
    }
    now += 5_000;
    queue = 0;
    await loop.tickOnce();
    expect(loop.getState().status).not.toBe('halted');
    loop.stop();
  });
});

// =============================================================================
// Mutation error / poll failure / partition handling
// =============================================================================

describe('AdaptiveLoop fault paths', () => {
  it('mutation callback throw halts loud, does not retry', async () => {
    let now = 0;
    const callbacks = mkCallbacks({
      scaleUp: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('core', 5, 0, 10)]),
      callbacks,
      { pollIntervalMs: 1000, dampeningWindowMs: 1000, settleWindowMs: 100000, now: () => now },
    );
    const faults: any[] = [];
    loop.on('fault', f => faults.push(f));
    loop.start();
    for (let i = 0; i < 5; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(loop.getState().status).toBe('halted');
    expect(faults.some(f => f.reason === 'mutation-error' && f.details.includes('boom'))).toBe(true);
    expect(callbacks.scaleUp).toHaveBeenCalledTimes(1); // never retried
    loop.stop();
  });

  it('3 consecutive poll failures halt loud', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const swarm = mkSwarm();
    (swarm.getStatus as any) = vi.fn(() => { throw new Error('status broken'); });
    const loop = createAdaptiveLoop(swarm, callbacks, {
      pollIntervalMs: 1000, dampeningWindowMs: 1000, settleWindowMs: 1000, now: () => now,
    });
    const faults: any[] = [];
    loop.on('fault', f => faults.push(f));
    loop.start();
    for (let i = 0; i < 5; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(loop.getState().status).toBe('halted');
    expect(faults.some(f => f.reason === 'metric-poll-failure')).toBe(true);
    loop.stop();
  });

  it('partition asymmetric suspends loop and emits partition fault', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const swarm = mkSwarm(
      [mkAgent('a1', 'coder', 'idle')],
      [mkDomain('core', 5, 0, 10)],
      { partitionDetected: true },
    );
    const loop = createAdaptiveLoop(swarm, callbacks, {
      pollIntervalMs: 1000, dampeningWindowMs: 1000, settleWindowMs: 1000, now: () => now,
    });
    const faults: any[] = [];
    loop.on('fault', f => faults.push(f));
    loop.start();
    now += 1000;
    await loop.tickOnce();
    expect(loop.getState().status).toBe('suspended');
    expect(callbacks.scaleUp).not.toHaveBeenCalled();
    expect(faults.some(f => f.reason === 'partition-detected')).toBe(true);
    loop.stop();
  });
});

// =============================================================================
// Adaptive resolver — the surface T10 wires into via setAdaptiveResolver
// =============================================================================

describe('AdaptiveLoop.resolveAdaptiveTopology — T10 hand-off', () => {
  it('returns mesh when CoV is high', async () => {
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('queen', 1, 1, 0), mkDomain('core', 5, 0, 0)]),
      mkCallbacks(),
    );
    expect(await loop.resolveAdaptiveTopology()).toBe('mesh');
  });

  it('returns hierarchical when CoV is low', async () => {
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('core', 5, 2, 0), mkDomain('integration', 3, 1, 0)]),
      mkCallbacks(),
    );
    // Equal load: CoV ≈ 0 → low → hierarchical
    expect(await loop.resolveAdaptiveTopology()).toBe('hierarchical');
  });

  it('throws when loop is halted', async () => {
    const callbacks = mkCallbacks({
      scaleUp: vi.fn().mockRejectedValue(new Error('fail')),
    });
    let now = 0;
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('core', 5, 0, 10)]),
      callbacks,
      { pollIntervalMs: 1000, dampeningWindowMs: 1000, settleWindowMs: 100000, now: () => now },
    );
    loop.start();
    for (let i = 0; i < 5; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(loop.getState().status).toBe('halted');
    await expect(loop.resolveAdaptiveTopology()).rejects.toThrow(/halted/);
    loop.stop();
  });
});

// =============================================================================
// Reset & lifecycle
// =============================================================================

describe('AdaptiveLoop lifecycle', () => {
  it('reset clears halted state so start can resume', async () => {
    const callbacks = mkCallbacks({
      scaleUp: vi.fn().mockRejectedValue(new Error('fail')),
    });
    let now = 0;
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('core', 5, 0, 10)]),
      callbacks,
      { pollIntervalMs: 1000, dampeningWindowMs: 1000, settleWindowMs: 100000, now: () => now },
    );
    loop.start();
    for (let i = 0; i < 5; i++) {
      now += 1000;
      await loop.tickOnce();
    }
    expect(loop.getState().status).toBe('halted');
    expect(() => loop.start()).toThrow(/halted/);
    loop.reset();
    expect(loop.getState().status).toBe('idle');
    expect(() => loop.start()).not.toThrow();
    loop.stop();
  });

  it('overlapping ticks are dropped, not queued', async () => {
    let now = 0;
    const callbacks = mkCallbacks();
    const loop = createAdaptiveLoop(
      mkSwarm([], [mkDomain('core', 5, 0, 0)]),
      callbacks,
      { pollIntervalMs: 1000, dampeningWindowMs: 1000, settleWindowMs: 1000, now: () => now },
    );
    const ticks: any[] = [];
    loop.on('tick', t => ticks.push(t));
    loop.start();
    // Issue two tickOnce calls without awaiting the first.
    const p1 = loop.tickOnce();
    const p2 = loop.tickOnce();
    await Promise.all([p1, p2]);
    expect(ticks.some(t => t.dropped && t.reason === 'overlap')).toBe(true);
    loop.stop();
  });
});
