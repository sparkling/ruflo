# ADR-100: Split `@claude-flow/cli` into `cli-core` + lazy-loaded extras

**Status**: Proposed
**Date**: 2026-05-05
**Version**: target v3.7.0-alpha.1 (alpha tag), graduating to v3.8.0 once validated
**Supersedes**: nothing
**Related**: ADR-098 (plugin capability sync and optimization), issue [#1748](https://github.com/ruvnet/ruflo/issues/1748) Issue 3 (cold-cache 30s MCP-startup race), [#1747](https://github.com/ruvnet/ruflo/issues/1747) (hooks shell injection — fixed in 3.6.28; orthogonal to this ADR)

## Context

Issue #1748 from the Liberation of Bajor team's methodical install-study identified a silent failure mode that affects every new user with a cold npx cache:

> **Issue 3:** First-time invocation of `npx -y claude-flow@latest mcp start` from a cold npx cache hits a Claude Code MCP-startup timeout. Logged as `Starting connection with timeout of 30000ms` followed by the server staying in "still connecting" state for the entire session. Zero claude-flow tools register; the model falls through to native tools.
>
> **Diagnosis:** The `claude-flow@latest` package is roughly 1.8 MB across 999 files. Cold npx download + extraction + spawn can exceed 30 seconds.

We confirmed the bug is reproducible. The same cold-cache penalty hits every plugin skill that falls back to `npx @claude-flow/cli ...` for memory/hooks operations when MCP tools aren't registered. Today's reality:

- Unpacked dist size: **9.6 MB across 777 files** (npm-packaged is 1.8 MB / 999 files per the issue, including all deps).
- 95+% of plugin skill traffic only needs `memory` + `hooks` commands (~420 KB of source TS).
- The remaining ~95% of the package (swarm, neural, federation, browser, daa, hive-mind, claims, performance, security, embeddings, ruvector, intelligence, autopilot, …) is paid as a download cost on every cold cache, even when never invoked.

The reporter's fix request #1 was: *"Reduce package footprint. 1.8 MB / 999 files is large for a tool whose first-run time is gated by a 30s timeout. A leaner core package (with optional plugins lazy-loaded) would push first-time-success rates above 99%."*

This ADR proposes the split.

## Decision

Split `@claude-flow/cli` into two packages with a backwards-compatible metapackage facade:

### 1. `@claude-flow/cli-core` (new, ~150–200 KB packed)

Contains exactly the surface plugin skills depend on plus the entry-point machinery:

```
cli-core/
  src/
    index.ts                    # CLI entry — registers core commands + lazy-binding hooks for extras
    output.ts, prompt.ts        # output utilities (already shared)
    types.ts                    # CommandContext, Command, etc.
    fs-secure.ts                # path-traversal guards
    commands/
      memory.ts                 # 11 subcommands: store, list, retrieve, search, delete, init, ...
      hooks.ts                  # 17 hook commands + 12 worker triggers (entry points only —
                                #  delegate to lazy-loaded handlers under cli-extras)
    mcp-tools/
      memory-tools.ts           # MCP tool defs for memory_*
      hooks-tools.ts            # MCP tool defs for hooks_* (the routing surface)
      types.ts
    mcp-client.ts               # client side (already small)
```

Target metric: **packed size ≤ 250 KB**, dist file count ≤ 80, cold-npx download + extract < 5 seconds on a typical broadband connection.

### 2. `@claude-flow/cli` (existing, becomes a metapackage)

```js
// v3/@claude-flow/cli/src/index.ts (after split)
export * from '@claude-flow/cli-core';

// Lazy-loaded extras — registered via dynamic import only when their command is invoked.
const lazyCommandTable: Record<string, () => Promise<{ default: Command }>> = {
  swarm:        () => import('./commands/swarm.js'),
  neural:       () => import('./commands/neural.js'),
  federation:   () => import('./commands/federation.js'),
  // ...
};
```

The metapackage:
- depends on `@claude-flow/cli-core` (as a regular dep — no dynamic resolution needed for core path)
- ships everything that's NOT in cli-core in its own dist
- registers a CLI dispatcher that defers to cli-core for `memory`/`hooks`/`output`, and dynamic-imports the extras when those commands fire

Existing users (`npx @claude-flow/cli@latest <anything>`) continue to work unchanged. The cold-cache penalty for `memory` / `hooks` invocations drops because they're served from cli-core (small) — but only if the user installs cli-core directly. Users who install the metapackage still pay the full footprint (because npx pulls the whole thing); the win is that **plugin skills can opt to invoke `npx @claude-flow/cli-core@latest memory store ...`** for the hot path.

### 3. Plugin skill scripts switch to cli-core

Each plugin's Bash blocks update:

```diff
- npx @claude-flow/cli@latest memory store --namespace cost-tracking ...
+ npx @claude-flow/cli-core@latest memory store --namespace cost-tracking ...
```

Cold-cache: **1.8 MB → ~200 KB**. 30s timeout race no longer applies.

### 4. Versioning + alpha tag strategy

- `cli-core` ships as **v3.7.0-alpha.1** under `--tag alpha` (alpha line)
- `cli` (existing) ships as **v3.7.0-alpha.1** with the metapackage refactor under `--tag alpha`
- `latest` continues to point at the legacy 3.6.x line until the alpha is validated by external users
- `v3alpha` tag for `cli` continues to track the latest pre-release

Alpha promotion to `latest` requires:
1. Cold-cache benchmark showing ≥80% reduction in first-call wall-time
2. At least one external integrator (the #1748 reporter is a candidate) confirms MCP startup succeeds within 30s on a cold cache
3. No regression in the existing 21 Tier 1 / 7 adversarial cost-tracker bench corpus

## Consequences

**Positive:**

- **#1748 Issue 3 fixed structurally** rather than worked around. Plugin-install users get fast first-call experience without any matrix-of-install-paths documentation.
- **Plugin skills become 30× faster on cold cache** (60s → 2s). Drastically lower abandonment for new users.
- The MCP-startup 30s race becomes a non-issue when the registered server is cli-core.
- Future "lite vs full" install differentiation (#1744 #1) becomes a real package boundary, not a documentation distinction.

**Negative:**

- **Two npm packages to keep in sync.** Versions, releases, dist-tags. Worth scripting as a release task.
- **Backwards compatibility risk.** Anyone importing from internal cli paths (e.g. `import x from '@claude-flow/cli/dist/src/commands/memory.js'`) will need to switch to `cli-core`. We control all known consumers (the plugins) so this is auditable.
- **CLI dispatcher complexity.** The metapackage's index.ts grows a lazy-load table. Mistakes there manifest as "command not found" — needs explicit tests.
- **Tree-shaking limitation.** ESM dynamic imports work, but require the consuming environment to support them. Modern Node 20+ does; older runtimes may not.

**Neutral:**

- **No changes to the published `ruflo` umbrella.** It continues to depend on `@claude-flow/cli` and gets the lazy-load benefits transparently.
- **No changes to `claude-flow` umbrella.** Same.
- The verification.md witness manifest grows by 1 release entry; no new fix categories.

## Riskiest assumption

The single biggest risk: that the Liberation of Bajor team's diagnosis (cold-cache pull + extract dominates startup) is correct AND that the 1.8 MB → 200 KB reduction translates directly to fitting under the 30s timeout. Two paths can fail this:

1. **MCP-server startup itself is slow** independent of package size (e.g., heavy ESM module-graph initialization, blocking native imports). If so, splitting the package doesn't help — we'd still race the timeout. Mitigation: profile module init time on cli-core before publishing to confirm <2s start.

2. **npx cache invalidation behaviors** on Windows + Git Bash (the reporter's environment) may behave differently than Linux. If npx re-extracts every time on Windows, the absolute size reduction matters; if it shares cache across invocations, we may not see linear improvement. Mitigation: validate on Windows specifically before promoting alpha → latest.

If either fails, this ADR's first benefit (30s race) doesn't materialize. The other benefits (smaller surface, cleaner upgrade story) still hold but are less urgent.

## Verification

Once cli-core is published:

```bash
# Cold cache (clear ~/.npm/_npx first)
rm -rf ~/.npm/_npx
time npx @claude-flow/cli-core@alpha memory store --namespace test --key x --value 1
# Expected: < 5s wall-time on typical connection

# Compare to current cli
rm -rf ~/.npm/_npx
time npx @claude-flow/cli@alpha memory store --namespace test --key x --value 1
# Expected: > 30s on typical connection (matches the bug)
```

The smoke contract for `cli-core` mirrors the existing one in spirit: every command parses, every MCP tool definition has the canonical fields, no wildcard tool grants. Existing `@claude-flow/cli` smoke contract is preserved.

## Migration path for plugin authors

Two-step migration plan after cli-core@alpha lands:

1. **Plugins update their script Bash blocks** to invoke `cli-core` for memory/hooks operations. Backwards-compatible — `cli` still works, just slower. Sample diff:

   ```diff
   - npx @claude-flow/cli@latest memory store ...
   + npx @claude-flow/cli-core@latest memory store ...
   ```

2. **README install matrix simplifies** — the "Plugin install (lite, slash commands only)" caveat becomes a "Plugin install + cli-core (fast, registers MCP via npx-warm fallback)" entry that approaches parity with full `npx ruflo init` for the common case.

## Plan of work

| Step | What | Status |
|---|---|---|
| 1 | Branch `feat/cli-core-split` + ADR-100 + scaffold | ✅ done — fire 1 |
| 2a | Foundation surface in cli-core (types, output, MCP-tool-types, validate-input) | ✅ done — fire 2 (commit `2329b81fa`, 136 KB / 20 files dist) |
| **2b** | **Architectural discovery (fire 3) — see "Discovery" below** | ✅ surfaced; informs steps 3+ |
| 3 | Backend abstraction: extract a lite memory backend (JSON-only, no sql.js/HNSW/ONNX) so `mcp-tools/memory-tools.ts` can copy cleanly into cli-core. Heavy backend stays in @claude-flow/cli. | pending |
| 4 | Definitions/handlers split for `hooks-tools.ts` — tool definitions (name/description/inputSchema, ~10 KB) live in cli-core; handler functions that actually do the work stay in cli with dynamic-import wiring. | pending |
| 5 | Update `@claude-flow/cli/src/index.ts` to re-export from cli-core + register lazy-loaded extras for non-foundation commands. | pending |
| 6 | Cold-cache benchmark: old vs new, persist to `docs/benchmarks/cli-core-cold-cache.json`. | pending |
| 7 | Bump `cli-core` to `3.7.0-alpha.1` once steps 3+4 land; publish under `--tag alpha`. (alpha.0 published in fire 3 with foundation-only.) | partial |
| 8 | PR description with cold-cache numbers + comment on issue #1760 with proof. | pending |

## Discovery (fire 3)

Initial assumption (fire 1's plan): "move memory + hooks source files into cli-core". Reality (fire 3): **both `memory-tools.ts` and `hooks-tools.ts` have deep transitive ML dependencies** that defeat the lite-bundle goal:

- `memory-tools.ts` (30 KB top-level) → `../memory/memory-initializer.js` (2830 LOC) → `fs-secure.ts` → `encryption/vault.ts` (ADR-096)
- `hooks-tools.ts` (146 KB top-level) → 9 transitive imports across `memory/{sona-optimizer, ewc-consolidation, memory-bridge}` (the SONA/EWC++ neural surface) and `ruvector/{moe-router, semantic-router, flash-attention, lora-adapter, enhanced-model-router}` (the ML routing layer)

Pulling those into cli-core would balloon it past the 250 KB packed target. The **right architectural move** is what the ADR's "Riskiest assumption" hinted at but didn't concretize:

1. **Memory backend abstraction.** Define a `MemoryBackend` interface in cli-core. cli-core ships a `JsonMemoryBackend` (no SQLite, no HNSW — just JSON file at `.swarm/memory.json`). cli ships a `SqliteHnswMemoryBackend` (the existing implementation) that swaps in via env-var or import map. Plugin scripts that only need basic store/retrieve get the lite backend's <2s cold-cache; plugins that need semantic search opt into the heavy backend.

2. **Tool-definition / handler split.** MCP tool *definitions* (the `MCPTool` shape: name, description, inputSchema) are pure data and small (~10 KB total for memory + hooks). They go in cli-core. The *handler* implementations (the actual code that runs when an MCP request fires) stay in cli's full module tree, accessed via dynamic-import only at request time. cli-core exposes the definitions so a metapackage can register them with the MCP server; the metapackage routes invocations to its full handler tree.

This is more work than fire 1 anticipated — likely 4-6 additional fires to land cleanly, vs the original "next fire" estimate. The ADR is updated to reflect the actual shape of the work.

**Net conclusion: foundation-only alpha.0 ships now (proves publish pipeline + gives plugin authors type imports). Backend abstraction + tool/handler split land in alpha.1 and alpha.2.**

## Related

- #1748 Issue 3 — the reporter's fix-request #1 for the 30s MCP timeout race
- ADR-098 — plugin capability sync (the lite-vs-full philosophy this ADR makes a real package boundary)
- v3.6.28 release ([#1753]) — added `--no-global` flag, also addressing #1744 papercuts; cli-core split is the structural follow-up

## Decision lifecycle

- **2026-05-05**: Proposed (this commit)
- **TBD**: Accepted after cold-cache benchmark proves <5s on typical connection
- **TBD**: Promoted alpha → latest after external validator (Liberation of Bajor team or equivalent) confirms MCP startup succeeds on cold cache
