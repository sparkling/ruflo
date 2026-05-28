/**
 * WASM Agent MCP Tools
 *
 * Exposes @ruvector/rvagent-wasm operations via MCP protocol with cross-process
 * persistence. Each MCP tool invocation is a separate CLI process, so the in-memory
 * registry in agent-wasm.ts is empty at every fresh start. We persist agent
 * metadata + serializable state to `<projectRoot>/.claude-flow/wasm-agents/store.json`
 * so create-then-op lifecycles work end-to-end across invocations.
 *
 * The live `WasmAgent` instance itself cannot be serialized (it's a wasm-bindgen
 * handle), but its config is enough to rehydrate — we reconstruct a fresh live
 * agent from saved config on demand, re-register it under the same id, then
 * dispatch the op. After state-changing ops we re-snapshot. All writes are
 * atomic (tmp + rename) and fail loudly on I/O errors (no silent swallow).
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MCPTool } from './types.js';
import { findProjectRoot } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';

async function loadAgentWasm() {
  const mod = await import('../ruvector/agent-wasm.js');
  return mod;
}

// ── ADR-129 P2 — Destructive-tool gate ──────────────────────────────────────
// Hand-ported from upstream `47a7825b0:wasm-agent-tools.ts:25-37` per ADR-0258
// §Group 4. Consumed by `wasm_agent_compose` to refuse risky mcpTools unless
// the caller opts in via `mcpToolsAllowDestructive: true`.

/** Tools that can cause data loss or system disruption — require explicit opt-in. */
const DESTRUCTIVE_TOOL_PATTERNS = [
  /^memory_delete$/,
  /^federation_/,
  /^swarm_shutdown$/,
  /^agent_terminate$/,
  /_delete$/,
  /_remove$/,
  /_drop$/,
  /_shutdown$/,
];

function isDestructiveTool(name: string): boolean {
  return DESTRUCTIVE_TOOL_PATTERNS.some(p => p.test(name));
}

/**
 * Safe-by-default MCP tool allowlist for `wasm_agent_compose`.
 *
 * Per ADR-0259 final 29-entry spec (vs upstream's 30): translates the 4
 * upstream underscore names that diverge from fork's hyphen convention
 * (`hooks_post-task`, `hooks_pre-task`, `agentdb_pattern-search`,
 * `agentdb_hierarchical-recall`), drops 4 tools that don't exist in fork
 * (`memory_compress`, `embeddings_search_text`, `wasm_agent_status`,
 * `task_summary`), and adds 3 fork-curated tools (`memory_search_unified`,
 * `memory_bridge_status`, `agentdb_skill_search`).
 *
 * A name on this Set gets the "Ruflo MCP tool: <name>" branded descriptor
 * inside a composed RVF; names off the Set still pass through
 * `DESTRUCTIVE_TOOL_PATTERNS` but get the bare "MCP tool: <name>" fallback.
 */
const SAFE_MCP_TOOLS = new Set([
  // Memory (8)
  'memory_search', 'memory_search_unified', 'memory_retrieve', 'memory_list', 'memory_stats',
  'memory_store', 'memory_export', 'memory_bridge_status',
  // Embeddings (4)
  'embeddings_search', 'embeddings_generate', 'embeddings_status', 'embeddings_compare',
  // Hooks (4) — note hyphens in post-/pre-task per fork convention
  'hooks_post-task', 'hooks_pre-task', 'hooks_route', 'hooks_metrics',
  // WASM agent surface (2)
  'wasm_agent_list', 'wasm_agent_files',
  // WASM gallery surface (3)
  'wasm_gallery_list', 'wasm_gallery_search', 'wasm_gallery_categories',
  // AgentDB (3) — note hyphens per fork convention
  'agentdb_pattern-search', 'agentdb_hierarchical-recall', 'agentdb_skill_search',
  // Neural (3)
  'neural_predict', 'neural_patterns', 'neural_status',
  // Task (2)
  'task_list', 'task_status',
]);

// ── ADR-129 P4 — Plugin manifest reader ─────────────────────────────────────
//
// Hand-ported from upstream `47a7825b0:v3/@claude-flow/cli/src/mcp-tools/
// wasm-agent-tools.ts:70-101` per ADR-0256 Option A (helpers-only). The
// consuming `includePlugins` parameter inside `wasm_agent_compose` is a
// Phase 2 surface and is deferred until Phase 2's three gating questions
// resolve (per ADR-0254 Amendment 1).
//
// These helpers are exported pure functions ready for Phase 2 wire-up;
// they have no archivist-seam interaction and no MCP-tool surface change.
// The smoke `scripts/smoke-wasm-plugin-bridge.mjs` validates fixture-level
// behavior on every CI run so the helpers cannot rot silently before
// Phase 2 catches up.

