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
 * The historical pattern `try { await import('pkg') } catch { /* not
 * available */ }` swallowed the 2026-05-19 ESM/CJS regression that
 * motivated ADR-0190/0191. Using this helper makes that class of bug
 * visible while still tolerating a missing optionalDependency.
 *
 * Use ONLY for entries that are actually in `optionalDependencies` of
 * the consuming package's `package.json`. For same-package internal
 * imports, required deps, or paths that cannot legitimately fail to
 * resolve, delete the catch entirely — see ADR-0191's per-callsite
 * disposition table.
 */
export async function tryOptionalImport<T = unknown>(spec: string): Promise<T | null> {
  try {
    return (await import(spec)) as T;
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      return null;
    }
    throw e;
  }
}
