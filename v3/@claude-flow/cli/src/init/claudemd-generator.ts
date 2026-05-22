/**
 * CLAUDE.md Generator
 * Generates enforceable, analyzer-optimized Claude Code configuration
 * with template variants for different usage patterns.
 *
 * Templates: minimal | standard | full | security | performance | solo
 * All templates use bullet-format rules with imperative keywords for enforceability.
 */

import type { InitOptions, ClaudeMdTemplate } from './types.js';

// --- Section Generators (each returns enforceable markdown) ---

function behavioralRules(): string {
  return `## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- NEVER add a \`Co-Authored-By\` trailer to user commits unless this project's \`.claude/settings.json\` has \`attribution.commit\` set (#2078). The Claude Code Bash tool may suggest one in its default commit-message template — ignore it. \`Co-Authored-By\` is semantic authorship attribution under git/GitHub convention; the tool is the facilitator, not a co-author.`;
}

function fileOrganization(): string {
  return `## File Organization

- NEVER save to root folder — use the directories below
- Use \`/src\` for source code files
- Use \`/tests\` for test files
- Use \`/docs\` for documentation and markdown files
- Use \`/config\` for configuration files
- Use \`/scripts\` for utility scripts
- Use \`/examples\` for example code`;
}

function projectArchitecture(_options: InitOptions): string {
  return `## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Use event sourcing for state changes
- Ensure input validation at system boundaries`;
}

function concurrencyRules(): string {
  return `## Concurrency

- Batch ALL independent operations into a single message
- Spawn ALL agents in ONE message using the Agent tool with \`run_in_background: true\`
- Batch ALL independent file reads/writes/edits in ONE message
- Batch ALL independent Bash commands in ONE message

## Task Complexity

- Single file edit or fix: work directly, no agents needed
- 3+ files, new feature, or cross-module refactoring: spawn agents
- When in doubt, start direct — escalate to agents if scope grows`;
}

function agentOrchestration(): string {
  // ADR-0136 Q1 (resolved 2026-05-05): compressed from 22-line prose to a
  // table + supplementary imperatives. Per "One decision, one section, one
  // shape" — the orchestration decision lives here as a table; toolSelectionRules()
  // carries the tool-selection comparison; whenToUseWhat() was deleted.
  // ADR-0098 anti-sprawl: "DO NOT call swarm_init ... reflexively" preserved
  // as a bullet (acceptance gate). ADR-0115 carve-out: "Use hive-mind_spawn ...
  // when convening a council" preserved as a bullet (acceptance gate).
  return `## Agent Orchestration

| Situation | Use | Never |
|---|---|---|
| Multi-file / fan-out work | \`Agent\` tool, \`run_in_background:true\`, all spawns in ONE message | Poll status; use CLI as substitute |
| High-stakes decision, ADR ratification, multi-perspective review | \`hive-mind_spawn\` (or \`ruflo hive-mind spawn --claude\`) | Treat as anti-sprawl violation |
| Reflexive coordination at task start | (skip) | \`swarm_init\` unless user asked or persistent state needed |
| User explicitly asked for a claude-flow swarm | \`swarm_init\` (CLI auto-reuses matching) | \`--new\` flag unless parallel swarm genuinely needed |

- Use \`hive-mind_spawn\` (or \`ruflo hive-mind spawn --claude\`) when convening a council: named experts, per-question voting, Byzantine consensus, queen synthesis. (ADR-0115 carve-out — NOT bundled into swarm-sprawl prohibition.)
- DO NOT call \`swarm_init\` reflexively at task start (ADR-0098 — applies to flat-coordination swarms only).
- After spawning agents: STOP and wait for results. Do not poll.`;
}

