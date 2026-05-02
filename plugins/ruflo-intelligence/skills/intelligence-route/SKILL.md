---
name: intelligence-route
description: Route tasks to optimal agents using learned patterns, model recommendations, and confidence scoring
argument-hint: "<task-description>"
allowed-tools: mcp__ruflo__hooks_route mcp__ruflo__hooks_model-route mcp__ruflo__hooks_model-stats mcp__ruflo__hooks_model-outcome mcp__ruflo__hooks_intelligence_pattern-search mcp__ruflo__hooks_intelligence_attention mcp__ruflo__hooks_intelligence_stats mcp__ruflo__neural_predict mcp__ruflo__hooks_pre-task Bash
---

# Intelligence Routing

Route tasks to the best agent and model based on learned patterns.

## When to use

Before starting any task, use intelligence routing to get the optimal agent type, model tier, and confidence score. This replaces manual agent selection with data-driven decisions.

## Steps

1. **Get routing recommendation** — call `mcp__ruflo__hooks_route` with the task description
2. **Check model recommendation** — call `mcp__ruflo__hooks_model-route` for the optimal model tier (Haiku/Sonnet/Opus)
3. **Search for similar patterns** — call `mcp__ruflo__hooks_intelligence_pattern-search` to find past successes
4. **Predict outcome** — call `mcp__ruflo__neural_predict` with the task description
5. **Spawn the recommended agent** at the recommended model tier
6. **Record outcome** — after task completes, call `mcp__ruflo__hooks_model-outcome` to train the router

## 3-Tier Model Routing

| Tier | Handler | When |
|------|---------|------|
| 1 | Agent Booster (WASM) | Simple transforms — skip LLM entirely |
| 2 | Haiku | Low complexity tasks (<30%) |
| 3 | Sonnet/Opus | Complex reasoning, architecture, security |

## CLI alternative

```bash
npx @sparkleideas/cli@latest hooks route --task "description"
npx @sparkleideas/cli@latest hooks pre-task --description "description"
npx @sparkleideas/cli@latest hooks explain --topic "routing decision"
```

## Viewing intelligence stats

Call `mcp__ruflo__hooks_intelligence_stats` or:
```bash
npx @sparkleideas/cli@latest hooks intelligence stats
```