interface PluginRvagentConfig {
  exposeSkillsAsTools?: string[] | boolean;
  autoWireOnCompose?: boolean;
}

interface PluginManifest {
  name?: string;
  rvagent?: PluginRvagentConfig;
}

/**
 * Load and parse a plugin's plugin.json, extracting the optional rvagent field.
 * Returns null silently if the plugin or its manifest is missing.
 */
function loadPluginManifest(pluginName: string): PluginManifest | null {
  // ADR-0100/G: mcp-tools/*-tools.ts must not call process.cwd() directly;
  // use findProjectRoot() so the workspace anchor honors --workspace-root /
  // ACCEPT_TEMP env discipline (see types.ts for the resolution chain).
  const projectRoot = findProjectRoot();
  const candidateDirs = [
    resolve(projectRoot, 'plugins', pluginName, '.claude-plugin', 'plugin.json'),
    resolve(projectRoot, 'plugins', `ruflo-${pluginName}`, '.claude-plugin', 'plugin.json'),
    resolve(projectRoot, 'v3', 'plugins', pluginName, '.claude-plugin', 'plugin.json'),
  ];
  for (const p of candidateDirs) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as PluginManifest;
      } catch (e: any) {
        // Malformed JSON or missing file → fall through to next candidate; rethrow IO errors.
        if (e instanceof SyntaxError || e?.code === 'ENOENT') continue;
        throw e;
      }
    }
  }
  return null;
}

/**
 * Extract skills declared for WASM agent exposure from a plugin manifest.
 * Handles both string[] and boolean forms of exposeSkillsAsTools.
 */
function extractPluginSkills(manifest: PluginManifest, pluginName: string): Array<{ name: string; description: string; trigger: string; content: string }> {
  const rv = manifest.rvagent;
  if (!rv) return [];
  const skillNames = Array.isArray(rv.exposeSkillsAsTools) ? rv.exposeSkillsAsTools : [];
  return skillNames.map(skillName => ({
    name: skillName,
    description: `Plugin skill: ${skillName} from ${pluginName}`,
    trigger: skillName,
    content: `Plugin-provided skill: ${skillName}`,
  }));
}

// Phase 2 consumers landed via ADR-0266 — `wasm_agent_compose` below now
// calls both `loadPluginManifest` and `extractPluginSkills`, so the
// ADR-0256 dead-code-seam markers (`void loadPluginManifest; void
// extractPluginSkills;`) are no longer required.

// ── Persistence layer ───────────────────────────────────────────

const STORAGE_DIR = '.claude-flow';
const WASM_DIR = 'wasm-agents';
const STORE_FILE = 'store.json';

interface PersistedAgent {
  id: string;
  config: {
    model?: string;
    instructions?: string;
    maxTurns?: number;
  };
  info: {
    id: string;
    state: 'idle' | 'running' | 'error';
    config: { model?: string; instructions?: string; maxTurns?: number };
    model: string;
    turnCount: number;
    fileCount: number;
    isStopped: boolean;
    createdAt: string;
  };
  state?: unknown;
  tools?: string[];
  todos?: unknown[];
  stateSnapshotAt?: string;
}

interface WasmStore {
  version: string;
  agents: Record<string, PersistedAgent>;
}

function getWasmDir(): string {
  return join(findProjectRoot(), STORAGE_DIR, WASM_DIR);
}

function getStorePath(): string {
  return join(getWasmDir(), STORE_FILE);
}

