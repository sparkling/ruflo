/**
 * ADR-0280 — learned action-value substrate + the de-confounded routing rerank.
 *
 * The substrate (learning/action-values.ts) is the cross-process bridge from
 * NightlyLearner's E[reward | action, task_type] (ADR-0279) to the routing hot
 * path. LocalReasoningBank.findSimilar blends β·uplift into the SORT while
 * keeping cosine as the relevance floor — so a pattern whose action *causes*
 * success outranks a marginally-more-similar one that merely co-occurs.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistActionValues,
  actionUplift,
  _resetActionValuesCache,
} from '../src/learning/action-values.js';
import { LocalReasoningBank, setActionUpliftBeta } from '../src/memory/intelligence.js';

let cwdRestore: string;
let tmpDir: string;
function setupTempCwd(): void {
  cwdRestore = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'action-values-'));
  process.chdir(tmpDir);
  _resetActionValuesCache();
  setActionUpliftBeta(null);
}
function cleanupTempCwd(): void {
  process.chdir(cwdRestore);
  rmSync(tmpDir, { recursive: true, force: true });
  _resetActionValuesCache();
  setActionUpliftBeta(null);
}

const AV = (action: string, taskType: string | null, uplift: number) => ({
  action, taskType, uplift,
  meanReward: 0.5, samples: 10, baselineReward: 0.5, confidence: 0.5,
});

// 768-dim normalized vectors (matches EMBEDDING_DIM) so cosine is exact under
// either the canonical or fallback cosineSim impl.
const DIM = 768;
function vec(x: number, y: number): number[] {
  const v = new Array(DIM).fill(0);
  const n = Math.hypot(x, y) || 1;
  v[0] = x / n; v[1] = y / n;
  return v;
}

describe('action-values substrate (ADR-0280)', () => {
  beforeEach(setupTempCwd);
  afterEach(cleanupTempCwd);

  it('persists and reads back uplift keyed by (action, taskType)', () => {
    persistActionValues([AV('opus', 'deploy', 0.35), AV('haiku', 'deploy', -0.35)]);
    _resetActionValuesCache();
    expect(actionUplift('opus', 'deploy')).toBeCloseTo(0.35, 5);
    expect(actionUplift('haiku', 'deploy')).toBeCloseTo(-0.35, 5);
  });

  it('returns 0 for unknown action / taskType / empty action (graceful fallback)', () => {
    persistActionValues([AV('opus', 'deploy', 0.35)]);
    _resetActionValuesCache();
    expect(actionUplift('sonnet', 'deploy')).toBe(0); // unknown action
    expect(actionUplift('opus', 'frontend')).toBe(0); // unknown taskType, no null row
    expect(actionUplift('', 'deploy')).toBe(0);       // empty action
  });

  it('falls back to the taskType-agnostic (null) row when present', () => {
    persistActionValues([AV('coder', null, 0.4)]);
    _resetActionValuesCache();
    expect(actionUplift('coder', 'anything')).toBeCloseTo(0.4, 5);
  });

  it('clamps uplift to [-1, 1]', () => {
    persistActionValues([AV('x', 't', 5), AV('y', 't', -5)]);
    _resetActionValuesCache();
    expect(actionUplift('x', 't')).toBe(1);
    expect(actionUplift('y', 't')).toBe(-1);
  });

  it('absent file → uplift 0 (no behavior change)', () => {
    expect(actionUplift('opus', 'deploy')).toBe(0);
  });
});

describe('LocalReasoningBank — action-uplift rerank (ADR-0280)', () => {
  beforeEach(setupTempCwd);
  afterEach(cleanupTempCwd);

  const QUERY = vec(1, 0);
  // A: cosine 0.9, low-uplift agent. B: cosine 0.8, high-uplift agent.
  const setupBank = (): LocalReasoningBank => {
    const bank = new LocalReasoningBank({ maxSize: 10, persistence: false });
    bank.store({ id: 'A', type: 'route', content: 'A', embedding: vec(0.9, Math.sqrt(0.19)), confidence: 0.5, metadata: { agent: 'researcher' } });
    bank.store({ id: 'B', type: 'route', content: 'B', embedding: vec(0.8, 0.6), confidence: 0.5, metadata: { agent: 'coder' } });
    return bank;
  };

  it('β=0 (default): pure cosine — higher-cosine A ranks first', () => {
    persistActionValues([AV('researcher', 'backend', -0.1), AV('coder', 'backend', 0.5)]);
    _resetActionValuesCache();
    setActionUpliftBeta(0);
    const res = setupBank().findSimilar(QUERY, { k: 2, taskType: 'backend' });
    expect(res.map(r => r.id)).toEqual(['A', 'B']);
  });

  it('β>0: a de-confounded high-uplift pattern (B) outranks higher-cosine A', () => {
    persistActionValues([AV('researcher', 'backend', -0.1), AV('coder', 'backend', 0.5)]);
    _resetActionValuesCache();
    setActionUpliftBeta(0.5);
    const res = setupBank().findSimilar(QUERY, { k: 2, taskType: 'backend' });
    // A rank = 0.9 + 0.5·(−0.1) = 0.85; B rank = 0.8 + 0.5·(0.5) = 1.05 → B first
    expect(res.map(r => r.id)).toEqual(['B', 'A']);
    // cosine stays the returned confidence (relevance floor unchanged)
    expect(res.find(r => r.id === 'B')!.confidence).toBeCloseTo(0.8, 5);
  });

  it('uplift never sneaks a sub-threshold pattern past the cosine floor', () => {
    const bank = new LocalReasoningBank({ maxSize: 10, persistence: false });
    bank.store({ id: 'lowcos', type: 'route', content: 'lowcos', embedding: vec(0.1, Math.sqrt(0.99)), confidence: 0.5, metadata: { agent: 'coder' } });
    persistActionValues([AV('coder', 'backend', 1)]); // max uplift
    _resetActionValuesCache();
    setActionUpliftBeta(1);
    // cosine 0.1 < threshold 0.3 → filtered out despite the +1 uplift
    expect(bank.findSimilar(QUERY, { k: 5, threshold: 0.3, taskType: 'backend' })).toHaveLength(0);
  });

  it('β>0 but no taskType → pure cosine (blend needs the context)', () => {
    persistActionValues([AV('coder', 'backend', 0.5)]);
    _resetActionValuesCache();
    setActionUpliftBeta(0.5);
    const res = setupBank().findSimilar(QUERY, { k: 2 }); // no taskType
    expect(res.map(r => r.id)).toEqual(['A', 'B']);
  });
});
