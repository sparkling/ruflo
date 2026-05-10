/**
 * Federation spend-reporting interface (ADR-097 Phase 3 upstream).
 *
 * The federation layer doesn't own model pricing — it can't know how much
 * a downstream agent's work cost until the integrator tells it. So the
 * coordinator exposes a `reportSpend()` method that callers invoke after
 * their downstream completes, and that method fans out to:
 *
 *   1. The injected SpendReporter (if any) — typically wires to the
 *      cost-tracker bus / `federation-spend` memory namespace
 *   2. The injected FederationBreakerService (if any) — its in-memory
 *      buffer becomes a transparent cache when the cost-tracker
 *      subscriber lands
 *
 * Both deps are constructor-optional. A coordinator with neither still
 * accepts reportSpend() calls (silent no-op) so callers don't need to
 * branch on which integrations are wired.
 *
 * Event shape matches the consumer contract pinned by
 * plugins/ruflo-cost-tracker/scripts/federation.mjs:
 *
 *   { peerId, taskId, tokensUsed, usdSpent, ts }
 *
 * Storage layout (consumer convention): namespace `federation-spend`,
 * key `fed-spend-<peerId>-<ts>`. The interface is storage-agnostic; the
 * default in-memory reporter included here is for tests + a reference
 * implementation. Production integrators write a thin adapter that
 * persists to ruflo memory / Redis / Datadog / their accounting system.
 */

/** A single per-send cost report from the integrator. */
export interface FederationSpendEvent {
  /** Peer this cost was incurred against. */
  readonly peerId: string;
  /** Optional task correlation key — not all callers will have one. */
  readonly taskId?: string;
  /** Tokens consumed (input + output). Negative values clamped to 0 by sink. */
  readonly tokensUsed: number;
  /** USD spent. Negative values clamped to 0 by sink. */
  readonly usdSpent: number;
  /** ISO 8601 timestamp. Caller-supplied for testability; auto-filled if omitted by reportSpend. */
  readonly ts: string;
  /** Whether the underlying send succeeded (drives breaker failure-ratio). */
  readonly success: boolean;
}

/**
 * Strategy interface the coordinator calls when reportSpend() fires.
 * Integrators implement this to push the event to whatever backend they
 * want — cost-tracker bus, Datadog, accounting DB, etc.
 *
 * Implementations must be tolerant: dropping or persisting later is
 * acceptable, but throwing here will surface to the integrator's caller.
 * Buffer and retry inside the implementation.
 */
export interface SpendReporter {
  reportSpend(event: FederationSpendEvent): Promise<void>;
}

/**
 * In-memory reporter for tests + a reference implementation. Production
 * code should wire a real SpendReporter that persists to durable storage.
 *
 * Buffer is unbounded — fine for tests, NOT fine for long-running
 * production. The cost-tracker consumer reads from durable storage, not
 * from this buffer.
 */
export class InMemorySpendReporter implements SpendReporter {
  private readonly buffer: FederationSpendEvent[] = [];

  async reportSpend(event: FederationSpendEvent): Promise<void> {
    this.buffer.push(event);
  }

  /** Snapshot of all reported events (test inspection). */
  getEvents(): readonly FederationSpendEvent[] {
    return [...this.buffer];
  }

  /** Drop everything (test cleanup). */
  clear(): void {
    this.buffer.length = 0;
  }
}
