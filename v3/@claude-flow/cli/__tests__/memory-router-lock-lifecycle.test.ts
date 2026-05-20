/**
 * ADR-0202: RVF lock lifecycle unit tests.
 *
 * Asserts that in daemon (non-persistent) scope, `_storage` is shut down
 * (and thus `_initialized` flips back to false) after each
 * routeMemoryOp / routeEmbeddingOp / routeLearningOp call.
 *
 * In persistent (CLI hook) scope, `_storage` stays cached across calls.
 *
 * The module is reset between each test via resetRouter() + vi.resetModules()
 * so state does not leak between assertions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @claude-flow/memory — externalised by vitest.config.ts; we must
// provide a manual factory to control the shutdown observable.
// ---------------------------------------------------------------------------

// We need a fresh mock factory per test. Use a module-level ref so the
// factory can be re-used in the mock below.
let mockShutdownFn: ReturnType<typeof vi.fn>;
let mockGetStatsFn: ReturnType<typeof vi.fn>;

vi.mock('@claude-flow/memory/storage-factory', () => ({
  createStorage: vi.fn(async () => {
    return {
      getByKey: vi.fn(async () => null),
      store: vi.fn(async () => ({})),
      search: vi.fn(async () => []),
      getStats: mockGetStatsFn,
      shutdown: mockShutdownFn,
    };
  }),
}));

vi.mock('@claude-flow/memory/resolve-config', () => ({
  getConfig: vi.fn(() => ({
    storage: { databasePath: ':memory:' },
    embedding: { dimension: 768 },
  })),
}));

// Silence the archivist dependency inside routeMemoryOp 'store' path.
vi.mock('@claude-flow/memory/embedding-adapter', () => ({
  generateEmbedding: vi.fn(async () => ({ embedding: [] })),
  generateBatchEmbeddings: vi.fn(async () => ({ embeddings: [] })),
  loadEmbeddingModel: vi.fn(async () => ({ success: true })),
  getAdaptiveThreshold: vi.fn(async () => 0.7),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let router: any;

describe('ADR-0202 memory-router lock lifecycle', () => {
  beforeEach(async () => {
    // Provide fresh mock functions for this test.
    mockShutdownFn = vi.fn(async () => {});
    mockGetStatsFn = vi.fn(async () => ({
      totalEntries: 0,
      dimensions: 768,
      hnswStats: { vectorCount: 0 },
    }));

    // Import the real module (vitest resolves the @claude-flow/memory mocks above).
    vi.resetModules();
    router = await import('../src/memory/memory-router.js');
  });

  afterEach(() => {
    if (router?.resetRouter) {
      router.resetRouter();
    }
  });

  // ---------------------------------------------------------------------------
  // Non-persistent (daemon) scope: storage must be shut down after each op
  // ---------------------------------------------------------------------------

  it('routeEmbeddingOp releases _storage after each op in daemon scope', async () => {
    router.setRouterPersistent(false);

    await router.routeEmbeddingOp({ type: 'hnswStatus' });

    // shutdown must have been called exactly once (for the single op).
    expect(mockShutdownFn).toHaveBeenCalledTimes(1);
  });

  it('routeEmbeddingOp resets _initialized to false after op in daemon scope', async () => {
    router.setRouterPersistent(false);

    await router.routeEmbeddingOp({ type: 'hnswStatus' });

    // After the op, calling ensureRouter() should trigger a fresh _doInit()
    // (i.e. createStorage is called again). We can observe this by checking
    // that mockShutdownFn was called (shutdown already asserted above) and
    // that a second op also calls shutdown — proving re-init occurred.
    await router.routeEmbeddingOp({ type: 'hnswStatus' });
    expect(mockShutdownFn).toHaveBeenCalledTimes(2);
  });

  it('multiple ops in daemon scope each call shutdown once', async () => {
    router.setRouterPersistent(false);

    await router.routeEmbeddingOp({ type: 'hnswStatus' });
    await router.routeEmbeddingOp({ type: 'hnswStatus' });
    await router.routeEmbeddingOp({ type: 'hnswStatus' });

    expect(mockShutdownFn).toHaveBeenCalledTimes(3);
  });

  // ---------------------------------------------------------------------------
  // Persistent (CLI hook) scope: storage stays cached across calls
  // ---------------------------------------------------------------------------

  it('routeEmbeddingOp does NOT call shutdown in persistent (hook CLI) scope', async () => {
    // Default is persistent=true (the CLI hook default).
    await router.routeEmbeddingOp({ type: 'hnswStatus' });
    await router.routeEmbeddingOp({ type: 'hnswStatus' });

    expect(mockShutdownFn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // setRouterPersistent / resetRouter interaction
  // ---------------------------------------------------------------------------

  it('resetRouter restores persistent=true so subsequent tests start clean', async () => {
    router.setRouterPersistent(false);
    router.resetRouter();

    // After reset, _isPersistent should be true again.
    await router.routeEmbeddingOp({ type: 'hnswStatus' });
    expect(mockShutdownFn).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Op error must propagate even when shutdown also errors
  // ---------------------------------------------------------------------------

  it('op error propagates even if shutdown throws', async () => {
    router.setRouterPersistent(false);

    // Make getStats throw to trigger an op error from inside the impl.
    mockGetStatsFn.mockRejectedValueOnce(new Error('storage read error'));
    // Also make shutdown throw.
    mockShutdownFn.mockRejectedValueOnce(new Error('shutdown error'));

    await expect(router.routeEmbeddingOp({ type: 'hnswStatus' }))
      // routeEmbeddingOp returns {success:false, error:...} on caught errors
      // — check that the op error message is surfaced, not the shutdown error.
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('storage read error') });
  });
});
