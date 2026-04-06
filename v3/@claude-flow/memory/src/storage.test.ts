/**
 * Storage Abstraction Tests (ADR-0076 Phase 3)
 *
 * Contract tests for IStorage + StorageFactory:
 *   - createStorage() returns an object satisfying IStorage
 *   - Factory selects RvfBackend when available
 *   - Factory throws a clear error when both backends fail
 *   - Round-trip: store -> get -> verify
 *   - Search returns results with correct dimensionality
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createStorage, type StorageConfig } from './storage-factory.js';
import type { IStorage, IStorageContract } from './storage.js';
import { createDefaultEntry, generateMemoryId } from './types.js';
import type { MemoryEntry, SearchResult } from './types.js';

// ===== Helpers =====

/** Build a config for in-memory testing */
function memoryConfig(overrides: Partial<StorageConfig> = {}): StorageConfig {
  return {
    databasePath: ':memory:',
    dimensions: 32,       // small for fast tests
    verbose: false,
    ...overrides,
  };
}

/** Create a test entry with an optional embedding */
function testEntry(opts: { dims?: number; namespace?: string; key?: string } = {}): MemoryEntry {
  const dims = opts.dims ?? 32;
  const embedding = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    embedding[i] = Math.random() * 2 - 1;
  }
  return {
    ...createDefaultEntry({
      key: opts.key ?? `key-${generateMemoryId()}`,
      content: 'test content',
      namespace: opts.namespace ?? 'test',
      tags: ['unit'],
    }),
    embedding,
  };
}

// ===== Tests =====

