/**
 * Typed timeout primitive for SLA-bounded calls.
 *
 * Per ADR-0191 (Phase B, Cluster B): the legacy pattern wrapped
 * `Promise.race([call, setTimeout-reject])` in an undiscriminating
 * `catch {}` that swallowed BOTH the timeout signal AND any
 * method-body bug. That hid two distinct event classes under a single
 * "feature unavailable" label.
 *
 * `withTimeoutLogged` separates them:
 * - Timeout: emit a `console.error` so the SLA event is observable,
 *   then return `null` so the caller can fall through to the next
 *   strategy without losing the signal.
 * - Any other throw: rethrow. Method-body errors are bugs and must
 *   surface — the caller's `if (result)` guard handles `null`
 *   cleanly, so there is no reason to swallow real errors to keep
 *   the call site simple.
 *
 * Callers that need to distinguish "timed out" from "method returned
 * null" can `instanceof`-check via `TimeoutError` instead of using
 * this helper.
 */

export class TimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export async function withTimeoutLogged<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (e: unknown) {
    if (e instanceof TimeoutError) {
      // SLA breach — surface the signal, then let the caller fall through.
      // Stays visible in CLI stderr / log capture; does not get folded
      // into the silent "feature unavailable" branch the legacy
      // try/catch produced.
      console.error(`[withTimeoutLogged] ${e.message}`);
      return null;
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
