/**
 * Agent MCP Tools for CLI
 *
 * Tool definitions for agent lifecycle management with file persistence.
 * Includes model routing integration for intelligent model selection.
 *
 * ADR-0181 Phase 5 (F4-3) — the four mutating agent_* tools (spawn, terminate,
 * pool, update) dispatch their FS-JSON mutation through the per-process Memory
 * Archivist (`getProcessArchivist().dispatch(...)`). The legacy unlocked
 * `loadAgentStore` / `saveAgentStore` pair stays below for envelope construction
 * (post-dispatch read-back), but is no longer the write path — the archivist's
 * substrate seam owns durability + isolation via the `agent_spawn` FS-JSON
 * store's O_EXCL lock. No `ensureRvfWired()` / `ensureSqliteWired()` calls —
 * agent_* routes to FS-JSON only.
 *
 * `agent_execute` is NOT flipped here. Its persistence runs inside
 * `executeAgentTask` (agent-execute-core.ts), which is shared with the
 * workflow runtime (G3) and does three writes: status='busy' pre-LLM,
 * status='idle'+lastResult post-LLM (success or error). Re-routing those
 * through the archivist requires either (a) refactoring agent-execute-core
 * to dispatch its own writes (out of W-agent scope; affects workflow
 * runtime), or (b) duplicating the writes here (double-write, ADR-0082
 * violation). Carried forward pending team-lead ruling.
 *
 * `agent_list` / `agent_status` / `agent_health` have no archivist counterpart
 * (no `handlers/agents/list.ts` etc.; not in `ToolPayloadMap`) and remain pure
 * cli reads of `.claude-flow/agents/store.json`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, findProjectRoot } from './types.js';
import { validateIdentifier, validateText, validateAgentSpawn } from './validate-input.js';
import { executeAgentTask } from './agent-execute-core.js';
import { getProcessArchivist } from '../memory/archivist-init.js';
import type { ToolPayloadMap } from 'agentdb/archivist';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const AGENT_DIR = 'agents';
const AGENT_FILE = 'store.json';

// Model types matching Claude Agent SDK
type ClaudeModel = 'haiku' | 'sonnet' | 'opus' | 'inherit';

interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  domain?: string;
  model?: ClaudeModel;  // Model assigned to this agent
  modelRoutedBy?: 'explicit' | 'router' | 'agent-booster' | 'default';  // How model was determined (ADR-026)
  lastResult?: Record<string, unknown>;  // Output from last completed task
}

interface AgentStore {
  agents: Record<string, AgentRecord>;
  version: string;
}

function getAgentDir(): string {
  return join(findProjectRoot(), STORAGE_DIR, AGENT_DIR);
}

function getAgentPath(): string {
  return join(getAgentDir(), AGENT_FILE);
}

function ensureAgentDir(): void {
  const dir = getAgentDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadAgentStore(): AgentStore {
  try {
    const path = getAgentPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return empty store on error
  }
  return { agents: {}, version: '3.0.0' };
}

function saveAgentStore(store: AgentStore): void {
  ensureAgentDir();
  writeFileSync(getAgentPath(), JSON.stringify(store, null, 2), 'utf-8');
}

// Phase 5: the archivist owns the write path. `saveAgentStore` is preserved
// only for any non-flipped legacy reader; it is intentionally unreferenced by
// the post-Phase-5 handler bodies below. `ensureAgentDir` likewise stays
// callable but unused — the archivist's substrate factory creates the parent
// directory itself.
void saveAgentStore;
void ensureAgentDir;

// Default model mappings for agent types (can be overridden)
const AGENT_TYPE_MODEL_DEFAULTS: Record<string, ClaudeModel> = {
  // Complex agents → opus
  'architect': 'opus',
  'security-architect': 'opus',
  'system-architect': 'opus',
  'core-architect': 'opus',
  // Medium complexity → sonnet
  'coder': 'sonnet',
  'reviewer': 'sonnet',
  'researcher': 'sonnet',
  'tester': 'sonnet',
  'analyst': 'sonnet',
  // Simple/fast agents → haiku
  'formatter': 'haiku',
  'linter': 'haiku',
  'documenter': 'haiku',
};

// Lazy-loaded model router
let modelRouterInstance: Awaited<ReturnType<typeof import('../ruvector/model-router.js').getModelRouter>> | null = null;

async function getModelRouter() {
  if (!modelRouterInstance) {
    try {
      const { getModelRouter } = await import('../ruvector/model-router.js');
      modelRouterInstance = getModelRouter();
    } catch (e) {
      // Log but don't fail - model router is optional
      console.error('[agent-tools] Model router load failed:', (e as Error).message);
    }
  }
  return modelRouterInstance;
}

/**
 * Determine model for agent based on (ADR-026 3-tier routing):
 * 1. Explicit model in config
 * 2. Enhanced task-based routing with Agent Booster AST (if task provided)
 * 3. Agent type defaults
 * 4. Fallback to sonnet
 */
