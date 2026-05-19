# Supply-chain & quality follow-ups

Open issues that the supply-chain audit + recent CI hardening surfaced but require work beyond a single PR. Triaged on 2026-05-19.

## #2047 — Witness manifests report `missing=95 drift=2`

**Status**: HIGH, open. Tracked at https://github.com/ruvnet/ruflo/issues/2047.

**Root cause**: the 12-hour scheduled verification job runs in a bare-source environment (no `npm ci && npm run build`), but the signed witness manifest references 95 compiled `dist/**` artifacts. In a pre-build state those files don't exist on disk → verify reports them as missing. The Ed25519 signature itself is valid; this is *not* tamper.

**Right fix** (when someone has cycles for it):

1. Identify the scheduled runner (it's not in `.github/workflows/`; it's likely an external poll that opens `[verification]` HIGH issues against this repo).
2. Make that runner do `npm ci --legacy-peer-deps && pnpm -C v3 install --frozen-lockfile && pnpm -C v3 build` before invoking `verify.mjs`.
3. Alternative: split the witness manifest into `src/`-only entries (always present) and `dist/`-only entries (built-by-CI), and have verify.mjs treat `missing` on dist entries as `expected-when-not-built` rather than HIGH.

**Interim CI guard** (already in place):
- `witness-verify-precondition-smoke` job in `v3-ci.yml` exercises the verify path on PRs *after* a build, so the manifest stays internally consistent against the buildable surface.
- `witness-marker-drift-smoke` runs the marker-presence layer (no signature, no build, no native deps) on every push/PR.

## #2048 — `agentic-flow/reasoningbank` ESM import fails on Windows (onnxruntime native binding)

**Status**: HIGH-UX-impact, open. Tracked at https://github.com/ruvnet/ruflo/issues/2048.

**Root cause**: `import('agentic-flow/reasoningbank')` triggers an eager load of `onnxruntime-node`'s native binding (`onnxruntime_binding.node`), which fails on Windows with "OS cannot run %1" even when the user has VCRedist + a working CJS `require('onnxruntime-node')` from the same directory. The static import in some part of the reasoningbank module graph forces the binding load before any user code runs.

**Pattern is identical to ADR-124** — which moved `@xenova/transformers` from agentic-flow's `dependencies` to `optionalDependencies` and converted the one eager static import to dynamic. The same shape of fix is needed for `onnxruntime-node` in `agentic-flow/src/reasoningbank/**`.

**Right fix** (upstream patch in `ruvnet/agentic-flow`):

1. Audit `agentic-flow/src/reasoningbank/**` for any static `import { ... } from 'onnxruntime-node'`. The 6 known callers in `src/embeddings/**`, `src/core/**`, `src/services/**`, `src/router/providers/onnx.ts`, and `src/utils/model-cache.ts` mostly use dynamic import already (ADR-124 left the pattern in place). The reasoningbank-specific surface needs the same audit.
2. Move `onnxruntime-node` from `dependencies` to `optionalDependencies` in `agentic-flow/package.json` (it's already in `optionalDependencies` per 2.0.12 — confirm reasoningbank doesn't transitively force-load it).
3. Wrap each remaining static binding in try/catch with a clear `npm install onnxruntime-node` warning + a hash-based fallback (the same fallback path the `embeddings.ts` patch in ADR-124 ships).
4. Cut `agentic-flow@2.0.13` (patch) and bump `v3/@claude-flow/browser` + root.

**Interim workaround for users**:
```bash
npm install ruflo --omit=optional       # Windows: skip the native binding entirely
# or
npm install ruflo && set ONNXRUNTIME_DISABLE=1   # disable at runtime
```

**CI guard** to add after the upstream patch lands:
- Windows runner smoke job that does `node -e "import('agentic-flow/reasoningbank').then(() => console.log('OK'))"` under `--omit=optional` and asserts it loads without the binding present.
- That smoke goes in the supply-chain audit suite alongside the other 5 layers.

## #2049 — `kg-extract` over-counts type imports + `kg-traverse` mis-wired

**Status**: closed by THIS PR.

- ✅ `kg-extract/SKILL.md` now declares `type-depends-on` as a separate relation with weight `0.1` and includes a regex carve-out for `import type` + inline `type` specifiers.
- ✅ `kg-traverse/SKILL.md` step 3 now calls `agentdb_pattern-search` (enabled) instead of `agentdb_semantic-route` (compiled-out). Both `allowed-tools` lines updated.
- ✅ New CI smoke `scripts/smoke-kg-extract-type-imports.mjs` + workflow job `kg-extract-type-imports-smoke` runs static contract checks on both SKILL.md files PLUS a behavioural fixture test that ensures the published regex correctly separates type-only imports from value imports.
