---
name: vector-search
description: Vector search via embeddings_* (large-scale HNSW) and ruvllm_hnsw_* (WASM router for ≤11 hot patterns)
argument-hint: "<query> [--limit N]"
allowed-tools: mcp__ruflo__embeddings_generate mcp__ruflo__embeddings_search mcp__ruflo__embeddings_compare mcp__ruflo__embeddings_init mcp__ruflo__embeddings_status mcp__ruflo__embeddings_hyperbolic mcp__ruflo__embeddings_neural mcp__ruflo__ruvllm_hnsw_create mcp__ruflo__ruvllm_hnsw_add mcp__ruflo__ruvllm_hnsw_route mcp__ruflo__memory_search_unified Bash
---

# Vector Search

Two distinct vector-search paths live in this plugin. Pick the right one — they're not interchangeable.

| Path | Tool family | Backing | Capacity | Latency |
|------|-------------|---------|----------|---------|
| **Large-scale corpus** | `embeddings_*` | `@sparkleideas/memory` HNSW (Rust/Native) | up to millions of vectors | 150×–12,500× faster than brute-force, depending on N and parameters |
| **Hot-path router** | `ruvllm_hnsw_*` | WASM-backed router (v2.0.1) | **~11 patterns max** (`ruvllm-tools.ts:58`) | sub-ms; designed for high-priority routing, not corpus search |

The "12,500×" headline applies to the large-scale `embeddings_search` path. The WASM router is **not** that path.

## When to use

| Need | Path |
|---|---|
| Search a corpus of N ≥ 500 documents | `embeddings_search` |
| Compare two strings | `embeddings_compare` |
| Hierarchical / taxonomic data | `embeddings_hyperbolic` (Poincare ball) |
| Route a query to one of ≤11 hot patterns | `ruvllm_hnsw_route` |
| Cross-namespace search | `memory_search_unified` |

## Standard search

1. **Check status** — `mcp__ruflo__embeddings_status` to verify the embedding engine.
2. **Initialize** — `mcp__ruflo__embeddings_init` if not active.
3. **Generate** — `mcp__ruflo__embeddings_generate` for text input.
4. **Search** — `mcp__ruflo__embeddings_search` with the query.
5. **Compare** — `mcp__ruflo__embeddings_compare` to measure similarity.
6. **Unified search** — `mcp__ruflo__memory_search_unified` for cross-namespace.

## Tuning

HNSW exposes three knobs that trade recall against latency. The "12,500×" headline assumes **defaults**; tune deliberately for your workload:

| Profile | `efSearch` | `M` | When to use |
|---------|-----------|-----|-------------|
| `recall-first` | 200 | 32 | Pattern recall during planning; quality matters more than ms |
| `balanced` (default) | 64 | 16 | General-purpose semantic recall |
| `latency-first` | 16 | 8 | Hot-path routing where p99 latency matters |

`efSearch` is passed via `ruvllm_hnsw_create` (`ruvllm-tools.ts:64`). `M` is registry-level today; raise as a follow-up if it should be MCP-tunable. `efConstruction` defaults to 200 in the lite index (`hnsw-index.ts:537`).

## HNSW pattern router (WASM, ≤11 patterns)

For routing a small number of high-priority patterns:
- `mcp__ruflo__ruvllm_hnsw_create` — create the WASM index (cap ~11)
- `mcp__ruflo__ruvllm_hnsw_add` — add a pattern
- `mcp__ruflo__ruvllm_hnsw_route` — route an incoming query

This is **not** a corpus index. Treat it as a fast classifier over a curated set of patterns.

## Hyperbolic embeddings

For hierarchical data (code trees, org charts), use `mcp__ruflo__embeddings_hyperbolic` which maps to Poincare ball space. Distance is geodesic, not cosine.

## CLI alternative

```bash
npx @sparkleideas/cli@latest embeddings search --query "authentication patterns"
npx @sparkleideas/cli@latest embeddings init
npx @sparkleideas/cli@latest memory search --query "your query"
```

## Performance

| Method | Speed |
|--------|-------|
| Brute-force scan | Baseline |
| HNSW (n=500, balanced) | ~150× faster |
| HNSW (n=10,000, balanced) | ~12,500× faster |
| `ruvllm_hnsw_route` (n≤11) | sub-ms per route, fixed cost |
