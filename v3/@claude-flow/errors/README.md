# @claude-flow/errors

Shared typed error library for the ruflo fork. Minimum-viable canonical
hierarchy extracted from `forks/ruflo/v3/plugins/gastown-bridge/src/errors.ts`
per [ADR-0242](../../../../docs/adr/ADR-0242-shared-error-library-and-mcp-envelope-honesty.md).

## Purpose

Establishes a single base error class (`RufloError`) with a typed code,
preserved `.cause` chain, structured `context`, and a log-safe `toJSON()`.
The goal is **cultural canon for new code** — old `throw new Error(string)`
sites are grandfathered; new sites should prefer `RufloError` (or a subclass)
so the cause chain and code are preserved through rethrows.

The library is paired with the advisory-first `scripts/check-throw-new-error.mjs`
and `scripts/check-mcp-handler-fatal-throw.mjs` lints in `ruflo-patch` — see
ADR-0242 §Decision scope for the long-term framing.

## Exports

| Export | Kind | What it is |
|---|---|---|
| `RufloError` | class | Base error class — `code`, `timestamp`, `context`, `cause`, `toJSON()`, `toString()` |
| `RufloErrorCode` | const enum | Flat enum of error codes — `RUFLO_E_*` prefix |
| `RufloErrorCodeType` | type | Union type of all `RufloErrorCode` values |
| `wrapError(err, code?)` | fn | Promote unknown to `RufloError`, preserving `.cause` |
| `getErrorMessage(err)` | fn | Safe message extractor for unknown |
| `isRufloError(err)` | fn | Type guard — narrows `unknown` to `RufloError` |

## Naming convention

Error codes use the **`RUFLO_E_*`** prefix (not `RUFLO_ERR_*`, not
`RUFLO_ERROR_*` — one form, picked here so the cross-fork grep is
unambiguous). The shape is:

```
RUFLO_E_<AREA>_<REASON>
```

Examples:

- `RUFLO_E_UNKNOWN` — fallthrough; use only when no better code applies
- `RUFLO_E_INITIALIZATION_FAILED` — module/service init failed
- `RUFLO_E_VALIDATION_FAILED` — input validation rejected
- `RUFLO_E_NOT_FOUND` — entity not found (caller should treat as expected)
- `RUFLO_E_DATA_INTEGRITY` — fatal data-corruption class
  (the `[[feedback-best-effort-must-rethrow-fatals]]` rule fires here)

Add new codes to `RufloErrorCode` as needed; keep them flat (no nested
namespaces — they collide with grep tooling).

## When to extend `RufloError`

| Situation | Do |
|---|---|
| Catching unknown in a handler/service and rethrowing | `throw wrapError(e, RufloErrorCode.<area>)` |
| Defining a new error subclass | `class FooError extends RufloError { … }` — call `super(msg, code, context, cause)` |
| Asserting a domain invariant | `throw new RufloError(msg, RufloErrorCode.DATA_INTEGRITY, {…}, e)` |
| Returning a sentinel for an *expected* condition (e.g. `NOT_FOUND` queried optimistically) | Return `null`/`undefined`; reserve errors for unexpected paths |

## When to set `cause`

**Always**, when wrapping. The `wrapError()` adapter does it for you:

```typescript
try {
  await loadConfig();
} catch (e) {
  throw wrapError(e, RufloErrorCode.CONFIGURATION_ERROR);
}
```

This preserves the parent stack + message — the demoted-to-string pattern
(`throw new Error(\`failed: \${e.message}\`)`) drops both.

## MCP handler ergonomics

Per ADR-0242 §Decision scope #5, the canonical handler shape becomes:

```typescript
try {
  // ... handler body
} catch (e) {
  throw wrapError(e, RufloErrorCode.<area>_FAILED);
}
```

— letting `mcp-server.ts:691-707` produce a clean JSON-RPC `-32603` error
frame, rather than swallowing the fatal into `{success:false, error: …}`
where the client (Claude Code, swarm agent) cannot distinguish it from a
non-error result.

## Provenance + INTEGRATION-LEDGER

The seed code is byte-identical with upstream's
`ruvnet/ruflo/v3/plugins/gastown-bridge/src/errors.ts` (700 LOC; fork has
701 LOC for the same hierarchy subset). This package re-organizes
upstream-derived content under a shared boundary — INTEGRATION-LEDGER
disposition is **`convergence-with-upstream`**, not fork-divergent
invention. The `gastown-bridge/errors.ts` re-export shim preserves
byte-identical behavior at consumer call sites (`GasTownError` remains a
subclass of `RufloError`, all type guards still pass).

See [ADR-0242 §pre-flight check 4](../../../../docs/adr/ADR-0242-shared-error-library-and-mcp-envelope-honesty.md#pre-flight-verification)
for the upstream-alignment rationale.

## Out of scope (deferred to follow-up ADRs)

Per ADR-0242 §"Decision scope (what this ADR explicitly does NOT propose)":

- Migrating any of the existing ~1,994 `throw new Error(string)` sites.
- Wiring `forks/ruflo/v3/@claude-flow/cli/src/production/error-handler.ts`
  (480 LOC, 0 callers — owned by F-13-002).
- Consolidating the two retry libraries (F-13-001).
- Deduping `ErrorCodes` + `MCPServerError` (F-13-003).
- Annotating `~149` un-marked `catch ... console.warn/error` swallows (F-13-008).
