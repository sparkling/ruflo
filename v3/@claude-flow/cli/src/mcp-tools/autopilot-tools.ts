/**
 * Autopilot MCP Tools
 *
 * 10 MCP tools for persistent swarm completion management.
 * Allows programmatic control of the autopilot loop via MCP.
 *
 * ADR-072: Autopilot Integration
 * @module @claude-flow/cli/mcp-tools/autopilot
 */

import type { MCPTool } from './types.js';
import { validateText } from './validate-input.js';
import {
  loadState, saveState, appendLog, loadLog, discoverTasks,
  isTerminal, tryLoadLearning,
  validateNumber, validateTaskSources,
  VALID_TASK_SOURCES,
} from '../autopilot-state.js';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ── MCP Tool Definitions ──────────────────────────────────────

const autopilotStatus: MCPTool = {
  name: 'autopilot_status',
  description: 'Get autopilot state including enabled status, iteration count, task progress, and learning metrics.',
  category: 'autopilot',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const state = loadState();
    const tasks = discoverTasks(state.taskSources);
    const completed = tasks.filter(t => isTerminal(t.status)).length;
    return ok({
      enabled: state.enabled,
      sessionId: state.sessionId,
      iterations: state.iterations,
      maxIterations: state.maxIterations,
      timeoutMinutes: state.timeoutMinutes,
      elapsedMs: state.enabled ? Date.now() - state.startTime : 0,
      tasks: { completed, total: tasks.length, percent: tasks.length === 0 ? 100 : Math.round((completed / tasks.length) * 100) },
      taskSources: state.taskSources,
    });
  },
};

const autopilotEnable: MCPTool = {
  name: 'autopilot_enable',
  description: 'Enable autopilot persistent completion. Agents will be re-engaged when tasks remain incomplete.',
  category: 'autopilot',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', description: 'Optional autopilot mode tag (string if provided)' },
    },
  },
  handler: async (params: Record<string, unknown> = {}) => {
    // ADR-0094 P11/P12: even though no fields are required, the response must
    // unambiguously carry `success:true` so the acceptance harness doesn't
    // flag it as neutral, AND any provided `mode` must be type-checked
    // loudly (ADR-0082) — silently accepting `{mode:["array"]}` or
    // `{mode:""}` is a fuzz failure.
    if (params.mode !== undefined) {
      if (typeof params.mode !== 'string') {
        return ok({
          success: false,
          error: "'mode' must be a string if provided (got " + JSON.stringify(params.mode) + ")",
        });
      }
      if (params.mode.length === 0) {
        return ok({
          success: false,
          error: "'mode' must be a non-empty string if provided",
        });
      }
    }
    const state = loadState();
    state.enabled = true;
    state.startTime = Date.now();
    state.iterations = 0;
    saveState(state);
    appendLog({ ts: Date.now(), event: 'enabled', sessionId: state.sessionId });
    return ok({
      success: true,
      enabled: true,
      mode: typeof params.mode === 'string' ? params.mode : undefined,
      maxIterations: state.maxIterations,
      timeoutMinutes: state.timeoutMinutes,
    });
  },
};

const autopilotDisable: MCPTool = {
  name: 'autopilot_disable',
  description: 'Disable autopilot. Agents will be allowed to stop even if tasks remain.',
  category: 'autopilot',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const state = loadState();
    state.enabled = false;
    saveState(state);
    appendLog({ ts: Date.now(), event: 'disabled', iterations: state.iterations });
    return ok({ enabled: false });
  },
};

const autopilotConfig: MCPTool = {
  name: 'autopilot_config',
  description: 'Configure autopilot limits: max iterations (1-1000), timeout in minutes (1-1440), and task sources.',
  category: 'autopilot',
  inputSchema: {
    type: 'object',
    properties: {
      maxIterations: { type: 'number', description: 'Max re-engagement iterations (1-1000)' },
      timeoutMinutes: { type: 'number', description: 'Timeout in minutes (1-1440)' },
      taskSources: { type: 'array', items: { type: 'string' }, description: `Task sources: ${[...VALID_TASK_SOURCES].join(', ')}` },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const state = loadState();
    if (params.maxIterations !== undefined) {
      state.maxIterations = validateNumber(params.maxIterations, 1, 1000, state.maxIterations);
    }
    if (params.timeoutMinutes !== undefined) {
      state.timeoutMinutes = validateNumber(params.timeoutMinutes, 1, 1440, state.timeoutMinutes);
    }
    if (params.taskSources !== undefined) {
      state.taskSources = validateTaskSources(params.taskSources);
    }
    saveState(state);
    return ok({ maxIterations: state.maxIterations, timeoutMinutes: state.timeoutMinutes, taskSources: state.taskSources });
  },
};

const autopilotReset: MCPTool = {
  name: 'autopilot_reset',
  description: 'Reset autopilot iteration counter and restart the timer.',
  category: 'autopilot',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const state = loadState();
    state.iterations = 0;
    state.startTime = Date.now();
    state.history = [];
    state.lastCheck = null;
    saveState(state);
    appendLog({ ts: Date.now(), event: 'reset' });
    return ok({ reset: true, iterations: 0 });
  },
};

