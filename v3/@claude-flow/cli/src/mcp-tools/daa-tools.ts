/**
 * DAA (Decentralized Autonomous Agents) MCP Tools for CLI
 *
 * V2 Compatibility - DAA agent management tools
 *
 * ⚠️ IMPORTANT: These tools provide LOCAL STATE MANAGEMENT.
 * - Agent coordination is tracked locally
 * - No distributed network communication
 * - Useful for workflow orchestration and state tracking
 *
 * ADR-0181 Phase 5 (F4-3 cli delegation): all 6 mutating daa_* tools
 * (daa_agent_create, daa_agent_adapt, daa_workflow_create, daa_workflow_execute,
 * daa_cognitive_pattern action='change', daa_knowledge_share) dispatch through
 * `archivist.dispatch()` for the authoritative JSON-store mutation, then
 * re-read the daa store to compose the cli response envelope (the handlers
 * return Promise<void>; the response is reconstructed from the persisted
 * record per the team-lead consolidated ruling).
 *
 * Read-only tools (daa_learning_status, daa_performance_metrics) and the
 * read paths of daa_cognitive_pattern (action='analyze', no-agentId catalogue)
 * keep their direct FS-JSON reads — the archivist has no read handler for the
 * daa family yet (out of Phase 5 scope per the recon's per-MCP-tools-file
 * delegation granularity).
 */

import { type MCPTool, findProjectRoot } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getProcessArchivist } from '../memory/archivist-init.js';
import type { ToolPayloadMap } from 'agentdb/archivist';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const DAA_DIR = 'daa';
const DAA_FILE = 'store.json';

interface DAAAgent {
  id: string;
  name: string;
  type: string;
  status: 'active' | 'idle' | 'learning' | 'terminated';
  cognitivePattern: string;
  learningRate: number;
  memory: boolean;
  capabilities: string[];
  metrics: {
    tasksCompleted: number;
    successRate: number;
    adaptations: number;
  };
  createdAt: string;
  lastActivity: string;
}

interface DAAWorkflow {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  steps: Array<{ name: string; status: string; output?: string }>;
  strategy: string;
  createdAt: string;
}

interface DAAStore {
  agents: Record<string, DAAAgent>;
  workflows: Record<string, DAAWorkflow>;
  knowledge: Record<string, { domain: string; content: unknown; sharedBy: string; timestamp: string }>;
  version: string;
}

function getDAADir(): string {
  return join(findProjectRoot(), STORAGE_DIR, DAA_DIR);
}

function getDAAPath(): string {
  return join(getDAADir(), DAA_FILE);
}

function ensureDAADir(): void {
  const dir = getDAADir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadDAAStore(): DAAStore {
  try {
    const path = getDAAPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return empty store
  }
  return { agents: {}, workflows: {}, knowledge: {}, version: '3.0.0' };
}

function saveDAAStore(store: DAAStore): void {
  ensureDAADir();
  // Atomic write: tmp + rename so a crashed writer can't leave truncated JSON.
  const target = getDAAPath();
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, target);
}

/**
 * ADR-0129 (B1) race-fix: cross-process advisory lock for DAA store
 * read-modify-write sequences. Without this, parallel `daa_workflow_create`
 * + `daa_workflow_execute` calls race the load→mutate→save sequence
 * (lost-update class — ADR-0094 P9). atomic rename in saveDAAStore protects
 * per-write but not against concurrent read-modify-write.
 *
 * Pattern: O_EXCL sentinel + stale-lock recovery, matches workflow-tools'
 * withWorkflowLock and rvf-backend's acquireLock (ADR-0095). 5s budget,
 * exponential backoff with jitter, fails loudly on timeout.
 */
function withDAALock<T>(cb: () => T): T {
  ensureDAADir();
  const lockPath = getDAAPath() + '.lock';
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
    } catch (err: unknown) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      const code = (err as { code?: string }).code;
      if (code !== 'EEXIST') throw err;
      // Someone else holds the lock. Detect stale (dead PID) and force.
      let stale = false;
      try {
        const existing = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: number };
        if (typeof existing?.pid === 'number' && existing.pid !== process.pid) {
          try { process.kill(existing.pid, 0); } catch { stale = true; }
        }
      } catch { stale = true; }
      if (stale) {
        try { unlinkSync(lockPath); } catch { /* already gone */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `[daa-tools] store lock contention: could not acquire ${lockPath} within ${budgetMs}ms`
        );
      }
      const jitter = Math.floor(Math.random() * waitMs);
      const sleepMs = Math.min(waitMs + jitter, Math.max(1, deadline - Date.now()));
      const end = Date.now() + sleepMs;
      while (Date.now() < end) { /* busy-wait — sync API */ }
      waitMs = Math.min(waitMs * 2, 400);
    }
  }
}

