# ruflo-rag-memory

Retrieval-Augmented Generation memory with HNSW vector search, AgentDB persistence, and Claude Code memory bridge.

## Overview

Provides semantic store/search/recall over AgentDB with HNSW-indexed vector search (150x-12,500x faster than brute force). Bridges Claude Code's native auto-memory into AgentDB with 384-dim ONNX embeddings for unified cross-session semantic retrieval.

## Installation

```bash
claude --plugin-dir plugins/ruflo-rag-memory
```

## Requires

- `ruflo-core` plugin (provides MCP server)

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `memory-specialist` | sonnet | AgentDB management, HNSW optimization, memory bridge, consolidation |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `memory-search` | `/memory-search <query>` | Semantic vector search across all namespaces |
| `memory-bridge` | `/memory-bridge [--all-projects]` | Import Claude Code auto-memory into AgentDB |

## Commands

```bash
# Store a memory entry
memory store --key "pattern-auth" --value "JWT with refresh tokens" --namespace patterns

# Semantic search (HNSW-indexed)
memory search --query "authentication patterns" --namespace patterns --limit 5

# Retrieve by key
memory retrieve --key "pattern-auth" --namespace patterns

# List entries
memory list --namespace patterns --limit 10

# Delete
memory delete --key "old-entry" --namespace patterns

# Quick semantic recall across all namespaces
recall "how did we handle rate limiting?"
```

## Architecture

```
Claude Code Auto-Memory (~/.claude/projects/*/memory/*.md)
        │
        ▼ (ONNX all-MiniLM-L6-v2, 384-dim)
    Memory Bridge
        │
        ▼
    AgentDB (SQLite + vector_indexes)
        │
        ├── patterns namespace
        ├── tasks namespace
        ├── solutions namespace
        ├── feedback namespace
        ├── security namespace
        └── claude-memories namespace
        │
        ▼ (HNSW ANN index)
    Semantic Search (150x-12,500x faster)
```

## Memory Namespaces

| Namespace | Purpose | Example Key |
|-----------|---------|-------------|
| `patterns` | Successful code/design patterns | `pattern-auth-jwt` |
| `tasks` | Task context and outcomes | `task-refactor-api` |
| `solutions` | Bug fixes and solutions | `fix-race-condition` |
| `feedback` | User feedback and corrections | `feedback-test-style` |
| `security` | Vulnerability patterns | `vuln-sql-injection` |
| `claude-memories` | Bridged Claude Code memories | `auto-imported` |

## Claude Memory Bridge

Auto-imports Claude Code's native `~/.claude/projects/*/memory/*.md` files into AgentDB on session start with ONNX vector embeddings.

```bash
# Manual import (current project)
/memory-bridge

# Import all projects
/memory-bridge --all-projects

# Check bridge health
# Via MCP: memory_bridge_status({})
```

Results include source attribution: `claude-code`, `auto-memory`, or `agentdb`.

## SmartRetrieval (ADR-090)

5-phase retrieval pipeline for higher-quality recall across sessions:

1. **Query expansion** -- template-based variant generation (no LLM)
2. **Multi-query fan-out + RRF** -- Reciprocal Rank Fusion across variants
3. **Recency boost** -- exponential decay from metadata timestamps
4. **MMR diversity** -- token-Jaccard Maximal Marginal Relevance re-ranking
5. **Session round-robin** -- interleaved results from distinct sessions

```bash
# CLI
npx @claude-flow/cli@latest memory search --query "auth patterns" --smart --limit 10

# MCP
mcp__claude-flow__memory_search({ query: "auth patterns", smart: true, limit: 10 })
```

Best for multi-session recall, temporal queries ("what did we decide last week?"), and diverse result sets.

## Unified Search

Queries across all namespaces simultaneously with MMR diversity reranking:

```bash
# Via MCP: memory_search_unified({ query: "auth security", limit: 5 })
# Via CLI:
npx @claude-flow/cli@latest memory search --query "auth security" --limit 5
```

## HNSW Performance

| Operation | Latency | vs Brute Force |
|-----------|---------|----------------|
| Vector search (100 entries) | ~0.01ms | 150x faster |
| Vector search (10k entries) | ~0.05ms | 2,500x faster |
| Vector search (100k entries) | ~0.1ms | 12,500x faster |
| Store + index | ~1ms | — |

## Integration with ruvector

When `ruflo-ruvector` is also loaded, rag-memory delegates to ruvector's backend for advanced features:
- FlashAttention-3 for O(N) memory attention
- Graph RAG for multi-hop knowledge retrieval
- Hybrid search (sparse + dense) with RRF fusion
- DiskANN for large-scale persistent indexes

## Related Plugins

- `ruflo-agentdb` — Full AgentDB with 19 controllers and HNSW search
- `ruflo-ruvector` — Advanced vector operations (FlashAttention-3, Graph RAG, hybrid search)
- `ruflo-rvf` — Portable RVF memory format for cross-machine export/import
- `ruflo-knowledge-graph` — Entity extraction and graph traversal over memory

## License

MIT
