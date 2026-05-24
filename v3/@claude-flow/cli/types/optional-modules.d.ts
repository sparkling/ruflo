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
declare module '@sparkleideas/agentdb'; // codemod-renamed form of 'agentdb'
declare module '@claude-flow/agentdb';
declare module '@claude-flow/memory';
declare module '@ruvector/attention';
declare module '@ruvector/sona';
declare module '@ruvector/rabitq-wasm';

// agentdb subpath exports — explicit identifier list because TypeScript treats
// `import type { X } from 'foo'` against an opaque `declare module 'foo';`
// as a namespace alias, not a type alias (triggers TS2709). We list each
// identifier as both a value (`const`) and a type (`type`) so callers can
// use either form. All bound to `any` because the real types live in the
// published `@sparkleideas/agentdb` dist that codemod swaps in.
//
// eslint-disable: this file declares opaque stubs for optional packages;
// `any` is the deliberate signature relaxation.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare module 'agentdb/archivist' {
  export const Archivist: any;
  export type Archivist = any;
  export const setAuditLogPath: any;
  export const __resetAuditWriterForTests: any;
  export const RaftTermCollisionError: any;
  export const DuplicateVoteError: any;
  export const RaftVoteChangeError: any;
  export const ProposalNotFoundError: any;
  export const VoterIdRequiredError: any;
  export type ArchivistInitConfig = any;
  export type AutopilotLearner = any;
  export type AutopilotLearnResult = any;
  export type CausalGraphWriter = any;
  export type CausalGraphWriteResult = any;
  export type EmbeddingScorer = any;
  export type FeedbackRecorder = any;
  export type FeedbackWriteResult = any;
  export type GNNTelemetryReader = any;
  export type HierarchicalMemoryWriter = any;
  export type HierarchicalWriteResult = any;
  export type LearningSystemWriter = any;
  export type LearningWriteResult = any;
  export type PatternHit = any;
  export type PatternReader = any;
  export type ReasoningBankWriter = any;
  export type ReasoningBankWriteResult = any;
  export type ReflexionStoreWriter = any;
  export type ReflexionWriteResult = any;
  export type RouteDecision = any;
  export type SemanticRouteReader = any;
  export type SkillLibraryWriter = any;
  export type SkillLibraryWriteResult = any;
  export type SonaTrajectoryReader = any;
  export type SonaTrajectoryWriter = any;
  export type SonaTrajectoryWriteResult = any;
  export type TaskRouter = any;
  export type ToolPayloadMap = any;
}
// BetterSqlite3 is imported as `import type BetterSqlite3 from 'better-sqlite3'`
// and used as `BetterSqlite3.Database` — needs namespace-merged form, not just default.
declare namespace BetterSqlite3 {
  type Database = any;
}
declare module 'agentdb/archivist/handlers' {
  // Side-effect-only import (registers handlers at module load) — no named exports needed.
}
declare module 'agentdb/wasm' {
  export type VectorBackendAsync = any;
}
declare module 'agentdb/adapters/memory-rvf-adapter' {
  export const MemoryRvfAdapter: any;
  export type MemoryRvfAdapter = any;
}

// Codemod-renamed forms: `agentdb/*` → `@sparkleideas/agentdb/*`.
// The codemod rewrites `import`/`require` strings in .ts but NOT the
// `declare module 'agentdb/*'` strings in .d.ts (its UNSCOPED_IMPORT_RE
// matches only import/require/from sites). So after codemod runs, callers
// import `@sparkleideas/agentdb/*` but the .d.ts still declares the
// pre-codemod names. Mirror each agentdb/* declaration to its renamed form
// so tsc resolves the post-codemod import sites.
declare module '@sparkleideas/agentdb/archivist' {
  export const Archivist: any;
  export type Archivist = any;
  export const setAuditLogPath: any;
  export const __resetAuditWriterForTests: any;
  export const RaftTermCollisionError: any;
  export const DuplicateVoteError: any;
  export const RaftVoteChangeError: any;
  export const ProposalNotFoundError: any;
  export const VoterIdRequiredError: any;
  export type ArchivistInitConfig = any;
  export const AutopilotLearner: any;
  export type AutopilotLearner = any;
  export type AutopilotLearnResult = any;
  export type CausalGraphWriter = any;
  export type CausalGraphWriteResult = any;
  export type EmbeddingScorer = any;
  export type FeedbackRecorder = any;
  export type FeedbackWriteResult = any;
  export type GNNTelemetryReader = any;
  export type HierarchicalMemoryWriter = any;
  export type HierarchicalWriteResult = any;
  export type LearningSystemWriter = any;
  export type LearningWriteResult = any;
  export type PatternHit = any;
  export type PatternReader = any;
  export type ReasoningBankWriter = any;
  export type ReasoningBankWriteResult = any;
  export type ReflexionStoreWriter = any;
  export type ReflexionWriteResult = any;
  export type RouteDecision = any;
  export type SemanticRouteReader = any;
  export type SkillLibraryWriter = any;
  export type SkillLibraryWriteResult = any;
  export type SonaTrajectoryReader = any;
  export type SonaTrajectoryWriter = any;
  export type SonaTrajectoryWriteResult = any;
  export type TaskRouter = any;
  export type ToolPayloadMap = any;
}
declare module '@sparkleideas/agentdb/archivist/handlers' {
  // Side-effect-only import — no named exports needed.
}
declare module '@sparkleideas/agentdb/wasm' {
  export type VectorBackendAsync = any;
}
declare module '@sparkleideas/agentdb/adapters/memory-rvf-adapter' {
  export const MemoryRvfAdapter: any;
  export type MemoryRvfAdapter = any;
}
declare module 'better-sqlite3' {
  // archivist-init.ts:137 imports `BetterSqlite3` default + references
  // `BetterSqlite3.Database` as a type. Both bound to `any`.
  const BetterSqlite3: any;
  export default BetterSqlite3;
  export type Database = any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
