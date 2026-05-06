# archive/

Frozen snapshots of older Ruflo / Claude-Flow code that is no longer built, tested, or published from this repo. Kept under git so history remains attributable, but **not part of the active codebase** — nothing here is wired into builds, tests, or npm publishes.

## Contents

| Path | What it is | Last live version | Status |
|---|---|---|---|
| [`v2/`](./v2/) | Pre-split `claude-flow` codebase | `claude-flow@2.7.47` | Superseded by `v3/@claude-flow/cli` |
| [`agents-root/`](./agents-root/) | Five YAML agent stubs from an early-2026 prototype | `2026-01-07` | Never wired into builds — superseded by `.claude/agents/` (33 md) + `plugins/*/agents/` (44 md) |

## agents-root (root-level `agents/` directory, 2026-01)

Five 10-11 line YAML files (`architect`, `coder`, `reviewer`, `security-architect`, `tester`) sketched out an early agent registration format. The format never got consumer code — no `.ts` / `.mjs` / `.json` import in the entire repo references this folder. Real agent definitions migrated to markdown frontmatter at `.claude/agents/*.md` (project-level) and `plugins/*/agents/*.md` (plugin-shipped).

Moved to `archive/agents-root/` rather than deleted to preserve the prototype's provenance — anyone wanting to see the original yaml schema can `git log archive/agents-root/`.

## v2 (`claude-flow` 2.x line)

The original monolithic `claude-flow` package — single npm artifact at `claude-flow@2.x`, with its own CLI, agents, MCP tools, hooks, and docs. Replaced in v3 by the workspace split under `v3/@claude-flow/*` (`cli`, `cli-core`, `codex`, `embeddings`, `hooks`, `memory`, `security`, `guidance`, …).

If you're looking for current code:

| Want… | Now lives in |
|---|---|
| CLI entry point | `v3/@claude-flow/cli/bin/cli.js` |
| Agent definitions | `.claude/agents/` (project-level) and `plugins/*/agents/` |
| MCP tools | `v3/@claude-flow/cli/src/mcp-tools/` |
| Hooks | `v3/@claude-flow/hooks/` |
| Memory + AgentDB | `v3/@claude-flow/memory/` |

## Why archive instead of delete?

- The 2.x line was published to npm as `claude-flow@2.x` and is still installable by anyone who pinned that range. Keeping the source in-tree means the published artifact's provenance is auditable.
- Some downstream forks and templates reference 2.x file paths; archiving (rather than deleting) gives them a stable URL.
- Migration questions like "how did 2.x do X?" are easier to answer when the code is one `git log archive/v2/` away.

## Don't…

- …add new code here. Everything new goes into `v3/` or `plugins/`.
- …expect tests to run against this. CI ignores `archive/` entirely.
- …import from here in active code paths.

If you need to revive something out of `v2/`, copy the relevant file into `v3/`, port its imports to the current module structure, and add tests — don't try to wire `archive/v2/` back into builds.
