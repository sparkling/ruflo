# ruflo-ruvector

Self-learning vector database powered by [`ruvector`](https://www.npmjs.com/package/ruvector) — HNSW, FlashAttention-3, Graph RAG, hybrid search, DiskANN, 103 MCP tools, Brain AGI, and 50+ attention mechanisms.

## Overview

Wraps the `ruvector` npm package as a Ruflo plugin, providing vector embedding, semantic search, clustering, hyperbolic space reasoning, self-learning hooks, and Brain AGI diagnostics. ruvector's Rust backend delivers sub-millisecond queries and 52,000+ inserts/sec.

## Prerequisites

```bash
npm install ruvector
```

## Installation

```bash
claude --plugin-dir plugins/ruflo-ruvector
```

## MCP Integration (103 Tools)

```bash
claude mcp add ruvector -- npx ruvector mcp start
```

Key tool categories: hooks routing, AST analysis, diff classification, coverage routing, graph clustering, security scanning, RAG context, brain knowledge, AGI diagnostics, midstream analytics.

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `vector-engineer` | sonnet | Embedding, HNSW indexing, FlashAttention-3, Graph RAG, hybrid search, clustering, hyperbolic space, Brain AGI |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `vector-embed` | `/vector-embed <text-or-file>` | ONNX embeddings (384-dim), normalize, store in HNSW |
| `vector-cluster` | `/vector-cluster <namespace> [--k N]` | k-means or density clustering with labeled summaries |
| `vector-hyperbolic` | `/vector-hyperbolic <text>` | Poincare ball hierarchical embeddings |

## Commands

```bash
# Embedding
vector embed <text>
vector batch <glob-pattern>
vector compare <text1> <text2>

# Search
vector search <query> [--limit N] [--hybrid] [--graph-rag]

# Clustering
vector cluster <namespace> [--k N | --density]

# Index management
vector index create <name>
vector index stats <name>

# Hyperbolic
vector hyperbolic embed <text>

# Self-learning hooks
vector hooks init
vector hooks route <task>
vector ast <file>

# Brain AGI
vector brain status
vector midstream status
```

## Search Capabilities (ruvector v2.1+)

| Feature | Description | Improvement |
|---------|-------------|-------------|
| FlashAttention-3 | IO-aware tiled attention | O(N) memory vs O(N^2) |
| Graph RAG | Knowledge graph + community detection | 30-60% better multi-hop |
| Hybrid Search | Sparse + dense with RRF fusion | 20-49% better retrieval |
| DiskANN / Vamana | SSD-friendly ANN with PQ compression | Large-scale search |
| ColBERT | Per-token late interaction | Fine-grained matching |
| Matryoshka | Adaptive-dimension with cascade | Flexible precision |
| MLA | Multi-Head Latent Attention | ~93% KV-cache compression |
| TurboQuant | 2-4 bit quantization | 6-8x memory reduction |

## Self-Learning Hooks

```bash
# Full 9-phase pretrain pipeline
npx ruvector hooks init --pretrain --build-agents quality

# Smart agent routing
npx ruvector hooks route --task "description"

# Code analysis
npx ruvector hooks ast-analyze --file src/module.ts
npx ruvector hooks diff-analyze --file src/module.ts
npx ruvector hooks coverage-route --task "description"
npx ruvector hooks security-scan --path src/
```

## Brain AGI

Access 8 AGI subsystems:

```bash
npx ruvector brain agi status      # Combined diagnostics
npx ruvector brain agi sona        # SONA patterns and trajectories
npx ruvector brain agi temporal    # Knowledge evolution velocity
npx ruvector brain agi explore     # Meta-learning curiosity & regret
npx ruvector brain search "query"  # Shared brain knowledge search
```

## Performance

| Operation | Latency | Notes |
|-----------|---------|-------|
| HNSW search | ~0.045ms | 8,800x vs inference |
| Memory cache | ~0.01ms | 40,000x vs inference |
| Insert | 52,000+/sec | Rust backend |
| Memory per vector | ~50 bytes | Efficient storage |

## Related Plugins

- `ruflo-agentdb` — HNSW storage backend in AgentDB
- `ruflo-intelligence` — SONA pattern learning integration
- `ruflo-knowledge-graph` — Graph RAG for multi-hop retrieval
- `ruflo-rag-memory` — Simple semantic search via ruvector

## License

MIT
