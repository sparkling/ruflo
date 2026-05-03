/**
 * DAA (Decentralized Autonomous Agents) MCP Tools for CLI
 *
 * V2 Compatibility - DAA agent management tools
 *
 * ⚠️ IMPORTANT: These tools provide LOCAL STATE MANAGEMENT.
 * - Agent coordination is tracked locally
 * - No distributed network communication
 * - Useful for workflow orchestration and state tracking
 */

import { type MCPTool, findProjectRoot } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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
      // ADR-0129 (B1) race-fix: load → mutate → save under withDAALock so
      // parallel `daa_agent_create` invocations don't lost-update each other.
      return withDAALock(() => {
        const store = loadDAAStore();
        const id = input.id as string;

        const agent: DAAAgent = {
          id,
          name: (input.name as string) || `DAA-${id}`,
          type: (input.type as string) || 'autonomous',
          status: 'active',
          cognitivePattern: (input.cognitivePattern as string) || 'adaptive',
          learningRate: (input.learningRate as number) || 0.01,
          memory: (input.enableMemory as boolean) ?? true,
          capabilities: (input.capabilities as string[]) || ['reasoning', 'learning'],
          metrics: {
            tasksCompleted: 0,
            successRate: 1.0,
            adaptations: 0,
          },
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
        };

        store.agents[id] = agent;
        saveDAAStore(store);

        return {
          success: true,
          agent: {
            id: agent.id,
            name: agent.name,
            type: agent.type,
            status: agent.status,
            cognitivePattern: agent.cognitivePattern,
            capabilities: agent.capabilities,
          },
          createdAt: agent.createdAt,
        };
      });
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
      // ADR-0129 (B1) race-fix: load → mutate → save under withDAALock.
      // Returns the post-update agent metrics so the post-lock AgentDB
      // tail-call can read consistent values.
      const lockResult = withDAALock(() => {
        const store = loadDAAStore();
        const agentId = input.agentId as string;
        const agent = store.agents[agentId];

        if (!agent) {
          return { found: false as const, agentId };
        }

        const performanceScore = (input.performanceScore as number) || 0.8;

        // Update agent metrics
        agent.metrics.adaptations++;
        agent.metrics.successRate = (agent.metrics.successRate + performanceScore) / 2;
        agent.lastActivity = new Date().toISOString();
        agent.status = 'active';
        saveDAAStore(store);

        return {
          found: true as const,
          agentId,
          performanceScore,
          adaptations: agent.metrics.adaptations,
          successRate: agent.metrics.successRate,
          status: agent.status,
        };
      });

      if (!lockResult.found) {
        return { success: false, error: 'Agent not found' };
      }

      // Store adaptation feedback in AgentDB for pattern learning (backward compat: JSON store above)
      let _storedIn: 'agentdb' | 'json-store' = 'json-store';
      try {
        const { routeMemoryOp } = await import('../memory/memory-router.js');
        await routeMemoryOp({
          type: 'store',
          key: `adapt-${lockResult.agentId}-${lockResult.adaptations}`,
          value: JSON.stringify({
            success: lockResult.performanceScore >= 0.5,
            quality: lockResult.performanceScore,
            agent: lockResult.agentId,
          }),
          namespace: 'daa-feedback',
        });
        _storedIn = 'agentdb';
      } catch { /* AgentDB not available */ }

      return {
        success: true,
        agentId: lockResult.agentId,
        adaptation: {
          feedback: input.feedback,
          performanceScore: lockResult.performanceScore,
          adaptations: lockResult.adaptations,
          newSuccessRate: lockResult.successRate,
        },
        status: lockResult.status,
        _storedIn,
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
      // ADR-0129 (B1) race-fix: load → mutate → save under withDAALock so
      // parallel `daa_workflow_create` invocations don't lost-update each other.
      return withDAALock(() => {
        const store = loadDAAStore();
        const id = input.id as string;

        const workflow: DAAWorkflow = {
          id,
          name: input.name as string,
          status: 'pending',
          steps: ((input.steps as unknown[]) || []).map((s, i) => ({
            name: typeof s === 'string' ? s : `Step ${i + 1}`,
            status: 'pending',
          })),
          strategy: (input.strategy as string) || 'adaptive',
          createdAt: new Date().toISOString(),
        };

        store.workflows[id] = workflow;
        saveDAAStore(store);

        return {
          success: true,
          workflowId: id,
          name: workflow.name,
          steps: workflow.steps.length,
          strategy: workflow.strategy,
          createdAt: workflow.createdAt,
        };
      });
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
      // ADR-0129 (B1) race-fix: load → mutate → save under withDAALock so
      // parallel `daa_workflow_execute` invocations don't observe a stale
      // pre-image (e.g. missing the workflow that was just created by a
      // concurrent `daa_workflow_create`). Without this, `p3-da-wf-exec`
      // can fail with `Workflow not found` when its sibling `p3-da-wf-create`
      // racing in the same E2E_DIR overwrote the just-created workflow.
      return withDAALock(() => {
        const store = loadDAAStore();
        const workflowId = input.workflowId as string;
        const workflow = store.workflows[workflowId];

        if (!workflow) {
          return { success: false, error: 'Workflow not found' };
        }

        workflow.status = 'running';
        saveDAAStore(store);

        return {
          success: true,
          workflowId,
          status: workflow.status,
          steps: workflow.steps,
          startedAt: new Date().toISOString(),
          _note: 'Steps are tracked but not auto-executed. Use agent tools to execute each step.',
        };
      });
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
      const sourceId = input.sourceAgentId as string;
      const targetIds = input.targetAgentIds as string[];
      const domain = (input.knowledgeDomain as string) || 'general';

      const knowledgeId = `knowledge-${Date.now()}`;
      const knowledgeEntry = {
        domain,
        content: input.knowledgeContent || {},
        sharedBy: sourceId,
        targetAgents: targetIds,
        timestamp: new Date().toISOString(),
      };

      // Primary: store in AgentDB for vector-searchable knowledge
      let _storedIn: 'agentdb' | 'json-store' = 'json-store';
      try {
        const { routeMemoryOp } = await import('../memory/memory-router.js');
        await routeMemoryOp({
          type: 'store',
          key: knowledgeId,
          value: JSON.stringify(knowledgeEntry),
          namespace: 'daa-knowledge',
          tags: [domain, sourceId, ...targetIds],
        });
        _storedIn = 'agentdb';
      } catch { /* AgentDB not available */ }

      // ADR-0129 (B1) race-fix: load → mutate → save under withDAALock so
      // backward-compat JSON-store writes don't lost-update each other.
      withDAALock(() => {
        const store = loadDAAStore();
        store.knowledge[knowledgeId] = knowledgeEntry;
        saveDAAStore(store);
      });

      return {
        success: true,
        knowledgeId,
        sourceAgent: sourceId,
        targetAgents: targetIds,
        domain,
        sharedAt: knowledgeEntry.timestamp,
        _storedIn,
        _note: _storedIn === 'agentdb'
          ? 'Knowledge stored in AgentDB (vector-searchable) and JSON store. Target agents can retrieve via daa_learning_status or memory search.'
          : 'Knowledge stored in shared JSON registry. Target agents can retrieve via daa_learning_status. No cross-agent memory transfer occurs.',
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
          // ADR-0129 (B1) race-fix: pattern change is load → mutate → save.
          return withDAALock(() => {
            const store = loadDAAStore();
            const agent = store.agents[agentId];
            if (!agent) {
              return { success: false, error: 'Agent not found' };
            }
            const oldPattern = agent.cognitivePattern;
            agent.cognitivePattern = input.pattern as string;
            saveDAAStore(store);

            return {
              success: true,
              agentId,
              previousPattern: oldPattern,
              newPattern: agent.cognitivePattern,
              changedAt: new Date().toISOString(),
            };
          });
        }

        // Read-only path (analyze) — load is safe without lock; the worst
        // case is reading a slightly stale pre-image. No write happens.
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
