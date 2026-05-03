# ADR-094: Migrate `@xenova/transformers` → `@huggingface/transformers`

**Status**: Proposed
**Date**: 2026-05-03
**Version**: targets v3.7.x
**Supersedes**: nothing
**Related**: ADR-093, npm audit CVE chain through `protobufjs`

## Context

`@xenova/transformers@2.17.2` is the legacy ONNX inference package we use for client-side embeddings (`pipeline('feature-extraction', ...)`). The package was deprecated in favor of `@huggingface/transformers` (currently 4.2.0) in late 2024. The legacy package has not received updates in over a year and pins old transitive deps that have since picked up critical CVEs:

- `protobufjs <7.5.5` — **CRITICAL — Arbitrary code execution** — comes through `onnxruntime-web` → `onnx-proto`
- The chain is: `@xenova/transformers` → `onnxruntime-web@<1.17` → `onnx-proto` → `protobufjs@<7.5.5`

`@huggingface/transformers@4.2+` uses modern `onnxruntime-web` versions that pull in `protobufjs >=7.5.5`, eliminating this CVE class entirely.

We had previously documented this as a deferred ADR-093 follow-up. The npm overrides we shipped in 3.6.18 cannot resolve this chain because (a) overrides only apply at the install root and (b) the version range required by `@xenova/transformers`'s manifests forbids the safer protobufjs.

### Current usage surface (verified by grep)

Only two call sites import `@xenova/transformers` in the v3 monorepo:

| File | Import | Usage |
|---|---|---|
| `v3/@claude-flow/embeddings/src/embedding-service.ts:387` | `const { pipeline } = await import('@xenova/transformers')` | Used as the ONNX backend for `feature-extraction` |
| `v3/@claude-flow/cli/src/memory/memory-initializer.ts:1539` | `const transformers = await import('@xenova/transformers').catch(() => null)` | Optional ONNX provider for embedding generation |

Both are dynamic imports wrapped in try/catch — the migration risk is bounded.

### API parity

A direct exports comparison (probed against `@xenova/transformers@2.17.2` and `@huggingface/transformers@4.2.0`):

- `@xenova/transformers`: 501 exports
- `@huggingface/transformers`: 935 exports (superset)
- **472 shared** exports, including all four we use: `pipeline`, `env`, `AutoTokenizer`, `AutoModel`
- 29 xenova-only exports (none used by us per grep)

Pipeline calls in both packages:
- xenova: `pipeline('feature-extraction', modelId)` → 384/768-dim Float32Array via `output.data`
- huggingface: same signature, same return shape (verified in HF migration guide)

## Decision

Migrate both call sites to a **provider-agnostic loader** that prefers `@huggingface/transformers`, falls back to `@xenova/transformers` for backwards compat with consumers who haven't installed the new package, and reports honest status via `embeddings_status.ruvectorStatus` (already structured per ADR-093 F5).

```ts
// New helper in @claude-flow/embeddings/src/transformers-loader.ts
export async function loadTransformersPipeline(): Promise<{
  pipeline: PipelineFn;
  source: '@huggingface/transformers' | '@xenova/transformers';
  version?: string;
} | null> {
  // Prefer the maintained successor
  try {
    const mod = await import('@huggingface/transformers');
    if (typeof mod.pipeline === 'function') {
      return { pipeline: mod.pipeline, source: '@huggingface/transformers', version: mod.version };
    }
  } catch { /* fall through */ }
  // Fall back to legacy for backwards compat
  try {
    const mod = await import('@xenova/transformers');
    if (typeof mod.pipeline === 'function') {
      return { pipeline: mod.pipeline, source: '@xenova/transformers', version: mod.version };
    }
  } catch { /* both unavailable */ }
  return null;
}
```

Update both call sites to use the loader:

```ts
// embedding-service.ts:387 (was: const { pipeline } = await import('@xenova/transformers'))
const t = await loadTransformersPipeline();
if (!t) throw new Error('No ONNX transformers package available');
this.pipeline = await t.pipeline('feature-extraction', this.modelName);
this.transformersSource = t.source;
```

### Dependency changes

`@claude-flow/embeddings/package.json`:
- Move `@xenova/transformers` from `dependencies` to `optionalDependencies` (keeps install size small for users who don't need ONNX)
- Add `@huggingface/transformers: "^4.2.0"` as a `peerDependency` (optional) and `optionalDependencies` (auto-install)
- Document in README that consumers can install either; the loader will use whichever is present

`@claude-flow/cli/package.json`: no direct change (transformers is a transitive of @claude-flow/embeddings).

### Validation plan

1. **Determinism check**: same input → identical 384-dim vectors across both packages (HF uses the same ONNX model weights for `Xenova/all-MiniLM-L6-v2`). Snapshot the first 8 dims for `"hello world"` and verify byte-identical output between packages.
2. **HNSW round-trip**: store a pattern with HF-generated embedding, search with same query → should hit with cosine similarity > 0.99.
3. **Mixed install**: install only `@huggingface/transformers` and verify embeddings work; install only `@xenova/transformers` and verify the fallback works; install neither and verify the graceful "no provider" path.
4. **Re-run the 6-agent verification swarm** against the build with the migration to confirm no regressions in `embeddings_*` MCP tools.
5. **`npm audit`** post-migration: `protobufjs <7.5.5` should drop from the prod tree.

## Consequences

**Positive:**
- Removes the critical RCE CVE chain through `protobufjs`. The 14-critical / 4-high audit count from 3.6.17 should drop substantially.
- Aligns with HuggingFace's official guidance (xenova was deprecated upstream).
- HF package is actively maintained (releases monthly vs xenova's last release in early 2025).
- API-compatible — bounded migration risk.

**Negative:**
- Bigger dependency tree (HF has more bundled features). Mitigated by making `@xenova/transformers` optional rather than removing entirely (consumers can opt for the smaller package).
- One more peer/optional dependency for `@claude-flow/embeddings` consumers to be aware of.

**Risk:**
- HF's `pipeline('feature-extraction', model)` might produce subtly different outputs vs xenova for the same model (e.g. different default normalization). Validation step #1 (byte-identical output check) catches this before merge.

## Notes

- This ADR is the migration plan. Implementation is queued for the next /loop iteration cycle.
- The `@huggingface/transformers` package itself currently audits clean against npm advisory database as of 2026-05-03.
- The provider-agnostic loader pattern (try-then-fallback) matches the existing `getQueryEmbedding` pattern in `hooks-tools.ts:3050`, so callers familiar with that codebase will recognize the shape.