async function determineAgentModel(
  agentType: string,
  config: Record<string, unknown>,
  task?: string
): Promise<{
  model: ClaudeModel;
  routedBy: 'explicit' | 'router' | 'agent-booster' | 'default';
  canSkipLLM?: boolean;
  agentBoosterIntent?: string;
  tier?: 1 | 2 | 3;
}> {
  // 1. Explicit model in config
  if (config.model && ['haiku', 'sonnet', 'opus', 'inherit'].includes(config.model as string)) {
    return { model: config.model as ClaudeModel, routedBy: 'explicit' };
  }

  // 2. Enhanced task-based routing with Agent Booster AST
  if (task) {
    try {
      // Try enhanced router first (includes Agent Booster detection)
      const { getEnhancedModelRouter } = await import('../ruvector/enhanced-model-router.js');
      const enhancedRouter = getEnhancedModelRouter();
      const routeResult = await enhancedRouter.route(task, { filePath: config.filePath as string });

      if (routeResult.tier === 1 && routeResult.canSkipLLM) {
        // Agent Booster can handle this task
        return {
          model: 'haiku', // Use haiku as fallback if AB fails
          routedBy: 'agent-booster',
          canSkipLLM: true,
          agentBoosterIntent: routeResult.agentBoosterIntent?.type,
          tier: 1,
        };
      }

      return {
        model: routeResult.model!,
        routedBy: 'router',
        tier: routeResult.tier,
      };
    } catch {
      // Enhanced router not available, try basic router
      const router = await getModelRouter();
      if (router) {
        try {
          const result = await router.route(task);
          return { model: result.model, routedBy: 'router' };
        } catch {
          // Fall through to defaults on router error
        }
      }
    }
  }

  // 3. Agent type defaults
  const defaultModel = AGENT_TYPE_MODEL_DEFAULTS[agentType];
  if (defaultModel) {
    return { model: defaultModel, routedBy: 'default' };
  }

  // 4. Fallback to sonnet (balanced)
  return { model: 'sonnet', routedBy: 'default' };
}

