/**
 * ADR-0121 (T3) — State-based CRDT primitives for hive-mind consensus.
 *
 * Three CvRDT lattices used by the `'crdt'` consensus strategy:
 *   - GCounter      — monotonic vote-count accumulation per voter
 *   - ORSet         — set of approving voter IDs (observed-remove semantics)
 *   - LWWRegister   — single-value verdict with last-write-wins tiebreak
 *
 * Convergence is mathematical, not protocol-driven: each `merge` is
 * commutative, associative, and idempotent. Re-broadcast is safe — the
 * same state can be merged any number of times in any order without
 * divergence.
 *
 * All state shapes are JSON-serialisable. Per ADR-0121 §Review-notes-row-11
 * (DEFER-TO-IMPL — `Set` JSON serialisation): the substrate-layer state
 * file (`state.json`) round-trips through `JSON.stringify`, which would
 * lose `Set` payloads. We back the OR-Set with an array of `[element, tag]`
 * tuples instead of a JS `Set`; merge semantics are unchanged because we
 * deduplicate on the canonical `${element}|${tag}` key.
 *
 * Per `feedback-no-fallbacks.md`: invalid inputs throw rather than coerce.
 * `LWWRegister.write` requires `voterId` (no defaulting to a hostname or PID).
 */

// ── GCounter ──────────────────────────────────────────────────────────

/**
 * State shape of a G-Counter — monotonic per-voter counter slots.
 * Voter keys are stable string identifiers (worker agentId from
 * `state.workers`). Values are non-negative integers.
 */
export interface GCounterState {
  counts: Record<string, number>;
}

/**
 * G-Counter — increment-only lattice.
 *
 * Operations:
 *   - `increment(voterId)` — local +1 to the slot owned by `voterId`.
 *     No-op for unknown voters; semantics permit each voter to advance
 *     only their own slot, and merge propagates state across replicas.
 *   - `value()` — sum across all slots.
 *   - `merge(other)` — slot-wise `max` over the union of voter keys.
 *
 * Convergence properties (provable by induction on `Math.max`):
 *   - Idempotent:    merge(a, a) = a
 *   - Commutative:   merge(a, b) = merge(b, a)
 *   - Associative:   merge(merge(a, b), c) = merge(a, merge(b, c))
 *
 * Disappearing-voter caveat (per ADR-0121 §Consequences-Negative): a
 * voter that increments and then never returns leaves a stale slot that
 * contributes to `value()` indefinitely. This is correct CvRDT behaviour
 * — votes are durable across voter death.
 */
export class GCounter {
  private state: GCounterState;

  constructor(initial?: GCounterState) {
    this.state = initial ? { counts: { ...initial.counts } } : { counts: {} };
  }

  /**
   * Increment the slot owned by `voterId`. Required parameter — no defaulting
   * (per `feedback-no-fallbacks.md`).
   */
  increment(voterId: string): void {
    if (typeof voterId !== 'string' || voterId.length === 0) {
      throw new Error('GCounter.increment: voterId is required (non-empty string)');
    }
    this.state.counts[voterId] = (this.state.counts[voterId] ?? 0) + 1;
  }

  /** Sum across all per-voter slots. */
  value(): number {
    let total = 0;
    for (const v of Object.values(this.state.counts)) total += v;
    return total;
  }

  /** Snapshot the state in a JSON-serialisable shape. */
  toJSON(): GCounterState {
    return { counts: { ...this.state.counts } };
  }

  /**
   * Merge with another G-Counter via slot-wise `max`. Returns a NEW instance
   * (does not mutate `this`) so callers can fold multiple snapshots.
   */
  merge(other: GCounter): GCounter {
    const merged: Record<string, number> = { ...this.state.counts };
    for (const [voterId, count] of Object.entries(other.state.counts)) {
      merged[voterId] = Math.max(merged[voterId] ?? 0, count);
    }
    return new GCounter({ counts: merged });
  }

  /** Hydrate from a serialised shape (e.g. from `state.json`). */
  static from(state: GCounterState | undefined | null): GCounter {
    if (!state || typeof state !== 'object' || !state.counts) {
      return new GCounter();
    }
    return new GCounter(state);
  }
}

// ── ORSet ─────────────────────────────────────────────────────────────

