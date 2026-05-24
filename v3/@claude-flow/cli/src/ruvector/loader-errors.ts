/**
 * Shared fail-loud throw helper for loader-cascade sites.
 *
 * Per ADR-0234 (CT-A; extends ADR-0095 amendment 2026-05-23 to sibling
 * loaders) and `feedback-no-fallbacks`, every loader that was previously
 * silently degrading to a hash / cosine-js / permissive fallback must
 * instead throw a labelled error so the deployment fact (missing native
 * binding, missing policy file, unimplemented IPFS path) surfaces.
 *
 * The throw shape mirrors `forks/ruflo/v3/@claude-flow/memory/src/rvf-backend.ts:1129`
 * (the ADR-0095 amendment template) so future audits / sync agents can
 * grep ONE pattern across all loader sites. The error message ALWAYS
 * contains the literal `'ADR-0234'` substring for test-grep + tracing.
 *
 * @module @claude-flow/cli/ruvector/loader-errors
 */

/**
 * Typed-error shape attached to throws raised by this helper. Sync agents
 * preserve the throw mechanically by matching `(err as LoaderError).adr === 'ADR-0234'`
 * rather than the (drift-prone) error message text.
 */
export interface LoaderError extends Error {
  readonly code: string;
  readonly path: string;
  readonly adr: 'ADR-0234';
  readonly cause?: unknown;
}

/**
 * Throw a fail-loud, labelled error at a loader boundary.
 *
 * @param code   Stable machine-readable identifier (e.g. `'RUVECTOR_UNAVAILABLE'`,
 *               `'DISKANN_TIER_UNAVAILABLE'`, `'HNSW_TIER_UNAVAILABLE'`,
 *               `'POLICY_LOAD_FAILED'`, `'IPFS_PATH_NOT_IMPLEMENTED'`).
 * @param path   Module spec, file path, or other locus the failure refers to.
 * @param hint   Operator-facing remediation hint (e.g. "Install @ruvector/diskann").
 *               The hint is appended after the path; `feedback-no-fallbacks` +
 *               ADR-0234 are always cited so the corpus rule is greppable.
 * @param cause  Optional underlying error to attach as `cause` for stack tracing.
 *
 * @throws LoaderError — always; never returns.
 */
export function throwLoaderUnavailable(
  code: string,
  path: string,
  hint: string,
  cause?: unknown,
): never {
  const causeMsg = cause
    ? `: ${(cause as { message?: string })?.message ?? String(cause)}`
    : '';
  const err = new Error(
    `[loader] ${code} at ${path}${causeMsg}. ` +
    `Silent fallback removed (ADR-0234, extends ADR-0095 amendment 2026-05-23 to sibling loaders per feedback-no-fallbacks). ` +
    hint,
  ) as LoaderError;
  // Tag the throw shape so sync agents / future audits can match on the
  // structured fields, not the (drift-prone) message text. See
  // RvfBackend.ts:1129 for the upstream-aligned template.
  (err as { code: string }).code = code;
  (err as { path: string }).path = path;
  (err as { adr: 'ADR-0234' }).adr = 'ADR-0234';
  if (cause !== undefined) {
    (err as { cause: unknown }).cause = cause;
  }
  throw err;
}
