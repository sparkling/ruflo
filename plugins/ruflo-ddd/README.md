# ruflo-ddd

Domain-Driven Design scaffolding -- bounded contexts, aggregate roots, domain events, and anti-corruption layers.

## Overview

Transforms business domains into well-structured bounded contexts with aggregate roots, value objects, domain events, repositories, and anti-corruption layers. Stores the domain model as a navigable graph in AgentDB with hierarchical nodes and causal edges for context dependencies.

## Installation

```bash
claude --plugin-dir plugins/ruflo-ddd
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `domain-modeler` | sonnet | Map domains to bounded contexts, design aggregates with invariants, define domain events, generate ACL interfaces |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `ddd-context` | `/ddd-context <context-name>` | Create a bounded context with standard directory structure |
| `ddd-aggregate` | `/ddd-aggregate <context> <aggregate-name>` | Scaffold an aggregate root with entity, value objects, repository, events, and test stubs |
| `ddd-validate` | `/ddd-validate` | Detect cross-context import violations and aggregate invariant issues |

## Commands (6 subcommands)

```bash
# Context management
ddd context create <name>
ddd context list

# Aggregate scaffolding
ddd aggregate <context> <name>
ddd event <context> <name>

# Validation & visualization
ddd validate                 # Check domain boundary violations
ddd map                      # Visualize context map with relationships
```

## Directory Structure per Context

```
src/<context-name>/
  domain/
    entities/           # Entities and aggregate root
    value-objects/       # Immutable value objects
    events/             # Domain events
    services/           # Domain services
    repositories/       # Repository interfaces
  application/          # Use cases / application services
  infrastructure/       # Repository implementations, ACL adapters
  index.ts              # Public API of the context
```

## Context Relationships

Detected via import analysis: upstream/downstream, ACL, shared kernel, published language. Boundary violations (direct cross-context imports) are flagged by `ddd validate`.

## Related Plugins

- `ruflo-adr` -- Document domain decisions as Architecture Decision Records
- `ruflo-sparc` -- Architecture phase leverages DDD bounded context patterns
- `ruflo-migrations` -- Align migration boundaries with aggregate roots

## License

MIT