const autopilotLog: MCPTool = {
  name: 'autopilot_log',
  description: 'Retrieve the autopilot event log. Shows enable/disable events, re-engagements, completions.',
  category: 'autopilot',
  inputSchema: {
    type: 'object',
    properties: {
      last: { type: 'number', description: 'Return only the last N entries' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const log = loadLog();
    const last = validateNumber(params.last, 1, 10000, 0);
    return ok(last > 0 ? log.slice(-last) : log);
  },
};

const autopilotProgress: MCPTool = {
  name: 'autopilot_progress',
  description: 'Detailed task progress broken down by source (team-tasks, swarm-tasks, file-checklist).',
  category: 'autopilot',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const state = loadState();
    const tasks = discoverTasks(state.taskSources);
    const bySource: Record<string, { completed: number; total: number; tasks: unknown[] }> = {};

    for (const t of tasks) {
      if (!bySource[t.source]) bySource[t.source] = { completed: 0, total: 0, tasks: [] };
      bySource[t.source].total++;
      if (isTerminal(t.status)) {
        bySource[t.source].completed++;
      }
      bySource[t.source].tasks.push(t);
    }

    const completed = tasks.filter(t => isTerminal(t.status)).length;
    return ok({
      overall: { completed, total: tasks.length, percent: tasks.length === 0 ? 100 : Math.round((completed / tasks.length) * 100) },
      bySource,
    });
  },
};

const autopilotLearn: MCPTool = {
  name: 'autopilot_learn',
  description: 'Discover success patterns from past task completions. Requires AgentDB for full functionality.',
  category: 'autopilot',
  inputSchema: { type: 'object', properties: {} },
  // ADR-0181 Phase F (2026-05-18): dispatched through archivist via
  // `AutopilotLearner` capability. The handler at
  // `forks/agentdb/src/archivist/handlers/autopilot/learn.ts` opens a
  // substrate `withWrite` envelope, writes the discovery result under the
  // `autopilot_learn` storeId for audit-chain enrolment, then returns.
  // The cli wrapper re-fetches the discovery result for its envelope —
  // matches the legacy `ok({ metrics, patterns })` / `ok({ available: false, ... })`
  // response shape.
  handler: async () => {
    const { getProcessArchivist } = await import('../memory/archivist-init.js');
    const archivist = await getProcessArchivist();
    await archivist.dispatch('autopilot_learn', {});
    // Re-resolve the result for the cli envelope. The capability adapter
    // performs the actual `tryLoadLearning()` + getMetrics() +
    // discoverSuccessPatterns() work; the dispatch above stamped the audit
    // chain. Calling it again here returns the same shape — this is the
    // post-dispatch read-back pattern used by other Phase 5+ flips (memory
    // wrapper at `mcp-tools/memory-tools.ts:288-321` does the same for
    // envelope parity).
    const learning = await tryLoadLearning();
    if (learning) {
      const [metrics, patterns] = await Promise.all([
        (learning as any).getMetrics(),
        (learning as any).discoverSuccessPatterns(),
      ]);
      return ok({ metrics, patterns });
    }
    return ok({ available: false, reason: 'AgentDB/AutopilotLearning not initialized', patterns: [] });
  },
};

const autopilotHistory: MCPTool = {
  name: 'autopilot_history',
  description: 'Search past completion episodes by keyword. Requires AgentDB.',
  category: 'autopilot',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    const vQuery = validateText(params.query, 'query');
    if (!vQuery.valid) return ok({ query: '', results: [], error: vQuery.error });
    const query = String(params.query || '');
    const limit = validateNumber(params.limit, 1, 100, 10);
    const learning = await tryLoadLearning();
    if (learning) {
      const results = await (learning as any).recallSimilarTasks(query, limit);
      return ok({ query, results });
    }
    return ok({ query, results: [], available: false });
  },
};

const autopilotPredict: MCPTool = {
  name: 'autopilot_predict',
  description: 'Predict the optimal next action based on current state and learned patterns.',
  category: 'autopilot',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const state = loadState();
    const learning = await tryLoadLearning();
    if (learning) {
      const prediction = await (learning as any).predictNextAction(state);
      return ok(prediction);
    }

    // Heuristic fallback
    const tasks = discoverTasks(state.taskSources);
    const incomplete = tasks.filter(t => !isTerminal(t.status));
    if (incomplete.length === 0) {
      return ok({ action: 'none', confidence: 1.0, reason: 'All tasks complete' });
    }
    return ok({
      action: `Work on: ${incomplete[0].subject}`,
      confidence: 0.5,
      reason: 'Heuristic (learning not available)',
      remaining: incomplete.length,
    });
  },
};

// ── Export ─────────────────────────────────────────────────────

export const autopilotTools: MCPTool[] = [
  autopilotStatus,
  autopilotEnable,
  autopilotDisable,
  autopilotConfig,
  autopilotReset,
  autopilotLog,
  autopilotProgress,
  autopilotLearn,
  autopilotHistory,
  autopilotPredict,
];
