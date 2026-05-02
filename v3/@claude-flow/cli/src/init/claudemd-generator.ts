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
- NEVER commit secrets, credentials, or .env files`;
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
  // ADR-0098 anti-sprawl applies to swarm_init only.
  // ADR-0115: hive-mind_spawn is the council-protocol entry point —
  // do NOT bundle it into the swarm-sprawl prohibition. Council
  // sessions (queen + named experts + voting + Byzantine consensus +
  // collective memory) are the intended use case for hive-mind_spawn
  // and shouldn't be discouraged by anti-sprawl phrasing.
  return `## Agent Orchestration

- DEFAULT: use Claude Code's built-in \`Agent\` tool for parallel work delegation
  (multi-file tasks, fan-out research, independent subagent jobs). It spawns
  subagents with ZERO coordination state, ZERO setup, ZERO cleanup.
- ALWAYS set \`run_in_background: true\` when spawning agents
- Put ALL agent spawns in a single message for parallel execution
- After spawning agents, STOP and wait for results — do not poll or check status
- Use \`hive-mind_spawn\` (or \`ruflo hive-mind spawn --claude\`) when convening
  a COUNCIL — named experts with consistent perspectives, per-question voting,
  Devil's Advocate role, Byzantine consensus, Queen synthesis with named
  conditions, persistent collective memory. Hive-mind is the right primitive
  for high-stakes decisions, ADR ratification, multi-perspective review.
- DO NOT call \`swarm_init\` or \`ruflo swarm init\` reflexively at the start
  of tasks (ADR-0098 anti-sprawl — applies to flat-coordination swarms only,
  NOT to hive-mind councils). Use \`swarm_init\` only when (a) the user explicitly
  asks for a claude-flow swarm, or (b) persistent cross-session coordination
  state is actually required.
- If you DO need a claude-flow swarm: the CLI now reuses matching running swarms
  automatically (ADR-0098 config-fingerprint dedupe). Pass \`--new\` only when
  you genuinely need a parallel swarm with the same config.
- NEVER use CLI tools as a substitute for Agent tool subagents`;
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

This project has a \`claude-flow\` MCP server with 200+ tools for memory,
swarms, agents, hooks, and coordination. Tools are deferred — you MUST call
ToolSearch to load a tool's schema before calling it.

Quick discovery:
- \`ToolSearch("claude-flow memory")\` — store, search, retrieve patterns
- \`ToolSearch("claude-flow agent")\` — spawn, list, manage agents
- \`ToolSearch("claude-flow swarm")\` — multi-agent coordination
- \`ToolSearch("claude-flow hooks")\` — lifecycle hooks and learning

Do NOT call \`mcp__claude-flow__agentdb_session-start\` or
\`mcp__claude-flow__agentdb_session-end\` — hooks manage session lifecycle
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

function whenToUseWhat(): string {
  // ADR-0098: the default "multi-agent work" path is the built-in Agent tool,
  // not claude-flow swarms. Swarm init stays in the table but gated on explicit need.
  return `## When to Use What

| Need | Use |
|------|-----|
| Multi-agent work on one task | \`Agent\` tool (built-in, \`run_in_background: true\`) — NOT a claude-flow swarm |
| Search or store memory | \`mcp__claude-flow__memory_*\` (load via ToolSearch first) |
| Persistent swarm coordination (rare, explicit) | \`ruflo swarm init\` via Bash — reuses matching running swarms (ADR-0098) |
| Run CLI diagnostics | \`ruflo doctor --fix\` via Bash |
| Invoke a registered skill | Skill tool with the skill name (e.g., \`/commit\`) |`;
}

function agentTypes(): string {
  return `## Available Agents (60+ Types)

### Core Development
\`coder\`, \`reviewer\`, \`tester\`, \`planner\`, \`researcher\`

### Specialized
\`security-architect\`, \`security-auditor\`, \`memory-specialist\`, \`performance-engineer\`

### Swarm Coordination
\`hierarchical-coordinator\`, \`mesh-coordinator\`, \`adaptive-coordinator\`

### GitHub & Repository
\`pr-manager\`, \`code-review-swarm\`, \`issue-tracker\`, \`release-manager\`

### SPARC Methodology
\`sparc-coord\`, \`sparc-coder\`, \`specification\`, \`pseudocode\`, \`architecture\``;
}

function memoryCommands(): string {
  return `## Memory Commands Reference

\`\`\`bash
# Store (REQUIRED: --key, --value; OPTIONAL: --namespace, --ttl, --tags)
ruflo memory store --key "pattern-auth" --value "JWT with refresh" --namespace patterns

# Search (REQUIRED: --query; OPTIONAL: --namespace, --limit, --threshold)
ruflo memory search --query "authentication patterns"

# List (OPTIONAL: --namespace, --limit)
ruflo memory list --namespace patterns --limit 10

# Retrieve (REQUIRED: --key; OPTIONAL: --namespace)
ruflo memory retrieve --key "pattern-auth" --namespace patterns
\`\`\``;
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
  return `## Security Protocol

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate all user input at system boundaries using Zod schemas
- Always sanitize file paths to prevent directory traversal attacks
- Always use parameterized queries — never concatenate SQL strings
- Run security audit after any authentication or authorization changes

### Security Scanning
\`\`\`bash
ruflo security scan --depth full
ruflo security audit --report
ruflo security cve --check
\`\`\`

### Security Agents
- \`security-architect\` — threat modeling, architecture review
- \`security-auditor\` — code audit, vulnerability detection
- Use agent routing code 9 (hierarchical/specialized) for security tasks`;
}

function performanceSection(): string {
  return `## Performance Optimization Protocol

- Always run benchmarks before and after performance changes
- Always profile before optimizing — never guess at bottlenecks
- Prefer algorithmic improvements over micro-optimizations
- Keep HNSW search within 150x-12,500x faster target
- Keep memory reduction within 50-75% target with quantization

### Performance Tooling
\`\`\`bash
ruflo performance benchmark --suite all
ruflo performance profile --target "[component]"
ruflo performance metrics --format table
\`\`\`

### Performance Agents
- \`performance-engineer\` — profiling, benchmarking, optimization
- \`perf-analyzer\` — bottleneck detection, analysis
- Use agent routing code 7 (hierarchical/specialized) for performance tasks`;
}

function setupAndBoundary(): string {
  return `## Quick Setup

\`\`\`bash
claude mcp add claude-flow -- npx -y @sparkleideas/cli@latest
ruflo daemon start
ruflo doctor --fix
\`\`\`

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues`;
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
    (_opts) => mcpToolDiscovery(),
    (_opts) => hookSignals(),
    (_opts) => whenToUseWhat(),
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
    (_opts) => mcpToolDiscovery(),
    (_opts) => hookSignals(),
    (_opts) => whenToUseWhat(),
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
    (_opts) => whenToUseWhat(),
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
    (_opts) => whenToUseWhat(),
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

  const header = `# Claude Code Configuration - RuFlo V3\n`;
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
