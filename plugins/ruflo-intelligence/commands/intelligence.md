---
name: intelligence
description: View intelligence system status, learned patterns, and routing stats
---

Show the intelligence system dashboard:

1. Call `mcp__claude-flow__hooks_intelligence_stats` to get pattern counts, trajectory history, and learning metrics
2. Call `mcp__claude-flow__neural_status` to get SONA/MoE state
3. Call `mcp__claude-flow__hooks_model-stats` to get model routing statistics
4. Present a summary table with pattern count, success rate, active trajectories, and model tier distribution