function antiDriftConfig(): string {
  // ADR-0098: removed the "ALWAYS use swarm init" worked example. Keeping only
  // the configuration guidance that applies when a swarm IS needed.
  return `## Swarm Configuration (when explicitly required)

These apply ONLY when the user has asked for a claude-flow swarm. For routine
multi-agent work, use the built-in \`Agent\` tool instead — see §"Agent Orchestration".

- Prefer hierarchical topology for coding swarms
- Keep maxAgents at 6-8 for tight coordination
- Use specialized strategy for clear role boundaries
- Use \`raft\` consensus for hive-mind (leader maintains authoritative state)
- Run frequent checkpoints via \`post-task\` hooks
- Keep shared memory namespace for all agents`;
}

function mcpToolDiscovery(): string {
  return `## MCP Tools (Deferred)

The \`ruflo\` MCP server is registered. Tools are deferred — call ToolSearch
to load a tool's schema before invoking it.

Quick discovery:
- \`ToolSearch("ruflo memory")\` — store, search, retrieve patterns
- \`ToolSearch("ruflo agent")\` — spawn, list, manage agents
- \`ToolSearch("ruflo swarm")\` — multi-agent coordination
- \`ToolSearch("ruflo hooks")\` — lifecycle hooks and learning

Do NOT call \`mcp__ruflo__agentdb_session-start\` or
\`mcp__ruflo__agentdb_session-end\` — hooks manage session lifecycle
automatically.`;
}

function hookSignals(): string {
  return `## Hook Signals

Hooks inject signals into the conversation at three points:

- **Before task**: \`[INTELLIGENCE] Relevant patterns...\` — incorporate when relevant
- **During task**: \`[INFO] Routing task...\` — consider the recommended agent type
- **After task**: hooks store outcomes automatically; do not call session-start/end

If \`[INFO] Router not available\` appears, proceed normally without routing.`;
}

// ADR-0136 Q1 (resolved 2026-05-05): whenToUseWhat() deleted. All 5 rows
// were redundant with agentOrchestration() table + toolSelectionRules() table
// + Skill tool description. The unique "ruflo doctor --fix" diagnostic row
// migrated to referencePointers().

// ADR-0136: agentTypes() and memoryCommands() removed as dead code.
// Replaced by referencePointers() (catalogs behind discovery commands)
// and toolSelectionRules() (decision tree).

function toolSelectionRules(): string {
  return `## Tool Selection Rules

When you need a capability, choose in this order. Stop at the first match.

| You need to... | Use | Prefer over |
|---|---|---|
| Coordinate parallel sub-tasks | \`Agent\` tool with \`run_in_background: true\` | \`swarm_init\` for one-shot work |
| Convene a council on a high-stakes decision | \`mcp__ruflo__hive-mind_spawn\` (or invoke the \`hive-mind-advanced\` skill) | \`Agent\` fan-out (no synthesis) |
| Persist patterns/decisions across sessions | \`mcp__ruflo__memory_store\` | Writing to MEMORY.md from in-session work |
| Recall past decisions/patterns | \`mcp__ruflo__memory_search\` | Asking the user to re-explain |

When the active toolset doesn't cover a capability:
1. Run \`ruflo skill list\` — a skill may already provide it
2. Run \`ruflo plugins list\` — an installable plugin may provide it
3. Only after both come up empty, build the capability inline or ask the user

Sub-agents spawned via \`Agent\` typically inherit the parent's \`mcp__ruflo__*\` toolset. For long-running sub-tasks where MCP visibility is uncertain, run a discovery probe before spawning rather than pre-fetching results.`;
}

function pluginInstallRule(): string {
  return `## Plugin Installation Rule

NEVER install plugins without explicit user confirmation. Plugins persist past the session.

Install only when ALL hold:
- User asked for a capability not covered by \`ruflo skill list\` or active MCP tools
- User confirmed the install

Discovery: \`ruflo plugins --help\`.
Install: \`/plugin install ruflo-<name>@ruflo\` (after \`/plugin marketplace add sparkling/ruflo\`).
Tell user to run \`/reload-plugins\` if commands don't appear post-install.`;
}

