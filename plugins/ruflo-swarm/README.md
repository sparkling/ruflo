# ruflo-swarm

Agent teams, swarm coordination, Monitor streams, and worktree isolation.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-swarm@ruflo
```

## What's Included

- **Agent Teams**: TeamCreate, SendMessage, and Task tool integration for multi-agent coordination
- **Topologies**: hierarchical, mesh, hierarchical-mesh, ring, star, adaptive
- **Monitor Streams**: Real-time swarm status via `Monitor("npx @claude-flow/cli@latest swarm watch --stream")`
- **Worktree Isolation**: Each agent works in its own git worktree to avoid conflicts
- **Hive-Mind Consensus**: Byzantine, Raft, Gossip, CRDT, and Quorum strategies
- **Anti-Drift**: hierarchical topology with specialized strategy for tight coordination

## Requires

- `ruflo-core` plugin (provides MCP server)
