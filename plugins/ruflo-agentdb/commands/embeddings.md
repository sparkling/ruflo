---
name: embeddings
description: RuVector embedding engine status and operations
---

Embedding engine commands:

1. Call `mcp__claude-flow__embeddings_status` to check the ONNX embedding engine
2. Show: model (all-MiniLM-L6-v2), dimensions (384), HNSW index status, cache hit rate
3. If not initialized, suggest calling `mcp__claude-flow__embeddings_init`
4. For search operations, use `mcp__claude-flow__embeddings_search` with the user's query
