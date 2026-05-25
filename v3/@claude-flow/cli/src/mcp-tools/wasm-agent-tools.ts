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

async function loadAgentWasm() {
  const mod = await import('../ruvector/agent-wasm.js');
  return mod;
}

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
  const candidateDirs = [
    resolve(process.cwd(), 'plugins', pluginName, '.claude-plugin', 'plugin.json'),
    resolve(process.cwd(), 'plugins', `ruflo-${pluginName}`, '.claude-plugin', 'plugin.json'),
    resolve(process.cwd(), 'v3', 'plugins', pluginName, '.claude-plugin', 'plugin.json'),
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

// Suppress unused-symbol diagnostics — these helpers are exported by file scope
// for Phase 2 to consume; intentional dead-code seam per ADR-0256 Option A.
void loadPluginManifest;
void extractPluginSkills;

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
