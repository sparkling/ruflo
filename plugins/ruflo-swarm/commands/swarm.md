---
description: Initialize, monitor, and manage multi-agent swarms
---
$ARGUMENTS

Swarm lifecycle management.

**Init**: `npx @sparkleideas/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized`
**Status**: `npx @sparkleideas/cli@latest swarm status`
**Health**: `npx @sparkleideas/cli@latest swarm health`
**Shutdown**: `npx @sparkleideas/cli@latest swarm shutdown`

Parse $ARGUMENTS to determine the subcommand. If no arguments, show swarm status.

After init, spawn agents via Claude Code's Task tool with `run_in_background: true` for parallel execution.
