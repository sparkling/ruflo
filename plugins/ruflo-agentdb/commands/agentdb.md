---
name: agentdb
description: AgentDB health, controller status, and session management
---

AgentDB management:

1. Call `mcp__claude-flow__agentdb_health` to check database health
2. Call `mcp__claude-flow__agentdb_controllers` to list all 19 controllers and their status
3. Present a summary with: total entries, active sessions, controller count, and storage size
4. If issues found, suggest running `npx @claude-flow/cli@latest memory init --force` to reinitialize
