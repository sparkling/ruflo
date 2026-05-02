# ruflo-hive-mind

Queen-led collective intelligence with consensus mechanisms for sparkling/ruflo.

## Install

    /plugin marketplace add sparkling/ruflo
    /plugin install ruflo-hive-mind@ruflo

## What's in the box

- 2 skills: `hive-mind`, `hive-mind-advanced`
- 16 agents (hive coordination, consensus, topology)
- 11 slash commands

## USERGUIDE contract

This plugin materialises everything the upstream USERGUIDE advertises for hive-mind. See `docs/USERGUIDE.md` (upstream) §Hive Mind for the full surface.

## Known gaps vs. USERGUIDE

The following USERGUIDE-advertised features ship as documentation only — runtime support is partial or missing. Tracked in ADR-0118.

| Feature | Status | Evidence | Tracker |
|---|---|---|---|
| Weighted consensus (Queen 3x) | ✗ missing from `ConsensusStrategy` enum | `mcp-tools/hive-mind-tools.ts:35` | ADR-0118 T1 |
| Gossip consensus | ✗ missing from `ConsensusStrategy` enum | `mcp-tools/hive-mind-tools.ts:35,518` | ADR-0118 T2 |
| CRDT consensus | ✗ missing from `ConsensusStrategy` enum | `mcp-tools/hive-mind-tools.ts:35,518` | ADR-0118 T3 |
| 8 Memory types + TTLs | ✗ flat dict, no TTL | `mcp-tools/hive-mind-tools.ts:937-1010` | ADR-0118 T4 |
| LRU + SQLite WAL backend | ✗ JSON file persistence | `loadHiveState`/`saveHiveState` | ADR-0118 T5 |
| Session checkpoint/resume/export/import | ✗ command surfaces only | `commands/hive-mind/{sessions,resume}.md` | ADR-0118 T6 |
| Queen-type behaviour | ⚠ prompt-string substitution only | `commands/hive-mind.ts:75,88` | ADR-0118 T7 |
| Worker-type behaviour | ⚠ display grouping + 4 scoring nudges | `swarm/src/queen-coordinator.ts:1248-1251` | ADR-0118 T8 |
| Adaptive topology (auto-scaling) | ⚠ config flag only | `swarm/src/unified-coordinator.ts:585` | ADR-0118 T9 |
| 5 swarm topologies | ⚠ prompt-string substitution only | `commands/hive-mind.ts:77,92` | ADR-0118 T10 |

When ADR-0118 closes a row, the materialise script removes the row from this README and the corresponding annotation from the relevant command file.