function referencePointers(): string {
  return `## Reference Pointers (when you need more than this file says)

- Tool catalog: \`ToolSearch\` with a relevant query
- Skill catalog: \`ruflo skill list\`
- Plugin catalog: \`ruflo plugins list\`
- Agent type catalog: \`ruflo agent list\`
- CLI diagnostics: \`ruflo doctor --fix\`
- Architecture decisions for this project: \`docs/adr/\`
- Cross-session memory: \`~/.claude/projects/<project>/memory/MEMORY.md\`
- Full feature reference: https://github.com/ruvnet/ruflo/blob/main/docs/USERGUIDE.md`;
}

function securityRulesLight(): string {
  return `## Security Rules

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate user input at system boundaries
- Always sanitize file paths to prevent directory traversal
- Run \`ruflo security scan\` after security-related changes`;
}

function buildAndTest(): string {
  return `## Build & Test

\`\`\`bash
# Build
npm run build

# Test
npm test

# Run a single test file
npm test -- path/to/test.ts

# Lint
npm run lint
\`\`\`

- ALWAYS run tests after making code changes
- ALWAYS verify build succeeds before committing

### Feature Workflow

1. Create or update tests first
2. Implement the change
3. Run tests — verify pass
4. Run build — verify success
5. Commit`;
}

function securitySection(): string {
  // ADR-0136 Q3 (resolved 2026-05-05): flag-syntax bash blocks replaced by
  // --help pointer per Principle 7 (reference, don't duplicate). Agent list +
  // routing-code line kept — they are decision data, not catalogs.
  return `## Security Protocol

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate all user input at system boundaries using Zod schemas
- Always sanitize file paths to prevent directory traversal attacks
- Always use parameterized queries — never concatenate SQL strings
- Run security audit after any authentication or authorization changes

Security CLI: \`ruflo security --help\`.

### Security Agents
- \`security-architect\` — threat modeling, architecture review
- \`security-auditor\` — code audit, vulnerability detection
- Use agent routing code 9 (hierarchical/specialized) for security tasks`;
}

function performanceSection(): string {
  // ADR-0136 Q3 (resolved 2026-05-05): flag-syntax bash block replaced by
  // --help pointer. Agent list + routing-code kept (decision data).
  return `## Performance Optimization Protocol

- Always run benchmarks before and after performance changes
- Always profile before optimizing — never guess at bottlenecks
- Prefer algorithmic improvements over micro-optimizations
- Keep HNSW search within 150x-12,500x faster target
- Keep memory reduction within 50-75% target with quantization

Performance CLI: \`ruflo performance --help\`.

### Performance Agents
- \`performance-engineer\` — profiling, benchmarking, optimization
- \`perf-analyzer\` — bottleneck detection, analysis
- Use agent routing code 7 (hierarchical/specialized) for performance tasks`;
}

function setupAndBoundary(): string {
  // ADR-0136: setup commands run before CLAUDE.md is read; the AI inherits
  // the running env, never bootstraps it. Keep only Support links here.
  // Bootstrap command preserved on a single line for the rebrand-ruflo-claudemd
  // test which gates on `claude mcp add` presence (one-time bootstrap marker).
  //
  // ADR-0223 grep-guard: this file MUST NOT cite `@sparkleideas/cli@latest`
  // in user-facing emission — ADR-0143 Pass 7 promoted the canonical brand
  // to `@sparkleideas/ruflo`. The bootstrap hint now uses `ruflo` as the
  // server key (matching the .mcp.json entry) and the wrapper binary
  // (`@sparkleideas/ruflo@latest`).
  // Documentation/Issues URLs stay at ruvnet/ruflo per ADR-0223 scope note
  // (public docs live upstream; not part of F-11-004's marketplace-source fix).
  return `## Support

One-time bootstrap (user runs once, AI never): \`claude mcp add ruflo -- npx -y @sparkleideas/ruflo@latest\`

- Documentation: https://github.com/ruvnet/ruflo
- Issues: https://github.com/ruvnet/ruflo/issues`;
}

// --- Template Composers ---

/**
 * Template section map — defines which sections are included per template.
 */