export const daaTools: MCPTool[] = [
  {
    name: 'daa_agent_create',
    description: 'Create a decentralized autonomous agent',
    category: 'daa',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Agent ID' },
        name: { type: 'string', description: 'Agent name' },
        type: { type: 'string', description: 'Agent type' },
        cognitivePattern: { type: 'string', enum: ['convergent', 'divergent', 'lateral', 'systems', 'critical', 'adaptive'], description: 'Cognitive pattern' },
        learningRate: { type: 'number', description: 'Learning rate (0-1)' },
        enableMemory: { type: 'boolean', description: 'Enable persistent memory' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Agent capabilities' },
      },
      required: ['id'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): dispatch + re-read pattern per team-lead
      // consolidated ruling. The handler at
      // `forks/agentdb/src/archivist/handlers/daa/agent-create.ts` owns the
      // load → mutate → save under substrate.withWrite (which subsumes the
      // ADR-0129 B1 withDAALock cross-process serialization). After dispatch
      // returns Promise<void>, re-read the store to compose the cli response
      // envelope from the authoritative persisted record.
      const id = input.id as string;
      const cognitivePattern = ((input.cognitivePattern as string) || 'adaptive') as
        ToolPayloadMap['daa_agent_create']['cognitivePattern'];

      const payload = {
        id,
        name: (input.name as string) || `DAA-${id}`,
        type: (input.type as string) || 'autonomous',
        cognitivePattern,
        learningRate: (input.learningRate as number) || 0.01,
        enableMemory: (input.enableMemory as boolean) ?? true,
        capabilities: (input.capabilities as string[]) || ['reasoning', 'learning'],
      } satisfies ToolPayloadMap['daa_agent_create'];

      await (await getProcessArchivist()).dispatch('daa_agent_create', payload);

      const postStore = loadDAAStore();
      const postAgent = postStore.agents[id];
      if (!postAgent) {
        throw new Error(
          `daa_agent_create: agent '${id}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      return {
        success: true,
        agent: {
          id: postAgent.id,
          name: postAgent.name,
          type: postAgent.type,
          status: postAgent.status,
          cognitivePattern: postAgent.cognitivePattern,
          capabilities: postAgent.capabilities,
        },
        createdAt: postAgent.createdAt,
      };
    },
  },
  {
    name: 'daa_agent_adapt',
    description: 'Trigger agent adaptation based on feedback',
    category: 'daa',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID' },
        feedback: { type: 'string', description: 'Feedback message' },
        performanceScore: { type: 'number', description: 'Performance score (0-1)' },
        suggestions: { type: 'array', items: { type: 'string' }, description: 'Improvement suggestions' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler
      // at `.../archivist/handlers/daa/agent-adapt.ts` owns the
      // load → mutate (adaptations++, successRate avg, lastActivity, status)
      // → save under substrate.withWrite. Pre-read to detect missing-agent so
      // the cli return shape preserves the `{success:false, error}` contract
      // (the handler throws on missing — we'd lose that shape if we let it
      // propagate, and it currently isn't recoverable from the Error message
      // alone). Post-dispatch we re-read to get the authoritative
      // adaptations + successRate for the response + AgentDB tail-call key.
      const agentId = input.agentId as string;
      const performanceScore = (input.performanceScore as number) || 0.8;

      const preStore = loadDAAStore();
      if (!preStore.agents[agentId]) {
        return { success: false, error: 'Agent not found' };
      }

      const payload = {
        agentId,
        feedback: input.feedback as string | undefined,
        performanceScore,
        suggestions: input.suggestions as ReadonlyArray<string> | undefined,
      } satisfies ToolPayloadMap['daa_agent_adapt'];

      await (await getProcessArchivist()).dispatch('daa_agent_adapt', payload);

      const postStore = loadDAAStore();
      const postAgent = postStore.agents[agentId];
      // Defensive read-back — the agent we just dispatched against must still
      // exist post-write; if it doesn't, that's a concurrent delete we can't
      // recover the metrics for. Fail loud rather than report stale numbers.
      if (!postAgent) {
        throw new Error(
          `daa_agent_adapt: agent '${agentId}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      // PHASE 6+: cross-substrate AgentDB tail-call removed (ADR-0181 Phase 5
      // hotfix, feedback-no-fallbacks). The prior `try { routeMemoryOp(...) }
      // catch { /* AgentDB not available */ }` block silently swallowed every
      // error from a separate-substrate write — exactly the silent-fallback
      // pattern the project rule forbids. The archivist dispatch above is the
      // authoritative write to the daa JSON-store. A future phase that wants
      // a vector-searchable AgentDB index of adaptation events should add it
      // as a registered handler invariant or a substrate-bridge — not a
      // try/catch wrapper at the cli boundary.

      return {
        success: true,
        agentId,
        adaptation: {
          feedback: input.feedback,
          performanceScore,
          adaptations: postAgent.metrics.adaptations,
          newSuccessRate: postAgent.metrics.successRate,
        },
        status: postAgent.status,
      };
    },
  },
  {
    name: 'daa_workflow_create',
    description: 'Create an autonomous workflow',
    category: 'daa',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Workflow ID' },
        name: { type: 'string', description: 'Workflow name' },
        steps: { type: 'array', items: { type: 'object' }, description: 'Workflow steps' },
        strategy: { type: 'string', enum: ['parallel', 'sequential', 'adaptive'], description: 'Execution strategy' },
        dependencies: { type: 'object', description: 'Step dependencies' },
      },
      required: ['id', 'name'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): dispatch + re-read pattern per team-lead
      // consolidated ruling. The handler at
      // `.../archivist/handlers/daa/workflow-create.ts` owns the
      // load → canonicalise steps → mutate → save under substrate.withWrite.
      // Pass the raw `steps` array through — the handler does its own
      // string-or-object canonicalisation. Re-read post-dispatch to compose
      // the response from the authoritative persisted record.
      const id = input.id as string;

      const payload = {
        id,
        name: input.name as string,
        steps: (input.steps as unknown[]) || [],
        strategy: ((input.strategy as string) || 'adaptive') as
          ToolPayloadMap['daa_workflow_create']['strategy'],
      } satisfies ToolPayloadMap['daa_workflow_create'];

      await (await getProcessArchivist()).dispatch('daa_workflow_create', payload);

      const postStore = loadDAAStore();
      const postWorkflow = postStore.workflows[id];
      if (!postWorkflow) {
        throw new Error(
          `daa_workflow_create: workflow '${id}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      return {
        success: true,
        workflowId: postWorkflow.id,
        name: postWorkflow.name,
        steps: postWorkflow.steps.length,
        strategy: postWorkflow.strategy,
        createdAt: postWorkflow.createdAt,
      };
    },
  },
  {
    name: 'daa_workflow_execute',
    description: 'Execute a DAA workflow',
    category: 'daa',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
        agentIds: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to use' },
        parallelExecution: { type: 'boolean', description: 'Enable parallel execution' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler
      // at `.../archivist/handlers/daa/workflow-execute.ts` owns the
      // load → reject if missing → workflow.status = 'running' → save under
      // substrate.withWrite (which subsumes withDAALock; the ADR-0129 B1
      // race the lock exists to serialise — `p3-da-wf-exec` observing the
      // stale pre-image missing a concurrent `daa_workflow_create` — is
      // preserved under the substrate's O_EXCL sentinel).
      //
      // Pre-read to detect missing-workflow so the cli return shape preserves
      // the `{success:false, error}` contract (the handler throws on missing;
      // we'd lose that shape if we propagated it). Post-dispatch we re-read
      // to surface the workflow's `steps` in the return.
      const workflowId = input.workflowId as string;
      const preStore = loadDAAStore();
      if (!preStore.workflows[workflowId]) {
        return { success: false, error: 'Workflow not found' };
      }

      const payload = {
        workflowId,
        agentIds: input.agentIds as ReadonlyArray<string> | undefined,
        parallelExecution: input.parallelExecution as boolean | undefined,
      } satisfies ToolPayloadMap['daa_workflow_execute'];

      await (await getProcessArchivist()).dispatch('daa_workflow_execute', payload);

      const postStore = loadDAAStore();
      const postWorkflow = postStore.workflows[workflowId];
      if (!postWorkflow) {
        throw new Error(
          `daa_workflow_execute: workflow '${workflowId}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      return {
        success: true,
        workflowId,
        status: postWorkflow.status,
        steps: postWorkflow.steps,
        startedAt: new Date().toISOString(),
        _note: 'Steps are tracked but not auto-executed. Use agent tools to execute each step.',
      };
    },
  },
  {
    name: 'daa_knowledge_share',
    description: 'Share knowledge between agents',
    category: 'daa',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Source agent ID' },
        targetAgentIds: { type: 'array', items: { type: 'string' }, description: 'Target agent IDs' },
        knowledgeDomain: { type: 'string', description: 'Knowledge domain' },
        knowledgeContent: { type: 'object', description: 'Knowledge to share' },
      },
      required: ['sourceAgentId', 'targetAgentIds'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): dispatch + re-read pattern per team-lead
      // consolidated ruling. The handler at
      // `.../archivist/handlers/daa/knowledge-share.ts` mints
      // `knowledgeId = ` + "`knowledge-${Date.now()}`" + ` internally` and
      // returns Promise<void>. The cli needs the same id for (a) the AgentDB
      // tail-call `key` (record-correspondence between JSON store + vector
      // store) and (b) the return-shape `knowledgeId` field. We identify the
      // new entry by diffing the JSON-store key-set across the dispatch:
      // pre-snapshot the knowledge keys, dispatch, re-read, take the set
      // difference. With the substrate's withWrite serialising this tool's
      // own writes, the set-difference is deterministic for the dispatch we
      // just issued.
      const sourceId = input.sourceAgentId as string;
      const targetIds = input.targetAgentIds as string[];
      const domain = (input.knowledgeDomain as string) || 'general';
      const knowledgeContent = (input.knowledgeContent as Record<string, unknown> | undefined) || {};

      const preKeys = new Set(Object.keys(loadDAAStore().knowledge));

      const payload = {
        sourceAgentId: sourceId,
        targetAgentIds: targetIds,
        knowledgeDomain: domain,
        knowledgeContent,
      } satisfies ToolPayloadMap['daa_knowledge_share'];

      await (await getProcessArchivist()).dispatch('daa_knowledge_share', payload);

      const postStore = loadDAAStore();
      const newKeys = Object.keys(postStore.knowledge).filter(k => !preKeys.has(k));
      if (newKeys.length !== 1) {
        throw new Error(
          `daa_knowledge_share: expected exactly 1 new knowledge entry after dispatch, found ${newKeys.length} — concurrent mutation suspected`,
        );
      }
      const knowledgeId = newKeys[0];
      const persistedEntry = postStore.knowledge[knowledgeId];

      // AgentDB tail-call: vector-searchable mirror keyed by the handler-minted
      // knowledgeId so the JSON-store record and AgentDB record correlate.
      // The handler's SCOPE NOTE keeps this tail-call at the cli boundary —
      // it writes into a SEPARATE substrate (the AgentDB vector store,
      // registered under its own `memory_store` mutation), kept outside the
      // daa-store withWrite so an AgentDB miss does not roll back the JSON-
      // store mirror that already committed.
      // PHASE 6+: cross-substrate AgentDB tail-call removed (ADR-0181 Phase 5
      // hotfix, feedback-no-fallbacks). Same removal as daa_agent_adapt
      // above — the prior try/catch swallowed every error from the AgentDB
      // vector-store write. The daa JSON-store dispatch above is the
      // authoritative write; a future phase wanting vector-searchable
      // knowledge entries adds it as a registered handler invariant or a
      // substrate-bridge, not a silent cli-side dual-write.

      return {
        success: true,
        knowledgeId,
        sourceAgent: persistedEntry.sharedBy,
        targetAgents: targetIds,
        domain: persistedEntry.domain,
        sharedAt: persistedEntry.timestamp,
      };
    },
  },
  {
    name: 'daa_learning_status',
    description: 'Get learning status for DAA agents',
    category: 'daa',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Specific agent ID' },
        detailed: { type: 'boolean', description: 'Include detailed metrics' },
      },
    },
    handler: async (input) => {
      const store = loadDAAStore();
      const agentId = input.agentId as string;

      if (agentId) {
        const agent = store.agents[agentId];
        if (!agent) {
          return { success: false, error: 'Agent not found' };
        }

        return {
          success: true,
          agent: {
            id: agent.id,
            status: agent.status,
            cognitivePattern: agent.cognitivePattern,
            learningRate: agent.learningRate,
            metrics: agent.metrics,
          },
        };
      }

      const agents = Object.values(store.agents);

      return {
        success: true,
        summary: {
          total: agents.length,
          active: agents.filter(a => a.status === 'active').length,
          learning: agents.filter(a => a.status === 'learning').length,
          avgSuccessRate: agents.length > 0
            ? agents.reduce((sum, a) => sum + a.metrics.successRate, 0) / agents.length
            : 0,
          totalAdaptations: agents.reduce((sum, a) => sum + a.metrics.adaptations, 0),
        },
        agents: agents.map(a => ({
          id: a.id,
          status: a.status,
          successRate: a.metrics.successRate,
          adaptations: a.metrics.adaptations,
        })),
      };
    },
  },
  {
    name: 'daa_cognitive_pattern',
    description: 'Analyze or change cognitive patterns',
    category: 'daa',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID' },
        action: { type: 'string', enum: ['analyze', 'change'], description: 'Action' },
        pattern: { type: 'string', enum: ['convergent', 'divergent', 'lateral', 'systems', 'critical', 'adaptive'], description: 'New pattern' },
      },
    },
    handler: async (input) => {
      const agentId = input.agentId as string;
      const action = (input.action as string) || 'analyze';

      if (agentId) {
        if (action === 'change' && input.pattern) {
          // ADR-0181 Phase 5 (F4-3): dispatch the WRITE path through the
          // archivist. The handler at
          // `.../archivist/handlers/daa/cognitive-pattern.ts` ONLY covers
          // action='change'; the READ paths below (analyze + catalogue) stay
          // at the cli boundary because the archivist has no read handler
          // for the daa family yet (out of Phase 5 scope).
          //
          // Pre-read to (a) detect missing-agent for the `{success:false}`
          // return shape, and (b) capture `previousPattern` — the handler
          // returns Promise<void> and does not surface the prior value.
          const preStore = loadDAAStore();
          const preAgent = preStore.agents[agentId];
          if (!preAgent) {
            return { success: false, error: 'Agent not found' };
          }
          const previousPattern = preAgent.cognitivePattern;
          const newPattern = input.pattern as
            NonNullable<ToolPayloadMap['daa_cognitive_pattern']['pattern']>;

          const payload = {
            agentId,
            action: 'change' as const,
            pattern: newPattern,
          } satisfies ToolPayloadMap['daa_cognitive_pattern'];

          await (await getProcessArchivist()).dispatch('daa_cognitive_pattern', payload);

          return {
            success: true,
            agentId,
            previousPattern,
            newPattern,
            changedAt: new Date().toISOString(),
          };
        }

        // Read-only path (analyze) — load is safe without lock; the worst
        // case is reading a slightly stale pre-image. No write happens.
        // ADR-0181 Phase 5: stays at cli boundary; no archivist read handler
        // for the daa family yet.
        const store = loadDAAStore();
        const agent = store.agents[agentId];
        if (!agent) {
          return { success: false, error: 'Agent not found' };
        }
        return {
          success: true,
          agentId,
          currentPattern: agent.cognitivePattern,
          learningRate: agent.learningRate,
          metrics: agent.metrics,
          _note: 'Pattern analysis requires real cognitive modeling. Current pattern and metrics shown.',
        };
      }

      // Return general pattern info
      const patternDescriptions = {
        convergent: 'Focused, analytical thinking for well-defined problems',
        divergent: 'Creative, exploratory thinking for open-ended problems',
        lateral: 'Indirect, creative approach to problem solving',
        systems: 'Holistic thinking considering interconnections',
        critical: 'Analytical evaluation and logical assessment',
        adaptive: 'Dynamic switching between patterns as needed',
      };

      return {
        success: true,
        patterns: patternDescriptions,
        recommendation: 'Use "adaptive" for general-purpose agents',
      };
    },
  },
  {
    name: 'daa_performance_metrics',
    description: 'Get DAA performance metrics',
    category: 'daa',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['all', 'agents', 'workflows', 'learning'], description: 'Metrics category' },
        timeRange: { type: 'string', description: 'Time range' },
      },
    },
    handler: async (input) => {
      const store = loadDAAStore();
      const category = (input.category as string) || 'all';

      const agents = Object.values(store.agents);
      const workflows = Object.values(store.workflows);

      const metrics = {
        agents: {
          total: agents.length,
          active: agents.filter(a => a.status === 'active').length,
          avgSuccessRate: agents.length > 0
            ? agents.reduce((sum, a) => sum + a.metrics.successRate, 0) / agents.length
            : 0,
          totalTasks: agents.reduce((sum, a) => sum + a.metrics.tasksCompleted, 0),
        },
        workflows: {
          total: workflows.length,
          completed: workflows.filter(w => w.status === 'completed').length,
          running: workflows.filter(w => w.status === 'running').length,
          successRate: workflows.length > 0
            ? workflows.filter(w => w.status === 'completed').length / workflows.length
            : 0,
        },
        learning: {
          totalAdaptations: agents.reduce((sum, a) => sum + a.metrics.adaptations, 0),
          knowledgeItems: Object.keys(store.knowledge).length,
          avgLearningRate: agents.length > 0
            ? agents.reduce((sum, a) => sum + a.learningRate, 0) / agents.length
            : 0,
        },
      };

      if (category === 'all') {
        return { success: true, metrics };
      }

      return {
        success: true,
        category,
        metrics: metrics[category as keyof typeof metrics],
      };
    },
  },
];
