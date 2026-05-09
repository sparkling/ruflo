// Ambient declarations for OPTIONAL dependencies that tsc cannot resolve in
// the workspace. Each declared module is opaque (typed `any`) — these
// declarations exist only to satisfy tsc's module-resolution pass for our
// dynamic `await import('...')` and `import type {...}` sites. Runtime
// behavior is unchanged: imports still fail at runtime if the package is
// missing, and the existing try/catch guards at the call sites handle it
// (per feedback-no-fallbacks: no silent fallback is introduced here, this
// is a type-system-only declaration).
//
// Background: workspace pins `-patch.NNN` external versions that aren't on
// Verdaccio, so `pnpm install` cannot fetch them. Once the structural
// install issue is resolved (versions republished or pins relaxed), these
// declarations should be removed and the real types take over.

declare module 'agentdb';
declare module '@claude-flow/agentdb';
declare module '@claude-flow/memory';
declare module '@ruvector/attention';
declare module '@ruvector/sona';
declare module '@ruvector/rabitq-wasm';

// `IStorageContract` is imported as a type-only re-export from
// `@claude-flow/memory/storage.js` (memory-router.ts:21). Until the sibling
// project ships a built dist, declare an opaque permissive shape so the
// type system accepts member access on `_storage`. This is a
// signature-relaxation, not a runtime stub: the real implementation comes
// from RvfBackend at runtime via `ensureRouter()`.
declare module '@claude-flow/memory/storage.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface IStorageContract { [key: string]: any; }
}
