---
name: swarm-init
description: Initialize a multi-agent swarm with anti-drift configuration
argument-hint: "[--topology hierarchical|mesh|ring]"
allowed-tools: Bash(npx *) mcp__ruflo__swarm_init mcp__ruflo__swarm_status Agent TeamCreate SendMessage
---
Initialize a hierarchical swarm for coordinated multi-agent work.

Via MCP: `mcp__ruflo__swarm_init({ topology: "hierarchical", maxAgents: 8, strategy: "specialized" })`

Or via CLI:
```bash
npx @sparkleideas/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

## Coordinate the swarm as a Claude Code team

A swarm is parallel **collaboration** — workers divide the work and coordinate while running. Bind them to a Claude Code team so the Agent-Teams behaviors activate (shared `team_context`, `teammate_mailbox`, `@name` addressing, `TaskUpdate` auto-claim):

1. After init, create the team — reuse the `swarmId` from the `swarm_init` response as the team name:
   `TeamCreate({ team_name: "<swarmId>", description: "<objective>" })`
2. Spawn each worker **into the team** — pass `team_name` on the `Agent`/`Task` call; add `isolation: "worktree"` for git-safe parallel edits:
   `Agent({ subagent_type: "coder", team_name: "<swarmId>", run_in_background: true, prompt: <task> })`
3. Coordinate at runtime with `SendMessage({ to: "<worker-name>", ... })` — workers see teammate messages and shared context, and can claim tasks.

**Swarm vs hive — when NOT to team-bind:** teams are for *collaboration during execution*. If the goal is a **consensus or dialectic decision** (independent expert positions → vote → verdict), use the **hive-mind** skill instead — its Council/Consensus patterns deliberately keep workers **isolated** (no cross-talk) so the dialectic stays honest. Never bind council workers to a team.

For larger teams (10+), use hierarchical-mesh topology:
```bash
npx @sparkleideas/cli@latest swarm init --topology hierarchical-mesh --max-agents 15 --strategy specialized
```
