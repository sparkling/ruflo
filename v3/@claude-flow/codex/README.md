# @claude-flow/codex

OpenAI Codex CLI adapter for Claude Flow V3. Enables multi-agent orchestration with **self-learning capabilities** for OpenAI Codex CLI following the [Agentic AI Foundation](https://agenticfoundation.org) standard.

## Key Concept: Execution Model

```
┌─────────────────────────────────────────────────────────────────┐
│  CLAUDE-FLOW = ORCHESTRATOR (tracks state, stores memory)       │
│  CODEX = EXECUTOR (writes code, runs commands, implements)      │
└─────────────────────────────────────────────────────────────────┘
```

**Codex does the work. Claude-flow coordinates and learns.**

## Quick Start

```bash
# Initialize for Codex (recommended)
npx claude-flow@alpha init --codex

# Full setup with all 137+ skills
npx claude-flow@alpha init --codex --full

# Dual mode (both Claude Code and Codex)
npx claude-flow@alpha init --dual
```

---

<details>
<summary><b>Features</b></summary>

| Feature | Description |
|---------|-------------|
| **AGENTS.md Generation** | Creates project instructions for Codex |
| **MCP Integration** | Self-learning via memory and vector search |
| **137+ Skills** | Invoke with `$skill-name` syntax |
| **Vector Memory** | Semantic pattern search (384-dim embeddings) |
| **Dual Platform** | Supports both Claude Code and Codex |
| **Auto-Registration** | MCP server registered during init |
| **HNSW Search** | 150x-12,500x faster pattern matching |
| **Self-Learning** | Learn from successes, remember patterns |

</details>

---

<details>
<summary><b>MCP Integration (Self-Learning)</b></summary>

### Automatic Registration

When you run `init --codex`, the MCP server is **automatically registered** with Codex:

```bash
# Verify MCP is registered
codex mcp list

# Expected output:
# Name         Command  Args                   Status
# claude-flow  npx      claude-flow mcp start  enabled
```

### Manual Registration

If MCP is not present, add manually:

```bash
codex mcp add claude-flow -- npx claude-flow mcp start
```

### MCP Tools Reference

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `memory_search` | Semantic vector search | **BEFORE** starting any task |
| `memory_store` | Save patterns with embeddings | **AFTER** completing successfully |
| `swarm_init` | Initialize coordination | Start of complex tasks |
| `agent_spawn` | Register agent roles | Multi-agent workflows |
| `neural_train` | Train on patterns | Periodic improvement |

### Tool Parameters

**memory_search**
```json
{
  "query": "search terms",
  "namespace": "patterns",
  "limit": 5
}
```

**memory_store**
```json
{
  "key": "pattern-name",
  "value": "what worked",
  "namespace": "patterns",
  "upsert": true
}
```

**swarm_init**
```json
{
  "topology": "hierarchical",
  "maxAgents": 5,
  "strategy": "specialized"
}
```

</details>

---

<details>
<summary><b>Self-Learning Workflow</b></summary>

### The 4-Step Pattern

```
1. LEARN:    memory_search(query="task keywords") → Find similar patterns
2. COORD:    swarm_init(topology="hierarchical") → Set up coordination
3. EXECUTE:  YOU write code, run commands        → Codex does real work
4. REMEMBER: memory_store(key, value, upsert=true) → Save for future
```

### Complete Example Prompt

```
Build an email validator using a learning-enabled swarm.

STEP 1 - LEARN (use MCP tool):
Use tool: memory_search
  query: "validation utility function patterns"
  namespace: "patterns"
If score > 0.7, use that pattern as reference.

STEP 2 - COORDINATE (use MCP tools):
Use tool: swarm_init with topology="hierarchical", maxAgents=3
Use tool: agent_spawn with type="coder", name="validator"

STEP 3 - EXECUTE (YOU do this - DON'T STOP HERE):
Create /tmp/validator/email.js with validateEmail() function
Create /tmp/validator/test.js with test cases
Run the tests

STEP 4 - REMEMBER (use MCP tool):
Use tool: memory_store
  key: "pattern-email-validator"
  value: "Email validation: regex, returns boolean, test cases"
  namespace: "patterns"
  upsert: true

YOU execute all code. MCP tools are for learning only.
```

### Similarity Score Guide

| Score | Meaning | Action |
|-------|---------|--------|
| > 0.7 | Strong match | Use the pattern directly |
| 0.5 - 0.7 | Partial match | Adapt and modify |
| < 0.5 | Weak match | Create new approach |

</details>

---

<details>
<summary><b>Directory Structure</b></summary>

```
project/
├── AGENTS.md                    # Main project instructions (Codex format)
├── .agents/
│   ├── config.toml              # Project configuration
│   ├── skills/                  # 137+ skills
│   │   ├── swarm-orchestration/
│   │   │   └── SKILL.md
│   │   ├── memory-management/
│   │   │   └── SKILL.md
│   │   ├── sparc-methodology/
│   │   │   └── SKILL.md
│   │   └── ...
│   └── README.md                # Directory documentation
├── .codex/                      # Local overrides (gitignored)
│   ├── config.toml              # Local development settings
│   └── AGENTS.override.md       # Local instruction overrides
└── .claude-flow/                # Runtime data
    ├── config.yaml              # Runtime configuration
    ├── data/                    # Memory and cache
    │   └── memory.db            # SQLite with vector embeddings
    └── logs/                    # Log files
```

### Key Files

| File | Purpose |
|------|---------|
| `AGENTS.md` | Main instructions for Codex (required) |
| `.agents/config.toml` | Project-wide configuration |
| `.codex/config.toml` | Local overrides (gitignored) |
| `.claude-flow/data/memory.db` | Vector memory database |

</details>

---

<details>
<summary><b>Templates</b></summary>

### Available Templates

| Template | Skills | Learning | Best For |
|----------|--------|----------|----------|
| `minimal` | 2 | Basic | Quick prototypes |
| `default` | 4 | Yes | Standard projects |
| `full` | 137+ | Yes | Full-featured development |
| `enterprise` | 137+ | Advanced | Team environments |

### Usage

```bash
# Minimal (fastest init)
npx claude-flow@alpha init --codex --minimal

# Default
npx claude-flow@alpha init --codex

# Full (all skills)
npx claude-flow@alpha init --codex --full
```

### Template Contents

**Minimal:**
- Core swarm orchestration
- Basic memory management

**Default:**
- Swarm orchestration
- Memory management
- SPARC methodology
- Basic coding patterns

**Full:**
- All 137+ skills
- GitHub integration
- Security scanning
- Performance optimization
- AgentDB vector search
- Neural pattern training

</details>

---

<details>
<summary><b>Platform Comparison (Claude Code vs Codex)</b></summary>

| Feature | Claude Code | OpenAI Codex |
|---------|-------------|--------------|
| Config File | `CLAUDE.md` | `AGENTS.md` |
| Skills Dir | `.claude/skills/` | `.agents/skills/` |
| Skill Syntax | `/skill-name` | `$skill-name` |
| Settings | `settings.json` | `config.toml` |
| MCP | Native | Via `codex mcp add` |
| Overrides | `.claude.local.md` | `.codex/config.toml` |

### Dual Mode

Run `init --dual` to set up both platforms:

```bash
npx claude-flow@alpha init --dual
```

This creates:
- `CLAUDE.md` for Claude Code users
- `AGENTS.md` for Codex users
- Shared `.claude-flow/` runtime
- Cross-compatible skills

</details>

---

<details>
<summary><b>Skill Invocation</b></summary>

### Syntax

In OpenAI Codex CLI, invoke skills with `$` prefix:

```
$swarm-orchestration
$memory-management
$sparc-methodology
$security-audit
$agent-coder
$agent-tester
$github-workflow
$performance-optimization
```

### Skill Categories

| Category | Examples |
|----------|----------|
| **Swarm** | `$swarm-orchestration`, `$swarm-advanced` |
| **Memory** | `$memory-management`, `$agentdb-vector-search` |
| **SPARC** | `$sparc-methodology`, `$specification`, `$architecture` |
| **GitHub** | `$github-code-review`, `$github-workflow-automation` |
| **Security** | `$security-audit`, `$security-overhaul` |
| **Testing** | `$tdd-london-swarm`, `$production-validator` |

### Custom Skills

Create custom skills in `.agents/skills/`:

```
.agents/skills/my-skill/
└── SKILL.md
```

**SKILL.md format:**
```markdown
# My Custom Skill

Instructions for what this skill does...

## Usage
Invoke with `$my-skill`
```

</details>

---

<details>
<summary><b>Configuration</b></summary>

### .agents/config.toml

```toml
# Model configuration
model = "gpt-4"

# Approval policy: "always" | "on-request" | "never"
approval_policy = "on-request"

# Sandbox mode: "read-only" | "workspace-write" | "danger-full-access"
sandbox_mode = "workspace-write"

# Web search: "off" | "cached" | "live"
web_search = "cached"

# MCP Servers
[mcp_servers.claude-flow]
command = "npx"
args = ["claude-flow", "mcp", "start"]
enabled = true

# Skills
[[skills]]
path = ".agents/skills/swarm-orchestration"
enabled = true

[[skills]]
path = ".agents/skills/memory-management"
enabled = true

[[skills]]
path = ".agents/skills/sparc-methodology"
enabled = true
```

### .codex/config.toml (Local Overrides)

```toml
# Local development overrides (gitignored)
# These settings override .agents/config.toml

approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "live"

# Disable MCP in local if needed
[mcp_servers.claude-flow]
enabled = false
```

### Environment Variables

```bash
# Configuration paths
CLAUDE_FLOW_CONFIG=./claude-flow.config.json
CLAUDE_FLOW_MEMORY_PATH=./.claude-flow/data

# Provider keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# MCP settings
CLAUDE_FLOW_MCP_PORT=3000
```

</details>

---

<details>
<summary><b>Vector Search Details</b></summary>

### Specifications

| Property | Value |
|----------|-------|
| Embedding Dimensions | 384 |
| Search Algorithm | HNSW |
| Speed Improvement | 150x-12,500x faster |
| Similarity Range | 0.0 - 1.0 |
| Storage | SQLite with vector extension |
| Model | all-MiniLM-L6-v2 |

### Namespaces

| Namespace | Purpose |
|-----------|---------|
| `patterns` | Successful code patterns |
| `solutions` | Bug fixes and solutions |
| `tasks` | Task completion records |
| `coordination` | Swarm state |
| `results` | Worker results |
| `default` | General storage |

### Example Searches

```javascript
// Find auth patterns
memory_search({ query: "authentication JWT patterns", namespace: "patterns" })

// Find bug solutions
memory_search({ query: "null pointer fix", namespace: "solutions" })

// Find past tasks
memory_search({ query: "user profile API", namespace: "tasks" })
```

</details>

---

<details>
<summary><b>API Reference</b></summary>

### CodexInitializer Class

```typescript
import { CodexInitializer } from '@claude-flow/codex';

class CodexInitializer {
  /**
   * Initialize a Codex project
   */
  async initialize(options: CodexInitOptions): Promise<CodexInitResult>;

  /**
   * Preview what would be created without writing files
   */
  async dryRun(options: CodexInitOptions): Promise<string[]>;
}
```

### initializeCodexProject Function

```typescript
import { initializeCodexProject } from '@claude-flow/codex';

/**
 * Quick initialization helper
 */
async function initializeCodexProject(
  projectPath: string,
  options?: Partial<CodexInitOptions>
): Promise<CodexInitResult>;
```

### Types

```typescript
interface CodexInitOptions {
  /** Project directory path */
  projectPath: string;
  /** Template to use */
  template?: 'minimal' | 'default' | 'full' | 'enterprise';
  /** Specific skills to include */
  skills?: string[];
  /** Overwrite existing files */
  force?: boolean;
  /** Enable dual mode (Claude Code + Codex) */
  dual?: boolean;
}

interface CodexInitResult {
  /** Whether initialization succeeded */
  success: boolean;
  /** List of files created */
  filesCreated: string[];
  /** List of skills generated */
  skillsGenerated: string[];
  /** Whether MCP was registered */
  mcpRegistered?: boolean;
  /** Non-fatal warnings */
  warnings?: string[];
  /** Fatal errors */
  errors?: string[];
}
```

### Programmatic Usage

```typescript
import { CodexInitializer, initializeCodexProject } from '@claude-flow/codex';

// Quick initialization
const result = await initializeCodexProject('/path/to/project', {
  template: 'full',
  force: true,
  dual: false,
});

console.log(`Files created: ${result.filesCreated.length}`);
console.log(`Skills: ${result.skillsGenerated.length}`);
console.log(`MCP registered: ${result.mcpRegistered}`);

// Or use the class directly
const initializer = new CodexInitializer();
const result = await initializer.initialize({
  projectPath: '/path/to/project',
  template: 'enterprise',
  skills: ['swarm-orchestration', 'memory-management', 'security-audit'],
  force: false,
  dual: true,
});

if (result.warnings?.length) {
  console.warn('Warnings:', result.warnings);
}
```

</details>

---

<details>
<summary><b>Migration from Claude Code</b></summary>

### Convert CLAUDE.md to AGENTS.md

```typescript
import { migrate } from '@claude-flow/codex';

const result = await migrate({
  sourcePath: './CLAUDE.md',
  targetPath: './AGENTS.md',
  preserveComments: true,
  generateSkills: true,
});

console.log(`Migrated: ${result.success}`);
console.log(`Skills generated: ${result.skillsGenerated.length}`);
```

### Manual Migration Checklist

1. **Rename config file**: `CLAUDE.md` → `AGENTS.md`
2. **Move skills**: `.claude/skills/` → `.agents/skills/`
3. **Update syntax**: `/skill-name` → `$skill-name`
4. **Convert settings**: `settings.json` → `config.toml`
5. **Register MCP**: `codex mcp add claude-flow -- npx claude-flow mcp start`

### Dual Mode Alternative

Instead of migrating, use dual mode to support both:

```bash
npx claude-flow@alpha init --dual
```

This keeps both `CLAUDE.md` and `AGENTS.md` in sync.

</details>

---

<details>
<summary><b>Troubleshooting</b></summary>

### MCP Not Working

```bash
# Check if registered
codex mcp list

# Re-register
codex mcp remove claude-flow
codex mcp add claude-flow -- npx claude-flow mcp start

# Test connection
npx claude-flow mcp test
```

### Memory Search Returns Empty

```bash
# Initialize memory database
npx claude-flow memory init --force

# Check if entries exist
npx claude-flow memory list

# Manually add a test pattern
npx claude-flow memory store --key "test" --value "test pattern" --namespace patterns
```

### Skills Not Loading

```bash
# Verify skill directory
ls -la .agents/skills/

# Check config.toml for skill registration
cat .agents/config.toml | grep skills

# Rebuild skills
npx claude-flow@alpha init --codex --force
```

### Vector Search Slow

```bash
# Check HNSW index
npx claude-flow memory stats

# Rebuild index
npx claude-flow memory optimize --rebuild-index
```

</details>

---

## Related Packages

| Package | Description |
|---------|-------------|
| [@claude-flow/cli](https://www.npmjs.com/package/@claude-flow/cli) | Main CLI (26 commands, 140+ subcommands) |
| [claude-flow](https://www.npmjs.com/package/claude-flow) | Umbrella package |
| [@claude-flow/memory](https://www.npmjs.com/package/@claude-flow/memory) | AgentDB with HNSW vector search |
| [@claude-flow/security](https://www.npmjs.com/package/@claude-flow/security) | Security module |

## License

MIT

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues
