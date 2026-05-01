# ruflo-adr

ADR lifecycle management -- create, index, supersede, and link Architecture Decision Records to code.

## Overview

Manages Architecture Decision Records through their full lifecycle (proposed, accepted, deprecated, superseded). ADRs are stored as markdown files in `docs/adr/` and indexed in AgentDB with causal edges tracking supersedes/amends/depends-on relationships. Includes compliance checking that scans git diffs for ADR violations.

## Installation

```bash
claude --plugin-dir plugins/ruflo-adr
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `adr-architect` | sonnet | ADR lifecycle management, code-ADR linking via grep/blame, AgentDB graph storage |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `adr-create` | `/adr-create <title>` | Create a new ADR with sequential numbering and AgentDB registration |
| `adr-index` | `/adr-index` | Build or rebuild the ADR index and dependency graph in AgentDB |
| `adr-review` | `/adr-review [--branch BRANCH]` | Review code changes against accepted ADRs for compliance violations |

## Commands (7 subcommands)

```bash
# Lifecycle
adr create <title>
adr list
adr status <adr-id> <new-status>
adr supersede <old-id> <new-id>

# Compliance
adr check                    # Scan recent git changes for ADR violations
adr graph                    # Show ADR dependency graph
adr search <query>           # Semantic search across ADRs
```

## ADR Lifecycle

```
proposed --> accepted --> deprecated
                    \--> superseded by ADR-XXX
```

Relationships tracked as causal edges: `supersedes`, `amends`, `depends-on`, `related`.

## Related Plugins

- `ruflo-ddd` -- Document domain decisions as ADRs
- `ruflo-sparc` -- Architecture phase (Phase 3) produces ADRs
- `ruflo-migrations` -- Schema change decisions recorded as ADRs

## License

MIT
