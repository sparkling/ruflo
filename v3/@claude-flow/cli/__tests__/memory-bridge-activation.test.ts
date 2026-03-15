/**
 * ADR-0033: Memory Bridge Activation Tests
 *
 * Tests the bridge functions added by ADR-0033:
 * - bridgeSolverBanditSelect / bridgeSolverBanditUpdate
 * - bridgeLearningBridgeLearn
 * - bridgeCausalRecall
 * - bridgeBatchOptimize / bridgeBatchPrune
 * - bridgeExplainableRecall
 * - bridgeGraphTransformerRerank
 * - bridgeGraphAdapter
 *
 * Uses London School TDD — the module-level getRegistry() is mocked to return
 * a controllable mock registry, so we test the wiring, not the controllers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ===== Mock registry factory =====

const mockControllers = new Map<string, any>();
let mockRegistry: any;

function setMockController(name: string, controller: any) {
  mockControllers.set(name, controller);
}

function clearMockControllers() {
  mockControllers.clear();
}

// Mock the getRegistry singleton that memory-bridge.ts calls internally.
// The bridge functions call `await getRegistry()` which returns a ControllerRegistry.
// We intercept the @claude-flow/memory import used by memory-bridge.

vi.mock('@claude-flow/memory', () => ({
  ControllerRegistry: vi.fn().mockImplementation(() => {
    mockRegistry = {
      get(name: string) { return mockControllers.get(name) ?? null; },
      getController(name: string) { return mockControllers.get(name) ?? null; },
      initialize: vi.fn().mockResolvedValue(undefined),
      isInitialized: vi.fn().mockReturnValue(true),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    return mockRegistry;
  }),
}));

// Mock fs/path for readProjectConfig and getDbPath
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn().mockReturnValue('{}') },
}));

// Now import the bridge functions under test
import {
  bridgeSolverBanditSelect,
  bridgeSolverBanditUpdate,
  bridgeLearningBridgeLearn,
  bridgeCausalRecall,
  bridgeBatchOptimize,
  bridgeBatchPrune,
  bridgeExplainableRecall,
  bridgeGraphTransformerRerank,
  bridgeGraphAdapter,
} from '../src/memory/memory-bridge.js';

// ===== Tests =====

describe('ADR-0033: Bridge Functions', () => {
  beforeEach(() => {
    clearMockControllers();
    vi.clearAllMocks();
  });

  // ----- bridgeSolverBanditSelect -----

  describe('bridgeSolverBanditSelect', () => {
    it('should return selected arm with confidence from bandit', async () => {
      const mockBandit = {
        selectArm: vi.fn().mockResolvedValue('arm-b'),
        getArmStats: vi.fn().mockReturnValue({ alpha: 8, beta: 2 }),
      };
      setMockController('solverBandit', mockBandit);

      const result = await bridgeSolverBanditSelect('model-routing', ['arm-a', 'arm-b', 'arm-c']);

      expect(result.arm).toBe('arm-b');
      expect(result.controller).toBe('solverBandit');
      // confidence = alpha / (alpha + beta) = 8 / 10 = 0.8
      expect(result.confidence).toBeCloseTo(0.8, 2);
      expect(mockBandit.selectArm).toHaveBeenCalledWith('model-routing', ['arm-a', 'arm-b', 'arm-c']);
    });

    it('should fallback to first arm when bandit unavailable', async () => {
      // No solverBandit controller registered
      const result = await bridgeSolverBanditSelect('ctx', ['fallback-arm', 'other']);

      expect(result.arm).toBe('fallback-arm');
      expect(result.confidence).toBe(0.5);
      expect(result.controller).toBe('fallback');
    });

    it('should fallback when selectArm throws', async () => {
      const mockBandit = {
        selectArm: vi.fn().mockRejectedValue(new Error('bandit error')),
      };
      setMockController('solverBandit', mockBandit);

      const result = await bridgeSolverBanditSelect('ctx', ['safe-arm']);

      expect(result.arm).toBe('safe-arm');
      expect(result.controller).toBe('fallback');
    });
  });

  // ----- bridgeSolverBanditUpdate -----

  describe('bridgeSolverBanditUpdate', () => {
    it('should call recordReward and persist state (fire-and-forget)', async () => {
      const mockBandit = {
        recordReward: vi.fn().mockResolvedValue(undefined),
        serialize: vi.fn().mockReturnValue({ arms: {} }),
      };
      setMockController('solverBandit', mockBandit);

      const result = await bridgeSolverBanditUpdate('ctx', 'arm-a', 0.9, 0.5);

      expect(result.success).toBe(true);
      expect(mockBandit.recordReward).toHaveBeenCalledWith('ctx', 'arm-a', 0.9, 0.5);
    });

    it('should return error when bandit unavailable', async () => {
      const result = await bridgeSolverBanditUpdate('ctx', 'arm-a', 0.9);

      expect(result.success).toBe(false);
      expect(result.error).toBe('SolverBandit not available');
    });

    it('should succeed even when persistence fails', async () => {
      const mockBandit = {
        recordReward: vi.fn().mockResolvedValue(undefined),
        serialize: vi.fn().mockImplementation(() => {
          throw new Error('serialize failed');
        }),
      };
      setMockController('solverBandit', mockBandit);

      const result = await bridgeSolverBanditUpdate('ctx', 'arm-a', 0.9);

      // persist failure is non-fatal — should still return success
      expect(result.success).toBe(true);
    });
  });

  // ----- bridgeLearningBridgeLearn -----

  describe('bridgeLearningBridgeLearn', () => {
    it('should call lb.learn with correct args', async () => {
      const mockLB = {
        learn: vi.fn().mockResolvedValue(undefined),
      };
      setMockController('learningBridge', mockLB);

      const result = await bridgeLearningBridgeLearn({
        input: 'query',
        output: 'response',
        reward: 0.85,
        context: 'coding',
      });

      expect(result.success).toBe(true);
      expect(mockLB.learn).toHaveBeenCalledWith('query', 'response', 0.85, 'coding');
    });

    it('should return error when LearningBridge unavailable', async () => {
      const result = await bridgeLearningBridgeLearn({
        input: 'q',
        output: 'a',
        reward: 0.5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('LearningBridge not available');
    });

    it('should return error when learn method missing', async () => {
      setMockController('learningBridge', { noLearnHere: true });

      const result = await bridgeLearningBridgeLearn({
        input: 'q',
        output: 'a',
        reward: 0.5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('LearningBridge not available');
    });
  });

  // ----- bridgeCausalRecall -----

  describe('bridgeCausalRecall', () => {
    it('should return results from causalRecall.search()', async () => {
      const mockCR = {
        search: vi.fn().mockResolvedValue([
          { id: 'r1', score: 0.95 },
          { id: 'r2', score: 0.8 },
        ]),
        getStats: vi.fn().mockReturnValue({ totalCausalEdges: 20 }),
      };
      setMockController('causalRecall', mockCR);

      const result = await bridgeCausalRecall({ query: 'auth pattern', k: 5 });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(mockCR.search).toHaveBeenCalledWith({
        query: 'auth pattern',
        k: 5,
        includeEvidence: undefined,
      });
    });

    it('should apply cold-start guard when <5 edges', async () => {
      const mockCR = {
        search: vi.fn(),
        getStats: vi.fn().mockReturnValue({ totalCausalEdges: 3 }),
      };
      setMockController('causalRecall', mockCR);

      const result = await bridgeCausalRecall({ query: 'test' });

      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
      expect(result.warning).toContain('Cold start');
      // search should NOT be called when under threshold
      expect(mockCR.search).not.toHaveBeenCalled();
    });

    it('should return error when CausalRecall unavailable', async () => {
      const result = await bridgeCausalRecall({ query: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('CausalRecall not available');
    });
  });

  // ----- bridgeBatchOptimize -----

  describe('bridgeBatchOptimize', () => {
    it('should call optimize() and getStats()', async () => {
      const mockBO = {
        optimize: vi.fn(),
        getStats: vi.fn().mockReturnValue({ totalOptimized: 42 }),
      };
      setMockController('batchOperations', mockBO);

      const result = await bridgeBatchOptimize();

      expect(result.success).toBe(true);
      expect(mockBO.optimize).toHaveBeenCalled();
      expect(result.stats).toEqual({ totalOptimized: 42 });
    });

    it('should return error when BatchOperations unavailable', async () => {
      const result = await bridgeBatchOptimize();

      expect(result.success).toBe(false);
      expect(result.error).toBe('BatchOperations not available');
    });
  });

  // ----- bridgeBatchPrune -----

  describe('bridgeBatchPrune', () => {
    it('should call pruneData with config', async () => {
      const mockBO = {
        pruneData: vi.fn().mockResolvedValue({ pruned: 15, remaining: 85 }),
      };
      setMockController('batchOperations', mockBO);

      const result = await bridgeBatchPrune({ maxAge: 86400, minReward: 0.3 });

      expect(result.success).toBe(true);
      expect(result.pruned).toEqual({ pruned: 15, remaining: 85 });
      expect(mockBO.pruneData).toHaveBeenCalledWith({ maxAge: 86400, minReward: 0.3 });
    });

    it('should return error when pruneData method missing', async () => {
      setMockController('batchOperations', { optimize: vi.fn() });

      const result = await bridgeBatchPrune();

      expect(result.success).toBe(false);
      expect(result.error).toBe('BatchOperations not available');
    });
  });

  // ----- bridgeExplainableRecall -----

  describe('bridgeExplainableRecall', () => {
    it('should return results with Merkle proof chain', async () => {
      const mockER = {
        recall: vi.fn().mockResolvedValue({
          results: [
            { id: 'entry-1', value: 'foo' },
            { id: 'entry-2', value: 'bar' },
          ],
        }),
      };
      const mockAttestation = {
        getProof: vi.fn().mockResolvedValue({
          hash: 'abc123',
          path: ['node1', 'node2'],
          verified: true,
        }),
      };
      setMockController('explainableRecall', mockER);
      setMockController('attestationLog', mockAttestation);

      const result = await bridgeExplainableRecall({
        query: 'test query',
        namespace: 'default',
        limit: 10,
        includeProof: true,
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.proofChain).toBeDefined();
      expect(result.proofChain!.length).toBeGreaterThan(0);
      expect(result.proofChain![0].proof).toBe('abc123');
      expect(result.proofChain![0].verified).toBe(true);
    });

    it('should fallback when controller unavailable', async () => {
      // No explainableRecall controller — the fallback calls bridgeSearchEntries
      // which also uses the registry. Since our mock registry has no backend/db,
      // the fallback itself may fail, returning success: false with an error.
      const result = await bridgeExplainableRecall({
        query: 'test',
        limit: 5,
      });

      // Result may be success or failure depending on fallback chain.
      // The key invariant is: it does NOT throw, and returns a structured response.
      expect(result).toHaveProperty('success');
      if (result.success) {
        expect(result.proofChain).toEqual([]);
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });

  // ----- bridgeGraphTransformerRerank -----

  describe('bridgeGraphTransformerRerank', () => {
    it('should rerank results using proof_gated module', async () => {
      const reranked = [
        { id: 'b', score: 0.95 },
        { id: 'a', score: 0.8 },
      ];
      const mockGT = {
        proofGated: {
          rerank: vi.fn().mockResolvedValue(reranked),
        },
      };
      setMockController('graphTransformer', mockGT);

      const input = [
        { id: 'a', score: 0.8 },
        { id: 'b', score: 0.95 },
      ];
      const result = await bridgeGraphTransformerRerank(input, 'search query');

      expect(result).toEqual(reranked);
      expect(mockGT.proofGated.rerank).toHaveBeenCalledWith(
        input,
        'search query',
        { module: 'proof_gated' },
      );
    });

    it('should return original results on failure', async () => {
      const mockGT = {
        proofGated: {
          rerank: vi.fn().mockRejectedValue(new Error('rerank failed')),
        },
      };
      setMockController('graphTransformer', mockGT);

      const input = [{ id: 'a' }, { id: 'b' }];
      const result = await bridgeGraphTransformerRerank(input, 'query');

      // Should return original results unchanged
      expect(result).toEqual(input);
    });

    it('should return original results when graphTransformer unavailable', async () => {
      const input = [{ id: 'x' }];
      const result = await bridgeGraphTransformerRerank(input, 'query');
      expect(result).toEqual(input);
    });

    it('should return empty array unchanged', async () => {
      const result = await bridgeGraphTransformerRerank([], 'query');
      expect(result).toEqual([]);
    });

    it('should return original results when rerank method missing', async () => {
      setMockController('graphTransformer', { noRerank: true });

      const input = [{ id: 'a' }];
      const result = await bridgeGraphTransformerRerank(input, 'query');
      expect(result).toEqual(input);
    });
  });

  // ----- bridgeGraphAdapter -----

  describe('bridgeGraphAdapter', () => {
    it('should support searchSkills action', async () => {
      const mockGA = {
        searchSkills: vi.fn().mockResolvedValue([
          { name: 'typescript', confidence: 0.9 },
          { name: 'testing', confidence: 0.8 },
        ]),
      };
      setMockController('graphAdapter', mockGA);

      const result = await bridgeGraphAdapter({ action: 'searchSkills', k: 5 });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(mockGA.searchSkills).toHaveBeenCalledWith(null, 5);
    });

    it('should support stats action', async () => {
      const mockGA = {
        getStats: vi.fn().mockReturnValue({ nodes: 100, edges: 250 }),
      };
      setMockController('graphAdapter', mockGA);

      const result = await bridgeGraphAdapter({ action: 'stats' });

      expect(result.success).toBe(true);
      expect(result.results![0]).toEqual({ nodes: 100, edges: 250 });
    });

    it('should return available status when getStats missing', async () => {
      setMockController('graphAdapter', {});

      const result = await bridgeGraphAdapter({ action: 'stats' });

      expect(result.success).toBe(true);
      expect(result.results![0]).toEqual({ status: 'available', type: 'GraphDatabaseAdapter' });
    });

    it('should return error when GraphAdapter unavailable', async () => {
      const result = await bridgeGraphAdapter({ action: 'searchSkills' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('GraphAdapter not available');
    });

    it('should return error for unknown action', async () => {
      setMockController('graphAdapter', {});

      const result = await bridgeGraphAdapter({ action: 'unknown' as any });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });
  });
});
