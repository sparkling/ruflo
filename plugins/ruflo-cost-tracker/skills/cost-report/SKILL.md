---
name: cost-report
description: Generate a cost report showing token usage and USD costs by agent and model
argument-hint: "[--period today]"
allowed-tools: mcp__claude-flow__memory_search mcp__claude-flow__memory_list mcp__claude-flow__memory_retrieve mcp__claude-flow__agentdb_pattern-search mcp__claude-flow__agentdb_semantic-route Bash
---

# Cost Report

Generate a comprehensive cost report showing token usage, USD costs, and budget utilization for the specified period.

## When to use

When you need to understand current spending -- how much each agent costs, which models consume the most budget, and whether you're on track to stay within budget.

## Steps

1. **Retrieve usage** -- call `mcp__claude-flow__memory_search` (or `_list` / `_retrieve`) on the `cost-tracking` namespace for the specified period (default: today). The `memory_*` tools route by namespace string; the `agentdb_hierarchical-*` tools do **not** (they route by tier `working|episodic|semantic`), so don't use them here. See [ruflo-agentdb ADR-0001 §"Namespace convention"](../../../ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md) for the routing contract.
2. **Compute costs** -- for each record, calculate cost using model pricing:
   - Haiku: $0.25/M input, $1.25/M output
   - Sonnet: $3.00/M input, $15.00/M output
   - Opus: $15.00/M input, $75.00/M output
   - Include cache write/read costs where applicable
3. **Aggregate by model** -- sum costs per model, compute percentage share
4. **Aggregate by agent** -- sum costs per agent, include the model each agent used
5. **Check budget** -- recall budget configuration via `memory_retrieve` and compute utilization percentage, check alert thresholds (50%/75%/90%/100%)
6. **Report** -- display: total cost, budget remaining, model breakdown, agent breakdown, active alerts

## CLI alternative

```bash
npx @claude-flow/cli@latest memory search --query "cost report for today" --namespace cost-tracking
npx @claude-flow/cli@latest memory list --namespace cost-tracking
```
