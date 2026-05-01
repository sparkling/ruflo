# ruflo-autopilot

Autonomous /loop-driven task completion with learning and prediction.

Combines Ruflo's 10 autopilot MCP tools with Claude Code's native `/loop` + `ScheduleWakeup` for persistent, cache-aware task completion loops.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-autopilot@ruflo
```

## Features

- **Autonomous loops**: Enable autopilot, then `/loop` drives iterative task completion
- **Progress tracking**: Monitors team-tasks, swarm-tasks, and file checklists
- **Learning**: Discovers success patterns from completed tasks via AgentDB
- **Prediction**: Predicts optimal next action based on state and learned patterns
- **Cache-aware**: ScheduleWakeup at 270s keeps prompt cache warm between iterations

## Commands

- `/autopilot` -- Enable, configure, or disable autopilot
- `/autopilot-status` -- Quick progress summary

## Skills

- `autopilot-loop` -- How to run an autopilot /loop iteration
- `autopilot-predict` -- Use learned patterns to pick the next task
