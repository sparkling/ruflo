// Ambient stubs for optional runtime-imported modules used by memory/src.
// These are either dynamically imported behind try/catch or static type-only
// imports. The local stub satisfies tsc when types aren't hoisted.

/* eslint-disable @typescript-eslint/no-explicit-any */

declare module 'agentdb' {
  const m: any;
  export default m;
}

declare module '@sparkleideas/agentdb' {
  const m: any;
  export default m;
}

declare module '@claude-flow/agentdb' {
  const m: any;
  export default m;
}

declare module 'ruvector' {
  const m: any;
  export default m;
  export const VectorDB: any;
  export function isWasm(): boolean;
}

declare module '@sparkleideas/ruvector' {
  const m: any;
  export default m;
  export const VectorDB: any;
  export function isWasm(): boolean;
}

declare module '@xenova/transformers' {
  const m: any;
  export default m;
  export const pipeline: any;
  export const env: any;
}

// sqlite-backend.ts: `import type Database from 'better-sqlite3'` then uses
// `Database.Database` as a namespaced type. Mirror cli/types/optional-modules.d.ts
// pattern: global namespace `Database` (matches caller's import name) + opaque
// module export.
declare namespace Database {
  type Database = any;
}
declare module 'better-sqlite3' {
  const Database: any;
  export default Database;
  export type Database = any;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
