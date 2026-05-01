# ruflo-cost-tracker

Token usage tracking, model cost attribution per agent, budget alerts, and optimization recommendations.

## Overview

Tracks token usage per agent, task, and model, then computes USD cost attribution using current model pricing. Monitors configurable budgets with tiered alerts (info at 50%, warning at 75%, critical at 90%, hard stop at 100%). Analyzes usage patterns and recommends optimizations such as model downgrades, prompt caching, and batch operations.

## Installation

```bash
claude --plugin-dir plugins/ruflo-cost-tracker
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `cost-analyst` | haiku | Token usage tracking, USD cost attribution, budget monitoring, optimization recommendations |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `cost-report` | `/cost-report [--period today]` | Generate a cost report with token usage and USD costs by agent and model |
| `cost-optimize` | `/cost-optimize` | Analyze usage patterns and recommend cost optimizations with estimated savings |

## Commands (5 subcommands)

```bash
cost report [--period today|week|month]  # Generate cost report for a period
cost breakdown [--by agent|model|task]   # Detailed breakdown by dimension
cost budget set <amount>                 # Set budget limit in USD
cost optimize                            # Analyze usage and suggest savings
cost history                             # Show cost tracking over time
```

## Model Pricing (per 1M tokens)

| Model | Input | Output | Cache Write | Cache Read |
|-------|-------|--------|-------------|------------|
| Haiku | $0.25 | $1.25 | $0.30 | $0.03 |
| Sonnet | $3.00 | $15.00 | $3.75 | $0.30 |
| Opus | $15.00 | $75.00 | $18.75 | $1.50 |

## Budget Alert Thresholds

| Level | Threshold | Action |
|-------|-----------|--------|
| Info | 50% consumed | Log notification |
| Warning | 75% consumed | Display warning, suggest optimizations |
| Critical | 90% consumed | Urgent alert, recommend model downgrades |
| Hard Stop | 100% consumed | Halt non-essential agent spawns |

## Optimization Strategies

| Strategy | Savings | Impact |
|----------|---------|--------|
| Downgrade simple tasks to Haiku | 80-92% | Minimal for low-complexity work |
| Enable prompt caching | 90% on reads | None (same quality) |
| Batch similar operations | 15-25% | Slight latency increase |
| Use Agent Booster (Tier 1) | 100% | Only for simple transforms |
| Shorten system prompts | 10-20% | Requires careful pruning |

## Related Plugins

- `ruflo-observability` -- Token usage metrics collected via observability instrumentation
- `ruflo-neural-trader` -- PnL tracking and cost-adjusted return calculation

## License

MIT
