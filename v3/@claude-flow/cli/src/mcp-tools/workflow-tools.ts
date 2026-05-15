/**
 * Workflow MCP Tools for CLI
 *
 * Tool definitions for workflow automation and orchestration.
 *
 * ADR-0181 Phase 5 (F4-3): all eight workflow_* mutation tools delegate to the
 * Memory Archivist via `getProcessArchivist().dispatch('workflow_*', payload)`.
 * The archivist handlers at `agentdb/src/archivist/handlers/workflow/` own the
 * substrate-locked load→mutate→save cycle (FS-JSON, `.claude-flow/workflows/store.json`)
 * and emit audit-chain entries. Handler signatures are `GuardedWrite<T>:
 * Promise<void>` — they DO NOT return data — so the cli re-reads the same
 * `store.json` after each successful dispatch to project the response envelope
 * callers depend on (notably `workflowId`, which the handler mints internally).
 *
 * workflow_status and workflow_list stay cli-authoritative for this phase:
 * their handlers are deferred to a sibling Phase 5+ task and are not yet
 * registered as `registerReadHandler<...>`. See TODOs at each site.
 */

// Phase 5: only the read path remains in the cli — the archivist owns
// mutations via `withWrite` (lock, atomic write, audit emission). The cli
// reads the same `.claude-flow/workflows/store.json` to project response
// envelopes (`workflowId`, status, etc.) after a successful dispatch.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, findProjectRoot } from './types.js';
import { getProcessArchivist } from '../memory/archivist-init.js';
// `ToolPayloadMap` keeps the dispatch payloads structurally checked at
// compile time (literal tool-name → payload type). Each call site closes
// the object with `satisfies ToolPayloadMap['workflow_*']` rather than an
// `as` cast — see DA worker check #2 (typed-payload fidelity) and the
// canonical pattern at `daa-tools.ts:205, 268, 337, 395, 456, 591`.
import type { ToolPayloadMap } from 'agentdb/archivist';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const WORKFLOW_DIR = 'workflows';
const WORKFLOW_FILE = 'store.json';

interface WorkflowStep {
  stepId: string;
  name: string;
  type: 'task' | 'condition' | 'parallel' | 'loop' | 'wait';
  config: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: unknown;
  startedAt?: string;
  completedAt?: string;
}

interface WorkflowRecord {
  workflowId: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  status: 'draft' | 'ready' | 'running' | 'paused' | 'completed' | 'failed';
  currentStep: number;
  variables: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface WorkflowStore {
  workflows: Record<string, WorkflowRecord>;
  templates: Record<string, WorkflowRecord>;
  version: string;
}

function getWorkflowDir(): string {
  return join(findProjectRoot(), STORAGE_DIR, WORKFLOW_DIR);
}

function getWorkflowPath(): string {
  return join(getWorkflowDir(), WORKFLOW_FILE);
}

// Read-only projection helper. Survives the Phase 5 flip because (a)
// workflow_status / workflow_list have no archivist handler yet and
// (b) every dispatch site re-reads via this to project `workflowId` /
// status / etc. back to MCP callers (handlers are `Promise<void>`).
function loadWorkflowStore(): WorkflowStore {
  try {
    const path = getWorkflowPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return default store on error
  }
  return { workflows: {}, templates: {}, version: '3.0.0' };
}

export const workflowTools: MCPTool[] = [
  {
    name: 'workflow_run',
    description: 'Run a workflow from a template or file',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template name to run' },
        file: { type: 'string', description: 'Workflow file path' },
        task: { type: 'string', description: 'Task description' },
        options: {
          type: 'object',
          description: 'Workflow options',
          properties: {
            parallel: { type: 'boolean', description: 'Run stages in parallel' },
            maxAgents: { type: 'number', description: 'Maximum agents to use' },
            timeout: { type: 'number', description: 'Timeout in seconds' },
            dryRun: { type: 'boolean', description: 'Validate without executing' },
          },
        },
      },
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): delegate to archivist `workflow_run` handler.
      // The handler at `archivist/handlers/workflow/run.ts` owns substrate
      // `withWrite` + audit emission and mints `workflowId` internally. The
      // cli pre-computes `stages` (response shape only — handler does not
      // emit them) and post-reads the store by `name` to surface the
      // minted workflowId. `dryRun=true` short-circuits before dispatch —
      // the handler is also short-circuited (returns void) but skipping
      // dispatch avoids an empty audit-chain entry for a validate-only call.
      const template = input.template as string | undefined;
      const task = input.task as string | undefined;
      const options = (input.options as Record<string, unknown>) || {};
      const dryRun = options.dryRun as boolean | undefined;

