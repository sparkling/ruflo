/**
 * ADR-0132 (T14) — Sub-queen failure escalation tests
 *
 * R8 carry-forward from ADR-0109; sibling to ADR-0131 (T12) worker-failure
 * protocol. Tests cover the three documented strategy paths in
 * `subQueenFailed()`:
 *
 *   1. promote-worker — sub-hive has ≥1 healthy worker
 *   2. escalate-to-root — zero healthy workers; subtree abandoned
 *   3. idempotent recovery — second call for same subQueenId is no-op
 *
 * Plus the fatal-error guards (sub-queen-in-its-own-subtree, healthy-set-
 * not-subset-of-subtree) and the lineage-event emission contract.
 *
 * TDD London-school: all dependencies are mocked. The handler is pure
 * w.r.t. its inputs — state transitions are driven by the
 * `SubQueenFailContext` snapshot the caller supplies, not by I/O against
 * shared hive state. No `state.queen` is required for these tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  QueenCoordinator,
  createQueenCoordinator,
  type ISwarmCoordinator,
  type INeuralLearningSystem,
  type IMemoryService,
  type SubQueenFailureRecord,
  type SubQueenFailContext,
} from '../src/queen-coordinator.js';
import type {
  CoordinatorMetrics,
  ConsensusResult,
} from '../src/types.js';
import type { DomainStatus } from '../src/unified-coordinator.js';

// =============================================================================
// Mock factories — minimal subset of queen-coordinator.test.ts helpers,
// just enough to instantiate the QueenCoordinator. The handler under test
// does not exercise the swarm/neural/memory services directly.
// =============================================================================

function createMockMetrics(): CoordinatorMetrics {
  return {
    uptime: 3600,
    activeAgents: 5,
    totalTasks: 100,
    completedTasks: 90,
    failedTasks: 5,
    avgTaskDurationMs: 5000,
    messagesPerSecond: 50,
    consensusSuccessRate: 0.95,
    coordinationLatencyMs: 50,
    memoryUsageBytes: 100000000,
  };
}

function createMockDomainStatuses(): DomainStatus[] {
  return [];
}

function createMockConsensusResult(): ConsensusResult {
  return {
    proposalId: 'proposal_1',
    approved: true,
    approvalRate: 1,
    participationRate: 1,
    finalValue: { approved: true },
    rounds: 1,
    durationMs: 10,
  };
}

function createMockSwarmCoordinator(): ISwarmCoordinator {
  return {
    getAgentsByDomain: vi.fn().mockReturnValue([]),
    getAllAgents: vi.fn().mockReturnValue([]),
    getAvailableAgents: vi.fn().mockReturnValue([]),
    getMetrics: vi.fn().mockReturnValue(createMockMetrics()),
    getDomainConfigs: vi.fn().mockReturnValue(new Map()),
    getStatus: vi.fn().mockReturnValue({
      domains: createMockDomainStatuses(),
      metrics: createMockMetrics(),
    }),
    assignTaskToDomain: vi.fn().mockResolvedValue('agent_1'),
    proposeConsensus: vi.fn().mockResolvedValue(createMockConsensusResult()),
    broadcastMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockNeuralSystem(): INeuralLearningSystem {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    beginTask: vi.fn().mockReturnValue('trajectory_1'),
    recordStep: vi.fn(),
    completeTask: vi.fn().mockResolvedValue(undefined),
    findPatterns: vi.fn().mockResolvedValue([]),
    retrieveMemories: vi.fn().mockResolvedValue([]),
    triggerLearning: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockMemoryService(): IMemoryService {
  return {
    semanticSearch: vi.fn().mockResolvedValue([]),
    store: vi.fn().mockResolvedValue(undefined),
  };
}

// =============================================================================
// Test suite
// =============================================================================

describe('ADR-0132 (T14) — sub-queen failure escalation', () => {
  let queen: QueenCoordinator;
  let mockSwarm: ISwarmCoordinator;
  let mockNeural: INeuralLearningSystem;
  let mockMemory: IMemoryService;

  beforeEach(() => {
    mockSwarm = createMockSwarmCoordinator();
    mockNeural = createMockNeuralSystem();
    mockMemory = createMockMemoryService();
    queen = createQueenCoordinator(mockSwarm, {}, mockNeural, mockMemory);
  });

  afterEach(async () => {
    if (queen) {
      await queen.shutdown();
    }
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Scenario 1 — promote-worker
  // ===========================================================================
  //
  // Hierarchical-mesh swarm with root queen + 1 sub-queen + 3 workers under
  // sub-queen. Simulate sub-queen non-response. Assert subtree reassigns:
  // 1 worker promoted (longest-lived, first in healthyWorkerIds), 2 workers
  // reassigned under it, lineage logged.
  describe('Scenario 1: promote-worker (≥1 healthy worker in subtree)', () => {
    it('promotes the longest-lived healthy worker to interim sub-queen', () => {
      const context: SubQueenFailContext = {
        // Lineage order: worker-1 spawned first (longest lineage), then -2, -3.
        workersInSubtree: ['worker-1', 'worker-2', 'worker-3'],
        healthyWorkerIds: ['worker-1', 'worker-2', 'worker-3'],
        subHiveId: 'sub-0',
        pendingProposalIds: ['proposal-A'],
      };

      const record = queen.subQueenFailed('sub-queen-0', 'timeout', context);

      expect(record.event).toBe('sub-queen-failure');
      expect(record.subQueenId).toBe('sub-queen-0');
      expect(record.reason).toBe('timeout');
      expect(record.escalationStrategy).toBe('promote-worker');
      expect(record.promotedWorkerId).toBe('worker-1');
      expect(record.reassignedWorkerIds).toEqual(['worker-2', 'worker-3']);
      expect(record.subHiveId).toBe('sub-0');
      expect(record.pendingProposalIds).toEqual(['proposal-A']);
      expect(record.timestamp).toBeGreaterThan(0);
      // Escalate-to-root fields MUST NOT be set on a promote-worker outcome.
      expect(record.abandonedWorkerIds).toBeUndefined();
    });

    it('reassigns only the healthy workers, not the unhealthy ones', () => {
      // Subtree of 3, but only 2 are healthy — the unhealthy worker is
      // implicitly excluded from reassignment because it isn't in
      // healthyWorkerIds. The strategy still picks promote-worker because
      // healthyWorkerIds.length >= 1.
      const context: SubQueenFailContext = {
        workersInSubtree: ['worker-1', 'worker-2', 'worker-3'],
        healthyWorkerIds: ['worker-2', 'worker-3'],
        subHiveId: 'sub-1',
      };

      const record = queen.subQueenFailed('sub-queen-1', 'error', context);

      expect(record.escalationStrategy).toBe('promote-worker');
      expect(record.promotedWorkerId).toBe('worker-2');
      expect(record.reassignedWorkerIds).toEqual(['worker-3']);
    });

    it('emits queen.subqueen.failure event with the lineage record', () => {
      const handler = vi.fn();
      queen.on('queen.subqueen.failure', handler);

      const context: SubQueenFailContext = {
        workersInSubtree: ['w1', 'w2'],
        healthyWorkerIds: ['w1', 'w2'],
      };
      const record = queen.subQueenFailed('sq-0', 'timeout', context);

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      // emitEvent wraps the payload in { id, type, source, timestamp, data }.
      expect(event.type).toBe('queen.subqueen.failure');
      expect(event.source).toBe('queen-coordinator');
      expect(event.data.escalationStrategy).toBe('promote-worker');
      expect(event.data.promotedWorkerId).toBe('w1');
      // Returned record matches event payload semantics.
      expect(record.escalationStrategy).toBe(event.data.escalationStrategy);
    });

    it('appends to the audit trail accessible via getSubQueenFailures()', () => {
      const context: SubQueenFailContext = {
        workersInSubtree: ['w1', 'w2'],
        healthyWorkerIds: ['w1', 'w2'],
      };
      queen.subQueenFailed('sq-0', 'timeout', context);

      const history = queen.getSubQueenFailures();
      expect(history).toHaveLength(1);
      expect(history[0].subQueenId).toBe('sq-0');
      expect(history[0].escalationStrategy).toBe('promote-worker');
    });
  });

  // ===========================================================================
  // Scenario 2 — escalate-to-root
  // ===========================================================================
  //
  // Sub-queen fails AND its subtree has 0 healthy workers. Assert escalation
  // to root: subtree marked FAILED, root queen receives reassignment notice
  // (the abandonedWorkerIds list).
  describe('Scenario 2: escalate-to-root (0 healthy workers)', () => {
    it('escalates to root and marks the entire subtree abandoned', () => {
      const context: SubQueenFailContext = {
        workersInSubtree: ['worker-A', 'worker-B', 'worker-C'],
        healthyWorkerIds: [], // entire subtree is non-responsive
        subHiveId: 'sub-2',
        pendingProposalIds: ['proposal-X', 'proposal-Y'],
      };

      const record = queen.subQueenFailed('sub-queen-2', 'error', context);

      expect(record.event).toBe('sub-queen-failure');
      expect(record.escalationStrategy).toBe('escalate-to-root');
      expect(record.abandonedWorkerIds).toEqual([
        'worker-A',
        'worker-B',
        'worker-C',
      ]);
      // Promote-worker fields MUST NOT be set on escalate-to-root.
      expect(record.promotedWorkerId).toBeUndefined();
      expect(record.reassignedWorkerIds).toBeUndefined();
      // Pending proposals carry forward for the top-tier queen to handle.
      expect(record.pendingProposalIds).toEqual(['proposal-X', 'proposal-Y']);
    });

    it('handles an empty subtree (no workers were ever assigned)', () => {
      // Edge case: the sub-hive collapsed to a single sub-queen with no
      // workers (e.g. dispatchByTopology assigned only one slice element).
      // The escalation path still records the (empty) abandoned list and
      // surfaces the failure for top-tier visibility.
      const context: SubQueenFailContext = {
        workersInSubtree: [],
        healthyWorkerIds: [],
      };

      const record = queen.subQueenFailed('lonely-sq', 'timeout', context);

      expect(record.escalationStrategy).toBe('escalate-to-root');
      expect(record.abandonedWorkerIds).toEqual([]);
    });

    it('emits queen.subqueen.failure event for escalation paths', () => {
      const handler = vi.fn();
      queen.on('queen.subqueen.failure', handler);

      queen.subQueenFailed('sq-doomed', 'error', {
        workersInSubtree: ['w1'],
        healthyWorkerIds: [],
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event.data.escalationStrategy).toBe('escalate-to-root');
      expect(event.data.abandonedWorkerIds).toEqual(['w1']);
    });
  });

  // ===========================================================================
  // Scenario 3 — idempotent recovery
  // ===========================================================================
  //
  // Sub-queen "fails" then comes back online (e.g. recovered after promotion).
  // Assert no double-promotion (idempotent on second `subQueenFailed` call
  // after recovery). Per ADR-0132 §Refinement, promotion is one-way for the
  // lifetime of the coordinator — recovery does NOT re-arm the slot.
  describe('Scenario 3: idempotent recovery (double-call returns already-handled)', () => {
    it('returns already-handled on second call without double-promotion', () => {
      const context: SubQueenFailContext = {
        workersInSubtree: ['worker-1', 'worker-2'],
        healthyWorkerIds: ['worker-1', 'worker-2'],
        subHiveId: 'sub-3',
      };

      const first = queen.subQueenFailed('sq-flaky', 'timeout', context);
      expect(first.escalationStrategy).toBe('promote-worker');
      expect(first.promotedWorkerId).toBe('worker-1');

      // Second call — even with a "different" reason. Handler must not
      // promote a different worker.
      const second = queen.subQueenFailed('sq-flaky', 'error', context);
      expect(second.escalationStrategy).toBe('already-handled');
      // Echo the original promotion so consumers can resolve without
      // re-running the strategy logic.
      expect(second.promotedWorkerId).toBe('worker-1');
      expect(second.reassignedWorkerIds).toEqual(['worker-2']);
    });

    it('emits queen.subqueen.failure event on the already-handled path', () => {
      // The audit trail still records the late call so observers know a
      // duplicate failure was reported. The strategy field is the discriminator.
      const handler = vi.fn();
      queen.on('queen.subqueen.failure', handler);

      const context: SubQueenFailContext = {
        workersInSubtree: ['w1'],
        healthyWorkerIds: ['w1'],
      };
      queen.subQueenFailed('sq-dup', 'timeout', context);
      queen.subQueenFailed('sq-dup', 'timeout', context);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0][0].data.escalationStrategy).toBe(
        'promote-worker',
      );
      expect(handler.mock.calls[1][0].data.escalationStrategy).toBe(
        'already-handled',
      );
    });

    it('isSubQueenFailed reports membership after first call', () => {
      expect(queen.isSubQueenFailed('sq-test')).toBe(false);
      queen.subQueenFailed('sq-test', 'timeout', {
        workersInSubtree: ['w1'],
        healthyWorkerIds: ['w1'],
      });
      expect(queen.isSubQueenFailed('sq-test')).toBe(true);
    });

    it('audit trail does NOT duplicate the original record on already-handled', () => {
      // Per ADR-0132 §Decision Outcome, the history holds the FIRST-pass
      // decision. Idempotent re-calls do not append a fresh history row
      // (they emit on the event surface for observers but do not mutate
      // the history list).
      const context: SubQueenFailContext = {
        workersInSubtree: ['w1'],
        healthyWorkerIds: ['w1'],
      };
      queen.subQueenFailed('sq-once', 'timeout', context);
      queen.subQueenFailed('sq-once', 'error', context);

      const history = queen.getSubQueenFailures();
      expect(history).toHaveLength(1);
      expect(history[0].reason).toBe('timeout'); // original reason preserved
      expect(history[0].escalationStrategy).toBe('promote-worker');
    });
  });

  // ===========================================================================
  // Fatal-error guards — re-thrown per
  // `feedback-best-effort-must-rethrow-fatals.md`. These aren't recoverable
  // states; silently swallowing them would mask caller corruption.
  // ===========================================================================
  describe('fatal-error guards (data-integrity)', () => {
    it('throws when sub-queen ID appears in its own workersInSubtree', () => {
      const context: SubQueenFailContext = {
        workersInSubtree: ['sq-self', 'w1'],
        healthyWorkerIds: ['w1'],
      };
      expect(() => queen.subQueenFailed('sq-self', 'timeout', context)).toThrow(
        /data-integrity error.*appears in its own workersInSubtree/,
      );
    });

    it('throws when a healthy worker ID is not in workersInSubtree', () => {
      const context: SubQueenFailContext = {
        workersInSubtree: ['w1', 'w2'],
        healthyWorkerIds: ['w1', 'w99'], // 'w99' is bogus
      };
      expect(() => queen.subQueenFailed('sq-x', 'error', context)).toThrow(
        /data-integrity error.*healthy worker w99 not in workersInSubtree/,
      );
    });

    it('does not register a fatal-failure call in the failed-set on throw', () => {
      // If the guard throws, we MUST NOT poison the idempotency state —
      // the caller may legitimately retry with a corrected snapshot.
      try {
        queen.subQueenFailed('sq-bad', 'timeout', {
          workersInSubtree: ['sq-bad', 'w1'],
          healthyWorkerIds: ['w1'],
        });
      } catch {
        // expected
      }
      expect(queen.isSubQueenFailed('sq-bad')).toBe(false);
    });
  });

  // ===========================================================================
  // History defensive-copy contract — getSubQueenFailures() must not leak
  // internal state.
  // ===========================================================================
  describe('audit-trail defensive copy', () => {
    it('returns a fresh array each call; mutation does not affect internal state', () => {
      queen.subQueenFailed('sq-1', 'timeout', {
        workersInSubtree: ['w1'],
        healthyWorkerIds: ['w1'],
      });

      const view = queen.getSubQueenFailures();
      view.push({
        event: 'sub-queen-failure',
        subQueenId: 'attacker-injected',
        reason: 'timeout',
        escalationStrategy: 'promote-worker',
        timestamp: 0,
      } as SubQueenFailureRecord);

      // Internal history is unaffected.
      const second = queen.getSubQueenFailures();
      expect(second).toHaveLength(1);
      expect(second[0].subQueenId).toBe('sq-1');
    });
  });
});
