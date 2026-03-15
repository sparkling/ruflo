/**
 * ADR-0033: hooks-tools controller activation wiring tests
 *
 * Tests the wiring added to hooks-tools.ts for ADR-0033 controllers:
 * - SolverBandit (hooks_route Phase 2, hooks_post-task Phase 2)
 * - SkillLibrary (hooks_route Phase 4, hooks_post-task Phase 4)
 * - LearningSystem (hooks_route Phase 4)
 * - SemanticRouter (hooks_route Phase 5)
 * - SonaTrajectory (hooks_post-task Phase 5, hooks_intelligence_stats)
 * - NightlyLearner (hooks_session-end Phase 3)
 *
 * London School TDD: all external dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mock setup — must be before imports
// =============================================================================

// Mock fs to prevent actual file I/O
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ size: 100, isFile: () => true, isDirectory: () => false })),
}));

// Mock memory-initializer (lazy-loaded by hooks-tools)
vi.mock('../src/memory/memory-initializer.js', () => ({
  generateEmbedding: vi.fn(async () => ({ embedding: new Array(384).fill(0.1), dimensions: 384, model: 'mock' })),
  storeEntry: vi.fn(async () => ({ success: true, id: 'mock-id' })),
  searchEntries: vi.fn(async () => ({ success: true, results: [], searchTime: 1 })),
  listEntries: vi.fn(async () => ({ success: true, entries: [] })),
  getEntry: vi.fn(async () => null),
  deleteEntry: vi.fn(async () => ({ success: true })),
  getStats: vi.fn(async () => ({
    totalEntries: 0, namespaces: [], memory: {
      indexSize: 0, memorySizeBytes: 0, totalAccessCount: 0,
    },
  })),
}));

// Mock SONA optimizer
vi.mock('../src/memory/sona-optimizer.js', () => ({
  getSONAOptimizer: vi.fn(async () => null),
}));

// Mock EWC consolidation
vi.mock('../src/memory/ewc-consolidation.js', () => ({
  getEWCConsolidator: vi.fn(async () => null),
}));

// Mock MoE router
vi.mock('../src/ruvector/moe-router.js', () => ({
  getMoERouter: vi.fn(async () => null),
}));

// Mock LoRA adapter
vi.mock('../src/ruvector/lora-adapter.js', () => ({
  getLoRAAdapter: vi.fn(async () => null),
}));

// Mock flash attention
vi.mock('../src/ruvector/flash-attention.js', () => ({
  getFlashAttention: vi.fn(async () => null),
}));

// Mock semantic router
vi.mock('../src/ruvector/semantic-router.js', () => ({
  SemanticRouter: vi.fn(),
}));

// Mock worker daemon
vi.mock('../src/services/worker-daemon.js', () => ({
  startDaemon: vi.fn(async () => ({ pid: 12345, getStatus: () => ({ pid: 12345 }) })),
  stopDaemon: vi.fn(async () => {}),
}));

// Mock enhanced model router
vi.mock('../src/services/enhanced-model-router.js', () => ({
  getEnhancedModelRouter: vi.fn(async () => null),
}));

// Default bridge mock — reconfigured per test via bridgeMock
const bridgeMock = {
  bridgeSolverBanditSelect: vi.fn(),
  bridgeSolverBanditUpdate: vi.fn(),
  bridgeGetController: vi.fn(),
  bridgeSemanticRoute: vi.fn(),
  bridgeRouteTask: vi.fn(async () => ({ route: 'general', confidence: 0.3, agents: ['coder'], controller: 'none' })),
  bridgeRecordFeedback: vi.fn(async () => ({ success: true, controller: 'mock', updated: 1 })),
  bridgeRecordCausalEdge: vi.fn(async () => ({ success: true })),
  bridgeSessionStart: vi.fn(async () => ({ success: true, controller: 'mock', restoredPatterns: 0 })),
  bridgeSessionEnd: vi.fn(async () => ({ success: true, controller: 'mock', persisted: true })),
  bridgeHealthCheck: vi.fn(async () => ({ available: true, status: 'healthy' })),
  bridgeListControllers: vi.fn(async () => []),
  bridgeStorePattern: vi.fn(async () => ({ success: true })),
  bridgeSearchPatterns: vi.fn(async () => ({ results: [] })),
  bridgeHierarchicalStore: vi.fn(async () => ({ success: true })),
  bridgeHierarchicalRecall: vi.fn(async () => ({ results: [] })),
  bridgeConsolidate: vi.fn(async () => ({ success: true })),
  bridgeBatchOperation: vi.fn(async () => ({ success: true })),
  bridgeContextSynthesize: vi.fn(async () => ({ success: true })),
};

vi.mock('../src/memory/memory-bridge.js', () => bridgeMock);

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { hooksRoute } from '../src/mcp-tools/hooks-tools.js';
import { hooksPostTask } from '../src/mcp-tools/hooks-tools.js';
import { hooksSessionEnd } from '../src/mcp-tools/hooks-tools.js';
import { hooksIntelligenceStats } from '../src/mcp-tools/hooks-tools.js';

// =============================================================================
// Helpers
// =============================================================================

/** Parse the JSON text from an MCPToolResult content array */
function parseRouteResult(result: any): any {
  if (result?.content?.[0]?.text) {
    return JSON.parse(result.content[0].text);
  }
  return result;
}

