/**
 * ADR-0243 F-10-007 — RvfBackend._pendingNativeIngest eager-flush +
 * re-entrancy-safe flag ordering.
 *
 * Before this ADR, `ensureNativeSemanticReady` set
 * `_nativeRehydrated = true` BEFORE the ingest loop. Two hazards:
 *   1. A re-entrant call during `ingestBatch` would see
 *      `_nativeRehydrated = true` AND a still-populated buffer.
 *   2. A fallback-degradation throw mid-loop left the buffer holding
 *      ~300MB (100K × Float32Array at 768-dim) AND marked rehydrated,
 *      so no retry would ever run.
 *
 * The fix per ADR-0243 §Decision F-10-007: flip `_nativeRehydrated`
 * only AFTER the buffer is cleared. Re-entrancy is safe, and a
 * fallback-degrade exit leaves the flag false so a subsequent attempt
 * can retry the ingest.
 *
 * Behavior test: load 100K entries into the pending buffer without
 * calling `search()`; call `ensureNativeSemanticReady` directly; assert
 * `_pendingNativeIngest.length === 0`.
 *
 * Stubs out the real `@ruvector/rvf-node` binding (an optional dep that
 * is NOT installed in the fork's test runtime) by injecting a minimal
 * `nativeDb` mock onto the backend instance, matching the test pattern
 * used by `rvf-backend-dim-adopt.test.ts`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RvfBackend } from './rvf-backend.js';

function makeBackend(): RvfBackend {
  return new RvfBackend({
    databasePath: ':memory:',
    dimensions: 8, // keep vectors tiny — the test asserts buffer state, not vector content
  });
}

interface IngestBatchCall {
  vectors: Float32Array;
  ids: number[];
  metaEntries: unknown;
}

function installNativeStub(backend: RvfBackend) {
  const calls: IngestBatchCall[] = [];
  const nativeStub = {
    ingestBatch(vectors: Float32Array, ids: number[], metaEntries: unknown) {
      calls.push({ vectors, ids, metaEntries });
    },
    query() {
      return [] as Array<{ id: number; score: number }>;
    },
    dimension() {
      return 8;
    },
  };
  (backend as any).nativeDb = nativeStub;
  // The real `assignNativeId` consults `nativeReverseMap`; the stub path
  // just needs an incrementing counter so each id gets a unique numId.
  let counter = 1;
  (backend as any).assignNativeId = (stringId: string) => {
    const n = counter++;
    (backend as any).nativeReverseMap?.set?.(n, stringId);
    return n;
  };
  // Ensure the nativeReverseMap exists (the real one is constructed in
  // initialize; we shortcut that here).
  if (!(backend as any).nativeReverseMap) {
    (backend as any).nativeReverseMap = new Map<number, string>();
  }
  return { calls };
}

function loadPendingEntries(backend: RvfBackend, count: number): void {
  const pending: Array<{ id: string; embedding: Float32Array }> = [];
  for (let i = 0; i < count; i++) {
    pending.push({
      id: `entry-${i}`,
      embedding: new Float32Array(8), // zeroed; vector content irrelevant to the test
    });
  }
  (backend as any)._pendingNativeIngest = pending;
}

describe('ADR-0243 F-10-007 — _pendingNativeIngest eager flush', () => {
  let backend: RvfBackend;
  let stub: ReturnType<typeof installNativeStub>;

  beforeEach(() => {
    backend = makeBackend();
    stub = installNativeStub(backend);
  });

  it('drains 100K entries from the buffer in one ensureNativeSemanticReady call', () => {
    loadPendingEntries(backend, 100_000);
    expect((backend as any)._pendingNativeIngest.length).toBe(100_000);
    expect((backend as any)._nativeRehydrated).toBe(false);

    // Call the (private) rehydrate path directly — the mission's test
    // contract.
    (backend as any).ensureNativeSemanticReady();

    expect((backend as any)._pendingNativeIngest.length).toBe(0);
    expect((backend as any)._nativeRehydrated).toBe(true);
    expect(stub.calls.length).toBe(100_000);
  });

  it('is idempotent — second call is a no-op (flag is set after the first clear)', () => {
    loadPendingEntries(backend, 10);
    (backend as any).ensureNativeSemanticReady();
    expect(stub.calls.length).toBe(10);

    // Manually re-populate the buffer; the second call MUST NOT touch
    // the native side because `_nativeRehydrated` is true.
    loadPendingEntries(backend, 5);
    (backend as any).ensureNativeSemanticReady();
    expect(stub.calls.length).toBe(10); // unchanged
    // The buffer is NOT cleared on the no-op path (the early return is
    // legitimate). Pre-ADR-0243 the same buffer would have been
    // re-ingested after the first call already set the flag.
    expect((backend as any)._pendingNativeIngest.length).toBe(5);
  });

  it('handles the cold path — nativeDb null is a no-op (no flag flip)', () => {
    (backend as any).nativeDb = null;
    loadPendingEntries(backend, 3);
    (backend as any).ensureNativeSemanticReady();
    // The function early-returns on nativeDb null; the buffer is
    // intentionally not cleared (HnswLite paths handle the entries).
    expect((backend as any)._pendingNativeIngest.length).toBe(3);
    expect((backend as any)._nativeRehydrated).toBe(false);
  });

  it('handles the empty-buffer path — flag flips even with nothing to ingest', () => {
    // No entries loaded.
    expect((backend as any)._pendingNativeIngest.length).toBe(0);
    (backend as any).ensureNativeSemanticReady();
    expect((backend as any)._nativeRehydrated).toBe(true);
    expect(stub.calls.length).toBe(0);
  });
});
