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

## G7 controllers (activated in ruflo 3.6.23+ / 3.6.24)

[ADR-095](../../v3/docs/adr/ADR-095-architectural-gaps-from-april-audit.md) closed five previously-disabled AgentDB controllers. They're now wired by default in the ControllerRegistry and reachable via `agentdb_*` MCP tools or the `/agentdb` slash command:

| Controller | Role | Source |
|---|---|---|
| `gnnService` | Graph Neural Network embeddings + relational scoring over the AgentDB causal graph. No-arg construction, safe-default activation. | `agentdb/dist/src/services/GNNService.js` |
| `rvfOptimizer` | RuVector format compaction — quantizes + dedupes vector blocks before persistence. No-arg construction. | `agentdb/dist/src/optimizations/RVFOptimizer.js` |
| `mutationGuard` | WASM-backed proof generation for state mutations (ADR-060). Gates writes through proof verification. | `agentdb/dist/src/security/MutationGuard.js` |
| `attestationLog` | Hash-chained audit log of mutations. Backed by a dedicated `.swarm/attestation.db` (separate from main memory.db so the audit trail is isolated). Requires `better-sqlite3`. | `agentdb/dist/src/security/AttestationLog.js` |
| `GuardedVectorBackend` | Wraps the existing vectorBackend with `mutationGuard` + `attestationLog` for proof-gated writes. Activates only when both prerequisites resolve. | `agentdb/dist/src/backends/ruvector/GuardedVectorBackend.js` |

The remaining G7 controller — `graphAdapter` — is still pending an external graph-DB connection. Tracked in ADR-095.

Inspect runtime status: `agentdb_controllers` MCP tool or `agentdb_health` — both report initialization status per controller.

## Commands

- `/agentdb` -- AgentDB health, controller status, session management
- `/embeddings` -- RuVector embedding engine status and operations

## Skills

- `agentdb-query` -- Query AgentDB with semantic routing and hierarchical recall
- `vector-search` -- HNSW vector search with RuVector embeddings
