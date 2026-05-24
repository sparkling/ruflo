// Ambient stub for @claude-flow/memory — optional cross-package dep.
// ADR-0076: loader.ts lazy-imports resolveConfig to avoid a hard dependency
// on @claude-flow/memory. The try/catch handles runtime absence; this stub
// satisfies the type-resolution pass when the sibling dist isn't yet
// available (e.g. cold first-build).
declare module '@claude-flow/memory' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const resolveConfig: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;
}
