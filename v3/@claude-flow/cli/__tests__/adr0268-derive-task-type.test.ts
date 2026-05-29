import { describe, it, expect } from 'vitest';
import {
  deriveTaskType,
  slugifyTaskType,
  classifyTaskType,
} from '../src/learning/derive-task-type.js';

// ADR-0268: deriveTaskType is the stable grouping key for autonomous skill
// promotion. It MUST be deterministic and identical on write+read sides, and it
// must never emit a per-instance id or the raw description (which would make
// consolidateEpisodesIntoSkills' GROUP BY never reach minAttempts).
describe('ADR-0268 deriveTaskType', () => {
  it('tier 1: explicit taskType wins, slugified', () => {
    expect(deriveTaskType({ taskType: 'My Custom Type', description: 'fix auth bug' }))
      .toBe('my-custom-type');
  });

  it('tier 2: task_create type, then agentType', () => {
    expect(deriveTaskType({ type: 'bugfix', description: 'whatever' })).toBe('bugfix');
    expect(deriveTaskType({ agentType: 'security-architect', description: 'x' }))
      .toBe('security-architect');
  });

  it('tier 3: classify description against the controlled vocabulary', () => {
    expect(deriveTaskType({ description: 'investigate an authentication failure' }))
      .toBe('authentication');
    expect(deriveTaskType({ description: 'optimize the database indexes' })).toBe('database');
  });

  it('tier 3 avoids substring false-positives (latest != test)', () => {
    expect(deriveTaskType({ description: 'ship the latest build' })).toBe('general');
  });

  it('tier 4: fallback general; never a per-instance id or raw description', () => {
    const t = deriveTaskType({ description: 'a very specific one-off task #4821' });
    expect(t).toBe('general');
    expect(t).not.toContain('4821');
  });

  it('slugify caps/strips; empty -> general', () => {
    expect(slugifyTaskType('  Hello, World!! ')).toBe('hello-world');
    expect(slugifyTaskType('')).toBe('general');
  });

  it('ci/cd classifies to ci-cd slug', () => {
    expect(classifyTaskType('set up ci/cd pipeline')).toBe('ci-cd');
  });

  it('determinism: identical input -> identical key (write==read contract)', () => {
    const a = deriveTaskType({ description: 'fix the security vulnerability' });
    const b = deriveTaskType({ description: 'fix the security vulnerability' });
    expect(a).toBe(b);
    expect(a).toBe('security');
  });
});
