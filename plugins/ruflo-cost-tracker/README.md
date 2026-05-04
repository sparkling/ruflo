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

## Federation budget circuit breaker pairing (ruflo 3.6.25+)

This plugin pairs naturally with the federation budget envelope shipped in [ADR-097](../../v3/docs/adr/ADR-097-federation-budget-circuit-breaker.md). The `federation_send` MCP tool now accepts caller-supplied caps that this plugin's tracking should respect:

| Field | Default | Effect |
|---|---|---|
| `maxHops` | `8` | Hard ceiling on recursive delegation across federated peers — defangs cost cascades from runaway sub-swarms. |
| `maxTokens` | unbounded | Σ tokens across the whole hop chain. Returns `BUDGET_EXCEEDED` (constant string, no oracle leak) on overshoot. |
| `maxUsd` | unbounded | Σ USD across hops. Same enforcement. |
| `hopCount` | `0` | Pass-through for re-forwarded messages. |
| `spent.{tokens,usd}` | `0` | Caller-reported usage from previous legs. Negatives clamped to 0. |

Phase 1 of ADR-097 enforces at the **send** side. Two follow-up phases will tighten the integration:

- **Phase 2 (deferred)** — peer state machine `ACTIVE` / `SUSPENDED` / `EVICTED` driven by trailing 24h cost (default suspension threshold $5) + 1h failure ratio (>50% over ≥10 sends). Auto-recovery after 30 min cooldown.
- **Phase 3 (deferred)** — `federation_spend` event bus. Each `federation_send` completion publishes `{peerId, taskId, tokensUsed, usdSpent, ts}`. This plugin's cost-tracker should aggregate per-peer rolling windows (1h / 24h / 7d) and expose them via the existing `cost-report` skill. Breaker queries the aggregate to evaluate suspension thresholds.

Until Phase 3 ships, federated spend is **not** counted in the host's cost-tracker — only local agent spend. Treat `cost-report` numbers as a lower bound when federation is in use.

## Compatibility

- **CLI:** pinned to `@claude-flow/cli` v3.6 major+minor.
- **Verification:** `bash plugins/ruflo-cost-tracker/scripts/smoke.sh` is the contract.

## Namespace coordination

This plugin owns two AgentDB namespaces:

- `cost-tracking` — usage records (consumed by `cost-report`)
- `cost-patterns` — optimization recommendations (consumed by `cost-optimize`)

Both follow the kebab-case `<plugin-stem>-<intent>` convention from [ruflo-agentdb ADR-0001 §"Namespace convention"](../ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md). Both are accessed via the `memory_*` tool family which routes by namespace.

> **Routing note:** The `agentdb_hierarchical-*` and `agentdb_pattern-*` tools route by tier / ReasoningBank, not by namespace string. Earlier versions of `cost-report` and `cost-optimize` passed namespace arguments to those tools and got silently-ignored behavior. ADR-0001 fixes this by switching the load path to `memory_*` and documenting the dual write path for optimization patterns.

Reserved namespaces (`pattern`, `claude-memories`, `default`) MUST NOT be shadowed.

## Verification

```bash
bash plugins/ruflo-cost-tracker/scripts/smoke.sh
# Expected: "10 passed, 0 failed"
```

## Architecture Decisions

- [`ADR-0001` — ruflo-cost-tracker plugin contract (namespace-routing fix, federation budget pairing, smoke as contract)](./docs/adrs/0001-cost-tracker-contract.md)

## Related Plugins

- `ruflo-agentdb` — namespace convention owner; defines the routing rules ADR-0001 fixes a violation of
- `ruflo-observability` -- Token usage metrics collected via observability instrumentation
- `ruflo-neural-trader` -- PnL tracking and cost-adjusted return calculation
- `ruflo-federation` -- Budget circuit breaker on outbound federation_send (ADR-097)

## License

MIT
