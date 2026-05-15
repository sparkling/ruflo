/**
 * Task MCP Tools for CLI
 *
 * ADR-0181 Phase 5 (F4-3) — every `task_*` MCP tool now dispatches its mutation
 * through the per-process Memory Archivist (`getProcessArchivist().dispatch(...)`).
 * The legacy unlocked `loadTaskStore`/`saveTaskStore` pair (which still exists
 * below, but only for envelope-construction read-back) is no longer the write
 * path — the archivist's substrate seam owns durability + isolation via the
 * `tasks` FS-JSON store's O_EXCL lock, and `task_complete` / `task_assign`
 * additionally route the cross-store `hive-mind_agents` write through the
 * archivist instead of the cli's prior best-effort try/catch.
 *
 * The handlers under `agentdb/src/archivist/handlers/tasks/**` return
 * `Promise<void>`; the cli envelope shape (the MCP response payload — varies
 * per tool, some with `success`, some without) is constructed here by
 * re-reading the post-dispatch store snapshot. The handler is the single
 * authoritative writer; the cli is the single authoritative envelope-shaper.
 * No `try/catch` wraps the dispatch with a legacy-path fallback — per
 * `feedback-no-fallbacks` + ADR-0181 §Architecture ("The original path is
 * deleted only once the delegation is release-verified — never both live at
 * once"), dispatch throws propagate.
 *
 * All seven `task_*` tools route to FS-JSON-family stores (`tasks` and, for
 * `task_complete` / `task_assign`, `hive-mind_agents`). No `ensureRvfWired()`
 * / `ensureSqliteWired()` calls — those helpers are reserved for tools that
 * touch RVF / SQLite-carve-out substrates. The Phase 4 hotfix posture
 * (`t1-6-empty-search` 33× regression from gratuitous `ensureRouter()`) is
 * preserved by NOT calling those helpers here.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, findProjectRoot } from './types.js';
import { getProcessArchivist } from '../memory/archivist-init.js';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const TASK_DIR = 'tasks';
const TASK_FILE = 'store.json';

interface TaskRecord {
  taskId: string;
  type: string;
  description: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  assignedTo: string[];
  tags: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result?: Record<string, unknown>;
}

interface TaskStore {
  tasks: Record<string, TaskRecord>;
  version: string;
}

function getTaskDir(): string {
  return join(findProjectRoot(), STORAGE_DIR, TASK_DIR);
}

function getTaskPath(): string {
  return join(getTaskDir(), TASK_FILE);
}

function ensureTaskDir(): void {
  const dir = getTaskDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadTaskStore(): TaskStore {
  try {
    const path = getTaskPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return empty store on error
  }
  return { tasks: {}, version: '3.0.0' };
}

function saveTaskStore(store: TaskStore): void {
  ensureTaskDir();
  writeFileSync(getTaskPath(), JSON.stringify(store, null, 2), 'utf-8');
}

// Phase 5: the archivist owns the write path. `saveTaskStore` is preserved
// only for any non-flipped legacy reader; it is intentionally unreferenced by
// the post-Phase-5 handler bodies below. `ensureTaskDir` likewise stays
// callable but unused — the archivist's substrate factory creates the parent
// directory itself.
void saveTaskStore;
void ensureTaskDir;

export const taskTools: MCPTool[] = [
  {
    name: 'task_create',
    description: 'Create a new task',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Task type (feature, bugfix, research, refactor)' },
        description: { type: 'string', description: 'Task description' },
        priority: { type: 'string', description: 'Task priority (low, normal, high, critical)' },
        assignTo: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to assign' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Task tags' },
      },
      required: ['type', 'description'],
    },
    handler: async (input) => {
      // Snapshot pre-dispatch taskIds so we can recover the archivist-minted
      // taskId from the post-dispatch store diff. The handler mints the id
      // (`task-${Date.now()}-${random}`) inside its `withWrite` scope; the cli
      // has no way to predict it. A one-record diff is unambiguous because the
      // FS-JSON substrate's O_EXCL lock serializes the create with any
      // concurrent task_create.
      const preIds = new Set(Object.keys(loadTaskStore().tasks));

      await (await getProcessArchivist()).dispatch('task_create', {
        type: input.type as string,
        description: input.description as string,
        priority: input.priority as TaskRecord['priority'] | undefined,
        assignTo: input.assignTo as ReadonlyArray<string> | undefined,
        tags: input.tags as ReadonlyArray<string> | undefined,
      });

      const post = loadTaskStore();
      const newIds = Object.keys(post.tasks).filter((id) => !preIds.has(id));
      if (newIds.length !== 1) {
        throw new Error(
          `task_create: expected exactly 1 new task in store after dispatch, found ${newIds.length}. ` +
            `Concurrent create races are serialized by the substrate lock — this indicates an audit-chain bug.`,
        );
      }
      const task = post.tasks[newIds[0]];

      return {
        taskId: task.taskId,
        type: task.type,
        description: task.description,
        priority: task.priority,
        status: task.status,
        createdAt: task.createdAt,
        assignedTo: task.assignedTo,
        tags: task.tags,
      };
    },
  },
  {
    name: 'task_status',
    description: 'Get task status',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const taskId = input.taskId as string;

      await (await getProcessArchivist()).dispatch('task_status', { taskId });

      const task = loadTaskStore().tasks[taskId];
      if (task) {
        return {
          taskId: task.taskId,
          type: task.type,
          description: task.description,
          status: task.status,
          progress: task.progress,
          priority: task.priority,
          assignedTo: task.assignedTo,
          tags: task.tags,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          result: task.result || null,
        };
      }

      return {
        taskId,
        status: 'not_found',
        error: 'Task not found',
      };
    },
  },
  {
    name: 'task_list',
    description: 'List all tasks',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status' },
        type: { type: 'string', description: 'Filter by type' },
        assignedTo: { type: 'string', description: 'Filter by assigned agent' },
        priority: { type: 'string', description: 'Filter by priority' },
        limit: { type: 'number', description: 'Max tasks to return' },
      },
    },
    handler: async (input) => {
      // The archivist handler runs the read under the substrate's withWrite
      // scope so the snapshot participates in the audit chain + lock order
      // against concurrent task_create / task_update / task_complete writers
      // (per handlers/tasks/list.ts header). Filter/sort/limit construction
      // stays cli-side per the same handler's "filter chain moves to the
      // wire-up callsite" rationale — the handler intentionally surfaces only
      // the consistent snapshot.
      await (await getProcessArchivist()).dispatch('task_list', {
        status: input.status as string | undefined,
        type: input.type as string | undefined,
        assignedTo: input.assignedTo as string | undefined,
        priority: input.priority as TaskRecord['priority'] | undefined,
        limit: input.limit as number | undefined,
      });

      let tasks = Object.values(loadTaskStore().tasks);

      // Apply filters
      if (input.status) {
        // Support comma-separated status values
        const statuses = (input.status as string).split(',').map(s => s.trim());
        tasks = tasks.filter(t => statuses.includes(t.status));
      }
      if (input.type) {
        tasks = tasks.filter(t => t.type === input.type);
      }
      if (input.assignedTo) {
        tasks = tasks.filter(t => t.assignedTo.includes(input.assignedTo as string));
      }
      if (input.priority) {
        tasks = tasks.filter(t => t.priority === input.priority);
      }

      // Sort by creation date (newest first)
      tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      // Apply limit
      const limit = (input.limit as number) || 50;
      tasks = tasks.slice(0, limit);

      return {
        tasks: tasks.map(t => ({
          taskId: t.taskId,
          type: t.type,
          description: t.description,
          status: t.status,
          progress: t.progress,
          priority: t.priority,
          assignedTo: t.assignedTo,
          createdAt: t.createdAt,
        })),
        total: tasks.length,
        filters: {
          status: input.status,
          type: input.type,
          assignedTo: input.assignedTo,
          priority: input.priority,
        },
      };
    },
  },
  {
    name: 'task_complete',
    description: 'Mark task as complete',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        result: { type: 'object', description: 'Task result data' },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const taskId = input.taskId as string;

      // Handler routes BOTH stores: the task record's status/progress/
      // completedAt/result fields AND the hive-mind_agents records for each
      // `assignedTo` agent (status → idle, currentTask → null, taskCount++).
      // The prior cli implementation wrapped the agent-sync in a best-effort
      // try/catch; the archivist surface (handlers/tasks/complete.ts header)
      // RE-THROWS fatals per feedback-best-effort-must-rethrow-fatals. The
      // post-flip behavior change is documented and intentional.
      await (await getProcessArchivist()).dispatch('task_complete', {
        taskId,
        result: input.result as Record<string, unknown> | undefined,
      });

      const task = loadTaskStore().tasks[taskId];
      if (task) {
        return {
          taskId: task.taskId,
          status: task.status,
          completedAt: task.completedAt,
          result: task.result,
        };
      }

      return {
        taskId,
        status: 'not_found',
        error: 'Task not found',
      };
    },
  },
  {
    name: 'task_update',
    description: 'Update task status or progress',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        status: { type: 'string', description: 'New status' },
        progress: { type: 'number', description: 'Progress percentage (0-100)' },
        assignTo: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to assign' },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const taskId = input.taskId as string;

      // Snapshot pre-dispatch state so the cli envelope can distinguish
      // success (task existed and was updated) from not-found (no task
      // record). The handler returns void either way; the cli's
      // `success: true/false` envelope is reconstructed from the pre-state.
      const preTask = loadTaskStore().tasks[taskId];

      await (await getProcessArchivist()).dispatch('task_update', {
        taskId,
        status: input.status as TaskRecord['status'] | undefined,
        progress: typeof input.progress === 'number' ? (input.progress as number) : undefined,
        assignTo: input.assignTo as ReadonlyArray<string> | undefined,
      });

      const task = loadTaskStore().tasks[taskId];
      if (!preTask || !task) {
        return {
          success: false,
          taskId,
          error: 'Task not found',
        };
      }

      return {
        success: true,
        taskId: task.taskId,
        status: task.status,
        progress: task.progress,
        assignedTo: task.assignedTo,
      };
    },
  },
  {
    name: 'task_assign',
    description: 'Assign a task to one or more agents',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to assign' },
        agentIds: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to assign' },
        unassign: { type: 'boolean', description: 'Unassign all agents from task' },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const taskId = input.taskId as string;

      // Snapshot the pre-dispatch assignment so the cli envelope can return
      // `previouslyAssigned` (the original cli surface contract — used by
      // callers to compute the assignment delta without re-reading state).
      // The handler also reads this internally, but it does not surface it;
      // the cli is the envelope author per Phase 5 §wire-up rationale.
      const preTask = loadTaskStore().tasks[taskId];
      if (!preTask) {
        return { taskId, error: 'Task not found' };
      }
      const previouslyAssigned = [...preTask.assignedTo];

      // Handler routes BOTH stores: task.assignedTo + hive-mind_agents
      // status/currentTask updates (assign → active, unassign/replaced →
      // idle) plus the auto-transition from `pending` → `in_progress` when
      // a previously-pending task gets agents assigned. The prior cli's
      // best-effort try/catch around agent-store I/O is gone — the
      // archivist substrate seam owns durability + isolation for both
      // stores via their respective O_EXCL locks.
      await (await getProcessArchivist()).dispatch('task_assign', {
        taskId,
        agentIds: input.agentIds as ReadonlyArray<string> | undefined,
        unassign: input.unassign as boolean | undefined,
      });

      const task = loadTaskStore().tasks[taskId];
      if (!task) {
        // Task disappeared between pre-read and post-read — shouldn't happen
        // since task_assign doesn't delete records, but surface as not-found
        // rather than throwing.
        return { taskId, error: 'Task not found' };
      }

      return {
        taskId: task.taskId,
        assignedTo: task.assignedTo,
        previouslyAssigned,
        status: task.status,
      };
    },
  },
  {
    name: 'task_cancel',
    description: 'Cancel a task',
    category: 'task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        reason: { type: 'string', description: 'Cancellation reason' },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const taskId = input.taskId as string;

      // Pre-state snapshot drives the `success: true/false` envelope (same
      // pattern as task_update). The handler returns void; not-found is
      // surfaced by absence of pre-task.
      const preTask = loadTaskStore().tasks[taskId];

      await (await getProcessArchivist()).dispatch('task_cancel', {
        taskId,
        reason: input.reason as string | undefined,
      });

      const task = loadTaskStore().tasks[taskId];
      if (!preTask || !task) {
        return {
          success: false,
          taskId,
          error: 'Task not found',
        };
      }

      return {
        success: true,
        taskId: task.taskId,
        status: task.status,
        cancelledAt: task.completedAt,
      };
    },
  },
];