      const templateName = template || 'custom';
      const stageNames: string[] = (() => {
        switch (templateName) {
          case 'feature':
            return ['Research', 'Design', 'Implement', 'Test', 'Review'];
          case 'bugfix':
            return ['Investigate', 'Fix', 'Test', 'Review'];
          case 'refactor':
            return ['Analyze', 'Refactor', 'Test', 'Review'];
          case 'security':
            return ['Scan', 'Analyze', 'Report'];
          default:
            return ['Execute'];
        }
      })();

      const stages: Array<{ name: string; status: string; agents: string[]; duration?: number }> =
        stageNames.map((name) => ({
          name,
          status: dryRun ? 'validated' : 'pending',
          agents: [],
        }));

      if (dryRun) {
        // Validate-only path: no dispatch, no workflowId minted, no audit entry.
        return {
          workflowId: '',
          template: templateName,
          status: 'validated',
          stages,
          metrics: {
            totalStages: stages.length,
            completedStages: 0,
            agentsSpawned: 0,
            estimatedDuration: `${stages.length * 30}s`,
          },
        };
      }

      await (await getProcessArchivist()).dispatch('workflow_run', {
        template,
        file: input.file as string | undefined,
        task,
        options,
      } satisfies ToolPayloadMap['workflow_run']);

      // Post-dispatch projection: handler mints workflowId internally; recover
      // it via the same name the handler used: `task || '${templateName} workflow'`.
      // Race note (PHASE 6+): two parallel `workflow_run` calls with the
      // same task land two entries with the same `name` — find-by-name picks
      // the most-recent by `createdAt`. Acceptance is sequential per workflow;
      // widening MutationHandlerFn to `Promise<R>` removes the race.
      const expectedName = task || `${templateName} workflow`;
      const store = loadWorkflowStore();
      const matches = Object.values(store.workflows).filter((w) => w.name === expectedName);
      const minted = matches.length
        ? matches.reduce((a, b) =>
            new Date(a.createdAt).getTime() >= new Date(b.createdAt).getTime() ? a : b,
          )
        : undefined;