const TEMPLATE_SECTIONS: Record<ClaudeMdTemplate, Array<(opts: InitOptions) => string>> = {
  minimal: [
    behavioralRules,
    fileOrganization,
    projectArchitecture,
    (_opts) => buildAndTest(),
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => mcpToolDiscovery(),
    (_opts) => hookSignals(),
    (_opts) => setupAndBoundary(),
  ],
  standard: [
    behavioralRules,
    fileOrganization,
    projectArchitecture,
    (_opts) => buildAndTest(),
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => agentOrchestration(),
    (_opts) => toolSelectionRules(),
    (_opts) => pluginInstallRule(),
    (_opts) => mcpToolDiscovery(),
    (_opts) => hookSignals(),
    (_opts) => referencePointers(),
    (_opts) => setupAndBoundary(),
  ],
  full: [
    behavioralRules,
    fileOrganization,
    projectArchitecture,
    (_opts) => buildAndTest(),
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => agentOrchestration(),
    (_opts) => antiDriftConfig(),
    (_opts) => toolSelectionRules(),
    (_opts) => pluginInstallRule(),
    (_opts) => mcpToolDiscovery(),
    (_opts) => hookSignals(),
    (_opts) => referencePointers(),
    (_opts) => setupAndBoundary(),
  ],
  security: [
    behavioralRules,
    fileOrganization,
    projectArchitecture,
    (_opts) => buildAndTest(),
    concurrencyRules,
    (_opts) => agentOrchestration(),
    (_opts) => securitySection(),
    (_opts) => mcpToolDiscovery(),
    (_opts) => hookSignals(),
    (_opts) => setupAndBoundary(),
  ],
  performance: [
    behavioralRules,
    fileOrganization,
    projectArchitecture,
    (_opts) => buildAndTest(),
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => agentOrchestration(),
    (_opts) => performanceSection(),
    (_opts) => mcpToolDiscovery(),
    (_opts) => hookSignals(),
    (_opts) => setupAndBoundary(),
  ],
  solo: [
    behavioralRules,
    fileOrganization,
    projectArchitecture,
    (_opts) => buildAndTest(),
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => mcpToolDiscovery(),
    (_opts) => hookSignals(),
    (_opts) => setupAndBoundary(),
  ],
};

// --- Public API ---

/**
 * Generate CLAUDE.md content based on init options and template.
 * Template is determined by: options.runtime.claudeMdTemplate > explicit param > 'standard'
 */
export function generateClaudeMd(options: InitOptions, template?: ClaudeMdTemplate): string {
  const tmpl = template ?? options.runtime.claudeMdTemplate ?? 'standard';
  const sections = TEMPLATE_SECTIONS[tmpl] ?? TEMPLATE_SECTIONS.standard;

  const header = `# Claude Code Configuration\n`;
  const body = sections.map(fn => fn(options)).join('\n\n');

  return `${header}\n${body}\n`;
}

/**
 * Generate minimal CLAUDE.md content (backward-compatible alias).
 */
export function generateMinimalClaudeMd(options: InitOptions): string {
  return generateClaudeMd(options, 'minimal');
}

/** Available template names for CLI wizard */
export const CLAUDE_MD_TEMPLATES: Array<{ name: ClaudeMdTemplate; description: string }> = [
  { name: 'minimal', description: 'Quick start — behavioral rules, MCP discovery, hook signals (~60 lines)' },
  { name: 'standard', description: 'Recommended — agent orchestration, MCP discovery, decision tree (~90 lines)' },
  { name: 'full', description: 'Standard + anti-drift config & swarm tuning (~120 lines)' },
  { name: 'security', description: 'Security-focused — adds security scanning, audit protocols, CVE checks' },
  { name: 'performance', description: 'Performance-focused — adds benchmarking, profiling, optimization protocols' },
  { name: 'solo', description: 'Solo developer — behavioral rules, MCP discovery, hook signals (~60 lines)' },
];

export default generateClaudeMd;
