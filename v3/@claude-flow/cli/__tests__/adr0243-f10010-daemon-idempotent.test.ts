/**
 * ADR-0243 F-10-010 — module-scope idempotency gate on
 * `setupShutdownHandlers` + `installCrashHandlers`.
 *
 * Before this ADR, `WorkerDaemon`'s constructor called
 * `setupShutdownHandlers` (3 listeners: SIGTERM/SIGINT/SIGHUP) and
 * `installCrashHandlers` (2 listeners: uncaughtException/
 * unhandledRejection) unconditionally. Multiple `WorkerDaemon`
 * constructions in one process (e.g. the `daemon trigger` path
 * constructs a fresh instance per call) doubled the listener count per
 * restart. ~3 restarts triggered `MaxListenersExceededWarning`; the
 * listener-store memory grew from start 1.
 *
 * The fix is module-scope `let daemonShutdownHandlersInstalled = false;
 * let daemonCrashHandlersInstalled = false;` gates on the two setup
 * functions, per ADR-0243 §Critique Expert 3 (the flag MUST be
 * module-scope, not instance-scope, because each new `WorkerDaemon` has
 * its own instance fields). Same shape as
 * `forks/agentdb/src/archivist/audit-writer.ts::installSignalHandlersOnce`.
 *
 * Behaviour test: construct two `WorkerDaemon` instances back-to-back
 * (the constructor wires both handler sets); assert listener counts
 * STAY AT THE BASELINE of one rather than doubling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Stub `agentdb/archivist` to avoid vitest transform-time resolution of
// an optional dep that is not installed in the fork's test runtime. Same
// pattern as `__tests__/hive-mind-consensus-parity.test.ts`. The daemon
// test does not invoke the archivist itself (constructor wires handlers
// before `initializeArchivist()` runs); the stub just lets the import
// graph resolve.
vi.mock('agentdb/archivist', () => ({
  Archivist: class StubArchivist {
    async initialize(): Promise<void> { /* no-op */ }
    async dispatch(): Promise<undefined> { return undefined; }
    async dispatchRead(): Promise<undefined> { return undefined; }
  },
  setAuditLogPath: vi.fn(),
}));

import { WorkerDaemon, __resetDaemonHandlerInstallFlagsForTests } from '../src/services/worker-daemon.js';

const HOOKED_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
const CRASH_EVENTS = ['uncaughtException', 'unhandledRejection'] as const;

function snapshotListenerCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of HOOKED_SIGNALS) out[s] = process.listenerCount(s);
  for (const e of CRASH_EVENTS) out[e] = process.listenerCount(e);
  return out;
}

describe('ADR-0243 F-10-010 — daemon signal/crash handler idempotency', () => {
  let tmpDir: string;
  let baselineListeners: Record<string, number>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr0243-daemon-'));
    fs.mkdirSync(path.join(tmpDir, '.claude-flow'), { recursive: true });
    __resetDaemonHandlerInstallFlagsForTests();
    baselineListeners = snapshotListenerCounts();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Drain any handlers this test installed so other tests in the same
    // worker process don't see stale listeners. We can't selectively
    // remove just our `shutdown`/`onCrash` closures (we don't have refs),
    // so use removeAllListeners on the signals/events whose counts we
    // expect to have ticked up — but ONLY back down to the baseline.
    for (const s of HOOKED_SIGNALS) {
      if (process.listenerCount(s) > baselineListeners[s]) {
        process.removeAllListeners(s);
      }
    }
    for (const e of CRASH_EVENTS) {
      if (process.listenerCount(e) > baselineListeners[e]) {
        process.removeAllListeners(e);
      }
    }
    __resetDaemonHandlerInstallFlagsForTests();
  });

  it('installs each signal handler exactly once across multiple WorkerDaemon constructions', () => {
    // First construction wires the handlers.
    new WorkerDaemon(tmpDir, { autoStart: false });
    const afterFirst = snapshotListenerCounts();
    for (const s of HOOKED_SIGNALS) {
      expect(afterFirst[s] - baselineListeners[s]).toBe(1);
    }
    for (const e of CRASH_EVENTS) {
      expect(afterFirst[e] - baselineListeners[e]).toBe(1);
    }

    // Second construction MUST NOT add another listener (idempotency
    // gate). Pre-ADR-0243 this would double each count.
    new WorkerDaemon(tmpDir, { autoStart: false });
    const afterSecond = snapshotListenerCounts();
    for (const s of HOOKED_SIGNALS) {
      expect(afterSecond[s] - baselineListeners[s]).toBe(1);
    }
    for (const e of CRASH_EVENTS) {
      expect(afterSecond[e] - baselineListeners[e]).toBe(1);
    }

    // Third construction — same assertion. The idempotency gate is
    // module-scope, so it survives across instances.
    new WorkerDaemon(tmpDir, { autoStart: false });
    const afterThird = snapshotListenerCounts();
    for (const s of HOOKED_SIGNALS) {
      expect(afterThird[s] - baselineListeners[s]).toBe(1);
    }
    for (const e of CRASH_EVENTS) {
      expect(afterThird[e] - baselineListeners[e]).toBe(1);
    }
  });

  it('the test-only reset re-arms the install path (regression guard for the reset helper itself)', () => {
    new WorkerDaemon(tmpDir, { autoStart: false });
    const after1 = process.listenerCount('SIGTERM');

    __resetDaemonHandlerInstallFlagsForTests();
    new WorkerDaemon(tmpDir, { autoStart: false });
    const after2 = process.listenerCount('SIGTERM');

    // The reset re-arms install — second construction adds another
    // listener after the reset. This confirms the gate is the ONLY
    // thing preventing re-install (no hidden double-gate).
    expect(after2 - after1).toBe(1);
  });
});
