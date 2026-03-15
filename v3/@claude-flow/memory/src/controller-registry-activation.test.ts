/**
 * ADR-0033: Controller Activation Tests
 *
 * Tests the factory cases added by ADR-0033 in ControllerRegistry.createController():
 * - solverBandit: SolverBandit with Thompson Sampling + state persistence
 * - agentMemoryScope: 3-scope isolation (agent, session, global)
 * - gnnService: GNN wrapper with isAvailable/differentiableSearch/getStats
 * - rvfOptimizer: Backend optimization wrapper
 *
 * Uses London School TDD (mock-first) — all dependencies are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ControllerRegistry, type RuntimeConfig } from './controller-registry.js';
import type { IMemoryBackend, MemoryEntry, MemoryQuery, MemoryEntryUpdate, SearchOptions, SearchResult, BackendStats, HealthCheckResult } from './types.js';

// ===== Mock agentdb module =====

const mockSolverBanditInstance = {
  selectArm: vi.fn().mockResolvedValue('arm-b'),
  recordReward: vi.fn().mockResolvedValue(undefined),
  getArmStats: vi.fn().mockReturnValue({ alpha: 5, beta: 2 }),
  serialize: vi.fn().mockReturnValue({ arms: { 'arm-a': { alpha: 1, beta: 1 } } }),
  deserialize: vi.fn(),
};

const MockSolverBandit = vi.fn().mockImplementation(() => mockSolverBanditInstance);

const mockIsGNNAvailable = vi.fn().mockReturnValue(true);
const mockDifferentiableSearch = vi.fn().mockResolvedValue([{ id: 'r1', score: 0.9 }]);

vi.mock('agentdb', () => ({
  SolverBandit: MockSolverBandit,
  isGNNAvailable: mockIsGNNAvailable,
  differentiableSearch: mockDifferentiableSearch,
}));

// ===== Mock Backend =====

function createMockBackend(overrides: Partial<IMemoryBackend> = {}): IMemoryBackend {
  const entries = new Map<string, MemoryEntry>();
  return {
    async initialize() {},
    async shutdown() {},
    async store(entry: MemoryEntry) { entries.set(entry.id, entry); },
    async get(id: string) { return entries.get(id) ?? null; },
    async getByKey(namespace: string, key: string) {
      for (const e of entries.values()) {
        if (e.namespace === namespace && e.key === key) return e;
      }
      return null;
    },
    async update(id: string, update: MemoryEntryUpdate) {
      const entry = entries.get(id);
      if (!entry) return null;
      Object.assign(entry, update);
      return entry;
    },
    async delete(id: string) { return entries.delete(id); },
    async query(query: MemoryQuery) {
      return Array.from(entries.values()).slice(0, query.limit);
    },
    async search(_embedding: Float32Array, _options: SearchOptions): Promise<SearchResult[]> {
      return [];
    },
    async bulkInsert(newEntries: MemoryEntry[]) {
      for (const e of newEntries) entries.set(e.id, e);
    },
    async bulkDelete(ids: string[]) {
      let c = 0;
      for (const id of ids) { if (entries.delete(id)) c++; }
      return c;
    },
    async count() { return entries.size; },
    async listNamespaces() { return []; },
    async clearNamespace() { return 0; },
    async getStats(): Promise<BackendStats> {
      return {
        totalEntries: entries.size,
        entriesByNamespace: {},
        entriesByType: { episodic: 0, semantic: 0, procedural: 0, working: 0, cache: 0 },
        memoryUsage: 0,
        avgQueryTime: 0,
        avgSearchTime: 0,
      };
    },
    async healthCheck(): Promise<HealthCheckResult> {
      return {
        status: 'healthy',
        components: {
          storage: { status: 'healthy', latency: 0 },
          index: { status: 'healthy', latency: 0 },
          cache: { status: 'healthy', latency: 0 },
        },
        timestamp: Date.now(),
        issues: [],
        recommendations: [],
      };
    },
    ...overrides,
  };
}

// ===== Tests =====

describe('ADR-0033: Controller Activation', () => {
  let registry: ControllerRegistry;
  let mockBackend: IMemoryBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ControllerRegistry();
    mockBackend = createMockBackend();
  });

  afterEach(async () => {
    if (registry.isInitialized()) {
      await registry.shutdown();
    }
  });

  // ----- solverBandit factory case -----

  describe('solverBandit factory case', () => {
    it('should create SolverBandit with default config when agentdb exports it', async () => {
      await registry.initialize({
        backend: mockBackend,
        controllers: { solverBandit: true },
      });

      // Verify constructor was called with the expected defaults
      expect(MockSolverBandit).toHaveBeenCalledWith({
        costWeight: 0.01,
        costDecay: 0.1,
        explorationBonus: 0.1,
      });

      const bandit = registry.get('solverBandit');
      expect(bandit).not.toBeNull();
    });

    it('should return null when SolverBandit class is not available', async () => {
      // Temporarily make SolverBandit undefined
      MockSolverBandit.mockImplementationOnce(() => {
        throw new Error('not a constructor');
      });

      // Need a fresh registry so the mock override applies
      const reg2 = new ControllerRegistry();
      await reg2.initialize({
        backend: mockBackend,
        controllers: { solverBandit: true },
      });

      // Should degrade — controller may be null or marked as failed
      const bandit = reg2.get('solverBandit');
      expect(bandit).toBeNull();

      await reg2.shutdown();
    });

    it('should restore persisted state if available', async () => {
      const persistedState = { arms: { 'arm-x': { alpha: 10, beta: 3 } } };
      const backendWithState = createMockBackend({
        async getByKey(_ns: string, key: string) {
          if (key === '_solver_bandit_state') {
            return { content: JSON.stringify(persistedState) } as any;
          }
          return null;
        },
      });

      await registry.initialize({
        backend: backendWithState,
        controllers: { solverBandit: true },
      });

      expect(mockSolverBanditInstance.deserialize).toHaveBeenCalledWith(persistedState);
    });

    it('should handle cold start (no persisted state) gracefully', async () => {
      // Default mock backend returns null for getByKey
      await registry.initialize({
        backend: mockBackend,
        controllers: { solverBandit: true },
      });

      // deserialize should not be called when there's no persisted state
      expect(mockSolverBanditInstance.deserialize).not.toHaveBeenCalled();

      const bandit = registry.get('solverBandit');
      expect(bandit).not.toBeNull();
    });
  });

  // ----- agentMemoryScope factory case -----

  describe('agentMemoryScope factory case', () => {
    it('should return scope controller with getScope, scopeKey, filterByScope methods', async () => {
      await registry.initialize({
        backend: mockBackend,
        controllers: { agentMemoryScope: true },
      });

      const scope = registry.get<any>('agentMemoryScope');
      expect(scope).not.toBeNull();
      expect(typeof scope!.getScope).toBe('function');
      expect(typeof scope!.scopeKey).toBe('function');
      expect(typeof scope!.filterByScope).toBe('function');
    });

    it('scopeKey should prefix key with scope:id:', async () => {
      await registry.initialize({
        backend: mockBackend,
        controllers: { agentMemoryScope: true },
      });

      const scope = registry.get<any>('agentMemoryScope')!;

      expect(scope.scopeKey('mykey', 'agent', 'agent-1')).toBe('agent:agent-1:mykey');
      expect(scope.scopeKey('mykey', 'session', 'sess-1')).toBe('session:sess-1:mykey');
      expect(scope.scopeKey('mykey', 'global')).toBe('global:mykey');
    });

    it('filterByScope should return only entries matching scope prefix', async () => {
      await registry.initialize({
        backend: mockBackend,
        controllers: { agentMemoryScope: true },
      });

      const scope = registry.get<any>('agentMemoryScope')!;

      const entries = [
        { key: 'agent:a1:key1' },
        { key: 'agent:a2:key2' },
        { key: 'session:s1:key3' },
        { key: 'global:key4' },
      ];

      const agentA1 = scope.filterByScope(entries, 'agent', 'a1');
      expect(agentA1).toHaveLength(1);
      expect(agentA1[0].key).toBe('agent:a1:key1');

      const sessionS1 = scope.filterByScope(entries, 'session', 's1');
      expect(sessionS1).toHaveLength(1);
      expect(sessionS1[0].key).toBe('session:s1:key3');

      const globalEntries = scope.filterByScope(entries, 'global');
      expect(globalEntries).toHaveLength(1);
      expect(globalEntries[0].key).toBe('global:key4');
    });

    it('unscopeKey should extract the original key and scope metadata', async () => {
      await registry.initialize({
        backend: mockBackend,
        controllers: { agentMemoryScope: true },
      });

      const scope = registry.get<any>('agentMemoryScope')!;

      const result = scope.unscopeKey('agent:a1:mykey');
      expect(result.key).toBe('mykey');
      expect(result.type).toBe('agent');

      const globalResult = scope.unscopeKey('global:mykey');
      expect(globalResult.key).toBe('mykey');
      expect(globalResult.type).toBe('global');
    });

    it('getStats should report 3 scopes', async () => {
      await registry.initialize({
        backend: mockBackend,
        controllers: { agentMemoryScope: true },
      });

      const scope = registry.get<any>('agentMemoryScope')!;
      const stats = scope.getStats();
      expect(stats.scopes).toEqual(['agent', 'session', 'global']);
    });
  });

  // ----- gnnService factory case -----

  describe('gnnService factory case', () => {
    it('should create wrapper with isAvailable/differentiableSearch/getStats', async () => {
      mockIsGNNAvailable.mockReturnValue(true);

      await registry.initialize({
        backend: mockBackend,
        controllers: { gnnService: true },
      });

      const gnn = registry.get<any>('gnnService');
      expect(gnn).not.toBeNull();
      expect(typeof gnn!.isAvailable).toBe('function');
      expect(typeof gnn!.differentiableSearch).toBe('function');
      expect(typeof gnn!.getStats).toBe('function');

      expect(gnn!.isAvailable()).toBe(true);
      expect(gnn!.getStats()).toEqual({ available: true, type: 'gnn-wrapper' });
    });

    it('should delegate differentiableSearch to agentdb function', async () => {
      mockIsGNNAvailable.mockReturnValue(true);

      await registry.initialize({
        backend: mockBackend,
        controllers: { gnnService: true },
      });

      const gnn = registry.get<any>('gnnService')!;
      const query = [0.1, 0.2];
      const candidates = [{ id: 'a' }, { id: 'b' }];
      await gnn.differentiableSearch(query, candidates, 5, 0.8);

      expect(mockDifferentiableSearch).toHaveBeenCalledWith(query, candidates, 5, 0.8);
    });

    it('should degrade gracefully when GNN functions unavailable', async () => {
      mockIsGNNAvailable.mockReturnValue(false);

      const reg2 = new ControllerRegistry();
      await reg2.initialize({
        backend: mockBackend,
        controllers: { gnnService: true },
      });

      const gnn = reg2.get<any>('gnnService');
      expect(gnn).not.toBeNull();
      expect(gnn!.isAvailable()).toBe(false);
      expect(gnn!.getStats()).toEqual({ available: false, type: 'gnn-wrapper' });

      await reg2.shutdown();
    });
  });

  // ----- rvfOptimizer factory case -----

  describe('rvfOptimizer factory case', () => {
    it('should create wrapper delegating to backend.optimize()', async () => {
      const mockOptimize = vi.fn().mockResolvedValue({ success: true, walCheckpointed: true });
      const mockGetStats = vi.fn().mockReturnValue({ totalEntries: 100 });
      const backendWithOptimize = createMockBackend();
      (backendWithOptimize as any).optimize = mockOptimize;
      (backendWithOptimize as any).getStats = mockGetStats;

      await registry.initialize({
        backend: backendWithOptimize,
        controllers: { rvfOptimizer: true },
      });

      const rvf = registry.get<any>('rvfOptimizer');
      expect(rvf).not.toBeNull();

      const result = await rvf!.optimize();
      expect(mockOptimize).toHaveBeenCalled();
      expect(result).toEqual({ success: true, walCheckpointed: true });

      expect(rvf!.isAvailable()).toBe(true);
    });

    it('should return fallback when backend lacks optimize()', async () => {
      // Standard mock backend doesn't have optimize()
      await registry.initialize({
        backend: mockBackend,
        controllers: { rvfOptimizer: true },
      });

      const rvf = registry.get<any>('rvfOptimizer');
      expect(rvf).not.toBeNull();

      const result = await rvf!.optimize();
      expect(result).toEqual({ success: false, reason: 'no backend optimize method' });
    });

    it('should report availability based on backend presence', async () => {
      await registry.initialize({
        backend: mockBackend,
        controllers: { rvfOptimizer: true },
      });

      const rvf = registry.get<any>('rvfOptimizer');
      expect(rvf!.isAvailable()).toBe(true);
    });

    it('should return wrapper stats from backend getStats', async () => {
      await registry.initialize({
        backend: mockBackend,
        controllers: { rvfOptimizer: true },
      });

      const rvf = registry.get<any>('rvfOptimizer');
      // Default mock backend has getStats but the rvfOptimizer wraps it
      const stats = await rvf!.getStats();
      // The rvfOptimizer calls backend.getStats which exists on our mock
      expect(stats).toBeDefined();
    });
  });
});
