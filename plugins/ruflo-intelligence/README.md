# ruflo-intelligence

Self-learning neural intelligence with SONA patterns, trajectory learning, and model routing.

Wraps Ruflo's intelligence MCP tools (neural_*, hooks_intelligence_*, hooks_model-*) into skills and commands for Claude Code.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-intelligence@ruflo
```

## Features

- **Neural training**: Train SONA patterns from task completions
- **Trajectory learning**: Record and learn from multi-step task trajectories
- **Intelligent routing**: Route tasks to optimal agents and model tiers
- **Pattern discovery**: Search and store successful patterns via HNSW
- **EWC++ consolidation**: Prevent catastrophic forgetting across sessions

## Commands

- `/intelligence` -- View intelligence dashboard and stats
- `/neural` -- Neural training and prediction commands

## Skills

- `neural-train` -- Train SONA neural patterns from successful tasks
- `intelligence-route` -- Route tasks using learned patterns and confidence scoring
