/**
 * Phase 1 — Public API surface tests (ADR-125)
 *
 * Asserts that:
 * - `MemoryService` is the canonical exported entry point.
 * - `UnifiedMemoryService` remains exported as a deprecated alias to the same class.
 * - `HnswLite` and `RvfBackend` are NOT exported from the top-level package surface.
 */

import { describe, it, expect } from 'vitest';
import * as memoryPkg from './index.js';

describe('Phase 1 — canonical public exports', () => {
  it('exports `MemoryService` as the canonical entry point', () => {
    expect(memoryPkg).toHaveProperty('MemoryService');
    expect(typeof (memoryPkg as any).MemoryService).toBe('function');
  });

  it('also exports `UnifiedMemoryService` as a deprecated alias', () => {
    expect(memoryPkg).toHaveProperty('UnifiedMemoryService');
    expect(typeof (memoryPkg as any).UnifiedMemoryService).toBe('function');
  });

  it('`MemoryService` and `UnifiedMemoryService` reference the same class', () => {
    expect((memoryPkg as any).MemoryService).toBe((memoryPkg as any).UnifiedMemoryService);
  });

  it('does NOT expose `HnswLite` from the top-level package', () => {
    expect(memoryPkg).not.toHaveProperty('HnswLite');
  });

  it('does NOT expose `RvfBackend` from the top-level package', () => {
    expect(memoryPkg).not.toHaveProperty('RvfBackend');
  });

  it('does NOT expose DDD layer types from the top-level package', () => {
    // These live under src/domain, src/application, src/infrastructure
    // and have never been re-exported from index.ts — assert that invariant.
    expect(memoryPkg).not.toHaveProperty('StoreMemoryCommandHandler');
    expect(memoryPkg).not.toHaveProperty('SearchMemoryQueryHandler');
    expect(memoryPkg).not.toHaveProperty('HybridMemoryRepository');
  });

  it('continues to expose the backend constructors that PR A keeps public', () => {
    // Backends that downstream packages import directly remain stable.
    expect(memoryPkg).toHaveProperty('AgentDBBackend');
    expect(memoryPkg).toHaveProperty('SQLiteBackend');
    // Fork-only adaptation per ADR-0230 Phase 1 take + step F (Phase 2 adapter):
    // `SqlJsBackend` is not vendored on the fork tree (upstream-only sql.js
    // fallback module — fork uses better-sqlite3 native path). `HybridBackend`
    // lands via ADR-0230 step F (cherry-pick `11eaef851` ADAPT). When step F
    // lands, re-enable the `HybridBackend` assertion. SqlJsBackend assertion
    // stays disabled per fork policy.
    // expect(memoryPkg).toHaveProperty('SqlJsBackend');  // fork-skip: not vendored
    // expect(memoryPkg).toHaveProperty('HybridBackend'); // TODO(adr-0230-step-F)
  });
});
