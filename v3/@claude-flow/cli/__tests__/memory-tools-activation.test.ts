/**
 * ADR-0033: memory-tools enhancements — activation tests
 *
 * Tests wiring for ADR-0033 enhancements to memory_store and memory_search:
 * - Scope prefix (AgentMemoryScope)
 * - Context synthesis (ContextSynthesizer)
 * - MMR diversity re-ranking (graceful degradation)
 * - Scope filtering on search results
 *
 * Uses London School TDD (mock-first): all bridge + initializer calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock setup — must be before imports
// ============================================================================

const mockScopeController = {
  scopeKey: vi.fn((key: string, scope: string, scopeId?: string) =>
    scopeId ? `${scope}:${scopeId}:${key}` : `${scope}::${key}`,
  ),
  filterByScope: vi.fn((results: any[], scope: string, scopeId?: string) =>
    results.filter((r: any) => r.key.startsWith(`${scope}:${scopeId || ''}`)),
  ),
};

const mockContextSynthesizer = {
  synthesize: vi.fn((results: any[]) => ({
    summary: 'Synthesized context from results',
    entryCount: results.length,
  })),
};

const mockMmrDiversity = {
  selectDiverse: vi.fn((results: any[]) => results.slice(0, 2)),
};

const mockMemoryGraph = {
  addNode: vi.fn(),
  getImportance: vi.fn(() => 0),
};

const mockBridgeGetController = vi.fn(async (name: string) => {
  switch (name) {
    case 'agentMemoryScope': return mockScopeController;
    case 'contextSynthesizer': return mockContextSynthesizer;
    case 'mmrDiversity': return mockMmrDiversity;
    case 'memoryGraph': return mockMemoryGraph;
    case 'metadataFilter': return null;
    case 'attentionService': return null;
    default: return null;
  }
});

// Mock memory-bridge
vi.mock('../src/memory/memory-bridge.js', () => ({
  bridgeGetController: mockBridgeGetController,
}));

// Mock fs to prevent actual file I/O
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const mockStoreEntry = vi.fn(async () => ({
  success: true,
  id: 'mock-id',
  embedding: { dimensions: 384 },
}));

const mockSearchEntries = vi.fn(async () => ({
  success: true,
  results: [
    { key: 'agent:a1:pattern-1', namespace: 'default', content: '"hello"', score: 0.9, tags: [] },
    { key: 'session:s1:pattern-2', namespace: 'default', content: '"world"', score: 0.7, tags: [] },
    { key: 'global::pattern-3', namespace: 'default', content: '"foo"', score: 0.5, tags: [] },
  ],
  searchTime: 1.5,
}));

const mockCheckInit = vi.fn(async () => ({ initialized: true }));
const mockInitDb = vi.fn(async () => {});

// Mock memory-initializer
vi.mock('../src/memory/memory-initializer.js', () => ({
  storeEntry: mockStoreEntry,
  searchEntries: mockSearchEntries,
  listEntries: vi.fn(async () => ({ entries: [], total: 0 })),
  getEntry: vi.fn(async () => ({ found: false })),
  deleteEntry: vi.fn(async () => ({ deleted: true })),
  checkMemoryInitialization: mockCheckInit,
  initializeMemoryDatabase: mockInitDb,
}));

// ============================================================================
// Import tools under test (after mocks)
// ============================================================================

import { memoryTools } from '../src/mcp-tools/memory-tools.js';

// Helper to find a tool by name
function findTool(name: string) {
  const tool = memoryTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

// ============================================================================
// Tests
// ============================================================================

describe('ADR-0033: memory-tools enhancements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock behavior
    mockBridgeGetController.mockImplementation(async (name: string) => {
      switch (name) {
        case 'agentMemoryScope': return mockScopeController;
        case 'contextSynthesizer': return mockContextSynthesizer;
        case 'mmrDiversity': return mockMmrDiversity;
        case 'memoryGraph': return mockMemoryGraph;
        case 'metadataFilter': return null;
        case 'attentionService': return null;
        default: return null;
      }
    });
    mockSearchEntries.mockResolvedValue({
      success: true,
      results: [
        { key: 'agent:a1:pattern-1', namespace: 'default', content: '"hello"', score: 0.9, tags: [] },
        { key: 'session:s1:pattern-2', namespace: 'default', content: '"world"', score: 0.7, tags: [] },
        { key: 'global::pattern-3', namespace: 'default', content: '"foo"', score: 0.5, tags: [] },
      ],
      searchTime: 1.5,
    });
  });

  // ---------- memory_store — scope prefix ----------

  describe('memory_store — scope prefix', () => {
    it('should prefix key with scope when scope param provided', async () => {
      const store = findTool('memory_store');

      await store.handler({
        key: 'pattern',
        value: 'data',
        namespace: 'patterns',
        scope: 'agent',
        scope_id: 'a1',
      });

      expect(mockScopeController.scopeKey).toHaveBeenCalledWith(
        'pattern',
        'agent',
        'a1',
      );
      // storeEntry should be called with the scoped key
      expect(mockStoreEntry).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'agent:a1:pattern' }),
      );
    });

    it('should use unscoped key when scope not provided', async () => {
      const store = findTool('memory_store');

      await store.handler({
        key: 'pattern',
        value: 'data',
        namespace: 'patterns',
      });

      expect(mockScopeController.scopeKey).not.toHaveBeenCalled();
      expect(mockStoreEntry).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'pattern' }),
      );
    });

    it('should gracefully degrade when scope controller unavailable', async () => {
      mockBridgeGetController.mockImplementation(async () => null);
      const store = findTool('memory_store');

      const result = await store.handler({
        key: 'pattern',
        value: 'data',
        namespace: 'patterns',
        scope: 'agent',
        scope_id: 'a1',
      });

      // Should still store with original key (scope prefix failed silently)
      expect(mockStoreEntry).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'pattern' }),
      );
      expect((result as any).success).toBe(true);
    });
  });

  // ---------- memory_search — scope filtering ----------

  describe('memory_search — scope filtering', () => {
    it('should filter results by scope when scope param provided', async () => {
      const search = findTool('memory_search');

      const result = await search.handler({
        query: 'test query',
        scope: 'agent',
        scope_id: 'a1',
      });

      expect(mockScopeController.filterByScope).toHaveBeenCalledWith(
        expect.any(Array),
        'agent',
        'a1',
      );
      // Only agent:a1:* results should remain
      const results = (result as any).results;
      expect(results.every((r: any) => r.key.startsWith('agent:a1'))).toBe(true);
    });

    it('should return all results when scope not provided', async () => {
      // Disable MMR so it does not trim results
      mockMmrDiversity.selectDiverse.mockReturnValue(null as any);
      const search = findTool('memory_search');

      const result = await search.handler({ query: 'test query' });

      expect(mockScopeController.filterByScope).not.toHaveBeenCalled();
      // All 3 search results should pass through (MMR returned falsy, so originals kept)
      expect((result as any).results.length).toBe(3);
    });
  });

  // ---------- memory_search — context synthesis ----------

  describe('memory_search — context synthesis', () => {
    it('should include synthesis when synthesize=true', async () => {
      const search = findTool('memory_search');

      const result = await search.handler({
        query: 'test query',
        synthesize: true,
      });

      expect(mockContextSynthesizer.synthesize).toHaveBeenCalled();
      expect((result as any).synthesis).toEqual({
        summary: 'Synthesized context from results',
        entryCount: expect.any(Number),
      });
    });

    it('should NOT synthesize when synthesize=false', async () => {
      const search = findTool('memory_search');

      const result = await search.handler({
        query: 'test query',
        synthesize: false,
      });

      expect(mockContextSynthesizer.synthesize).not.toHaveBeenCalled();
      expect((result as any).synthesis).toBeUndefined();
    });

    it('should NOT synthesize when synthesize omitted', async () => {
      const search = findTool('memory_search');

      const result = await search.handler({ query: 'test query' });

      expect(mockContextSynthesizer.synthesize).not.toHaveBeenCalled();
      expect((result as any).synthesis).toBeUndefined();
    });

    it('should gracefully degrade when synthesizer unavailable', async () => {
      mockBridgeGetController.mockImplementation(async (name: string) => {
        if (name === 'contextSynthesizer') return null;
        if (name === 'memoryGraph') return mockMemoryGraph;
        if (name === 'mmrDiversity') return mockMmrDiversity;
        if (name === 'attentionService') return null;
        return null;
      });

      const search = findTool('memory_search');

      const result = await search.handler({
        query: 'test query',
        synthesize: true,
      });

      // Should still return results without synthesis
      expect((result as any).results.length).toBeGreaterThan(0);
      expect((result as any).synthesis).toBeUndefined();
    });

    it('should NOT synthesize when results are empty', async () => {
      mockSearchEntries.mockResolvedValueOnce({
        success: true,
        results: [],
        searchTime: 0.5,
      });

      const search = findTool('memory_search');

      const result = await search.handler({
        query: 'no results',
        synthesize: true,
      });

      expect(mockContextSynthesizer.synthesize).not.toHaveBeenCalled();
      expect((result as any).synthesis).toBeUndefined();
    });
  });

  // ---------- memory_search — MMR diversity ----------

  describe('memory_search — MMR diversity', () => {
    it('should apply MMR re-ranking when available', async () => {
      const search = findTool('memory_search');

      const result = await search.handler({
        query: 'test',
        mmr_lambda: 0.7,
      });

      expect(mockMmrDiversity.selectDiverse).toHaveBeenCalledWith(
        expect.any(Array),
        'test',
        { lambda: 0.7, k: 10 },
      );
    });

    it('should apply MMR with default lambda 0.5', async () => {
      const search = findTool('memory_search');

      await search.handler({ query: 'test' });

      expect(mockMmrDiversity.selectDiverse).toHaveBeenCalledWith(
        expect.any(Array),
        'test',
        expect.objectContaining({ lambda: 0.5 }),
      );
    });

    it('should not throw on MMR failure (graceful degradation)', async () => {
      mockMmrDiversity.selectDiverse.mockImplementation(() => {
        throw new Error('MMR computation failed');
      });

      const search = findTool('memory_search');

      const result = await search.handler({ query: 'test' });

      // Should return original results, not an error
      expect((result as any).results.length).toBeGreaterThan(0);
      expect((result as any).error).toBeUndefined();
    });

    it('should not apply MMR when only 1 result', async () => {
      mockSearchEntries.mockResolvedValueOnce({
        success: true,
        results: [
          { key: 'only-one', namespace: 'default', content: '"single"', score: 0.9, tags: [] },
        ],
        searchTime: 0.5,
      });

      const search = findTool('memory_search');

      await search.handler({ query: 'test' });

      expect(mockMmrDiversity.selectDiverse).not.toHaveBeenCalled();
    });

    it('should fall back to original results when MMR returns empty', async () => {
      mockMmrDiversity.selectDiverse.mockReturnValue([]);

      const search = findTool('memory_search');

      const result = await search.handler({ query: 'test' });

      // Original results should be preserved when MMR returns empty
      expect((result as any).results.length).toBeGreaterThan(0);
    });
  });
});
