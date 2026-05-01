# ruflo-core

Core Ruflo MCP tools, commands, and Claude Code orchestration patterns.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-core@ruflo
```

## What's Included

- **MCP Server**: 314 tools via `@claude-flow/cli` (memory, agents, swarm, hooks, neural, security)
- **CLI Commands**: 26 commands with 140+ subcommands for agent orchestration
- **3-Tier Model Routing**: Agent Booster (WASM), Haiku, Sonnet/Opus with automatic cost optimization
- **Session Management**: Persistent sessions with cross-conversation learning
- **Hooks System**: 17 hooks + 12 background workers for self-learning automation

## Configuration

The MCP server starts automatically when this plugin is active. Override environment variables in `.mcp.json` as needed.