function ensureWasmDir(): void {
  const dir = getWasmDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load the store from disk. Missing file returns empty store. JSON parse errors
 * throw — we do NOT swallow corruption silently (ADR-0082 / feedback-no-fallbacks).
 */
function loadStore(): WasmStore {
  const path = getStorePath();
  if (!existsSync(path)) {
    return { version: '1.0.0', agents: {} };
  }
  const data = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(data) as WasmStore;
  if (!parsed || typeof parsed !== 'object' || !parsed.agents) {
    throw new Error(`Corrupt WASM agent store at ${path}: missing 'agents' field`);
  }
  return parsed;
}

/**
 * Write the store atomically: write to a unique tmp path, then rename.
 * rename() is atomic on POSIX within the same filesystem, so readers never
 * see a half-written file. Fails loudly on any I/O error — no silent swallow.
 */
function saveStore(store: WasmStore): void {
  ensureWasmDir();
  const target = getStorePath();
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  const body = JSON.stringify(store, null, 2);
  writeFileSync(tmp, body, 'utf-8');
  renameSync(tmp, target);
}

/**
 * Run cb under exclusive advisory-lock on the store's sibling .lock file.
 * Without this, parallel `wasm_agent_create` processes race on the
 * load→mutate→save sequence: two processes read the same pre-image, each
 * adds its agent, saveStore clobbers whichever rename lands last — the
 * "lost update" class. atomic rename protects per-write but not against
 * concurrent read-modify-write.
 *
 * Same advisory-lock pattern as rvf-backend's acquireLock (ADR-0095). PID
 * is recorded in the lock file so a crashed writer's stale lock can be
 * detected + force-unlocked. 5s budget, exponential backoff with jitter,
 * fails loudly on timeout.
 */
function withStoreLock<T>(cb: () => T): T {
  ensureWasmDir();
  const lockPath = getStorePath() + '.lock';
  const budgetMs = 5000;
  const deadline = Date.now() + budgetMs;
  let waitMs = 10;
  while (true) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx'); // O_CREAT|O_EXCL — atomic
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd); fd = undefined;
      try {
        return cb();
      } finally {
        try { unlinkSync(lockPath); } catch { /* already gone */ }
      }
    } catch (err: any) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
      if (err?.code !== 'EEXIST') throw err;
      // Someone else holds the lock. Detect stale (dead PID) and force.
      let stale = false;
      try {
        const existing = JSON.parse(readFileSync(lockPath, 'utf-8'));
        if (typeof existing?.pid === 'number' && existing.pid !== process.pid) {
          try { process.kill(existing.pid, 0); } catch { stale = true; }
        }
      } catch { stale = true; }
      if (stale) {
        try { unlinkSync(lockPath); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `[wasm-agent-tools] store lock contention: could not acquire ${lockPath} within ${budgetMs}ms`
        );
      }
      // Backoff with small jitter. Bounded by deadline.
      const jitter = Math.floor(Math.random() * waitMs);
      const sleepMs = Math.min(waitMs + jitter, Math.max(1, deadline - Date.now()));
      const end = Date.now() + sleepMs;
      // Busy-wait (no async await path available for this sync API).
      while (Date.now() < end) { /* noop */ }
      waitMs = Math.min(waitMs * 2, 400);
    }
  }
}

// Convenience wrapper — run load → mutate → save under the lock.
function mutateStore(mutator: (s: WasmStore) => void): WasmStore {
  return withStoreLock(() => {
    const s = loadStore();
    mutator(s);
    saveStore(s);
    return s;
  });
}

function snapshotAgent(wasm: Awaited<ReturnType<typeof loadAgentWasm>>, id: string, config: PersistedAgent['config']): PersistedAgent {
  const info = wasm.getWasmAgent(id);
  if (!info) {
    throw new Error(`snapshotAgent: agent '${id}' not in live registry`);
  }
  let state: unknown;
  let tools: string[] | undefined;
  let todos: unknown[] | undefined;
  try { state = wasm.getWasmAgentState(id); } catch { state = undefined; }
  try { tools = wasm.getWasmAgentTools(id); } catch { tools = undefined; }
  try { todos = wasm.getWasmAgentTodos(id); } catch { todos = undefined; }
  return {
    id,
    config,
    info,
    state,
    tools,
    todos,
    stateSnapshotAt: new Date().toISOString(),
  };
}

/**
 * Ensure a WASM agent is live in the in-memory registry for this process.
 * If missing, rehydrate from the persisted store by reconstructing a fresh
 * `WasmAgent` with the same config. The id is preserved by registering the
 * rehydrated agent under the same key via the low-level registry contract.
 *
 * Returns the loaded wasm module for the caller to dispatch the op.
 * Throws if the agent id is neither live nor persisted.
 */
async function ensureLive(agentId: string): Promise<Awaited<ReturnType<typeof loadAgentWasm>>> {
  const wasm = await loadAgentWasm();
  if (wasm.getWasmAgent(agentId)) {
    return wasm;
  }
  const store = loadStore();
  const record = store.agents[agentId];
  if (!record) {
    // Leave resolution to the inner op — it will throw "WASM agent not found",
    // which is the honest signal to the caller that this id was never created.
    return wasm;
  }
  // Rehydrate: create a fresh `WasmAgent` with the saved config (the live
  // wasm-bindgen handle itself isn't serializable), then re-key it under the
  // persisted id so `getWasmAgent(agentId)`, `executeWasmTool(agentId, ...)`,
  // etc. resolve correctly in this process for the rest of the invocation.
  const fresh = await wasm.createWasmAgent(record.config);
  if (fresh.id !== agentId) {
    wasm.rehydrateWasmAgent(fresh.id, agentId);
  }
  return wasm;
}

