# ruflo-loop-workers

Cache-aware /loop workers and CronCreate background automation.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-loop-workers@ruflo
```

## What's Included

- **Loop Workers**: Recurring tasks via `/loop` with ScheduleWakeup (delay <270s for prompt cache hits)
- **CronCreate**: Background cron jobs for audit, optimization, and monitoring
- **12 Background Workers**: ultralearn, optimize, consolidate, predict, audit, map, preload, deepdive, document, refactor, benchmark, testgaps
- **Daemon Management**: Start, stop, status, trigger, and enable workers
- **ADR-091 Integration**: Native Claude Code capabilities preferred over daemon polling

## Requires

- `ruflo-core` plugin (provides MCP server)
