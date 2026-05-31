/**
 * ADR-0280: learned action-value substrate — the cross-process bridge from
 * NightlyLearner's `E[reward | action, task_type]` (ADR-0279) to the live
 * routing decisions that consume it.
 *
 * The learner runs in the daemon's `learn` worker (and the manual
 * `agentdb_learner_run`); the routing hot path (`hooks_route`, the ModelRouter)
 * runs in a separate process. So `routeLearningOp({type:'run'})` persists the
 * report's action-values to `.swarm/action-values.json`, and the consumers load
 * it (cached, TTL-refreshed) to blend `β·uplift` into their rank. `uplift` is
 * the de-confounded signal: an action that *causes* success for this task-type
 * outranks one that merely co-occurs.
 *
 * Best-effort by design: missing/empty file → `uplift = 0` → callers fall back
 * to pure cosine / the online bandit prior (no behavior change). The blend is
 * flag-gated at each consumer; this module only supplies the signal.
 *
 * @module action-values
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/** One learner action-value row (mirrors agentdb NightlyLearner.ActionValue). */
export interface ActionValue {
  action: string;
  taskType: string | null;
  meanReward: number;
  samples: number;
  baselineReward: number;
  uplift: number;
  confidence: number;
}

const REL_PATH = '.swarm/action-values.json';

function filePath(): string {
  return join(process.cwd(), REL_PATH);
}

function keyOf(action: string, taskType: string | null | undefined): string {
  return `${taskType ?? 'general'}:${action}`;
}

/**
 * Persist the learner's action-values for cross-process consumption. Called from
 * routeLearningOp('run') after NightlyLearner.run(). Best-effort (swallows IO
 * errors — a routing miss is non-fatal).
 */
export function persistActionValues(rows: ActionValue[] | undefined | null): void {
  if (!Array.isArray(rows) || rows.length === 0) return;
  try {
    const p = filePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ updatedAt: Date.now(), rows }));
    _cache = null; // invalidate same-process cache
  } catch {
    // best-effort persistence
  }
}

// In-process cache with a short TTL so the hot path reads stay cheap but pick up
// new learner runs within ~TTL.
let _cache: Map<string, ActionValue> | null = null;
let _loadedAt = 0;
const TTL_MS = 30_000;

/** Load + cache the persisted action-values keyed `${taskType}:${action}`. */
export function loadActionValues(force = false): Map<string, ActionValue> {
  const now = Date.now();
  if (!force && _cache && now - _loadedAt < TTL_MS) return _cache;
  const m = new Map<string, ActionValue>();
  try {
    const p = filePath();
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, 'utf-8')) as { rows?: unknown };
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      for (const r of rows as ActionValue[]) {
        if (r && typeof r.action === 'string' && typeof r.uplift === 'number') {
          m.set(keyOf(r.action, r.taskType), r);
        }
      }
    }
  } catch {
    // ignore — empty map → uplift 0 → callers fall back to cosine/prior
  }
  _cache = m;
  _loadedAt = now;
  return m;
}

/**
 * Learned de-confounded uplift for `(action, taskType)` — `E[reward | action,
 * taskType] − E[reward | taskType]`. Falls back to the task-type-agnostic row,
 * then 0 (unknown action → no blend). Clamped to [-1, 1].
 */
export function actionUplift(action: string, taskType?: string | null): number {
  if (!action) return 0;
  const m = loadActionValues();
  const v = m.get(keyOf(action, taskType)) ?? (taskType ? m.get(keyOf(action, null)) : undefined);
  if (!v || !Number.isFinite(v.uplift)) return 0;
  return Math.max(-1, Math.min(1, v.uplift));
}

/** Test/diagnostic helper — clears the in-process cache. */
export function _resetActionValuesCache(): void {
  _cache = null;
  _loadedAt = 0;
}