/**
 * State shape of an OR-Set — observed-remove set with per-add unique tags.
 *
 * `entries` and `tombstones` are arrays of `[element, tag]` tuples (not
 * JS `Set`s) so the shape round-trips through JSON without loss. Lookup
 * deduplication uses the canonical key `${element}|${tag}` internally.
 */
export interface ORSetState<E extends string = string> {
  entries: Array<[E, string]>;
  tombstones: Array<[E, string]>;
}

/**
 * OR-Set — observed-remove set lattice.
 *
 * Operations:
 *   - `add(element, voterId)` — append `(element, uniqueTag)` where the tag
 *     is generated locally from the voterId and a per-call counter. One tag
 *     per `add` invocation; duplicates of the same `element` get distinct
 *     tags so concurrent removes don't accidentally drop later additions.
 *   - `remove(element)` — shift every `(element, *)` tuple from `entries`
 *     into `tombstones`. Concurrent adds with un-seen tags survive removal.
 *   - `elements()` — set of elements present in `entries` whose `(element, tag)`
 *     pair is NOT shadowed by `tombstones`.
 *   - `merge(other)` — `entries = a.entries ∪ b.entries`; `tombstones =
 *     a.tombstones ∪ b.tombstones`. Add-wins under concurrent add/remove.
 *
 * Convergence properties: union is commutative + associative + idempotent
 * by construction.
 *
 * Tombstone-leak caveat (per ADR-0121 §Consequences-Negative): tombstones
 * occupy memory until garbage collection. For short-lived consensus rounds
 * this is bounded, but long-lived OR-Sets must annotate the trade-off.
 */
export class ORSet<E extends string = string> {
  private state: ORSetState<E>;
  private tagCounter = 0;

  constructor(initial?: ORSetState<E>) {
    this.state = initial
      ? {
          entries: [...initial.entries],
          tombstones: [...initial.tombstones],
        }
      : { entries: [], tombstones: [] };
  }

  /**
   * Add `element` with a unique tag derived from `voterId` + a per-instance
   * monotonic counter + a small random salt. The tag must be unique across
   * all add invocations on this replica; collision would let a remove on
   * one branch accidentally tombstone a concurrent add on another.
   */
  add(element: E, voterId: string): void {
    if (typeof voterId !== 'string' || voterId.length === 0) {
      throw new Error('ORSet.add: voterId is required (non-empty string)');
    }
    const tag = `${voterId}:${this.tagCounter++}:${Math.random().toString(36).slice(2, 8)}`;
    this.state.entries.push([element, tag]);
  }

  /**
   * Move every observed `(element, *)` tuple from `entries` to `tombstones`.
   * Add-wins: tags appearing later (from other replicas) survive the
   * tombstone set because their pair never landed in this replica's view.
   */
  remove(element: E): void {
    const remaining: Array<[E, string]> = [];
    for (const pair of this.state.entries) {
      if (pair[0] === element) {
        this.state.tombstones.push(pair);
      } else {
        remaining.push(pair);
      }
    }
    this.state.entries = remaining;
  }

