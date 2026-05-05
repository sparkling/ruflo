---
description: Query and manage collective hive memory across 8 memory types with TTL
---

# hive-mind-memory

Command documentation for hive-mind-memory in category hive-mind.

Usage:
```bash
npx @sparkleideas/cli@latest hive-mind hive-mind-memory [options]
```

## Collective Memory Types (USERGUIDE contract)

| Type | TTL | Purpose |
|---|---|---|
| `knowledge` | permanent | Long-term shared facts and learned patterns |
| `context` | 1h | Short-lived working context |
| `task` | 30min | Active task state |
| `result` | permanent | Task outcomes |
| `error` | 24h | Failure traces |
| `metric` | 1h | Performance metrics |
| `consensus` | permanent | Decisions reached via voting |
| `system` | permanent | Hive infrastructure state |
