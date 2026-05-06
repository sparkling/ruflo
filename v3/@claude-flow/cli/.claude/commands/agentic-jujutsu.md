---
description: AI-native version control via @sparkleideas/agentic-jujutsu — invokes the agentic-jujutsu skill with $ARGUMENTS routed to the underlying jj wrapper
---
$ARGUMENTS

Invoke the `/agentic-jujutsu` skill (loaded from `.claude/skills/agentic-jujutsu/SKILL.md`) to operate AI-native version control via the `@sparkleideas/agentic-jujutsu` npm package.

The skill body provides full subcommand reference (status, log, diff, new, analyze, mcp-server, mcp-tools, mcp-call, compare-git). Pass `$ARGUMENTS` through to the skill — common patterns:

| Subcommand | Invocation | What it does |
|---|---|---|
| `status` | `/agentic-jujutsu status` | Show working-copy status (faster than git status; lock-free across concurrent agents) |
| `log` | `/agentic-jujutsu log --limit 10` | Commit history with quantum fingerprints |
| `diff` | `/agentic-jujutsu diff` | Show working-copy diff |
| `new "msg"` | `/agentic-jujutsu new "msg"` | Create new commit (atomic, no merge conflicts) |
| `analyze` | `/agentic-jujutsu analyze` | Analyze repository structure + agent activity |
| `mcp-server` | `/agentic-jujutsu mcp-server` | Start the agentic-jujutsu MCP server (exposes 12 tools to other agents) |
| `mcp-tools` | `/agentic-jujutsu mcp-tools` | List MCP tools the server provides |
| `compare-git` | `/agentic-jujutsu compare-git` | Side-by-side perf comparison vs Git |

## When to use

- Multiple AI agents modifying code simultaneously without merge conflicts
- Lock-free version control (faster than Git for concurrent writes)
- SHA3-512 cryptographic integrity verification of commits
- Self-learning AI that improves merge resolution from experience
- Pattern recognition + intelligent commit suggestions

## Underlying binary

The skill shells out to `npx @sparkleideas/agentic-jujutsu` which loads
`agentic-jujutsu.darwin-arm64.node` (built by the fork's napi-rebuild
pipeline per ADR-0150). Binary is a Mach-O 64-bit arm64 dylib (~22.8MB)
exposing `JjWrapper`, `QuantumSigner`, `signMessage`, `verifySignature`,
and `generateSigningKeypair`.

## See also

- USERGUIDE.md §"Agentic-Jujutsu — Self-Learning AI Version Control" (L5156-5340)
- Skill: `.claude/skills/agentic-jujutsu/SKILL.md`
- Package: `@sparkleideas/agentic-jujutsu` (Verdaccio: `http://localhost:4873`)
- ADR-0148 §"Findings — Category C" (skill wired into init's SKILLS_MAP)
- ADR-0150 (multi-fork napi-rebuild + bundle-native-binaries that ships the .node binary)
