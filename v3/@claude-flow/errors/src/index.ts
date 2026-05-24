/**
 * @claude-flow/errors — Shared typed error library for ruflo (fork-internal).
 *
 * Minimum-viable extraction of the gold-standard hierarchy from
 * `forks/ruflo/v3/plugins/gastown-bridge/src/errors.ts` (the same file is
 * upstream byte-identical at `ruvnet/ruflo/v3/plugins/gastown-bridge/src/errors.ts`).
 * Per ADR-0242 §Decision scope, only the base subset is exported:
 *
 *   - `RufloError`        — base class with `code`/`cause`/`context`/`timestamp`
 *   - `RufloErrorCode`    — enum of error codes (RUFLO_E_* prefix)
 *   - `wrapError`         — promote unknown to RufloError, preserving cause
 *   - `getErrorMessage`   — safe message extractor
 *   - `isRufloError`      — type guard
 *
 * Plugin-specific subclasses (BeadsError, FormulaError, ConvoyError,
 * CLIExecutionError, ValidationError) remain in gastown-bridge. New code
 * should extend RufloError directly; old code is grandfathered per
 * ADR-0242's lint-allowlist policy.
 *
 * Naming convention: `RUFLO_E_<area>_<reason>` (e.g. `RUFLO_E_UNKNOWN`,
 * `RUFLO_E_VALIDATION_FAILED`). See README.md §"Naming convention".
 *
 * Divergence marker (ADR-0234 precedent): the seed code is upstream-derived
 * via gastown-bridge/errors.ts; this package re-organizes upstream content
 * under a shared boundary. INTEGRATION-LEDGER disposition:
 * `convergence-with-upstream`.
 *
 * @module @claude-flow/errors
 * @version 0.1.0
 */

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Ruflo error codes — flat enum, RUFLO_E_* prefix convention.
 *
 * Add new codes here as they're needed by handlers/services. The prefix
 * makes them grep-friendly across the codebase and unambiguous in logs.
 */
export const RufloErrorCode = {
  // General
  UNKNOWN: 'RUFLO_E_UNKNOWN',
  INITIALIZATION_FAILED: 'RUFLO_E_INITIALIZATION_FAILED',
  NOT_INITIALIZED: 'RUFLO_E_NOT_INITIALIZED',
  CONFIGURATION_ERROR: 'RUFLO_E_CONFIGURATION_ERROR',

  // Validation
  VALIDATION_FAILED: 'RUFLO_E_VALIDATION_FAILED',
  INVALID_INPUT: 'RUFLO_E_INVALID_INPUT',
  INVALID_ARGUMENTS: 'RUFLO_E_INVALID_ARGUMENTS',

  // I/O
  IO_FAILED: 'RUFLO_E_IO_FAILED',
  TIMEOUT: 'RUFLO_E_TIMEOUT',
  NOT_FOUND: 'RUFLO_E_NOT_FOUND',
  PERMISSION_DENIED: 'RUFLO_E_PERMISSION_DENIED',

  // Protocol (MCP/HTTP/etc.)
  PROTOCOL_ERROR: 'RUFLO_E_PROTOCOL_ERROR',

  // Data integrity (the [[feedback-best-effort-must-rethrow-fatals]] class)
  DATA_INTEGRITY: 'RUFLO_E_DATA_INTEGRITY',
} as const;

export type RufloErrorCodeType = (typeof RufloErrorCode)[keyof typeof RufloErrorCode];

// ============================================================================
// Base Error Class
// ============================================================================

/**
 * Base error class for the ruflo fork.
 *
 * Carries `code` (programmatic), `timestamp`, `context` (structured
 * diagnostic data), and `cause` (parent error chain). `toJSON()` produces
 * a log-safe serialization; `toString()` produces a human-readable one.
 *
 * @example
 * ```typescript
 * throw new RufloError(
 *   'Failed to initialize memory tier',
 *   RufloErrorCode.INITIALIZATION_FAILED,
 *   { tier: 'l1', backend: 'rvf' },
 *   parentError
 * );
 * ```
 */
export class RufloError extends Error {
  /** Error code for programmatic handling */
  readonly code: RufloErrorCodeType;

  /** Timestamp when error occurred */
  readonly timestamp: Date;

  /** Additional context about the error */
  readonly context?: Record<string, unknown>;

  /** Original error if this wraps another error */
  readonly cause?: Error;

  constructor(
    message: string,
    code: RufloErrorCodeType = RufloErrorCode.UNKNOWN,
    context?: Record<string, unknown>,
    cause?: Error
  ) {
    super(message);
    this.name = 'RufloError';
    this.code = code;
    this.timestamp = new Date();
    this.context = context;
    this.cause = cause;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RufloError);
    }
  }

  /**
   * Convert error to JSON for logging/serialization
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      timestamp: this.timestamp.toISOString(),
      context: this.context,
      cause: this.cause?.message,
      stack: this.stack,
    };
  }

  /**
   * Create a human-readable string representation
   */
  toString(): string {
    let str = `[${this.code}] ${this.message}`;
    if (this.context) {
      str += ` | Context: ${JSON.stringify(this.context)}`;
    }
    if (this.cause) {
      str += ` | Caused by: ${this.cause.message}`;
    }
    return str;
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Type guard for RufloError (and any subclass).
 */
export function isRufloError(error: unknown): error is RufloError {
  return error instanceof RufloError;
}

/**
 * Wrap an unknown error as a RufloError, preserving `.cause`.
 *
 * - If `error` is already a RufloError, returns it unchanged.
 * - If `error` is any other Error, wraps it preserving message + cause.
 * - Otherwise stringifies and creates an UNKNOWN RufloError.
 *
 * @example
 * ```typescript
 * try { await loadConfig(); }
 * catch (e) { throw wrapError(e, RufloErrorCode.CONFIGURATION_ERROR); }
 * ```
 */
export function wrapError(error: unknown, code?: RufloErrorCodeType): RufloError {
  if (error instanceof RufloError) {
    return error;
  }

  if (error instanceof Error) {
    return new RufloError(
      error.message,
      code ?? RufloErrorCode.UNKNOWN,
      undefined,
      error
    );
  }

  return new RufloError(
    String(error),
    code ?? RufloErrorCode.UNKNOWN
  );
}

/**
 * Extract error message safely from unknown.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
