# ruflo-core

Core Ruflo MCP tools, commands, and Claude Code orchestration patterns.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-core@ruflo
```

## What's Included

- **MCP Server**: 314 tools via `@sparkleideas/cli` (memory, agents, swarm, hooks, neural, security)
- **CLI Commands**: 26 commands with 140+ subcommands for agent orchestration
- **3-Tier Model Routing**: Agent Booster (WASM), Haiku, Sonnet/Opus with automatic cost optimization
- **Session Management**: Persistent sessions with cross-conversation learning
- **Hooks**: PreToolUse / PostToolUse / PreCompact / Stop wired to claude-flow's auto-routing + learning loop. Defined at `plugins/ruflo-core/hooks/hooks.json` so the per-plugin loader picks them up on `/plugin install ruflo-core@ruflo` (per-plugin layout — fixes #1748 Issue 1; the marketplace-root copy at `.claude-plugin/hooks/hooks.json` is preserved for `claude --plugin-dir <repo-root>` users).

## Configuration

The MCP server starts automatically when this plugin is active. Override environment variables in `.mcp.json` as needed.
