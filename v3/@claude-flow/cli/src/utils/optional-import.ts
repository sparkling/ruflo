/**
 * Discriminating helper for genuinely-optional package imports.
 *
 * Per ADR-0191 (Phase B, Cluster A): wraps a dynamic `import()` of a
 * package listed in `optionalDependencies`. Returns `null` ONLY when
 * the resolver reports the package isn't installed
 * (`ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`). Every other error —
 * including ESM/CJS interop failures, syntax errors in the imported
 * module, or anything else — propagates.
 *
 * The legacy `try await import(pkg) catch swallow-with-comment` pattern
 * (the comment was a literal "not available" tag) swallowed the
 * 2026-05-19 ESM/CJS regression that motivated ADR-0190/0191. Using
 * this helper makes that class of bug visible while still tolerating a
 * missing optionalDependency.
 *
 * Use ONLY for entries that are actually in `optionalDependencies` of
 * the consuming package's manifest. For same-package internal imports,
 * required deps, or paths that cannot legitimately fail to resolve,
 * delete the catch entirely — see ADR-0191's per-callsite disposition.
 */
// Error codes Node.js produces when a package or subpath isn't reachable.
// These all mean the same thing for our purposes: "the bit we wanted is not
// installed/exported, treat as absent." Anything else propagates.
//   - ERR_MODULE_NOT_FOUND  — ESM resolver: spec not found
//   - MODULE_NOT_FOUND      — CJS resolver: spec not found
//   - ERR_PACKAGE_PATH_NOT_EXPORTED — package installed but subpath missing
//     from its `exports` map (common with version-skew on internal subpaths,
//     e.g. agentic-flow's `dist/coordination/*` between minor versions)
//   - ERR_PACKAGE_IMPORT_NOT_DEFINED — import-map miss on a `#`-prefixed spec
const _OPTIONAL_ABSENT_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
]);

export async function tryOptionalImport<T = unknown>(spec: string): Promise<T | null> {
  try {
    return (await import(spec)) as T;
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code;
    if (code && _OPTIONAL_ABSENT_CODES.has(code)) {
      return null;
    }
    throw e;
  }
}
