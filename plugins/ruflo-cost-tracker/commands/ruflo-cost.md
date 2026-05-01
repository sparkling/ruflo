---
name: ruflo-cost
description: Cost tracking operations — generate reports, view breakdowns, set budgets, and get optimization recommendations
---

Cost tracking commands:

**`cost report [--period today|week|month]`** -- Generate a cost report for the specified period.
1. Recall token usage records from `cost-tracking` namespace for the period
2. Compute costs by model using current pricing (haiku/sonnet/opus input/output rates)
3. Aggregate by agent, task, and model
4. Show budget utilization percentage if a budget is configured
5. Display: total cost, breakdown by model, breakdown by agent, budget status

**`cost breakdown [--by agent|model|task]`** -- Detailed cost breakdown by dimension.
1. Recall all usage records from `cost-tracking` namespace
2. Group by the specified dimension (agent, model, or task)
3. For each group: total tokens (input/output/cache), total cost, percentage of total
4. Sort by cost descending
5. Display: dimension value, input tokens, output tokens, cache tokens, total cost, share %

**`cost budget set <amount>`** -- Set a budget limit in USD.
1. Store the budget configuration via `mcp__claude-flow__agentdb_hierarchical-store`
2. Configure alert thresholds: info at 50%, warning at 75%, critical at 90%, hard stop at 100%
3. Report: budget set, current spend, remaining budget, alert thresholds

**`cost optimize`** -- Analyze usage and suggest cost optimizations.
1. Recall recent usage data from `cost-tracking` namespace
2. For each agent, analyze: average task complexity, model used, token efficiency
3. Identify agents using expensive models for low-complexity tasks
4. Check cache hit rates and suggest caching improvements
5. Look for redundant agent spawns or duplicate work
6. Calculate estimated savings for each recommendation
7. Display: recommendation, current cost, projected cost, savings, impact assessment

**`cost history`** -- Show cost tracking history over time.
1. Recall all cost reports from `cost-tracking` namespace
2. Show daily/weekly totals with trend direction
3. Highlight days with unusual spending (>2x average)
4. Display: date, total cost, top agent, top model, budget status
