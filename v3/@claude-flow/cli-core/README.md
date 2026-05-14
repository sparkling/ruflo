# @claude-flow/cli-core

> **Status:** alpha (pre-release). Tracking ADR-100. Don't depend on this in production yet.

Lightweight core CLI surface for [Claude Flow](https://github.com/ruvnet/ruflo) — `memory` + `hooks` commands only. Designed to load fast on a cold npx cache so plugin skills don't race Claude Code's 30 second MCP-startup timeout.

## Why a separate package?

Issue [#1748 #3](https://github.com/ruvnet/ruflo/issues/1748) documented a silent failure mode for new users: `npx claude-flow@latest mcp start` from a cold npx cache regularly exceeds 30 seconds (1.8 MB / 999 files), Claude Code's MCP startup timeout fires, zero tools register, and the user observes "Ruflo is broken — no MCP tools available."

`@claude-flow/cli-core` is a ≤250 KB packed subset containing only what plugin skills actually call: `memory store/list/retrieve/search/delete/init` and the `hooks` family (route, model-outcome, post-edit, pre-task, etc.). On a cold cache, `npx @claude-flow/cli-core@alpha memory store ...` should complete in under 5 seconds — well under the timeout.

## Install

```bash
# Pre-release alpha
npm install @claude-flow/cli-core@alpha

# Or just npx-invoke directly from a plugin Bash block
npx @claude-flow/cli-core@alpha memory store --key x --value 1 --namespace patterns
```

## What's included

| Category | Commands |
|---|---|
| `memory` | `store`, `list`, `retrieve`, `search`, `delete`, `init`, `migrate`, `stats`, `configure`, `cleanup`, `compress`, `export`, `import` |
| `hooks` | `route`, `pre-task`, `post-task`, `pre-edit`, `post-edit`, `pre-command`, `post-command`, `model-outcome`, `model-route`, `model-stats`, `worker-*`, `intelligence_*`, plus 12 background-worker dispatchers |

## What's NOT included (use `@claude-flow/cli` for these)

- `swarm`, `hive-mind`, `agent`, `task`, `coordination` — multi-agent orchestration
- `neural`, `embeddings`, `intelligence` — full ML surface
- `federation`, `claims`, `aidefence` — cross-installation features
- `browser`, `wasm`, `rvf` — sandbox + browser automation
- `init`, `migrate`, `doctor`, `daemon`, `deployment` — lifecycle management
- `performance`, `security`, `providers`, `plugins`, `config` — admin surface

For any of these, install `@claude-flow/cli@alpha` (the metapackage that re-exports cli-core and lazy-loads everything else).

## Compatibility

`@claude-flow/cli-core@3.7.0-alpha.x` ships in lockstep with `@claude-flow/cli@3.7.0-alpha.x`. Once promoted from alpha → latest, the two packages will continue to share the major.minor line.

## Non-archivist surface

`@claude-flow/cli-core` is an **explicit non-archivist published surface** per [ADR-0180 Open Follow-up #9](../../../../../ruflo-patch/docs/adr/ADR-0180-adopt-thin-memory-coordinator-with-type-enforced-mutation-handlers.md) disposition. The package's `memory` commands write via `JsonMemoryBackend` to `.swarm/memory.json` — **storage-disjoint** from the archivist-managed substrates (RVF + the five SQLite carve-out controllers the heavy `@sparkleideas/cli` reads). cli-core does NOT route through the archivist runtime (`routeMemoryOp`). This is **deliberate decoupling** per ADR-0162 §Batch F-2 (cli-core split, 22.9× cold-cache speedup) — importing the archivist (which depends on `better-sqlite3`/RVF, OTEL, the controller registry, etc.) would defeat the lightweight-startup design goal that motivated the package's existence.

Three operational rules apply:

1. **No audit-chain completeness for `.swarm/memory.json` writes.** Mutations made through cli-core's `JsonMemoryBackend` are off-chain by construction. The "audit chain is complete" guarantee in ADR-0180 covers only mutations routed through the archivist; cli-core writes are outside that envelope.
2. **Plugin authors who need audit chain MUST use the heavy `@sparkleideas/cli` path** (or `routeMemoryOp` directly). Use cli-core only when you can accept off-chain semantics — typically lightweight plugin scripts that need fast cold-cache startup and don't share state with the substrate the archivist coordinates.
3. **Any future cli-core surface expansion that touches substrate beyond local JSON re-opens this disposition.** The current carve-out is justified because `JsonMemoryBackend` writes are storage-disjoint from the RVF / SQLite carve-out substrate. Adding HNSW, RVF, or SQLite-backed paths to cli-core (e.g., the `MIGRATION.md` "alpha.4 opt-in HNSW build" idea) requires a new ADR amendment.

See ADR-0180 Open Follow-up #9 (lines ~440-457) for the full audit, caller analysis, and rationale.

## Verification

```bash
# Cold cache test — clear npx cache first
rm -rf ~/.npm/_npx
time npx @claude-flow/cli-core@alpha memory store --key smoke --value test --namespace test
# Expected: <5 seconds wall-time on typical broadband
```

## Documentation

- [ADR-100 — cli-core split](../../docs/adr/ADR-100-cli-core-split-lazy-load.md) — design rationale
- **[MIGRATION.md](./MIGRATION.md) — concrete diff + env-flag pattern for switching plugin scripts**
- [Issue #1748](https://github.com/ruvnet/ruflo/issues/1748) — the bug this package addresses
- [Issue #1760](https://github.com/ruvnet/ruflo/issues/1760) — alpha tracking issue (status, benchmarks, fire-by-fire progress)
- [Main `@claude-flow/cli` README](../cli/README.md) — full feature list

## License

MIT
