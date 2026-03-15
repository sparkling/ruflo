/**
 * ADR-0033 P6-B: COW (Copy-on-Write) Branching Tests
 *
 * Tests the derive/branchGet/branchStore/branchMerge methods on RvfBackend.
 * Uses in-memory mode (:memory:) to avoid filesystem I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RvfBackend } from '../rvf-backend.js';

function createInMemoryBackend(): RvfBackend {
  return new RvfBackend({
    databasePath: ':memory:',
    dimensions: 4,
    autoPersistInterval: 0,
  });
}

describe('ADR-0033 P6-B: COW Branching', () => {
  let backend: RvfBackend;

  beforeEach(async () => {
    backend = createInMemoryBackend();
    await backend.initialize();
  });

  afterEach(async () => {
    await backend.shutdown();
  });

  // ----- derive() -----

  describe('derive()', () => {
    it('should create a branch and return success with branchId and parentId', async () => {
      const result = await backend.derive('experiment-1');

      expect(result.success).toBe(true);
      expect(result.branchId).toMatch(/^branch:experiment-1:\d+$/);
      expect(result.parentId).toBe('default');
      expect(result.error).toBeUndefined();
    });

    it('should store branch metadata entry', async () => {
      const result = await backend.derive('test-branch');
      const metaKey = `_branch_meta:${result.branchId}`;

      const meta = await backend.getByKey('default', metaKey);
      expect(meta).not.toBeNull();

      const parsed = JSON.parse(meta!.content);
      expect(parsed.branchId).toBe(result.branchId);
      expect(parsed.branchName).toBe('test-branch');
      expect(parsed.parentId).toBe('default');
      expect(parsed.status).toBe('active');
      expect(parsed.writeCount).toBe(0);
    });

    it('should create unique branchIds for different branches', async () => {
      const r1 = await backend.derive('branch-a');
      const r2 = await backend.derive('branch-b');

      expect(r1.branchId).not.toBe(r2.branchId);
    });

    it('should tag metadata with branch-meta', async () => {
      const result = await backend.derive('tagged');
      const metaKey = `_branch_meta:${result.branchId}`;
      const meta = await backend.getByKey('default', metaKey);

      expect(meta!.tags).toContain('branch-meta');
    });
  });

  // ----- branchGet() -----

  describe('branchGet()', () => {
    it('should return branch-local value when it exists', async () => {
      const { branchId } = await backend.derive('local-read');
      await backend.branchStore(branchId, 'mykey', 'branch-value');

      const entry = await backend.branchGet(branchId, 'mykey');
      expect(entry).not.toBeNull();
      expect(entry!.content).toBe('branch-value');
    });

    it('should fall back to parent when branch key not found', async () => {
      // Store a value in the parent (unscoped key)
      await backend.store({
        id: 'parent-entry-1',
        key: 'shared-key',
        content: 'parent-value',
        type: 'working',
        namespace: 'default',
        tags: [],
        metadata: {},
        accessLevel: 'private',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
        references: [],
        accessCount: 0,
        lastAccessedAt: Date.now(),
      });

      const { branchId } = await backend.derive('fallback');

      const entry = await backend.branchGet(branchId, 'shared-key');
      expect(entry).not.toBeNull();
      expect(entry!.content).toBe('parent-value');
    });

    it('should return null when neither branch nor parent has key', async () => {
      const { branchId } = await backend.derive('empty');
      const entry = await backend.branchGet(branchId, 'nonexistent');
      expect(entry).toBeNull();
    });

    it('should prefer branch value over parent value', async () => {
      // Store parent value
      await backend.store({
        id: 'parent-shadow-1',
        key: 'shadowed',
        content: 'parent-original',
        type: 'working',
        namespace: 'default',
        tags: [],
        metadata: {},
        accessLevel: 'private',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
        references: [],
        accessCount: 0,
        lastAccessedAt: Date.now(),
      });

      const { branchId } = await backend.derive('shadow');
      await backend.branchStore(branchId, 'shadowed', 'branch-override');

      const entry = await backend.branchGet(branchId, 'shadowed');
      expect(entry!.content).toBe('branch-override');
    });
  });

  // ----- branchStore() -----

  describe('branchStore()', () => {
    it('should store with branch prefix key', async () => {
      const { branchId } = await backend.derive('store-test');
      const result = await backend.branchStore(branchId, 'mykey', 'myval');

      expect(result.success).toBe(true);

      // Verify the entry is stored with the branch-prefixed key
      const branchKey = `${branchId}:mykey`;
      const entry = await backend.getByKey('default', branchKey);
      expect(entry).not.toBeNull();
      expect(entry!.content).toBe('myval');
    });

    it('should tag branch data entries', async () => {
      const { branchId } = await backend.derive('tag-test');
      await backend.branchStore(branchId, 'k1', 'v1');

      const branchKey = `${branchId}:k1`;
      const entry = await backend.getByKey('default', branchKey);
      expect(entry!.tags).toContain('branch-data');
      expect(entry!.tags).toContain(branchId);
    });

    it('should update branch write count metadata', async () => {
      const { branchId } = await backend.derive('write-count');
      await backend.branchStore(branchId, 'k1', 'v1');
      await backend.branchStore(branchId, 'k2', 'v2');

      const metaKey = `_branch_meta:${branchId}`;
      const meta = await backend.getByKey('default', metaKey);
      const parsed = JSON.parse(meta!.content);
      expect(parsed.writeCount).toBe(2);
    });

    it('should not affect parent namespace', async () => {
      const { branchId } = await backend.derive('isolation');
      await backend.branchStore(branchId, 'isolated-key', 'branch-only');

      // Parent should not see the key without prefix
      const parent = await backend.getByKey('default', 'isolated-key');
      expect(parent).toBeNull();
    });
  });

  // ----- branchMerge() -----

  describe('branchMerge()', () => {
    it('should copy branch entries to parent', async () => {
      const { branchId } = await backend.derive('merge-test');
      await backend.branchStore(branchId, 'alpha', 'val-a');
      await backend.branchStore(branchId, 'beta', 'val-b');

      const result = await backend.branchMerge(branchId);
      expect(result.success).toBe(true);
      expect(result.mergedKeys).toBe(2);

      // Verify parent now has the merged entries
      const alpha = await backend.getByKey('default', 'alpha');
      expect(alpha).not.toBeNull();
      expect(alpha!.content).toBe('val-a');

      const beta = await backend.getByKey('default', 'beta');
      expect(beta).not.toBeNull();
      expect(beta!.content).toBe('val-b');
    });

    it('should mark branch as merged', async () => {
      const { branchId } = await backend.derive('merge-status');
      await backend.branchStore(branchId, 'x', 'y');
      await backend.branchMerge(branchId);

      const metaKey = `_branch_meta:${branchId}`;
      const meta = await backend.getByKey('default', metaKey);
      const parsed = JSON.parse(meta!.content);
      expect(parsed.status).toBe('merged');
      expect(parsed.mergedAt).toBeDefined();
      expect(parsed.mergedKeys).toBe(1);
    });

    it('should return count of merged keys', async () => {
      const { branchId } = await backend.derive('count-test');
      await backend.branchStore(branchId, 'k1', 'v1');
      await backend.branchStore(branchId, 'k2', 'v2');
      await backend.branchStore(branchId, 'k3', 'v3');

      const result = await backend.branchMerge(branchId);
      expect(result.mergedKeys).toBe(3);
    });

    it('should return zero merged keys for empty branch', async () => {
      const { branchId } = await backend.derive('empty-merge');
      const result = await backend.branchMerge(branchId);
      expect(result.success).toBe(true);
      expect(result.mergedKeys).toBe(0);
    });

    it('should strip branch tags from merged entries', async () => {
      const { branchId } = await backend.derive('tag-strip');
      await backend.branchStore(branchId, 'tagged-entry', 'content');
      await backend.branchMerge(branchId);

      const merged = await backend.getByKey('default', 'tagged-entry');
      expect(merged).not.toBeNull();
      expect(merged!.tags).not.toContain('branch-data');
      expect(merged!.tags).not.toContain(branchId);
    });

    it('should add mergedFrom metadata to merged entries', async () => {
      const { branchId } = await backend.derive('meta-merge');
      await backend.branchStore(branchId, 'with-meta', 'data');
      await backend.branchMerge(branchId);

      const merged = await backend.getByKey('default', 'with-meta');
      expect(merged!.metadata.mergedFrom).toBe(branchId);
    });
  });
});
