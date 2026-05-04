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

## Broadcast vs. Agent-tool workers

The `mcp__ruflo__hive-mind_broadcast` MCP tool reaches workers registered through `npx ruflo hive-mind spawn` (the substrate's own worker registry, persisted in `.claude-flow/hive-mind/state.json`). It does **not** reach workers spawned via Claude Code's `Agent` tool — those live in a separate, in-process registry that the hive substrate cannot enumerate. The two registries do not bridge today.

The canonical pattern for council-style work is therefore **single-round Agent-tool spawns followed by queen-composed transcript** — the queen reads N independent worker verdicts and writes the inter-expert discussion using their actual content. This is empirically validated across 250+ working sessions (see ADR-0140 §Evidence).

Multi-round dialectic via `hive-mind_broadcast` waking idle Agent-tool workers is **aspirational** — not implemented. See ADR-0140 §Decision and `feedback-hive-orchestration-pattern.md` for the layer-bridge gap.

For runtime cross-talk between Agent-tool workers, two transports actually work:

- **File-based** — workers read/write `/tmp/<hive-id>/{pos,reaction}-*.md` with a sleep-based barrier (validated 2026-05-04, see `reference-hive-runtime-crosstalk-pattern.md`).
- **Bash CLI** — `npx ruflo hive-mind memory -a set` / `-a get` from inside the worker prompt; the CLI bridges to substrate without the MCP hang.

Do **not** call `mcp__ruflo__hive-mind_memory` from sub-agent context — it hangs (~600s stall + watchdog kill). See ADR-0140 Piece 3a.

## Known gaps vs. USERGUIDE

All USERGUIDE-advertised features have runtime support. ADR-0118 §Status reports every tracked task as `complete`. The next review cycle may reopen items if upstream reflows.
