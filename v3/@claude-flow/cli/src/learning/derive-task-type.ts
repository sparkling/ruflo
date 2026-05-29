/**
 * ADR-0268: deriveTaskType — the stable grouping key for autonomous skill
 * promotion. `consolidateEpisodesIntoSkills` groups episodes by `task_type`
 * (`GROUP BY ... HAVING COUNT(*) >= minAttempts`); a per-instance key (taskId)
 * or the raw free-text description never groups, so promotion never fires. This
 * derives a stable, repeatable TYPE label.
 *
 * It MUST be called identically on the write side (episode record) and the read
 * side (pre-task `retrieveSkillByType`) — the `skills.name` key IS this value,
 * so any divergence silently misses.
 *
 * Tiers (highest-confidence first):
 *   1. explicit `taskType`
 *   2. structural: task_create `type` / agent_spawn `agentType` (subagent_type)
 *   3. keyword-classify the description against the controlled vocabulary
 *   4. fallback `general` — NEVER taskId or the raw description
 */

// Controlled task-type vocabulary. Mirrors the KEYWORD_PATTERNS keys in
// mcp-tools/hooks-tools.ts (today used for agent routing); promoted here to the
// canonical task-type taxonomy per ADR-0268. Ordered most-specific-first so e.g.
// "authentication" wins over the substring "auth".
export const TASK_TYPE_VOCABULARY: readonly string[] = [
  'authentication', 'performance', 'security', 'database', 'frontend', 'backend',
  'refactor', 'feature', 'deploy', 'memory', 'swarm', 'api', 'auth', 'test',
  'bug', 'fix', 'ci/cd',
];

/** Normalize an arbitrary label to a stable slug (<=128 chars); empty -> 'general'. */
export function slugifyTaskType(raw: string): string {
  const slug = (raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return slug || 'general';
}

/** Word-boundary keyword classification against the controlled vocabulary. */
export function classifyTaskType(description: string): string | null {
  const d = (description ?? '').toLowerCase();
  if (!d) return null;
  for (const kw of TASK_TYPE_VOCABULARY) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(d)) {
      return slugifyTaskType(kw);
    }
  }
  return null;
}

export interface TaskTypeInput {
  /** tier 1: explicit task type */
  taskType?: string;
  /** tier 2: task_create `type` */
  type?: string;
  /** tier 2: agent_spawn `agentType` / subagent_type */
  agentType?: string;
  /** tier 3: free-text task description to classify */
  description?: string;
}

export function deriveTaskType(input: TaskTypeInput): string {
  if (input.taskType && input.taskType.trim()) return slugifyTaskType(input.taskType);
  if (input.type && input.type.trim()) return slugifyTaskType(input.type);
  if (input.agentType && input.agentType.trim()) return slugifyTaskType(input.agentType);
  const classified = classifyTaskType(input.description ?? '');
  if (classified) return classified;
  return 'general';
}
