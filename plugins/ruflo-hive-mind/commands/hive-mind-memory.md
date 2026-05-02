---
name: hive-mind-memory
description: Query and manage collective hive memory across 8 memory types with TTL
implementation-status: partial
gap-tracker: [ADR-0118-T4, ADR-0118-T5]
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

> **Implementation status**: `partial` — see ADR-0118 T4 (memory types + TTLs) and T5 (LRU + SQLite WAL backend). The current MCP backend exposes a flat key/value dict with no type discriminator or TTL.
