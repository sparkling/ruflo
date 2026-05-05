---
description: Spawn a Hive Mind swarm — supports --queen-type (Strategic|Tactical|Adaptive) and --consensus (majority|weighted|byzantine|raft|gossip|crdt|quorum)
---

# hive-mind-spawn

Spawn a Hive Mind swarm with queen-led coordination.

## Usage
```bash
npx @sparkleideas/cli@latest hive-mind spawn <objective> [options]
```

## Options
- `--queen-type <type>` - Queen type (strategic, tactical, adaptive)
- `--max-workers <n>` - Maximum worker agents
- `--consensus <type>` - Consensus algorithm
- `--claude` - Generate Claude Code spawn commands

## Examples
```bash
npx @sparkleideas/cli@latest hive-mind spawn "Build API"
npx @sparkleideas/cli@latest hive-mind spawn "Research patterns" --queen-type adaptive
npx @sparkleideas/cli@latest hive-mind spawn "Build service" --claude
```