describe('StorageFactory', () => {
  let storage: IStorage | null = null;

  afterEach(async () => {
    if (storage) {
      await storage.shutdown();
      storage = null;
    }
  });

  // --- Contract: createStorage() returns an IStorage ---

  describe('createStorage() contract', () => {
    it('returns an object with all IStorageContract methods', async () => {
      storage = await createStorage(memoryConfig());

      // IStorageContract: the 10 methods controllers call
      const contractMethods: Array<keyof IStorageContract> = [
        'initialize',
        'shutdown',
        'store',
        'get',
        'getByKey',
        'update',
        'delete',
        'search',
        'query',
        'count',
      ];

      for (const method of contractMethods) {
        expect(typeof (storage as any)[method]).toBe('function');
      }
    });

    it('returns an object that also has full IMemoryBackend methods', async () => {
      storage = await createStorage(memoryConfig());

      // IStorage = IMemoryBackend, so these extra methods must exist
      const extraMethods = [
        'bulkInsert',
        'bulkDelete',
        'listNamespaces',
        'clearNamespace',
        'getStats',
        'healthCheck',
      ];

      for (const method of extraMethods) {
        expect(typeof (storage as any)[method]).toBe('function');
      }
    });
  });

  // --- Backend selection ---

  describe('backend selection', () => {
    it('selects RvfBackend for in-memory databases', async () => {
      storage = await createStorage(memoryConfig({ verbose: false }));
      expect(storage).toBeDefined();

      // RvfBackend starts with 0 entries
      await expect(storage.count()).resolves.toBe(0);
    });

    it('throws a clear error when both backends fail', async () => {
      // Force failure by providing invalid dimensions (0 is rejected by RvfBackend)
      await expect(
        createStorage({ databasePath: ':memory:', dimensions: 0 }),
      ).rejects.toThrow(/Failed to create storage backend/);
    });

    it('error message includes path and dimensions', async () => {
      try {
        await createStorage({ databasePath: '/nonexistent/path.rvf', dimensions: -1 });
        expect.unreachable('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('/nonexistent/path.rvf');
        expect(err.message).toContain('Dimensions');
      }
    });
  });

  // --- Round-trip: store -> get -> verify ---

  describe('storage round-trip', () => {
    it('store and retrieve by id', async () => {
      storage = await createStorage(memoryConfig());
      const entry = testEntry();

      await storage.store(entry);
      const retrieved = await storage.get(entry.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(entry.id);
      expect(retrieved!.key).toBe(entry.key);
      expect(retrieved!.content).toBe('test content');
      expect(retrieved!.namespace).toBe('test');
    });

    it('store and retrieve by namespace + key', async () => {
      storage = await createStorage(memoryConfig());
      const entry = testEntry({ namespace: 'ns1', key: 'unique-key' });

      await storage.store(entry);
      const retrieved = await storage.getByKey('ns1', 'unique-key');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(entry.id);
    });

    it('update modifies content', async () => {
      storage = await createStorage(memoryConfig());
      const entry = testEntry();

      await storage.store(entry);
      const updated = await storage.update(entry.id, { content: 'new content' });

      expect(updated).not.toBeNull();
      expect(updated!.content).toBe('new content');
      expect(updated!.version).toBe(entry.version + 1);
    });

    it('delete removes the entry', async () => {
      storage = await createStorage(memoryConfig());
      const entry = testEntry();

      await storage.store(entry);
      expect(await storage.delete(entry.id)).toBe(true);
      expect(await storage.get(entry.id)).toBeNull();
      await expect(storage.count()).resolves.toBe(0);
    });

    it('count returns correct totals', async () => {
      storage = await createStorage(memoryConfig());
      const e1 = testEntry({ namespace: 'a' });
      const e2 = testEntry({ namespace: 'a' });
      const e3 = testEntry({ namespace: 'b' });

      await storage.store(e1);
      await storage.store(e2);
      await storage.store(e3);

      await expect(storage.count()).resolves.toBe(3);
      await expect(storage.count('a')).resolves.toBe(2);
      await expect(storage.count('b')).resolves.toBe(1);
    });

    it('query filters by namespace', async () => {
      storage = await createStorage(memoryConfig());
      const e1 = testEntry({ namespace: 'alpha' });
      const e2 = testEntry({ namespace: 'beta' });

      await storage.store(e1);
      await storage.store(e2);

      const results = await storage.query({
        type: 'hybrid',
        namespace: 'alpha',
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0].namespace).toBe('alpha');
    });
  });

  // --- Search with correct dimensionality ---

  describe('vector search', () => {
    it('search returns results with score and distance', async () => {
      const dims = 32;
      storage = await createStorage(memoryConfig({ dimensions: dims }));

      // Store several entries with embeddings
      for (let i = 0; i < 5; i++) {
        await storage.store(testEntry({ dims }));
      }

      // Create a query vector
      const queryVec = new Float32Array(dims);
      for (let i = 0; i < dims; i++) queryVec[i] = Math.random();

      const results: SearchResult[] = await storage.search(queryVec, { k: 3 });

      expect(results.length).toBeLessThanOrEqual(3);
      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        expect(r).toHaveProperty('entry');
        expect(r).toHaveProperty('score');
        expect(r).toHaveProperty('distance');
        expect(typeof r.score).toBe('number');
        expect(typeof r.distance).toBe('number');
      }
    });

    it('search results are sorted by descending score', async () => {
      const dims = 32;
      storage = await createStorage(memoryConfig({ dimensions: dims }));

      for (let i = 0; i < 10; i++) {
        await storage.store(testEntry({ dims }));
      }

      const queryVec = new Float32Array(dims);
      for (let i = 0; i < dims; i++) queryVec[i] = 0.5;

      const results = await storage.search(queryVec, { k: 5 });

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('search with threshold filters low-scoring results', async () => {
      const dims = 32;
      storage = await createStorage(memoryConfig({ dimensions: dims }));

      for (let i = 0; i < 5; i++) {
        await storage.store(testEntry({ dims }));
      }

      const queryVec = new Float32Array(dims);
      for (let i = 0; i < dims; i++) queryVec[i] = 0.5;

      const results = await storage.search(queryVec, { k: 10, threshold: 0.99 });

      // With random vectors and a 0.99 threshold, most should be filtered
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.99);
      }
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('get returns null for nonexistent id', async () => {
      storage = await createStorage(memoryConfig());
      expect(await storage.get('does-not-exist')).toBeNull();
    });

    it('getByKey returns null for nonexistent key', async () => {
      storage = await createStorage(memoryConfig());
      expect(await storage.getByKey('ns', 'nope')).toBeNull();
    });

    it('delete returns false for nonexistent id', async () => {
      storage = await createStorage(memoryConfig());
      expect(await storage.delete('does-not-exist')).toBe(false);
    });

    it('update returns null for nonexistent id', async () => {
      storage = await createStorage(memoryConfig());
      expect(await storage.update('does-not-exist', { content: 'x' })).toBeNull();
    });

    it('search on empty storage returns empty array', async () => {
      storage = await createStorage(memoryConfig());
      const queryVec = new Float32Array(32);
      const results = await storage.search(queryVec, { k: 5 });
      expect(results).toEqual([]);
    });

    it('count on empty storage returns 0', async () => {
      storage = await createStorage(memoryConfig());
      await expect(storage.count()).resolves.toBe(0);
    });
  });
});
