/**
 * Error classes for the RVF backend.
 *
 * Extracted from rvf-backend.ts (ADR-0154 G7 follow-up 2026-05-07).
 * Resolves the constructor-collision concern documented in the original
 * file (the source-structural test at
 * tests/unit/adr0086-rvf-integration.test.mjs:87 used a regex that
 * could match either RvfBackend's constructor or one of these error
 * classes' constructors — moving them out leaves only RvfBackend's
 * `constructor` in rvf-backend.ts).
 */

/**
 * Fail-loud signal from `loadFromDisk()` when the on-disk RVF file is
 * unreadable: bad magic, truncated header, garbage payload.
 *
 * Pre-fix behaviour: `loadFromDisk()` swallowed JSON.parse errors and
 * silently re-initialized with empty state. Next persist would then
 * overwrite the corrupt file with the empty Map — a destructive,
 * data-losing fallback (ADR-0082 §"silent fallback antipattern").
 *
 * The class is named so memory-router._isFatalInitError() and
 * agentdb-backend.ts's known-fatals catalog pick it up and propagate
 * it through registry/init catches without masking. (See
 * agentdb-backend.ts:280, 335 for the named-class registry.)
 *
 * Removing the corrupt file requires explicit operator action (move or
 * delete it, or restore from a backup) — never automatic, never silent.
 */
export class RvfCorruptError extends Error {
  constructor(path: string, reason: string) {
    super(
      `RVF storage at ${path} is corrupt: ${reason}. ` +
      `No WAL recovery data available. Refusing to start with empty state ` +
      `to prevent silent overwrite of the corrupt file on next persist. ` +
      `Move or delete the file to start fresh, or restore from a backup.`,
    );
    this.name = 'RvfCorruptError';
  }
}

/**
 * ADR-0112 Phase 2 (RVF track): fail-loud signal for data-path methods
 * called before `initialize()` has completed.
 *
 * Pre-fix behavior: data-path methods (store / get / query / search /
 * etc.) had no init guard and would operate against the constructor-
 * initialized empty Map + null nativeDb. Writes appeared to succeed
 * (entry landed in the Map) but persistence failed silently and the
 * native HNSW index was never updated. Reads returned empty without
 * indicating the backend had never loaded its on-disk state. This is
 * the exact ADR-0082 silent-fallback antipattern at the method-level
 * (W1.5/W1.6 fixed init-time, W1.8 closes method-time per ADR-0112
 * §Required follow-up #1 "Both contracts apply at the method level").
 *
 * The class is named so memory-router._isFatalInitError() picks it up
 * and propagates it through registry/init catches without masking.
 *
 * Callers receive the method name in the error message so the failure
 * is precisely diagnosable ("RvfBackend.store called before
 * initialize() — backend is not initialized" vs. a generic guard).
 */
export class RvfNotInitializedError extends Error {
  constructor(method: string) {
    super(
      `RvfBackend.${method} called before initialize() — backend is not ` +
      `initialized. Per ADR-0112, public methods must fail loud rather than ` +
      `silently operate against a constructor-only state (which would lose ` +
      `data on persist + skip native HNSW indexing). Call initialize() first.`,
    );
    this.name = 'RvfNotInitializedError';
  }
}
