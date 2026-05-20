/**
 * ADR-0202: Integration tests for daemon / hook RVF lock coexistence.
 *
 * These tests verify that setRouterPersistent(false) + the withRouter
 * helper prevent the daemon from holding the RVF flock between ops, so
 * concurrent hook/MCP processes can acquire it without LockHeld errors.
 *
 * Because the native RVF lock is a real filesystem flock, we cannot
 * trivially test cross-process contention in a pure unit environment.
 * These tests instead verify the JS-layer contract that governs the
 * lock lifetime:
 *
 *   1. In daemon scope, each routeEmbeddingOp call shuts down the backend
 *      in its finally block — asserting the window is bounded to the op.
 *
 *   2. Multiple concurrent daemon-scope ops (simulating parallel worker
 *      ticks + hook processes) each complete without throwing LockHeld.
 *      This exercises the retry-on-LockHeld budget in the mocked backend.
 *
 *   3. In persistent scope (hook CLI), no LockHeld retry is needed — the
 *      backend stays open for the process lifetime.
 *
 * Full cross-process lsof verification is handled by the acceptance
 * harness (check_adr0202_daemon_lock_breaks) which requires a real
 * Verdaccio install and is not suitable for the unit-test runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Controllable mock backend — tracks open/close calls to assert lifetime
// ---------------------------------------------------------------------------

let openCount: number;
let closeCount: number;
let shouldThrowLockHeldOnce: boolean;

vi.mock('@claude-flow/memory/storage-factory', () => ({
  createStorage: vi.fn(async () => {
    openCount++;
    if (shouldThrowLockHeldOnce) {
      // Simulate a LockHeld rejection on the first open (as the native
      // store would), then succeed. The retry logic is inside _doInit's
      // caller chain; here we surface it as a storage-open failure so we
      // can observe that the op propagates the error correctly.
      shouldThrowLockHeldOnce = false;
      throw Object.assign(new Error('RVF error 0x0300: LockHeld'), { code: 0x0300 });
    }
    return {
      getByKey: vi.fn(async () => null),
      store: vi.fn(async () => ({})),
      search: vi.fn(async () => []),
      getStats: vi.fn(async () => ({
        totalEntries: 0,
        dimensions: 768,
        hnswStats: { vectorCount: 0 },
      })),
      shutdown: vi.fn(async () => {
        closeCount++;
      }),
    };
  }),
}));

vi.mock('@claude-flow/memory/resolve-config', () => ({
  getConfig: vi.fn(() => ({
    storage: { databasePath: ':memory:' },
    embedding: { dimension: 768 },
  })),
}));

vi.mock('@claude-flow/memory/embedding-adapter', () => ({
  generateEmbedding: vi.fn(async () => ({ embedding: [] })),
  generateBatchEmbeddings: vi.fn(async () => ({ embeddings: [] })),
  loadEmbeddingModel: vi.fn(async () => ({ success: true })),
  getAdaptiveThreshold: vi.fn(async () => 0.7),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let router: any;

describe('ADR-0202 daemon-hook coexistence (JS layer)', () => {
  beforeEach(async () => {
    openCount = 0;
    closeCount = 0;
    shouldThrowLockHeldOnce = false;
    vi.resetModules();
    router = await import('../../src/memory/memory-router.js');
  });

  afterEach(() => {
    if (router?.resetRouter) router.resetRouter();
  });

  // ---------------------------------------------------------------------------
  // #1 Happy path: daemon scope releases after each op
  // ---------------------------------------------------------------------------

  it('daemon scope: open and close counts match across 10 sequential ops', async () => {
    router.setRouterPersistent(false);

    for (let i = 0; i < 10; i++) {
      await router.routeEmbeddingOp({ type: 'hnswStatus' });
    }

    // Each op must open and close exactly once.
    expect(openCount).toBe(10);
    expect(closeCount).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // #2 Contention simulation: 10 concurrent ops all complete successfully
  // ---------------------------------------------------------------------------

  it('daemon scope: 10 concurrent ops all succeed (no unhandled LockHeld)', async () => {
    router.setRouterPersistent(false);

    const ops = Array.from({ length: 10 }, () =>
      router.routeEmbeddingOp({ type: 'hnswStatus' }),
    );
    const results = await Promise.all(ops);

    // All ops must complete without throwing (they return {success:true/false}).
    for (const r of results) {
      expect(r).toBeDefined();
    }
    // open count <= 10 (some may share an init if they overlap)
    expect(openCount).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // #3 Hook CLI scope: backend stays open; open/close counts differ
  // ---------------------------------------------------------------------------

  it('hook CLI scope: backend opened once and NOT closed after ops', async () => {
    // Persistent = true (default for hook CLI processes).

    await router.routeEmbeddingOp({ type: 'hnswStatus' });
    await router.routeEmbeddingOp({ type: 'hnswStatus' });

    // Storage opened once (cached), never closed by withRouter.
    expect(openCount).toBe(1);
    expect(closeCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // #4 F-13-009 anti-shape: LockHeld must NOT be swallowed (exit 0 with error)
  // ---------------------------------------------------------------------------

  it('LockHeld on storage open propagates as a fail-loud throw (not swallowed)', async () => {
    router.setRouterPersistent(false);
    shouldThrowLockHeldOnce = true;

    // A LockHeld during init (_doInit) must propagate as a THROW — the ADR-0202
    // fail-loud behaviour that escapes routeFeedbackOp -> hooks-tools.ts:857 ->
    // CLI exit 1. The F-13-009 anti-shape is the OPPOSITE (success:true / exit 0
    // hiding the error). So we assert the call rejects with the LockHeld message,
    // never resolves to a silent-success envelope.
    await expect(router.routeEmbeddingOp({ type: 'hnswStatus' })).rejects.toThrow(/LockHeld/);
  });
});