  /**
   * The set of elements currently present (not shadowed by tombstones for
   * the same `(element, tag)` pair). Returned as an array for JSON-friendliness;
   * callers can wrap in `new Set(...)` if needed.
   */
  elements(): E[] {
    const tombstoneKeys = new Set<string>();
    for (const [el, tag] of this.state.tombstones) {
      tombstoneKeys.add(`${el}|${tag}`);
    }
    const seen = new Set<E>();
    const out: E[] = [];
    for (const [el, tag] of this.state.entries) {
      if (tombstoneKeys.has(`${el}|${tag}`)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
    return out;
  }

  /** Snapshot in JSON-serialisable shape. */
  toJSON(): ORSetState<E> {
    return {
      entries: this.state.entries.map(([e, t]) => [e, t] as [E, string]),
      tombstones: this.state.tombstones.map(([e, t]) => [e, t] as [E, string]),
    };
  }

  /**
   * Merge with another OR-Set via union of `entries` and `tombstones`.
   * Deduplicates pairs whose `${element}|${tag}` key already appears.
   * Returns a NEW instance.
   */
  merge(other: ORSet<E>): ORSet<E> {
    const seenEntries = new Set<string>();
    const seenTombstones = new Set<string>();
    const mergedEntries: Array<[E, string]> = [];
    const mergedTombstones: Array<[E, string]> = [];
    for (const [el, tag] of this.state.entries.concat(other.state.entries)) {
      const key = `${el}|${tag}`;
      if (seenEntries.has(key)) continue;
      seenEntries.add(key);
      mergedEntries.push([el, tag]);
    }
    for (const [el, tag] of this.state.tombstones.concat(other.state.tombstones)) {
      const key = `${el}|${tag}`;
      if (seenTombstones.has(key)) continue;
      seenTombstones.add(key);
      mergedTombstones.push([el, tag]);
    }
    return new ORSet<E>({ entries: mergedEntries, tombstones: mergedTombstones });
  }

  /** Hydrate from a serialised shape. */
  static from<E extends string = string>(
    state: ORSetState<E> | undefined | null,
  ): ORSet<E> {
    if (!state || typeof state !== 'object') return new ORSet<E>();
    return new ORSet<E>({
      entries: Array.isArray(state.entries) ? state.entries : [],
      tombstones: Array.isArray(state.tombstones) ? state.tombstones : [],
    });
  }
}

// ── LWWRegister ───────────────────────────────────────────────────────

/**
 * State shape of a Last-Writer-Wins register.
 *
 * - `value` — the registered value (any JSON-serialisable type). `null` for
 *   the empty-register sentinel; `JSON.stringify` preserves `null` losslessly
 *   (whereas `undefined` would be elided).
 * - `timestamp` — wall-clock millisecond from `Date.now()` on the writer
 *   (NOT a logical clock, NOT a vector clock, NOT an HLC). Per ADR-0121
 *   §Tiebreaker contract: the tiebreaker is total-ordered on
 *   `(timestamp, voterId)`, so any wall-clock-skew magnitude resolves
 *   deterministically — the larger pair wins, full stop. Empty-register
 *   sentinel uses `timestamp: 0` (JSON-clean — `-Infinity` would serialise
 *   to `null` and break round-trip equality).
 * - `voterId` — stable string identifier (matches the worker's agentId in
 *   `state.workers`). NOT a hostname / PID (those drift across restarts).
 *   Empty-register sentinel uses `voterId: ''`. A real write (with a
 *   non-empty voterId) always dominates the empty sentinel because
 *   `voterId > ''` is true for any non-empty string at the same timestamp.
 */
export interface LWWRegisterState<V = unknown> {
  value: V | null;
  timestamp: number;
  voterId: string;
}

/**
 * LWW-Register — last-writer-wins lattice with `(timestamp, voterId)`
 * lexicographic tiebreak.
 *
 * Operations:
 *   - `write(value, voterId, timestamp)` — replace state if
 *     `(timestamp, voterId)` is lexicographically greater than current.
 *   - `value()` — current registered value.
 *   - `merge(other)` — pick whichever side has the lexicographically greater
 *     `(timestamp, voterId)` pair. Exact ties pick `this` deterministically
 *     (degenerate — both sides hold the same value when the pair matches).
 *
 * Convergence properties: lexicographic max is commutative + associative;
 * idempotent because the equality branch returns `this`'s value (which on
 * `merge(a, a)` is `a` itself).
 *
 * Same-voter same-millisecond collision (per ADR-0121 §Consequences-Negative):
 * voter A writes `(v1, ts, A)` then `(v2, ts, A)` in the same `Date.now()`
 * tick. The pairs are equal; the second write loses (the register holds `v1`).
 * This is correct LWW behaviour — tests must exercise the silent-drop case.
 */
export class LWWRegister<V = unknown> {
  private state: LWWRegisterState<V>;

  constructor(initial?: LWWRegisterState<V>) {
    this.state = initial
      ? { value: initial.value, timestamp: initial.timestamp, voterId: initial.voterId }
      // JSON-clean empty sentinel: `null` value (preserved by JSON), `0`
      // timestamp (preserved; `-Infinity` would serialise to `null`), empty
      // voterId. Any real write with a non-empty voterId dominates this.
      : { value: null, timestamp: 0, voterId: '' };
  }

  /**
   * Replace the register if the incoming `(timestamp, voterId)` strictly
   * dominates the current state lexicographically.
   *
   * `voterId` is REQUIRED (per ADR-0121 §Error-paths). Throws on absence
   * — no defaulting to hostname or PID, which would break tiebreaker
   * determinism across replicas.
   */
  write(value: V, voterId: string, timestamp: number): void {
    if (typeof voterId !== 'string' || voterId.length === 0) {
      throw new Error(
        'LWWRegister.write: voterId is required (non-empty string). ' +
          'Per ADR-0121 §Error-paths, no defaulting to hostname/PID.',
      );
    }
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      throw new Error(
        `LWWRegister.write: timestamp must be a finite number, got ${JSON.stringify(timestamp)}`,
      );
    }
    if (LWWRegister.dominates(timestamp, voterId, this.state.timestamp, this.state.voterId)) {
      this.state = { value, timestamp, voterId };
    }
  }

  /** Current registered value. `null` for an empty register. */
  value(): V | null {
    return this.state.value;
  }

  /** Snapshot the state in a JSON-serialisable shape. */
  toJSON(): LWWRegisterState<V> {
    return {
      value: this.state.value,
      timestamp: this.state.timestamp,
      voterId: this.state.voterId,
    };
  }

  /**
   * Merge with another LWW-Register. Picks the side with the greater
   * `(timestamp, voterId)` pair. Exact equality (same `voterId` + same
   * `timestamp`) returns `this` deterministically; per the §Tiebreaker
   * contract this case only arises from local re-broadcast or a
   * voter writing identical state twice — both sides hold the same value.
   * Returns a NEW instance.
   */
  merge(other: LWWRegister<V>): LWWRegister<V> {
    if (
      LWWRegister.dominates(
        other.state.timestamp,
        other.state.voterId,
        this.state.timestamp,
        this.state.voterId,
      )
    ) {
      return new LWWRegister<V>(other.state);
    }
    return new LWWRegister<V>(this.state);
  }

  /** Hydrate from a serialised shape. */
  static from<V = unknown>(
    state: LWWRegisterState<V> | undefined | null,
  ): LWWRegister<V> {
    if (!state || typeof state !== 'object') return new LWWRegister<V>();
    return new LWWRegister<V>(state);
  }

  /**
   * Strict-domination check on the `(timestamp, voterId)` pair.
   *
   * Returns true iff `(tA, idA)` lexicographically dominates `(tB, idB)`.
   * Equality returns false (caller treats equality as "no replacement",
   * which is what makes the merge idempotent).
   */
  private static dominates(
    tA: number,
    idA: string,
    tB: number,
    idB: string,
  ): boolean {
    if (tA > tB) return true;
    if (tA < tB) return false;
    // Same timestamp — break ties by voterId string comparison.
    return idA > idB;
  }
}

// ── Triple snapshot ──────────────────────────────────────────────────

/**
 * The CRDT-state triple a voter contributes to a `crdt` consensus round.
 * Lands on the `ConsensusProposal` record as the merge accumulator
 * (see ADR-0121 §State-snapshot shape per voter).
 *
 * - `votes`     : G-Counter — accumulated yea-vote count per voter
 * - `approvers` : OR-Set    — set of voters who have approved
 * - `verdict`   : LWW-Register — the proposal's resolved verdict
 */
export interface CRDTState {
  votes: GCounterState;
  approvers: ORSetState;
  verdict: LWWRegisterState;
}

/** Construct an empty CRDT-state triple (used at proposal creation). */
export function emptyCRDTState(): CRDTState {
  return {
    votes: new GCounter().toJSON(),
    approvers: new ORSet().toJSON(),
    verdict: new LWWRegister().toJSON(),
  };
}

/**
 * Merge two CRDT-state triples component-wise. Each component uses its
 * own primitive's `merge`. Returns a new triple in JSON-serialisable shape
 * for direct assignment to `proposal.crdtState`.
 */
export function mergeCRDTState(a: CRDTState, b: CRDTState): CRDTState {
  return {
    votes: GCounter.from(a.votes).merge(GCounter.from(b.votes)).toJSON(),
    approvers: ORSet.from(a.approvers).merge(ORSet.from(b.approvers)).toJSON(),
    verdict: LWWRegister.from(a.verdict).merge(LWWRegister.from(b.verdict)).toJSON(),
  };
}