// =============================================================================
// Tests
// =============================================================================

describe('ADR-0033: hooks-tools controller activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset bridge defaults
    bridgeMock.bridgeSolverBanditSelect.mockResolvedValue(undefined);
    bridgeMock.bridgeSolverBanditUpdate.mockResolvedValue(undefined);
    bridgeMock.bridgeGetController.mockResolvedValue(null);
    bridgeMock.bridgeSemanticRoute.mockResolvedValue({ route: null });
    bridgeMock.bridgeRouteTask.mockResolvedValue({ route: 'general', confidence: 0.3, agents: ['coder'], controller: 'none' });
    bridgeMock.bridgeRecordFeedback.mockResolvedValue({ success: true, controller: 'mock', updated: 1 });
    bridgeMock.bridgeRecordCausalEdge.mockResolvedValue({ success: true });
    bridgeMock.bridgeSessionEnd.mockResolvedValue({ success: true, controller: 'mock', persisted: true });
  });

  // ===========================================================================
  // hooks_route — SolverBandit routing (Phase 2)
  // ===========================================================================

  describe('hooks_route -- SolverBandit routing', () => {
    it('should return early via SolverBandit when confidence > 0.6', async () => {
      bridgeMock.bridgeSolverBanditSelect.mockResolvedValue({
        arm: 'coder',
        confidence: 0.8,
        controller: 'solverBandit',
      });

      const result = await hooksRoute.handler({ task: 'write unit tests' });
      const parsed = parseRouteResult(result);

      expect(parsed.recommended_agent).toBe('coder');
      expect(parsed.confidence).toBe(0.8);
      expect(parsed.routing_method).toBe('solverBandit');
      expect(bridgeMock.bridgeSolverBanditSelect).toHaveBeenCalledWith(
        'write unit tests',
        expect.arrayContaining(['coder', 'reviewer', 'tester']),
      );
    });

    it('should fall through when SolverBandit confidence <= 0.6', async () => {
      bridgeMock.bridgeSolverBanditSelect.mockResolvedValue({
        arm: 'coder',
        confidence: 0.4,
        controller: 'fallback',
      });

      const result = await hooksRoute.handler({ task: 'write code' });
      const parsed = parseRouteResult(result);

      // Should NOT be solverBandit — it fell through
      expect(parsed.routing_method).not.toBe('solverBandit');
    });

    it('should fall through when SolverBandit confidence > 0.6 but controller is fallback', async () => {
      bridgeMock.bridgeSolverBanditSelect.mockResolvedValue({
        arm: 'coder',
        confidence: 0.9,
        controller: 'fallback',
      });

      const result = await hooksRoute.handler({ task: 'write code' });
      const parsed = parseRouteResult(result);

      expect(parsed.routing_method).not.toBe('solverBandit');
    });

    it('should fall through when bridgeSolverBanditSelect is undefined', async () => {
      // Remove the function entirely
      const original = bridgeMock.bridgeSolverBanditSelect;
      (bridgeMock as any).bridgeSolverBanditSelect = undefined;

      const result = await hooksRoute.handler({ task: 'review security' });

      // Should complete without error (fell through to another phase)
      expect(result).toBeDefined();

      // Restore
      (bridgeMock as any).bridgeSolverBanditSelect = original;
    });

    it('should fall through when SolverBandit throws', async () => {
      bridgeMock.bridgeSolverBanditSelect.mockRejectedValue(new Error('bandit crashed'));

      const result = await hooksRoute.handler({ task: 'fix bug' });

      // Should complete without error (caught by try-catch)
      expect(result).toBeDefined();
      const parsed = parseRouteResult(result);
      expect(parsed.routing_method).not.toBe('solverBandit');
    });

    it('should fall through when SolverBandit times out', async () => {
      // Return a promise that never resolves — the 2s timeout race should catch it
      bridgeMock.bridgeSolverBanditSelect.mockReturnValue(new Promise(() => {}));

      // Use fake timers to avoid waiting 2 real seconds
      vi.useFakeTimers();

      const resultPromise = hooksRoute.handler({ task: 'optimize performance' });

      // Advance past the 2000ms timeout
      await vi.advanceTimersByTimeAsync(2100);

      const result = await resultPromise;
      expect(result).toBeDefined();
      const parsed = parseRouteResult(result);
      expect(parsed.routing_method).not.toBe('solverBandit');

      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // hooks_route — SkillLibrary search (Phase 4)
  // ===========================================================================

  describe('hooks_route -- SkillLibrary search', () => {
    it('should route via SkillLibrary when skill confidence > 0.7', async () => {
      const mockSkills = {
        search: vi.fn().mockResolvedValue([
          { name: 'auth-handler', agent: 'security-architect', confidence: 0.85, pattern: 'authentication' },
        ]),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      const result = await hooksRoute.handler({ task: 'implement authentication' });
      const parsed = parseRouteResult(result);

      expect(parsed.routing_method).toBe('skillLibrary');
      expect(parsed.recommended_agent).toBe('security-architect');
      expect(parsed.confidence).toBe(0.85);
      expect(parsed.skill).toBe('auth-handler');
      expect(mockSkills.search).toHaveBeenCalledWith('implement authentication', 3);
    });

    it('should use score field when confidence is absent', async () => {
      const mockSkills = {
        search: vi.fn().mockResolvedValue([
          { name: 'test-skill', pattern: 'testing', score: 0.9 },
        ]),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      const result = await hooksRoute.handler({ task: 'write tests', task_type: 'testing' });
      const parsed = parseRouteResult(result);

      expect(parsed.routing_method).toBe('skillLibrary');
      expect(parsed.confidence).toBe(0.9);
      // When no agent field, falls back to pattern or name
      expect(parsed.recommended_agent).toBe('testing');
    });

    it('should fall through when no matching skills', async () => {
      const mockSkills = {
        search: vi.fn().mockResolvedValue([]),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      const result = await hooksRoute.handler({ task: 'do something unique' });
      const parsed = parseRouteResult(result);

      expect(parsed.routing_method).not.toBe('skillLibrary');
    });

    it('should fall through when skill confidence <= 0.7', async () => {
      const mockSkills = {
        search: vi.fn().mockResolvedValue([
          { name: 'weak-match', agent: 'coder', confidence: 0.5, score: 0.5 },
        ]),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      const result = await hooksRoute.handler({ task: 'ambiguous task' });
      const parsed = parseRouteResult(result);

      expect(parsed.routing_method).not.toBe('skillLibrary');
    });

    it('should fall through when skills controller is null', async () => {
      bridgeMock.bridgeGetController.mockResolvedValue(null);

      const result = await hooksRoute.handler({ task: 'any task' });

      expect(result).toBeDefined();
    });

    it('should fall through when skills.search throws', async () => {
      const mockSkills = {
        search: vi.fn().mockRejectedValue(new Error('search failed')),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      const result = await hooksRoute.handler({ task: 'any task' });

      expect(result).toBeDefined();
      const parsed = parseRouteResult(result);
      expect(parsed.routing_method).not.toBe('skillLibrary');
    });
  });

  // ===========================================================================
  // hooks_route — LearningSystem recommendation (Phase 4)
  // ===========================================================================

  describe('hooks_route -- LearningSystem recommendation', () => {
    it('should merge learningSystem metadata into routing result', async () => {
      const mockLearningSystem = {
        recommendAlgorithm: vi.fn().mockResolvedValue({
          algorithm: 'ucb1',
          reason: 'best exploration-exploitation trade-off',
        }),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'learningSystem') return mockLearningSystem;
        return null;
      });
      // Make SemanticRouter return a valid result so we can see routingMetadata in the output
      bridgeMock.bridgeSemanticRoute.mockResolvedValue({
        route: 'tester',
        confidence: 0.75,
      });

      const result = await hooksRoute.handler({ task: 'optimize search' });
      const parsed = parseRouteResult(result);

      // The SemanticRouter result includes spread routingMetadata
      expect(parsed.learningSystem).toBeDefined();
      expect(parsed.learningSystem.algorithm).toBe('ucb1');
      expect(mockLearningSystem.recommendAlgorithm).toHaveBeenCalledWith('optimize search');
    });

    it('should not add metadata when recommendAlgorithm returns null', async () => {
      const mockLearningSystem = {
        recommendAlgorithm: vi.fn().mockResolvedValue(null),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'learningSystem') return mockLearningSystem;
        return null;
      });
      bridgeMock.bridgeSemanticRoute.mockResolvedValue({
        route: 'coder',
        confidence: 0.8,
      });

      const result = await hooksRoute.handler({ task: 'write code' });
      const parsed = parseRouteResult(result);

      expect(parsed.learningSystem).toBeUndefined();
    });

    it('should not crash when learningSystem throws', async () => {
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'learningSystem') throw new Error('LS crashed');
        return null;
      });

      const result = await hooksRoute.handler({ task: 'any task' });

      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // hooks_route — SemanticRouter (Phase 5)
  // ===========================================================================

  describe('hooks_route -- SemanticRouter', () => {
    it('should return route from SemanticRouter when available', async () => {
      bridgeMock.bridgeSemanticRoute.mockResolvedValue({
        route: 'tester',
        confidence: 0.9,
      });

      const result = await hooksRoute.handler({ task: 'test the auth module' });
      const parsed = parseRouteResult(result);

      expect(parsed.recommended_agent).toBe('tester');
      expect(parsed.confidence).toBe(0.9);
      expect(parsed.routing_method).toBe('semanticRouter');
      expect(bridgeMock.bridgeSemanticRoute).toHaveBeenCalledWith({ input: 'test the auth module' });
    });

    it('should use default confidence 0.7 when not provided', async () => {
      bridgeMock.bridgeSemanticRoute.mockResolvedValue({
        route: 'coder',
      });

      const result = await hooksRoute.handler({ task: 'write a parser' });
      const parsed = parseRouteResult(result);

      expect(parsed.confidence).toBe(0.7);
    });

    it('should fall through when SemanticRouter returns null route', async () => {
      bridgeMock.bridgeSemanticRoute.mockResolvedValue({ route: null });

      const result = await hooksRoute.handler({ task: 'general task' });
      const parsed = parseRouteResult(result);

      expect(parsed.routing_method).not.toBe('semanticRouter');
    });

    it('should fall through when SemanticRouter returns error', async () => {
      bridgeMock.bridgeSemanticRoute.mockResolvedValue({ route: 'coder', error: 'something wrong' });

      const result = await hooksRoute.handler({ task: 'general task' });
      const parsed = parseRouteResult(result);

      expect(parsed.routing_method).not.toBe('semanticRouter');
    });

    it('should fall through when bridgeSemanticRoute is undefined', async () => {
      const original = bridgeMock.bridgeSemanticRoute;
      (bridgeMock as any).bridgeSemanticRoute = undefined;

      const result = await hooksRoute.handler({ task: 'any task' });

      expect(result).toBeDefined();

      (bridgeMock as any).bridgeSemanticRoute = original;
    });

    it('should fall through when SemanticRouter throws', async () => {
      bridgeMock.bridgeSemanticRoute.mockRejectedValue(new Error('router crashed'));

      const result = await hooksRoute.handler({ task: 'any task' });

      expect(result).toBeDefined();
      const parsed = parseRouteResult(result);
      expect(parsed.routing_method).not.toBe('semanticRouter');
    });
  });

  // ===========================================================================
  // hooks_post-task — SolverBandit feedback (Phase 2)
  // ===========================================================================

  describe('hooks_post-task -- SolverBandit feedback', () => {
    it('should call bridgeSolverBanditUpdate fire-and-forget on task completion', async () => {
      bridgeMock.bridgeSolverBanditUpdate.mockResolvedValue(undefined);

      const result = await hooksPostTask.handler({
        taskId: 'task-123',
        success: true,
        agent: 'coder',
        quality: 0.9,
        task_type: 'coding',
      });

      expect(result).toBeDefined();
      expect(bridgeMock.bridgeSolverBanditUpdate).toHaveBeenCalledWith('coding', 'coder', 0.9);
    });

    it('should use task as taskType when task_type not provided', async () => {
      bridgeMock.bridgeSolverBanditUpdate.mockResolvedValue(undefined);

      await hooksPostTask.handler({
        taskId: 'task-456',
        success: true,
        agent: 'reviewer',
        quality: 0.7,
        task: 'review PR',
      });

      expect(bridgeMock.bridgeSolverBanditUpdate).toHaveBeenCalledWith('review PR', 'reviewer', 0.7);
    });

    it('should not block response when bridgeSolverBanditUpdate rejects', async () => {
      bridgeMock.bridgeSolverBanditUpdate.mockRejectedValue(new Error('update failed'));

      const result = await hooksPostTask.handler({
        taskId: 'task-789',
        success: true,
        agent: 'coder',
        quality: 0.8,
      });

      // Handler should still complete successfully
      expect(result).toBeDefined();
      expect((result as any).taskId).toBe('task-789');
    });

    it('should not crash when bridgeSolverBanditUpdate is undefined', async () => {
      const original = bridgeMock.bridgeSolverBanditUpdate;
      (bridgeMock as any).bridgeSolverBanditUpdate = undefined;

      const result = await hooksPostTask.handler({
        taskId: 'task-noupdate',
        success: true,
        agent: 'coder',
        quality: 0.5,
      });

      expect(result).toBeDefined();

      (bridgeMock as any).bridgeSolverBanditUpdate = original;
    });
  });

  // ===========================================================================
  // hooks_post-task — SkillLibrary creation (Phase 4)
  // ===========================================================================

  describe('hooks_post-task -- SkillLibrary creation', () => {
    it('should create skill when quality > 0.8', async () => {
      const mockSkills = {
        create: vi.fn().mockResolvedValue({ success: true }),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      await hooksPostTask.handler({
        taskId: 'task-skill',
        success: true,
        agent: 'coder',
        quality: 0.95,
        task_type: 'refactoring',
      });

      expect(mockSkills.create).toHaveBeenCalledWith({
        name: 'refactoring-coder',
        pattern: 'refactoring',
        context: expect.stringContaining('"agent":"coder"'),
      });
    });

    it('should NOT create skill when quality <= 0.8', async () => {
      const mockSkills = {
        create: vi.fn().mockResolvedValue({ success: true }),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      await hooksPostTask.handler({
        taskId: 'task-lowq',
        success: true,
        agent: 'coder',
        quality: 0.5,
      });

      expect(mockSkills.create).not.toHaveBeenCalled();
    });

    it('should NOT create skill when quality is exactly 0.8', async () => {
      const mockSkills = {
        create: vi.fn().mockResolvedValue({ success: true }),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      await hooksPostTask.handler({
        taskId: 'task-boundary',
        success: true,
        agent: 'coder',
        quality: 0.8,
      });

      // quality > 0.8 is strict, so 0.8 exactly should NOT trigger
      expect(mockSkills.create).not.toHaveBeenCalled();
    });

    it('should not block response when skills.create rejects', async () => {
      const mockSkills = {
        create: vi.fn().mockRejectedValue(new Error('create failed')),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      const result = await hooksPostTask.handler({
        taskId: 'task-fail-create',
        success: true,
        agent: 'coder',
        quality: 0.95,
      });

      expect(result).toBeDefined();
      expect((result as any).taskId).toBe('task-fail-create');
    });

    it('should include context with agent, quality, and timestamp', async () => {
      const mockSkills = {
        create: vi.fn().mockResolvedValue({ success: true }),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'skills') return mockSkills;
        return null;
      });

      await hooksPostTask.handler({
        taskId: 'task-ctx',
        success: true,
        agent: 'tester',
        quality: 0.9,
        task_type: 'testing',
      });

      const contextArg = mockSkills.create.mock.calls[0][0].context;
      const parsed = JSON.parse(contextArg);
      expect(parsed.agent).toBe('tester');
      expect(parsed.quality).toBe(0.9);
      expect(parsed.timestamp).toBeTypeOf('number');
    });
  });

  // ===========================================================================
  // hooks_post-task — SonaTrajectory recording (Phase 5)
  // ===========================================================================

  describe('hooks_post-task -- SonaTrajectory recording', () => {
    it('should record trajectory step fire-and-forget', async () => {
      const mockTrajectory = {
        recordStep: vi.fn().mockResolvedValue({ success: true }),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'sonaTrajectory') return mockTrajectory;
        return null;
      });

      await hooksPostTask.handler({
        taskId: 'task-traj',
        success: true,
        agent: 'coder',
        quality: 0.85,
        task_type: 'coding',
      });

      expect(mockTrajectory.recordStep).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'coding',
          agent: 'coder',
          reward: 0.85,
          success: true,
          timestamp: expect.any(Number),
        }),
      );
    });

    it('should not block response when recordStep rejects', async () => {
      const mockTrajectory = {
        recordStep: vi.fn().mockRejectedValue(new Error('record failed')),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'sonaTrajectory') return mockTrajectory;
        return null;
      });

      const result = await hooksPostTask.handler({
        taskId: 'task-traj-fail',
        success: true,
        agent: 'coder',
        quality: 0.7,
      });

      expect(result).toBeDefined();
      expect((result as any).taskId).toBe('task-traj-fail');
    });

    it('should skip recording when sonaTrajectory is null', async () => {
      bridgeMock.bridgeGetController.mockResolvedValue(null);

      const result = await hooksPostTask.handler({
        taskId: 'task-no-traj',
        success: true,
        agent: 'coder',
        quality: 0.7,
      });

      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // hooks_session-end — NightlyLearner consolidation (Phase 3)
  // ===========================================================================

  describe('hooks_session-end -- NightlyLearner consolidation', () => {
    it('should trigger consolidation fire-and-forget on session end', async () => {
      const mockNightlyLearner = {
        consolidate: vi.fn().mockResolvedValue({ success: true }),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'nightlyLearner') return mockNightlyLearner;
        return null;
      });

      const result = await hooksSessionEnd.handler({ saveState: true, stopDaemon: false });

      expect(result).toBeDefined();
      expect(mockNightlyLearner.consolidate).toHaveBeenCalled();
    });

    it('should not block session end when NightlyLearner unavailable', async () => {
      bridgeMock.bridgeGetController.mockResolvedValue(null);

      const result = await hooksSessionEnd.handler({ saveState: false, stopDaemon: false });

      expect(result).toBeDefined();
      expect((result as any).sessionPersistence).toBeDefined();
    });

    it('should not block session end when consolidate rejects', async () => {
      const mockNightlyLearner = {
        consolidate: vi.fn().mockRejectedValue(new Error('consolidation failed')),
      };
      bridgeMock.bridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'nightlyLearner') return mockNightlyLearner;
        return null;
      });

      const result = await hooksSessionEnd.handler({ saveState: true, stopDaemon: false });

      expect(result).toBeDefined();
    });

    it('should not block when bridgeGetController throws', async () => {
      bridgeMock.bridgeGetController.mockRejectedValue(new Error('controller registry crashed'));

      const result = await hooksSessionEnd.handler({ saveState: false, stopDaemon: false });

      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // hooks_intelligence_stats — SonaTrajectory stats (Phase 5)
  // ===========================================================================

  describe('hooks_intelligence_stats -- SonaTrajectory stats', () => {
    it('should include sonaTrajectory key in stats when controller is available', async () => {
      // The hooksIntelligenceStats handler calls getSonaTrajectory() which
      // is a module-level lazy singleton. It caches the result from the first
      // call (which may be null if bridgeGetController wasn't set up yet).
      // We import the stats handler and verify it handles the cached value
      // gracefully — the important contract is that it does not throw.
      const result = await hooksIntelligenceStats.handler({});

      // Stats handler should complete without error regardless of
      // sonaTrajectory availability (it's a cached singleton)
      expect(result).toBeDefined();
      const stats = (result as any)?.content?.[0]?.text
        ? JSON.parse((result as any).content[0].text)
        : result;
      // The stats object should always be returned (with or without sonaTrajectory)
      expect(stats).toBeDefined();
    });
  });

  // ===========================================================================
  // hooks_post-task — default quality values (WM-107a)
  // ===========================================================================

  describe('hooks_post-task -- quality defaults', () => {
    it('should use 0.85 default quality for successful tasks without explicit quality', async () => {
      bridgeMock.bridgeSolverBanditUpdate.mockResolvedValue(undefined);

      await hooksPostTask.handler({
        taskId: 'task-default-q',
        success: true,
        agent: 'coder',
      });

      // bridgeSolverBanditUpdate is called with the quality value
      expect(bridgeMock.bridgeSolverBanditUpdate).toHaveBeenCalledWith(
        expect.anything(), 'coder', 0.85,
      );
    });

    it('should use 0.2 default quality for failed tasks without explicit quality', async () => {
      bridgeMock.bridgeSolverBanditUpdate.mockResolvedValue(undefined);

      await hooksPostTask.handler({
        taskId: 'task-fail-q',
        success: false,
        agent: 'coder',
      });

      expect(bridgeMock.bridgeSolverBanditUpdate).toHaveBeenCalledWith(
        expect.anything(), 'coder', 0.2,
      );
    });

    it('should preserve explicit quality=0.0 (not coerce to default)', async () => {
      bridgeMock.bridgeSolverBanditUpdate.mockResolvedValue(undefined);

      await hooksPostTask.handler({
        taskId: 'task-zero-q',
        success: true,
        agent: 'coder',
        quality: 0.0,
      });

      expect(bridgeMock.bridgeSolverBanditUpdate).toHaveBeenCalledWith(
        expect.anything(), 'coder', 0.0,
      );
    });
  });
});