      return {
        workflowId: minted?.workflowId ?? '',
        template: templateName,
        status: 'running',
        stages,
        metrics: {
          totalStages: stages.length,
          completedStages: 0,
          agentsSpawned: 0,
          estimatedDuration: `${stages.length * 30}s`,
        },
      };
    },
  },
  {
    name: 'workflow_create',
    description: 'Create a new workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'Workflow description' },
        steps: {
          type: 'array',
          description: 'Workflow steps',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['task', 'condition', 'parallel', 'loop', 'wait'] },
              config: { type: 'object' },
            },
          },
        },
        variables: { type: 'object', description: 'Initial variables' },
      },
      required: ['name', 'steps'],
    },
    handler: async (input) => {
      // ──────────────────────────────────────────────────────────────
      // P11/P12 validation stays cli-side (named-error shapes for
      // `_p12_expect_named_error` acceptance). The archivist handler
      // ALSO validates (throw shape) — defense in depth — but the cli's
      // structured return shape is what acceptance probes assert on, so
      // we MUST reject pre-dispatch to preserve the contract.
      // ──────────────────────────────────────────────────────────────
      if (typeof input.name !== 'string') {
        return {
          success: false,
          error: `'name' is required and must be a string (got ${typeof input.name})`,
          field: 'name',
        };
      }
      if (input.name.length === 0) {
        return {
          success: false,
          error: `'name' must be a non-empty string (received empty string, expected at least 1 character)`,
          field: 'name',
        };
      }
      if (input.steps === undefined || input.steps === null) {
        return {
          success: false,
          error: `'steps' is required and must be an array of workflow step objects (missing in input)`,
          field: 'steps',
        };
      }
      if (!Array.isArray(input.steps)) {
        return {
          success: false,
          error: `'steps' must be an array (got ${typeof input.steps})`,
          field: 'steps',
        };
      }
      if (input.steps.length === 0) {
        return {
          success: false,
          error: `'steps' must be a non-empty array (received empty array, expected at least 1 step)`,
          field: 'steps',
        };
      }

      // ADR-0181 Phase 5 (F4-3): delegate to archivist `workflow_create`
      // handler. The handler at `archivist/handlers/workflow/create.ts` owns
      // substrate `withWrite` (subsumes the cli's prior `withWorkflowLock`,
      // ADR-0094 P9 exactly-one-winner) and the name-based idempotency check
      // is INSIDE the handler's write critical section. Pre-dispatch we
      // probe for an existing winner so the cli's response can set
      // `reused: true` without re-inferring it from a post-dispatch state.
      const name = input.name as string;
      const preStore = loadWorkflowStore();
      const preExisting = Object.values(preStore.workflows).find((w) => w.name === name);

      // Stage steps through a per-element map so the payload structurally
      // matches `WorkflowCreateStep` instead of being a full-array cast.
      // The closing `satisfies ToolPayloadMap['workflow_create']` keeps the
      // typed-overload payload check live (DA worker check #2).
      const stepsIn = input.steps as ReadonlyArray<Record<string, unknown>>;
      const steps = stepsIn.map((s) => ({
        name: s.name as string | undefined,
        type: s.type as 'task' | 'condition' | 'parallel' | 'loop' | 'wait' | undefined,
        config: s.config as Record<string, unknown> | undefined,
      }));

      await (await getProcessArchivist()).dispatch('workflow_create', {
        name,
        description: input.description as string | undefined,
        steps,
        variables: input.variables as Record<string, unknown> | undefined,
      } satisfies ToolPayloadMap['workflow_create']);

      // Post-dispatch projection: find the (possibly newly-minted, possibly
      // pre-existing) workflow by name. The handler's idempotency-check
      // (ADR-0094 P9) guarantees exactly one winner per name; we resolve to
      // that winner regardless of who minted it.
      const store = loadWorkflowStore();
      const workflow = Object.values(store.workflows).find((w) => w.name === name);
      if (!workflow) {
        // Handler returned without inserting — unrecoverable. Per
        // feedback-no-fallbacks: fail loud rather than fabricate.
        throw new Error(
          `archivist: workflow_create dispatched without inserting a record (name='${name}')`,
        );
      }

      return {
        workflowId: workflow.workflowId,
        name: workflow.name,
        status: workflow.status,
        stepCount: workflow.steps.length,
        createdAt: workflow.createdAt,
        reused: preExisting !== undefined && preExisting.workflowId === workflow.workflowId,
      };
    },
  },
  {
    name: 'workflow_execute',
    description: 'Execute a workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID to execute' },
        variables: { type: 'object', description: 'Runtime variables to inject' },
        startFromStep: { type: 'number', description: 'Step to start from (0-indexed)' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): delegate to archivist `workflow_execute`
      // handler. Pre-read for the missing-record / already-running guards so
      // the cli preserves its `{ workflowId, error: '...' }` shape (the
      // handler throws on these, which would propagate as an Error and lose
      // the structured shape probes depend on). Post-dispatch we re-read to
      // project the running-state response with per-step `results[]`.
      const workflowId = input.workflowId as string;

      const preStore = loadWorkflowStore();
      const preWorkflow = preStore.workflows[workflowId];
      if (!preWorkflow) {
        return { workflowId, error: 'Workflow not found' };
      }
      if (preWorkflow.status === 'running') {
        return { workflowId, error: 'Workflow already running' };
      }

      await (await getProcessArchivist()).dispatch('workflow_execute', {
        workflowId,
        variables: input.variables as Record<string, unknown> | undefined,
        startFromStep: input.startFromStep as number | undefined,
      } satisfies ToolPayloadMap['workflow_execute']);

      const store = loadWorkflowStore();
      const workflow = store.workflows[workflowId];
      if (!workflow) {
        throw new Error(
          `archivist: workflow_execute dispatched but workflow vanished (workflowId='${workflowId}')`,
        );
      }

      const results: Array<{ stepId: string; status: string; _note: string }> = [];
      for (let i = workflow.currentStep; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        results.push({
          stepId: step.stepId,
          status: step.status,
          _note: 'Workflow execution tracks state. Actual step execution requires agent assignment via task tools.',
        });
      }

      return {
        workflowId,
        status: workflow.status,
        totalSteps: results.length,
        results,
        startedAt: workflow.startedAt,
        _note: 'Workflow is now running. Steps are in pending state and must be executed via task tools.',
      };
    },
  },
  {
    name: 'workflow_status',
    description: 'Get workflow status',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
        verbose: { type: 'boolean', description: 'Include step details' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      // TODO(ADR-0181 Phase 5+): dispatchRead when workflow_status is
      // registered as `registerReadHandler<...>` in the archivist (sibling
      // task per recon-map-and-rulings). Stays cli-authoritative for Phase 5.
      const store = loadWorkflowStore();
      const workflowId = input.workflowId as string;
      const workflow = store.workflows[workflowId];

      if (!workflow) {
        return { workflowId, error: 'Workflow not found' };
      }

      const completedSteps = workflow.steps.filter(s => s.status === 'completed').length;
      const progress = workflow.steps.length > 0 ? (completedSteps / workflow.steps.length) * 100 : 0;

      const status = {
        workflowId: workflow.workflowId,
        name: workflow.name,
        status: workflow.status,
        progress,
        currentStep: workflow.currentStep,
        totalSteps: workflow.steps.length,
        completedSteps,
        createdAt: workflow.createdAt,
        startedAt: workflow.startedAt,
        completedAt: workflow.completedAt,
      };

      if (input.verbose) {
        return {
          ...status,
          description: workflow.description,
          variables: workflow.variables,
          steps: workflow.steps.map(s => ({
            stepId: s.stepId,
            name: s.name,
            type: s.type,
            status: s.status,
            startedAt: s.startedAt,
            completedAt: s.completedAt,
          })),
          error: workflow.error,
        };
      }

      return status;
    },
  },
  {
    name: 'workflow_list',
    description: 'List all workflows',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status' },
        limit: { type: 'number', description: 'Max workflows to return' },
      },
    },
    handler: async (input) => {
      // TODO(ADR-0181 Phase 5+): dispatchRead when workflow_list is
      // registered as `registerReadHandler<...>` in the archivist (sibling
      // task per recon-map-and-rulings). Stays cli-authoritative for Phase 5.
      const store = loadWorkflowStore();
      let workflows = Object.values(store.workflows);

      // Apply filters
      if (input.status) {
        workflows = workflows.filter(w => w.status === input.status);
      }

      // Sort by creation date (newest first)
      workflows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      // Apply limit
      const limit = (input.limit as number) || 20;
      workflows = workflows.slice(0, limit);

      return {
        workflows: workflows.map(w => ({
          workflowId: w.workflowId,
          name: w.name,
          status: w.status,
          stepCount: w.steps.length,
          createdAt: w.createdAt,
          completedAt: w.completedAt,
        })),
        total: workflows.length,
        filters: { status: input.status },
      };
    },
  },
  {
    name: 'workflow_pause',
    description: 'Pause a running workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): delegate to archivist `workflow_pause` handler.
      // Pre-read for missing-record / not-running guards (preserve cli's
      // `{ error: '...' }` envelope), then dispatch + re-read for the response.
      const workflowId = input.workflowId as string;

      const preStore = loadWorkflowStore();
      const preWorkflow = preStore.workflows[workflowId];
      if (!preWorkflow) {
        return { workflowId, error: 'Workflow not found' };
      }
      if (preWorkflow.status !== 'running') {
        return { workflowId, error: 'Workflow not running' };
      }

      await (await getProcessArchivist()).dispatch(
        'workflow_pause',
        { workflowId } satisfies ToolPayloadMap['workflow_pause'],
      );

      const store = loadWorkflowStore();
      const workflow = store.workflows[workflowId];
      if (!workflow) {
        throw new Error(
          `archivist: workflow_pause dispatched but workflow vanished (workflowId='${workflowId}')`,
        );
      }

      return {
        workflowId,
        status: workflow.status,
        pausedAt: new Date().toISOString(),
        currentStep: workflow.currentStep,
      };
    },
  },
  {
    name: 'workflow_resume',
    description: 'Resume a paused workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): delegate to archivist `workflow_resume` handler.
      // Pre-read for missing-record / not-paused guards (preserve cli's
      // `{ error: '...' }` envelope), then dispatch + re-read for the response.
      const workflowId = input.workflowId as string;

      const preStore = loadWorkflowStore();
      const preWorkflow = preStore.workflows[workflowId];
      if (!preWorkflow) {
        return { workflowId, error: 'Workflow not found' };
      }
      if (preWorkflow.status !== 'paused') {
        return { workflowId, error: 'Workflow not paused' };
      }

      await (await getProcessArchivist()).dispatch(
        'workflow_resume',
        { workflowId } satisfies ToolPayloadMap['workflow_resume'],
      );

      const store = loadWorkflowStore();
      const workflow = store.workflows[workflowId];
      if (!workflow) {
        throw new Error(
          `archivist: workflow_resume dispatched but workflow vanished (workflowId='${workflowId}')`,
        );
      }

      // Report current step states — do not auto-complete them
      const stepStates = workflow.steps.map(step => ({
        stepId: step.stepId,
        name: step.name,
        status: step.status,
      }));

      const remainingSteps = workflow.steps.length - workflow.currentStep;

      return {
        workflowId,
        status: workflow.status,
        resumed: true,
        currentStep: workflow.currentStep,
        remainingSteps,
        steps: stepStates,
        _note: 'Workflow resumed. Steps remain in their current state and must be executed via task tools.',
      };
    },
  },
  {
    name: 'workflow_cancel',
    description: 'Cancel a workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
        reason: { type: 'string', description: 'Cancellation reason' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): delegate to archivist `workflow_cancel` handler.
      // Pre-read for missing-record / already-finished guards (preserve cli's
      // `{ error: '...' }` envelope), then dispatch + re-read for the response.
      const workflowId = input.workflowId as string;
      const reason = input.reason as string | undefined;

      const preStore = loadWorkflowStore();
      const preWorkflow = preStore.workflows[workflowId];
      if (!preWorkflow) {
        return { workflowId, error: 'Workflow not found' };
      }
      if (preWorkflow.status === 'completed' || preWorkflow.status === 'failed') {
        return { workflowId, error: 'Workflow already finished' };
      }
      // Capture pre-cancel currentStep — the handler does not advance it, so
      // `skippedSteps = steps.length - currentStep` is identical pre/post,
      // but reading from the post-state keeps the projection self-consistent.

      await (await getProcessArchivist()).dispatch('workflow_cancel', {
        workflowId,
        reason,
      } satisfies ToolPayloadMap['workflow_cancel']);

      const store = loadWorkflowStore();
      const workflow = store.workflows[workflowId];
      if (!workflow) {
        throw new Error(
          `archivist: workflow_cancel dispatched but workflow vanished (workflowId='${workflowId}')`,
        );
      }

      return {
        workflowId,
        status: workflow.status,
        cancelledAt: workflow.completedAt,
        reason: workflow.error,
        skippedSteps: workflow.steps.length - workflow.currentStep,
      };
    },
  },
  {
    name: 'workflow_delete',
    description: 'Delete a workflow',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID' },
      },
      required: ['workflowId'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): delegate to archivist `workflow_delete` handler.
      // Pre-read for missing-record / running-workflow guards (preserve cli's
      // `{ error: '...' }` envelope), then dispatch. No post-dispatch read is
      // strictly needed — the response shape is static — but we keep the call
      // pattern uniform with the rest of the family for verifier audit clarity.
      const workflowId = input.workflowId as string;

      const preStore = loadWorkflowStore();
      const preWorkflow = preStore.workflows[workflowId];
      if (!preWorkflow) {
        return { workflowId, error: 'Workflow not found' };
      }
      if (preWorkflow.status === 'running') {
        return { workflowId, error: 'Cannot delete running workflow' };
      }

      await (await getProcessArchivist()).dispatch(
        'workflow_delete',
        { workflowId } satisfies ToolPayloadMap['workflow_delete'],
      );

      return {
        workflowId,
        deleted: true,
        deletedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'workflow_template',
    description: 'Save workflow as template or create from template',
    category: 'workflow',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'create', 'list'], description: 'Template action' },
        workflowId: { type: 'string', description: 'Workflow ID (for save)' },
        templateId: { type: 'string', description: 'Template ID (for create)' },
        templateName: { type: 'string', description: 'Template name (for save)' },
        newName: { type: 'string', description: 'New workflow name (for create)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      // ADR-0181 Phase 5 (F4-3): delegate to archivist `workflow_template`
      // handler. The handler discriminates on `payload.action` ('save' |
      // 'create' | 'list') under one `withWrite` scope:
      //   - 'save'   mints a templateId, clones the workflow into store.templates
      //   - 'create' mints a workflowId, clones the template into store.workflows
      //   - 'list'   is a read no-op inside the write scope (will migrate to a
      //              sibling GuardedRead in a Phase 5+ task per recon)
      //
      // Pre-existence guards stay cli-side (preserve `{ action, error: '...' }`
      // envelope). Server-minted IDs are recovered via before/after key-diff —
      // race-prone for two concurrent save/create calls cloning the SAME source
      // workflow/template (same generated name fallback), but the handler's
      // `withWrite` lock keeps the diff consistent within a single call.
      // PHASE 6+: widen MutationHandlerFn to `Promise<R>` so the handler
      // returns the minted ID and the diff dance can be retired.
      const action = input.action as 'save' | 'create' | 'list';

      if (action === 'save') {
        const sourceWorkflowId = input.workflowId as string;
        const preStore = loadWorkflowStore();
        if (!preStore.workflows[sourceWorkflowId]) {
          return { action, error: 'Workflow not found' };
        }

        const beforeTemplateKeys = new Set(Object.keys(preStore.templates));

        await (await getProcessArchivist()).dispatch('workflow_template', {
          action: 'save',
          workflowId: sourceWorkflowId,
          templateName: input.templateName as string | undefined,
        } satisfies ToolPayloadMap['workflow_template']);

        const store = loadWorkflowStore();
        const newTemplateKey = Object.keys(store.templates).find((k) => !beforeTemplateKeys.has(k));
        if (!newTemplateKey) {
          throw new Error(
            `archivist: workflow_template save dispatched without inserting a template (workflowId='${sourceWorkflowId}')`,
          );
        }
        const template = store.templates[newTemplateKey];

        return {
          action,
          templateId: newTemplateKey,
          name: template.name,
          savedAt: new Date().toISOString(),
        };
      }

      if (action === 'create') {
        const sourceTemplateId = input.templateId as string;
        const preStore = loadWorkflowStore();
        if (!preStore.templates[sourceTemplateId]) {
          return { action, error: 'Template not found' };
        }

        const beforeWorkflowKeys = new Set(Object.keys(preStore.workflows));

        await (await getProcessArchivist()).dispatch('workflow_template', {
          action: 'create',
          templateId: sourceTemplateId,
          newName: input.newName as string | undefined,
        } satisfies ToolPayloadMap['workflow_template']);

        const store = loadWorkflowStore();
        const newWorkflowKey = Object.keys(store.workflows).find((k) => !beforeWorkflowKeys.has(k));
        if (!newWorkflowKey) {
          throw new Error(
            `archivist: workflow_template create dispatched without inserting a workflow (templateId='${sourceTemplateId}')`,
          );
        }
        const workflow = store.workflows[newWorkflowKey];

        return {
          action,
          workflowId: newWorkflowKey,
          name: workflow.name,
          fromTemplate: sourceTemplateId,
          createdAt: workflow.createdAt,
        };
      }

      if (action === 'list') {
        // Dispatching `action: 'list'` is a no-op write under the handler's
        // current shape — it still takes the substrate write scope (emits an
        // audit entry for a pure read). Phase 5+ migrates 'list' to a
        // sibling GuardedRead; until then we project from a direct
        // loadWorkflowStore() to keep the audit chain clean of read-only
        // entries. Stays cli-authoritative for this action only.
        const store = loadWorkflowStore();
        return {
          action,
          templates: Object.values(store.templates).map(t => ({
            templateId: t.workflowId,
            name: t.name,
            stepCount: t.steps.length,
            createdAt: t.createdAt,
          })),
          total: Object.keys(store.templates).length,
        };
      }

      return { action, error: 'Unknown action' };
    },
  },
];
