# ruflo-agentdb

AgentDB memory controllers with HNSW vector search, RuVector embeddings, and causal knowledge graphs.

Wraps Ruflo's AgentDB MCP tools (agentdb_*, embeddings_*, ruvllm_hnsw_*) into skills and commands for Claude Code.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-agentdb@ruflo
```

## Features

- **19 AgentDB controllers**: Hierarchical store/recall, semantic routing, context synthesis
- **HNSW vector search**: 150x-12,500x faster than brute-force scanning
- **384-dim ONNX embeddings**: all-MiniLM-L6-v2 for semantic similarity
- **Causal knowledge graphs**: Link related knowledge with causal edges
- **Hyperbolic embeddings**: Poincare ball model for hierarchical data

## Commands

- `/agentdb` -- AgentDB health, controller status, session management
- `/embeddings` -- RuVector embedding engine status and operations

## Skills

- `agentdb-query` -- Query AgentDB with semantic routing and hierarchical recall
- `vector-search` -- HNSW vector search with RuVector embeddings
