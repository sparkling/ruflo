/**
 * BoundedLRU<K, V> — generic LRU cache for long-lived process resource discipline.
 *
 * ADR-0243 (CT-J Site #1, #5): factored from `HiveLRU`
 * (hive-mind-tools.ts:868-931) so the ruvllm WASM-handle Maps and the
 * hooks-tools `activeTrajectories` Map can share one bounded-cache shape
 * without two near-duplicate implementations. The shape matches `HiveLRU`
 * verbatim where it can — fail-loud on invalid `maxEntries`, move-to-front
 * on `get`, eviction = drop oldest insertion key — and adds:
 *
 *   1. A `dispose` probe: on eviction, look for `destroy`/`free`/`dispose`
 *      on the evicted value (in that priority order) and call the first
 *      method found. This is the contract the F-10-001 NAPI/WASM handles
 *      need so that a bounded JS Map does not become a "bounded JS leak
 *      with unbounded WASM heap" — see ADR-0243 §Critique outcomes
 *      (Expert 1, NAPI/WASM handle lifecycle).
 *
 *   2. An optional idle-TTL: per ADR-0243 F-10-005, `activeTrajectories`
 *      can be orphaned by a buggy client that calls `trajectory-start`
 *      without ever calling `trajectory-end`. When `idleTtlMs` is set,
 *      `set()` records a wall-clock timestamp per key and `get()` evicts
 *      entries whose age exceeds the TTL on access. Default: TTL disabled.
 *
 * Failure modes (per `feedback-no-fallbacks`):
 *   - `maxEntries` non-finite, non-positive, or non-integer → throw at
 *     construction. Caller must produce a valid positive integer.
 *   - `idleTtlMs` non-finite or negative → throw at construction. Zero
 *     means "disabled" (no TTL evaluation).
 *
 * Env-driven defaults are NOT in this file; each callsite reads its own
 * env var (`RUFLO_BOUNDED_LRU_MAX`, `CLAUDE_FLOW_RUVLLM_CACHE_MAX`, etc.)
 * and passes the parsed integer to the constructor. This keeps the env
 * surface visible at the callsite rather than hidden in a shared utility.
 */

export type DisposeFn<V> = (value: V) => void;

export interface BoundedLRUOptions<V> {
  /** Max entries to retain. Eviction = drop oldest insertion key once exceeded. */
  maxEntries: number;
  /**
   * Optional explicit dispose function. When set, takes priority over the
   * auto-probe (destroy/free/dispose). Call when you want a hard-coded
   * dispose path or one the auto-probe cannot find (e.g. `.close()`).
   */
  dispose?: DisposeFn<V>;
  /**
   * Optional idle TTL in milliseconds. When > 0, `get()` evicts entries
   * whose `Date.now() - lastTouched > idleTtlMs`. Default: 0 (disabled).
   * Use for client-failure-mode protection on registries that depend on
   * an explicit "end" call (e.g. `activeTrajectories`).
   */
  idleTtlMs?: number;
}

interface Entry<V> {
  value: V;
  /** ms since epoch when last set or get'd. Only consulted when idleTtlMs > 0. */
  touchedAt: number;
}

/**
 * Probe a value for a method to call on eviction. Returns the first of
 * `destroy`/`free`/`dispose` that exists as a function, or undefined.
 *
 * Priority order rationale (per ADR-0243 §Critique Expert 1):
 *   - `destroy` is the NAPI convention (HnswRouter, SonaInstant, MicroLora).
 *   - `free` is the WASM/raw-buffer convention.
 *   - `dispose` is the broader `[Symbol.dispose]`-adjacent convention.
 */
function probeDispose<V>(value: V): DisposeFn<V> | undefined {
  if (value === null || value === undefined) return undefined;
  const obj = value as unknown as Record<string, unknown>;
  for (const name of ['destroy', 'free', 'dispose'] as const) {
    const fn = obj[name];
    if (typeof fn === 'function') {
      return (v) => {
        // Re-resolve at call-time in case the method was reassigned.
        const m = (v as unknown as Record<string, unknown>)[name] as unknown;
        if (typeof m === 'function') {
          (m as (...args: unknown[]) => unknown).call(v);
        }
      };
    }
  }
  return undefined;
}

export class BoundedLRU<K, V> {
  private readonly store = new Map<K, Entry<V>>();
  private readonly maxEntries: number;
  private readonly disposeOverride: DisposeFn<V> | undefined;
  private readonly idleTtlMs: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private ttlEvictions = 0;

