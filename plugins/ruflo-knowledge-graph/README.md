# ruflo-knowledge-graph

Knowledge graph construction -- entity extraction, relation mapping, and pathfinder graph traversal.

## Overview

Extracts entities (classes, functions, modules, types, concepts) and relations (imports, extends, implements, depends-on, calls) from source code and documentation. Builds a navigable knowledge graph stored in AgentDB with hierarchical nodes and causal edges. Traverses the graph using a pathfinder algorithm that scores paths by edge weight and semantic similarity.

## Installation

```bash
claude --plugin-dir plugins/ruflo-knowledge-graph
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `graph-navigator` | sonnet | Entity extraction, relation mapping, knowledge graph construction, pathfinder traversal |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `kg-extract` | `/kg-extract <path>` | Extract entities and relations from source files to build a knowledge graph |
| `kg-traverse` | `/kg-traverse <entity> [--depth N]` | Pathfinder traversal starting from a seed entity |

## Commands (5 subcommands)

```bash
kg extract <path>            # Extract entities and relations from source files
kg traverse <entity>         # Pathfinder traversal from a seed entity
kg relations <entity>        # List all direct relations for an entity
kg visualize                 # ASCII visualization of the knowledge graph
kg search <query>            # Semantic search across the graph
```

## Entity Types

| Type | Examples |
|------|----------|
| class | `UserService`, `AuthController` |
| function | `calculateDiscount`, `handleRequest` |
| module | `auth`, `payments`, `api` |
| concept | `authentication`, `caching` |
| type | `User`, `OrderStatus` |
| config | `database`, `redis`, `jwt` |

## Pathfinder Algorithm

1. **Seed** -- start from the target entity node
2. **Expand** -- follow causal edges outward (configurable depth, default 3)
3. **Score** -- `relevance = edge_weight * semantic_similarity(query, node)`
4. **Prune** -- remove paths below threshold (default 0.3)
5. **Rank** -- return top-K paths by cumulative relevance

## Related Plugins

- `ruflo-ruvector` -- HNSW indexing for fast semantic search across graph nodes
- `ruflo-adr` -- ADR dependency graphs share the same causal edge model

## License

MIT