export const agentTools: MCPTool[] = [
  {
    name: 'agent_spawn',
    description: 'Spawn a Ruflo-tracked agent with cost attribution + memory persistence + swarm coordination. Use when native Task tool is wrong because you need (a) cost tracking per agent in the cost-tracking namespace, (b) cross-session learning via the patterns namespace, or (c) coordination with other agents in a swarm topology (hierarchical / mesh / consensus). For one-shot subtasks with no learning loop, native Task is fine. Pair with hooks_route to pick the right model first.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: { type: 'string', description: 'Type of agent to spawn' },
        agentId: { type: 'string', description: 'Optional custom agent ID' },
        // #2085 — accept swarmId so spawned agents register in the
        // swarm.agents array that swarm_status reports. Omit to register
        // with the most-recently-created swarm.
        swarmId: { type: 'string', description: 'Optional swarm to register the agent with (defaults to most-recent swarm)' },
        config: { type: 'object', description: 'Agent configuration' },
        domain: { type: 'string', description: 'Agent domain' },
        model: {
          type: 'string',
          enum: ['haiku', 'sonnet', 'opus', 'inherit'],
          description: 'Claude model to use (haiku=fast/cheap, sonnet=balanced, opus=most capable)'
        },
        task: { type: 'string', description: 'Task description for intelligent model routing' },
      },
      required: ['agentType'],
    },
    handler: async (input) => {
      // Input validation (ADR-0094 P11/P12): typeof guard + named error + structural hint
      if (input.agentType === undefined || input.agentType === null) {
        return { success: false, error: "'agentType' is required and must be a non-empty string" };
      }
      if (typeof input.agentType !== 'string') {
        return { success: false, error: "'agentType' must be a string (got " + (Array.isArray(input.agentType) ? 'array' : typeof input.agentType) + "); expected a non-empty string type name" };
      }
      if (input.agentType.length === 0) {
        return { success: false, error: "'agentType' is required and must be a non-empty string" };
      }
      if (input.agentType.length > 128) {
        return { success: false, error: "'agentType' must be no more than 128 characters (invalid length: " + input.agentType.length + ")" };
      }

      const agentId = (input.agentId as string) || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const agentType = input.agentType as string;
      const config = (input.config as Record<string, unknown>) || {};

      // Add explicit model to config if provided
      if (input.model) {
        config.model = input.model;
      }

      // Get task from either top-level or config (CLI passes it in config.task)
      const task = (input.task as string) || (config.task as string) || undefined;

      // Determine model using ADR-026 3-tier routing logic (pure compute, not
      // substrate state — handlers/agents/spawn.ts header §"ADR-026 3-tier
      // model routing" says routing stays in cli pre-dispatch).
      const routingResult = await determineAgentModel(
        agentType,
        config,
        task
      );

      const agent: AgentRecord = {
        agentId,
        agentType,
        status: 'idle',
        health: 1.0,
        taskCount: 0,
        config,
        createdAt: new Date().toISOString(),
        domain: input.domain as string,
        model: routingResult.model,
        modelRoutedBy: routingResult.routedBy,
      };

      const spawnPayload = { agent } satisfies ToolPayloadMap['agent_spawn'];
      await (await getProcessArchivist()).dispatch('agent_spawn', spawnPayload);

      // #2085 — also push to the swarm store's agents array so that
      // swarm_status reports the new agent. Without this, agent_spawn
      // and swarm_status read/write separate stores and agents added
      // post-init never show up in swarm_status.agents — confirmed for
      // all topologies (hierarchical, mesh, etc.). The archivist.dispatch
      // above writes the agent store via the audit-traced envelope; this
      // best-effort swarm-store push is the additional bridging.
      try {
        const { loadSwarmStore: _loadSwarmStore, saveSwarmStore: _saveSwarmStore } =
          await import('./swarm-tools.js');
        const swarmStore = _loadSwarmStore();
        let targetSwarmId = (input.swarmId as string) || '';
        if (!targetSwarmId) {
          // Default to the most-recently-created swarm.
          const all = Object.values(swarmStore.swarms);
          const latest = all.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          )[0];
          targetSwarmId = latest?.swarmId || '';
        }
        if (targetSwarmId && swarmStore.swarms[targetSwarmId]) {
          const swarm = swarmStore.swarms[targetSwarmId];
          if (!Array.isArray(swarm.agents)) swarm.agents = [];
          // Idempotent — don't duplicate if agent_spawn is retried.
          if (!swarm.agents.includes(agentId)) {
            swarm.agents.push(agentId);
            _saveSwarmStore(swarmStore);
          }
        }
      } catch { /* swarm store unavailable — agent still registered globally */ }

      // Include Agent Booster routing info if applicable
      const response: Record<string, unknown> = {
        success: true,
        agentId,
        agentType: agent.agentType,
        model: agent.model,
        modelRoutedBy: routingResult.routedBy,
        status: 'spawned',
        createdAt: agent.createdAt,
        note: 'Agent registered for coordination. Three execution paths: ' +
          '(1) call agent_execute(agentId, prompt) — direct LLM call via Anthropic Messages API (requires ANTHROPIC_API_KEY); ' +
          '(2) Claude Code Task tool — spawns a real subagent; ' +
          '(3) claude -p — headless background instance.',
      };

      // Add Agent Booster info if task can skip LLM
      if (routingResult.canSkipLLM) {
        response.canSkipLLM = true;
        response.agentBoosterIntent = routingResult.agentBoosterIntent;
        response.tier = routingResult.tier;
        response.note = `Agent Booster can handle "${routingResult.agentBoosterIntent}" - use agent_booster_edit_file MCP tool`;
      } else if (routingResult.tier) {
        response.tier = routingResult.tier;
      }

      return response;
    },
  },
  {
    // ADR-095 G1: real LLM execution via the agent registry. Previously
    // agent_spawn registered metadata but nothing dispatched work to a
    // provider — the wire between AnthropicProvider and the agent
    // registry was missing, as the April audit (@roman-rr) called out.
    // agent_execute closes that wire by reading the agent's configured
    // model, calling the Anthropic Messages API directly via fetch, and
    // updating the agent record with lastResult / taskCount / status.
    // No mock — actual HTTP request to api.anthropic.com.
    name: 'agent_execute',
    description: 'Execute a task on a spawned agent — calls the Anthropic Messages API with the agent\'s configured model. Requires ANTHROPIC_API_KEY in env.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of the spawned agent' },
        prompt: { type: 'string', description: 'Task / prompt for the agent to execute' },
        systemPrompt: { type: 'string', description: 'Optional system prompt (overrides agent default)' },
        maxTokens: { type: 'number', description: 'Max output tokens (default 1024)' },
        temperature: { type: 'number', description: 'Sampling temperature 0..1 (default 0.7)' },
      },
      required: ['agentId', 'prompt'],
    },
    handler: async (input) => {
      const vId = validateIdentifier(input.agentId, 'agentId');
      if (!vId.valid) return { success: false, error: `Input validation failed: ${vId.error}` };
      const vP = validateText(input.prompt as string, 'prompt');
      if (!vP.valid) return { success: false, error: `Input validation failed: ${vP.error}` };

      // Delegate to the shared core (also used by the workflow runtime).
      return executeAgentTask({
        agentId: input.agentId as string,
        prompt: input.prompt as string,
        systemPrompt: input.systemPrompt as string | undefined,
        maxTokens: input.maxTokens as number | undefined,
        temperature: input.temperature as number | undefined,
        timeoutMs: input.timeoutMs as number | undefined,
      });
    },
  },
  {
    name: 'agent_terminate',
    description: 'Terminate an agent',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of agent to terminate' },
        force: { type: 'boolean', description: 'Force immediate termination' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;

      // Pre-check existence so the cli envelope can return the legacy
      // `{success: false, error: 'Agent not found'}` shape rather than
      // letting the handler throw (handlers/agents/terminate.ts:55-57).
      // The task_assign callsite uses this same shape (task-tools.ts:387-390).
      const pre = loadAgentStore();
      if (!pre.agents[agentId]) {
        return {
          success: false,
          agentId,
          error: 'Agent not found',
        };
      }

      const terminatePayload = {
        agentId,
        force: input.force as boolean | undefined,
      } satisfies ToolPayloadMap['agent_terminate'];
      await (await getProcessArchivist()).dispatch('agent_terminate', terminatePayload);

      return {
        success: true,
        agentId,
        terminated: true,
        terminatedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'agent_status',
    description: 'Get agent status',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of agent' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const store = loadAgentStore();
      const agentId = input.agentId as string;
      const agent = store.agents[agentId];

      if (agent) {
        return {
          agentId: agent.agentId,
          agentType: agent.agentType,
          status: agent.status,
          health: agent.health,
          taskCount: agent.taskCount,
          createdAt: agent.createdAt,
          domain: agent.domain,
          lastResult: agent.lastResult || null,
        };
      }

      return {
        agentId,
        status: 'not_found',
        error: 'Agent not found',
      };
    },
  },
  {
    name: 'agent_list',
    description: 'List all agents',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status' },
        domain: { type: 'string', description: 'Filter by domain' },
        includeTerminated: { type: 'boolean', description: 'Include terminated agents' },
      },
    },
    handler: async (input) => {
      const store = loadAgentStore();
      let agents = Object.values(store.agents);

      // Filter by status
      if (input.status) {
        agents = agents.filter(a => a.status === input.status);
      } else if (!input.includeTerminated) {
        agents = agents.filter(a => a.status !== 'terminated');
      }

      // Filter by domain
      if (input.domain) {
        agents = agents.filter(a => a.domain === input.domain);
      }

      return {
        agents: agents.map(a => ({
          agentId: a.agentId,
          agentType: a.agentType,
          status: a.status,
          health: a.health,
          taskCount: a.taskCount,
          createdAt: a.createdAt,
          domain: a.domain,
        })),
        total: agents.length,
        filters: {
          status: input.status,
          domain: input.domain,
          includeTerminated: input.includeTerminated,
        },
      };
    },
  },
  {
    name: 'agent_pool',
    description: 'Manage agent pool',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'scale', 'drain', 'fill'], description: 'Pool action' },
        targetSize: { type: 'number', description: 'Target pool size (for scale action)' },
        agentType: { type: 'string', description: 'Agent type filter' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const action = (input.action as string) || 'status';  // Default to status

      if (action === 'status') {
        // Read-only — handler explicitly throws on 'status' action
        // (handlers/agents/pool.ts:132-135). Routing through dispatchRead is
        // the right shape but no read handler is registered yet; stay
        // cli-authoritative until the read handler lands.
        const store = loadAgentStore();
        const agents = Object.values(store.agents).filter(a => a.status !== 'terminated');
        const byType: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        for (const agent of agents) {
          byType[agent.agentType] = (byType[agent.agentType] || 0) + 1;
          byStatus[agent.status] = (byStatus[agent.status] || 0) + 1;
        }
        const busyAgents = agents.filter(a => a.status === 'busy').length;
        const utilization = agents.length > 0 ? busyAgents / agents.length : 0;
        return {
          action,
          // CLI expected fields
          poolId: 'agent-pool-default',
          currentSize: agents.length,
          minSize: (input.min as number) || 0,
          maxSize: (input.max as number) || 100,
          autoScale: (input.autoScale as boolean) ?? false,
          utilization,
          agents: agents.map(a => ({
            id: a.agentId,
            type: a.agentType,
            status: a.status,
          })),
          // Additional fields
          id: 'agent-pool-default',
          size: agents.length,
          totalAgents: agents.length,
          byType,
          byStatus,
          avgHealth: agents.length > 0 ? agents.reduce((sum, a) => sum + a.health, 0) / agents.length : 0,
        };
      }

      if (action === 'scale') {
        const targetSize = (input.targetSize as number) || 5;
        const agentType = (input.agentType as string) || 'worker';

        // Pre-snapshot drives the cli envelope's `previousSize` + the
        // `added` / `removed` diff. The handler mints its own agent IDs
        // inside withWrite (handlers/agents/pool.ts:62-65) so cli cannot
        // predict them — diff is the only way to recover them.
        const pre = loadAgentStore();
        const preIds = new Set(
          Object.values(pre.agents)
            .filter(a => a.status !== 'terminated' && a.agentType === agentType)
            .map(a => a.agentId),
        );
        const preActiveOfType = preIds.size;

        const scalePayload = {
          action: 'scale' as const,
          targetSize,
          agentType,
        } satisfies ToolPayloadMap['agent_pool'];
        await (await getProcessArchivist()).dispatch('agent_pool', scalePayload);

        const post = loadAgentStore();
        const postActiveIds = new Set(
          Object.values(post.agents)
            .filter(a => a.status !== 'terminated' && a.agentType === agentType)
            .map(a => a.agentId),
        );
        const added: string[] = [];
        for (const id of postActiveIds) if (!preIds.has(id)) added.push(id);
        const removed: string[] = [];
        for (const id of preIds) if (!postActiveIds.has(id)) removed.push(id);

        return {
          action,
          agentType,
          previousSize: preActiveOfType,
          targetSize,
          newSize: postActiveIds.size,
          added,
          removed,
        };
      }

      if (action === 'drain') {
        const agentType = input.agentType as string | undefined;

        const pre = loadAgentStore();
        const preActive = Object.values(pre.agents).filter(a => a.status !== 'terminated');

        const drainPayload = {
          action: 'drain' as const,
          agentType,
        } satisfies ToolPayloadMap['agent_pool'];
        await (await getProcessArchivist()).dispatch('agent_pool', drainPayload);

        const post = loadAgentStore();
        const postActive = Object.values(post.agents).filter(a => a.status !== 'terminated');
        const drained = preActive.length - postActive.length;

        return {
          action,
          agentType: agentType || 'all',
          drained,
          remaining: postActive.length,
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    name: 'agent_health',
    description: 'Check agent health',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Specific agent ID (optional)' },
        threshold: { type: 'number', description: 'Health threshold (0-1)' },
      },
    },
    handler: async (input) => {
      const store = loadAgentStore();
      const agents = Object.values(store.agents).filter(a => a.status !== 'terminated');
      const threshold = (input.threshold as number) || 0.5;

      if (input.agentId) {
        const agent = store.agents[input.agentId as string];
        if (agent) {
          return {
            agentId: agent.agentId,
            health: agent.health,
            status: agent.status,
            healthy: agent.health >= threshold,
            taskCount: agent.taskCount,
            uptime: Date.now() - new Date(agent.createdAt).getTime(),
          };
        }
        return { agentId: input.agentId, error: 'Agent not found' };
      }

      const healthyAgents = agents.filter(a => a.health >= threshold);
      const degradedAgents = agents.filter(a => a.health >= 0.3 && a.health < threshold);
      const unhealthyAgents = agents.filter(a => a.health < 0.3);
      const avgHealth = agents.length > 0 ? agents.reduce((sum, a) => sum + a.health, 0) / agents.length : 1;

      return {
        // CLI expected fields
        agents: agents.map(a => {
          const uptime = Date.now() - new Date(a.createdAt).getTime();
          return {
            id: a.agentId,
            type: a.agentType,
            health: a.health >= threshold ? 'healthy' : (a.health >= 0.3 ? 'degraded' : 'unhealthy'),
            uptime,
            tasks: { active: a.taskCount > 0 ? 1 : 0, queued: 0, completed: a.taskCount, failed: 0 },
            _note: 'Per-agent OS metrics not available — use system_metrics for real CPU/memory',
          };
        }),
        overall: {
          healthy: healthyAgents.length,
          degraded: degradedAgents.length,
          unhealthy: unhealthyAgents.length,
          cpu: null,
          memory: null,
          _note: 'Per-agent CPU/memory not available — use system_metrics for real OS-level stats',
          score: Math.round(avgHealth * 100),
          issues: unhealthyAgents.length,
        },
        // Additional fields
        total: agents.length,
        healthyCount: healthyAgents.length,
        unhealthyCount: unhealthyAgents.length,
        threshold,
        avgHealth,
        unhealthyAgents: unhealthyAgents.map(a => ({
          agentId: a.agentId,
          health: a.health,
          status: a.status,
        })),
      };
    },
  },
  {
    name: 'agent_update',
    description: 'Update agent status or config',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of agent' },
        status: { type: 'string', description: 'New status' },
        health: { type: 'number', description: 'Health value (0-1)' },
        taskCount: { type: 'number', description: 'Task count' },
        config: { type: 'object', description: 'Config updates' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;

      // Pre-check existence so the cli envelope returns
      // `{success: false, error: 'Agent not found'}` instead of letting
      // the handler throw (handlers/agents/update.ts:59-61).
      const pre = loadAgentStore();
      if (!pre.agents[agentId]) {
        return {
          success: false,
          agentId,
          error: 'Agent not found',
        };
      }

      const updatePayload = {
        agentId,
        status: input.status as AgentRecord['status'] | undefined,
        health: typeof input.health === 'number' ? (input.health as number) : undefined,
        taskCount: typeof input.taskCount === 'number' ? (input.taskCount as number) : undefined,
        config: input.config as Record<string, unknown> | undefined,
      } satisfies ToolPayloadMap['agent_update'];
      await (await getProcessArchivist()).dispatch('agent_update', updatePayload);

      const post = loadAgentStore();
      const agent = post.agents[agentId];

      return {
        success: true,
        agentId,
        updated: true,
        agent: {
          agentId: agent.agentId,
          status: agent.status,
          health: agent.health,
          taskCount: agent.taskCount,
        },
      };
    },
  },
];