  constructor(opts: BoundedLRUOptions<V>) {
    if (!Number.isFinite(opts.maxEntries) || !Number.isInteger(opts.maxEntries) || opts.maxEntries < 1) {
      // Fail-loud per feedback-no-fallbacks: an invalid capacity should not
      // silently default. Caller must produce a positive integer.
      throw new Error(
        `BoundedLRU: maxEntries must be a positive integer, got ${opts.maxEntries}`,
      );
    }
    if (opts.idleTtlMs !== undefined) {
      if (!Number.isFinite(opts.idleTtlMs) || opts.idleTtlMs < 0) {
        throw new Error(
          `BoundedLRU: idleTtlMs must be a non-negative finite number, got ${opts.idleTtlMs}`,
        );
      }
    }
    this.maxEntries = opts.maxEntries;
    this.disposeOverride = opts.dispose;
    this.idleTtlMs = opts.idleTtlMs ?? 0;
  }

  /**
   * Read max-entries from `envName`, fall back to `defaultValue` when unset.
   * Throws on a set-but-unparseable value (fail-loud).
   */
  static readEnvMax(envName: string, defaultValue: number): number {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') return defaultValue;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(
        `BoundedLRU: ${envName} must be a positive integer, got ${JSON.stringify(raw)}`,
      );
    }
    return parsed;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    if (this.idleTtlMs > 0) {
      const age = Date.now() - entry.touchedAt;
      if (age > this.idleTtlMs) {
        this.store.delete(key);
        this.disposeEntry(entry.value);
        this.ttlEvictions++;
        this.misses++;
        return undefined;
      }
    }
    // Move-to-front: delete + re-set advances insertion-order to "newest".
    this.store.delete(key);
    entry.touchedAt = Date.now();
    this.store.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: K, value: V): void {
    const existing = this.store.get(key);
    if (existing !== undefined) {
      // Re-set on existing key: dispose the old value before overwriting
      // (a different WASM handle may now occupy the same id slot).
      this.store.delete(key);
      if (existing.value !== value) {
        this.disposeEntry(existing.value);
      }
    }
    this.store.set(key, { value, touchedAt: Date.now() });
    while (this.store.size > this.maxEntries) {
      // Map.keys() in JS returns insertion-order; first key is the oldest.
      const it = this.store.keys().next();
      if (it.done) break;
      const oldest = it.value as K;
      const oldEntry = this.store.get(oldest);
      this.store.delete(oldest);
      if (oldEntry !== undefined) this.disposeEntry(oldEntry.value);
      this.evictions++;
    }
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  delete(key: K): boolean {
    const entry = this.store.get(key);
    if (entry === undefined) return false;
    this.store.delete(key);
    this.disposeEntry(entry.value);
    return true;
  }

  /**
   * Clear all entries. Disposes each value via the dispose contract.
   */
  clear(): void {
    for (const entry of this.store.values()) {
      this.disposeEntry(entry.value);
    }
    this.store.clear();
  }

  /**
   * Iterate values in insertion order (oldest first). Does NOT count as
   * an access — touchedAt is not updated. Caller is responsible for any
   * TTL-driven decisions (e.g. `prune()` for an explicit sweep).
   */
  *values(): IterableIterator<V> {
    for (const entry of this.store.values()) {
      yield entry.value;
    }
  }

  /**
   * Iterate [key, value] pairs in insertion order (oldest first). Same
   * non-touching semantics as `values()`.
   */
  *entries(): IterableIterator<[K, V]> {
    for (const [k, entry] of this.store.entries()) {
      yield [k, entry.value];
    }
  }

  /**
   * Sweep TTL-expired entries. Only meaningful when `idleTtlMs > 0`;
   * a no-op when TTL is disabled. Use to proactively reclaim resources
   * without waiting for the next `get()`.
   */
  prune(): number {
    if (this.idleTtlMs <= 0) return 0;
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.touchedAt > this.idleTtlMs) {
        this.store.delete(key);
        this.disposeEntry(entry.value);
        this.ttlEvictions++;
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.store.size;
  }

  stats(): {
    hits: number;
    misses: number;
    evictions: number;
    ttlEvictions: number;
    size: number;
    capacity: number;
  } {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      ttlEvictions: this.ttlEvictions,
      size: this.store.size,
      capacity: this.maxEntries,
    };
  }

  private disposeEntry(value: V): void {
    if (this.disposeOverride) {
      try {
        this.disposeOverride(value);
      } catch {
        // dispose is best-effort during eviction — do not propagate.
      }
      return;
    }
    const probe = probeDispose(value);
    if (probe !== undefined) {
      try {
        probe(value);
      } catch {
        // dispose is best-effort during eviction — do not propagate.
      }
    }
  }
}
