---
name: neural
description: Neural pattern training and prediction commands
---

Neural system commands:

1. Parse the user's subcommand (train, status, patterns, predict, optimize)
2. For **train**: call `mcp__claude-flow__neural_train` with pattern-type and epochs
3. For **status**: call `mcp__claude-flow__neural_status`
4. For **patterns**: call `mcp__claude-flow__neural_patterns` to list learned patterns
5. For **predict**: call `mcp__claude-flow__neural_predict` with the task description
6. For **optimize**: call `mcp__claude-flow__neural_optimize`
7. Present results in a clear format