export const wasmAgentTools: MCPTool[] = [
  {
    name: 'wasm_agent_create',
    description: 'Create a sandboxed WASM agent with virtual filesystem (no OS access). Optionally use a gallery template.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        template: { type: 'string', description: 'Gallery template name (coder, researcher, tester, reviewer, security, swarm)' },
        model: { type: 'string', description: 'Model identifier (default: anthropic:claude-sonnet-4-6)' },
        instructions: { type: 'string', description: 'System instructions for the agent' },
        maxTurns: { type: 'number', description: 'Max conversation turns (default: 50)' },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await loadAgentWasm();
        let info;
        let source = 'config';
        let config: PersistedAgent['config'];
        if (args.template) {
          info = await wasm.createAgentFromTemplate(args.template as string);
          source = 'gallery';
          // createAgentFromTemplate wraps createWasmAgent with template instructions,
          // but only the saved fields matter for rehydration. Record what we know.
          config = {
            model: info.config.model,
            instructions: info.config.instructions,
            maxTurns: info.config.maxTurns,
          };
        } else {
          config = {
            model: args.model as string | undefined,
            instructions: args.instructions as string | undefined,
            maxTurns: args.maxTurns as number | undefined,
          };
          info = await wasm.createWasmAgent(config);
        }

        // Persist under advisory lock — prevents the read-modify-write race
        // when multiple `wasm_agent_create` processes run concurrently.
        withStoreLock(() => {
          const store = loadStore();
          store.agents[info!.id] = snapshotAgent(wasm, info!.id, config);
          saveStore(store);
        });

        const payload: Record<string, unknown> = { success: true, agent: info };
        if (source === 'gallery') payload.source = 'gallery';
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_prompt',
    description: 'Send a prompt to a WASM agent and get a response.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string', description: 'WASM agent ID' },
        input: { type: 'string', description: 'User prompt to send' },
      },
      required: ['agentId', 'input'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await ensureLive(args.agentId as string);
        const result = await wasm.promptWasmAgent(args.agentId as string, args.input as string);
        // Re-snapshot after a prompt run — state/turnCount advanced.
        withStoreLock(() => {
          const store = loadStore();
          const existing = store.agents[args.agentId as string];
          if (existing) {
            store.agents[args.agentId as string] = snapshotAgent(wasm, args.agentId as string, existing.config);
            saveStore(store);
          }
        });
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_tool',
    description: 'Execute a tool on a WASM agent sandbox. Tools: read_file, write_file, edit_file, write_todos, list_files. Use flat format: {tool, path, content, ...}.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string', description: 'WASM agent ID' },
        toolName: { type: 'string', description: 'Tool name (read_file, write_file, edit_file, write_todos, list_files)' },
        toolInput: { type: 'object', description: 'Tool parameters (flat: {path, content, old_string, new_string, todos})' },
      },
      required: ['agentId', 'toolName'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await ensureLive(args.agentId as string);
        const toolCall = {
          tool: args.toolName as string,
          ...((args.toolInput as Record<string, unknown>) ?? {}),
        };
        const result = await wasm.executeWasmTool(args.agentId as string, toolCall);
        // Re-snapshot after tool execution — fileCount/state may have advanced.
        withStoreLock(() => {
          const store = loadStore();
          const existing = store.agents[args.agentId as string];
          if (existing) {
            store.agents[args.agentId as string] = snapshotAgent(wasm, args.agentId as string, existing.config);
            saveStore(store);
          }
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_list',
    description: 'List all active WASM agents.',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => {
      try {
        // Reading from disk gives a stable cross-process view; in-memory agents
        // in the current process are reflected only if they were persisted
        // (i.e. created via wasm_agent_create). Both create and subsequent
        // state-changing ops write through, so disk is the source of truth.
        const store = loadStore();
        const agents = Object.values(store.agents).map(a => a.info);
        return { content: [{ type: 'text', text: JSON.stringify({ agents, count: agents.length }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_terminate',
    description: 'Terminate a WASM agent and free resources.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string', description: 'WASM agent ID' },
      },
      required: ['agentId'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await loadAgentWasm();
        // Best-effort free the live in-memory handle (may not exist in this process).
        let ok = false;
        try { ok = wasm.terminateWasmAgent(args.agentId as string); } catch { ok = false; }
        // Always delete the persisted record — this is the authoritative removal.
        const hadRecord = withStoreLock(() => {
          const store = loadStore();
          const present = !!store.agents[args.agentId as string];
          if (present) {
            delete store.agents[args.agentId as string];
            saveStore(store);
          }
          return present;
        });
        return { content: [{ type: 'text', text: JSON.stringify({ success: ok || hadRecord }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_files',
    description: 'Get a WASM agent\'s available tools and info.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string', description: 'WASM agent ID' },
      },
      required: ['agentId'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await ensureLive(args.agentId as string);
        const tools = wasm.getWasmAgentTools(args.agentId as string);
        const info = wasm.getWasmAgent(args.agentId as string);
        return { content: [{ type: 'text', text: JSON.stringify({ tools, fileCount: info?.fileCount ?? 0, turnCount: info?.turnCount ?? 0 }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_export',
    description: 'Export a WASM agent\'s full state (config, filesystem, conversation) as JSON.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentId: { type: 'string', description: 'WASM agent ID' },
      },
      required: ['agentId'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await ensureLive(args.agentId as string);
        const state = wasm.exportWasmState(args.agentId as string);
        return { content: [{ type: 'text', text: state }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_list',
    description: 'List all available WASM agent gallery templates (Coder, Researcher, Tester, Reviewer, Security, Swarm).',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => {
      try {
        const wasm = await loadAgentWasm();
        const templates = await wasm.listGalleryTemplates();
        return { content: [{ type: 'text', text: JSON.stringify({ templates, count: templates.length }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_search',
    description: 'Search WASM agent gallery templates by query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await loadAgentWasm();
        const results = await wasm.searchGalleryTemplates(args.query as string);
        return { content: [{ type: 'text', text: JSON.stringify({ results, count: results.length }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_create',
    description: 'Create a WASM agent from a gallery template.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        template: { type: 'string', description: 'Template name (coder, researcher, tester, reviewer, security, swarm)' },
      },
      required: ['template'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await loadAgentWasm();
        const info = await wasm.createAgentFromTemplate(args.template as string);
        // Persist gallery-created agents too, so they participate in the same lifecycle.
        const config: PersistedAgent['config'] = {
          model: info.config.model,
          instructions: info.config.instructions,
          maxTurns: info.config.maxTurns,
        };
        withStoreLock(() => {
          const store = loadStore();
          store.agents[info.id] = snapshotAgent(wasm, info.id, config);
          saveStore(store);
        });
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, agent: info, template: args.template }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },

  // ── ADR-129 P3 / ADR-0266 Phase 1 — Group 1 introspection (5 tools) ─────────
  //
  // Per ADR-0258 §Group 1: each handler's FIRST non-arg-parse statement is
  // `await ensureLive(args.agentId as string)`. No `withStoreLock`. No
  // re-snapshot. Pattern matches existing `wasm_agent_files` (`:485-494`).
  // Handler bodies cribbed verbatim from upstream `47a7825b0:wasm-agent-tools
  // .ts:437-531`, with `loadAgentWasm()` swapped for `ensureLive(...)` so the
  // cold-process rehydrate path resolves before the live read.

  {
    name: 'wasm_agent_state',
    description: 'Read the full internal state of a WASM agent (messages, turn count, config, stop status). Use when native Task is wrong because the agent runs in a sandboxed WASM runtime whose internal conversation history is not directly accessible from the host process.',
    inputSchema: {
      type: 'object' as const,
      properties: { agentId: { type: 'string', description: 'WASM agent ID' } },
      required: ['agentId'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.agentId, 'agentId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const wasm = await ensureLive(args.agentId as string);
        const state = wasm.getWasmAgentState(args.agentId as string);
        return { content: [{ type: 'text', text: JSON.stringify({ agentId: args.agentId, state }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_todos',
    description: 'Get the structured todo list of a WASM agent as JSON. Use when native Task is wrong because the todo state lives inside the sandboxed WASM runtime and is not visible to the host process.',
    inputSchema: {
      type: 'object' as const,
      properties: { agentId: { type: 'string', description: 'WASM agent ID' } },
      required: ['agentId'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.agentId, 'agentId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const wasm = await ensureLive(args.agentId as string);
        const todos = wasm.getWasmAgentTodos(args.agentId as string);
        return { content: [{ type: 'text', text: JSON.stringify({ agentId: args.agentId, todos }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_tools',
    description: 'List the tools registered on a WASM agent sandbox. Use when native Task is wrong because the tool registry lives inside the WASM runtime and cannot be inspected from the host via standard reflection.',
    inputSchema: {
      type: 'object' as const,
      properties: { agentId: { type: 'string', description: 'WASM agent ID' } },
      required: ['agentId'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.agentId, 'agentId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const wasm = await ensureLive(args.agentId as string);
        const tools = wasm.getWasmAgentTools(args.agentId as string);
        return { content: [{ type: 'text', text: JSON.stringify({ agentId: args.agentId, tools }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_turn_count',
    description: 'Return the current turn count of a WASM agent. Use when native Task is wrong because turn-limit enforcement and progress tracking must be polled from inside the sandboxed WASM runtime rather than inferred externally.',
    inputSchema: {
      type: 'object' as const,
      properties: { agentId: { type: 'string', description: 'WASM agent ID' } },
      required: ['agentId'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.agentId, 'agentId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const wasm = await ensureLive(args.agentId as string);
        const info = wasm.getWasmAgent(args.agentId as string);
        if (!info) return { content: [{ type: 'text', text: JSON.stringify({ error: `Agent not found: ${args.agentId}` }) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify({ agentId: args.agentId, turnCount: info.turnCount }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_agent_is_stopped',
    description: 'Check whether a WASM agent has reached its stop condition (max turns or explicit stop). Use when native Task is wrong because the stop condition is evaluated inside the WASM runtime and not observable from the host without an explicit query.',
    inputSchema: {
      type: 'object' as const,
      properties: { agentId: { type: 'string', description: 'WASM agent ID' } },
      required: ['agentId'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.agentId, 'agentId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const wasm = await ensureLive(args.agentId as string);
        const info = wasm.getWasmAgent(args.agentId as string);
        if (!info) return { content: [{ type: 'text', text: JSON.stringify({ error: `Agent not found: ${args.agentId}` }) }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify({ agentId: args.agentId, isStopped: info.isStopped }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },

  // ── ADR-129 P3 / ADR-0266 Phase 2 — Group 2 mutator (1 tool) ────────────────
  //
  // Per ADR-0258 §Group 2: `ensureLive` THEN `resetWasmAgent` THEN
  // `withStoreLock(() => ... snapshotAgent ... saveStore)`. Pattern matches
  // existing `wasm_agent_prompt` (`:371-389`). Reset advances the persisted
  // state (clears messages + turn count) so we MUST re-snapshot under the
  // store lock.

  {
    name: 'wasm_agent_reset',
    description: 'Reset a WASM agent — clears messages and turn count so it can be reused across tasks. Use when native Task is wrong because the agent lives in a sandboxed WASM runtime that must be explicitly reset rather than simply re-spawned.',
    inputSchema: {
      type: 'object' as const,
      properties: { agentId: { type: 'string', description: 'WASM agent ID' } },
      required: ['agentId'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.agentId, 'agentId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const wasm = await ensureLive(args.agentId as string);
        const ok = wasm.resetWasmAgent(args.agentId as string);
        withStoreLock(() => {
          const store = loadStore();
          const existing = store.agents[args.agentId as string];
          if (existing) {
            store.agents[args.agentId as string] = snapshotAgent(wasm, args.agentId as string, existing.config);
            saveStore(store);
          }
        });
        return { content: [{ type: 'text', text: JSON.stringify({ success: ok, agentId: args.agentId }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },

  // ── ADR-129 P2 / ADR-0266 Phase 3 — Group 4 compose builder (1 tool) ────────
  //
  // Per ADR-0258 §Group 4: ephemeral pure builder; returns base64 RVF bytes to
  // caller, does NOT write `store.json`. Preserves upstream's AIDefence scan
  // gate and the plugin auto-wire (P4 helpers already in fork via ADR-0256).
  // Handler body verbatim from upstream `47a7825b0:wasm-agent-tools.ts:357-431`.

  {
    name: 'wasm_agent_compose',
    description: [
      'Compose an RVF container with explicit skills, MCP tool descriptors, prompts, and tools.',
      'Returns base64-encoded RVF bytes + a manifest of what was packed.',
      'SECURITY: mcpTools accepts only an explicit allowlist — never pass "*".',
      'Destructive tools (memory_delete, *_shutdown, federation_*, etc.) require',
      'mcpToolsAllowDestructive: true.',
      'Use includePlugins to auto-wire skills from plugins that declare rvagent.exposeSkillsAsTools.',
    ].join(' '),
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Optional name for the composed agent' },
        model: { type: 'string', description: 'Model identifier (default: anthropic:claude-sonnet-4-6)' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skill names to include' },
        mcpTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit allowlist of MCP tool names to embed (principle of least privilege)',
        },
        mcpToolsAllowDestructive: {
          type: 'boolean',
          description: 'Set true to allow destructive tools (*_delete, *_shutdown, federation_*, etc.)',
        },
        prompts: { type: 'array', items: { type: 'object' }, description: 'Prompt objects to embed' },
        tools: { type: 'array', items: { type: 'object' }, description: 'Tool definitions to embed' },
        includePlugins: {
          type: 'array',
          items: { type: 'string' },
          description: 'Plugin names whose rvagent.exposeSkillsAsTools skills should be included',
        },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await loadAgentWasm();
        const allowDestructive = args.mcpToolsAllowDestructive === true;
        const requestedTools = (args.mcpTools as string[] | undefined) ?? [];

        // Validate: reject destructive tools unless explicitly opted in
        const blockedTools = requestedTools.filter(n => isDestructiveTool(n) && !allowDestructive);
        if (blockedTools.length > 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              error: `Destructive tools blocked: ${blockedTools.join(', ')}. Set mcpToolsAllowDestructive: true to allow.`,
              blockedTools,
            }) }],
            isError: true,
          };
        }

        // Build MCP tool descriptors from the allowlist
        const mcpToolDescriptors = requestedTools.map(name => ({
          name,
          description: SAFE_MCP_TOOLS.has(name) ? `Ruflo MCP tool: ${name}` : `MCP tool: ${name}`,
          input_schema: {},
          group: 'ruflo',
        }));

        // ADR-129 P4: auto-wire plugin skills
        const pluginSkills: Array<{ name: string; description: string; trigger: string; content: string }> = [];
        const pluginWarnings: string[] = [];
        const includePlugins = (args.includePlugins as string[] | undefined) ?? [];
        for (const pluginName of includePlugins) {
          const manifest = loadPluginManifest(pluginName);
          if (!manifest) {
            pluginWarnings.push(`Plugin not found: ${pluginName} (skipped)`);
            continue;
          }
          const skills = extractPluginSkills(manifest, pluginName);
          pluginSkills.push(...skills);
        }

        // Merge explicit skills with plugin skills
        const explicitSkillNames = (args.skills as string[] | undefined) ?? [];
        const explicitSkills = explicitSkillNames.map(name => ({
          name,
          description: `Skill: ${name}`,
          trigger: name,
          content: name,
        }));

        const allSkills = [...explicitSkills, ...pluginSkills];

        const rvfBytes = await wasm.buildRvfContainer({
          prompts: (args.prompts as Array<{ name: string; system_prompt: string; version: string }> | undefined) ?? [],
          tools: (args.tools as Array<{ name: string; description: string; parameters: unknown[]; returns: string }> | undefined) ?? [],
          skills: allSkills,
          mcpTools: mcpToolDescriptors,
        });

        const { Buffer } = await import('node:buffer');
        const rvfBase64 = Buffer.from(rvfBytes).toString('base64');

        const manifest = {
          skills: allSkills.map(s => s.name),
          mcpTools: requestedTools,
          prompts: ((args.prompts as unknown[]) ?? []).length,
          tools: ((args.tools as unknown[]) ?? []).length,
          rvfSizeBytes: rvfBytes.length,
          pluginWarnings: pluginWarnings.length > 0 ? pluginWarnings : undefined,
        };

        return { content: [{ type: 'text', text: JSON.stringify({ success: true, rvfBase64, manifest }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },

  // ── ADR-129 P3 / ADR-0266 Phase 3 — Group 3 gallery tools (10) ──────────────
  //
  // Per ADR-0258 §Group 3: plain `await loadAgentWasm()` + direct call. NO
  // `ensureLive` (gallery is not per-agent). NO `withStoreLock` (gallery state
  // lives inside the in-process WASM module; cross-process persistence is
  // out-of-scope for ADR-129 per ADR-0258). Pattern matches existing
  // `wasm_gallery_list` (`:520-528`). `wasm_gallery_import` preserves the
  // AIDefence scan gate verbatim from upstream.

  {
    name: 'wasm_gallery_load_rvf',
    description: 'Load a named gallery template as a base64-encoded RVF container. Use when native Read is wrong because RVF containers are packed inside the WASM gallery store and are not accessible as plain filesystem files.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Gallery template ID' } },
      required: ['id'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.id, 'id'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const wasm = await loadAgentWasm();
        const bytes = await wasm.galleryLoadRvf(args.id as string);
        const { Buffer } = await import('node:buffer');
        return { content: [{ type: 'text', text: JSON.stringify({ id: args.id, rvfBase64: Buffer.from(bytes).toString('base64'), sizeBytes: bytes.length }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_configure',
    description: 'Apply runtime configuration overrides (e.g. maxTurns, model) to the active WASM gallery template. Use when native Edit is wrong because gallery configuration lives inside the WASM runtime state and cannot be changed via filesystem writes.',
    inputSchema: {
      type: 'object' as const,
      properties: { config: { type: 'object', description: 'Configuration overrides (e.g. {maxTurns: 100})' } },
      required: ['config'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await loadAgentWasm();
        await wasm.galleryConfigure(JSON.stringify(args.config));
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_categories',
    description: 'Return all WASM gallery template categories with per-category template counts. Use when native Bash/ls is wrong because gallery category metadata is indexed inside the WASM runtime, not on the filesystem.',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => {
      try {
        const wasm = await loadAgentWasm();
        const categories = await wasm.getGalleryCategories();
        return { content: [{ type: 'text', text: JSON.stringify({ categories }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_list_by_category',
    description: 'List WASM gallery templates filtered to a specific category. Use when native Glob is wrong because gallery templates are stored in the WASM runtime registry, not as individual filesystem files.',
    inputSchema: {
      type: 'object' as const,
      properties: { category: { type: 'string', description: 'Category name' } },
      required: ['category'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.category, 'category'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const wasm = await loadAgentWasm();
        const templates = await wasm.galleryListByCategory(args.category as string);
        return { content: [{ type: 'text', text: JSON.stringify({ category: args.category, templates }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_add_custom',
    description: 'Add a custom agent template to the WASM gallery registry. Use when native Write is wrong because custom templates must be registered inside the WASM runtime store, not written as plain files.',
    inputSchema: {
      type: 'object' as const,
      properties: { template: { type: 'object', description: 'Template object to add' } },
      required: ['template'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const wasm = await loadAgentWasm();
        await wasm.galleryAddCustom(JSON.stringify(args.template));
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_remove_custom',
    description: 'Remove a custom template from the WASM gallery by ID. Use when native Bash rm is wrong because custom templates exist only inside the WASM runtime registry and cannot be deleted via filesystem operations.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Custom template ID to remove' } },
      required: ['id'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.id, 'id'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const wasm = await loadAgentWasm();
        await wasm.galleryRemoveCustom(args.id as string);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, id: args.id }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_import',
    description: [
      'HIGH RISK: Import custom templates from JSON into the gallery.',
      'The payload is deserialized inside the WASM runtime — a malicious system_prompt',
      'in an imported template can direct agents toward harmful behavior.',
      'Input is scanned by AIDefence when available.',
      'Requires explicit confirmation of the source before use.',
    ].join(' '),
    inputSchema: {
      type: 'object' as const,
      properties: {
        templatesJson: { type: 'string', description: 'JSON string of template array to import' },
      },
      required: ['templatesJson'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateText(args.templatesJson, 'templatesJson'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        // ADR-129 P3 AIDefence gate — scan for prompt injection before WASM deserialization.
        // ADR-118 pattern: lazy import @claude-flow/aidefence; warn and continue if unavailable.
        let aiDefenceWarning: string | undefined;
        try {
          const aidefenceMod = await import('@claude-flow/aidefence');
          const defence = aidefenceMod.createAIDefence({ enableLearning: false });
          if (defence) {
            // Fork's AIDefence exposes `detect()` returning `{safe, threats, ...}`;
            // upstream's older `scan()`-returning-`{isThreat}` API does not exist
            // here. The semantic mapping is `isThreat === !safe`.
            const detectResult = await defence.detect(args.templatesJson as string);
            if (detectResult && detectResult.safe === false) {
              return {
                content: [{ type: 'text', text: JSON.stringify({
                  error: 'AIDefence blocked import: potential prompt injection detected in template payload',
                  HIGH_RISK: true,
                  threats: detectResult.threats,
                }) }],
                isError: true,
              };
            }
          }
        } catch {
          aiDefenceWarning = 'AIDefence not available — import proceeded without prompt-injection scan';
          console.warn(`[wasm_gallery_import] HIGH_RISK: ${aiDefenceWarning}`);
        }

        const wasm = await loadAgentWasm();
        const count = await wasm.galleryImportCustom(args.templatesJson as string);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, importedCount: count, warning: aiDefenceWarning }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_export',
    description: 'Export all custom WASM gallery templates as a JSON snapshot. Use when native Read/cat is wrong because custom templates live inside the WASM runtime store and are not persisted as individual files on disk.',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => {
      try {
        const wasm = await loadAgentWasm();
        const exported = await wasm.galleryExportCustom();
        return { content: [{ type: 'text', text: JSON.stringify({ exported }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_active',
    description: 'Return the ID of the currently active WASM gallery template. Use when native Bash is wrong because the active-template cursor is tracked inside the WASM runtime state, not in a file you can read directly.',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => {
      try {
        const wasm = await loadAgentWasm();
        const activeId = await wasm.galleryGetActive();
        return { content: [{ type: 'text', text: JSON.stringify({ activeId: activeId ?? null }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'wasm_gallery_config',
    description: 'Get the runtime configuration overrides applied to the active WASM gallery template. Use when native Read is wrong because gallery config overrides are stored in the WASM runtime state rather than as an editable config file.',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => {
      try {
        const wasm = await loadAgentWasm();
        const config = await wasm.galleryGetConfig();
        return { content: [{ type: 'text', text: JSON.stringify({ config }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
];

// Re-export persistence helpers for test harnesses (keeps surface minimal).
export const _wasmPersistence = {
  getStorePath,
  loadStore,
  saveStore,
  withStoreLock,
  mutateStore,
  snapshotAgent,
  ensureLive,
};
