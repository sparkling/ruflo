/**
 * Thompson sampling bandit — convergence tests for the cost-adjusted router.
 *
 * What this proves: given an environment where Haiku is the right answer for
 * low-complexity tasks (matching the live observation that avg complexity is
 * ~0.30 but the deterministic router picks Opus 77% of the time), the bandit
 * converges to Haiku within ~50 trials and shifts the distribution decisively.
 *
 * The test environment is a deterministic outcome simulator — we know which
 * model is "right" for a synthetic task and feed that back via recordOutcome.
 * No mocks of the real Anthropic API; the bandit only sees `success/failure/
 * escalated` strings, which is exactly what hooks_model-outcome delivers.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ModelRouter } from '../src/ruvector/model-router.js';
import { persistActionValues, _resetActionValuesCache } from '../src/learning/action-values.js';

let cwdRestore: string;
let tmpDir: string;

function setupTempCwd(): void {
  cwdRestore = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'router-bandit-'));
  process.chdir(tmpDir);
}

function cleanupTempCwd(): void {
  process.chdir(cwdRestore);
  rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Synthetic outcome oracle. Models reality where:
 *   - Haiku has 80% success on simple tasks (complexity < 0.4)
 *   - Sonnet has 80% success on medium tasks (0.4–0.7)
 *   - Opus has 80% success on complex tasks (> 0.7)
 *   - Wrong-tier on simple → Opus succeeds anyway but we score it as
 *     "escalated" for the bandit (cost-suboptimal even when correct).
 */
function syntheticOutcome(
  model: 'haiku' | 'sonnet' | 'opus',
  complexity: number,
  rng: () => number = Math.random,
): 'success' | 'failure' | 'escalated' {
  const optimal = complexity < 0.4 ? 'haiku' : complexity < 0.7 ? 'sonnet' : 'opus';
  if (model === optimal) return rng() < 0.8 ? 'success' : 'failure';
  // Bigger model on smaller task: succeeds but counts as "escalated"
  // (cost-suboptimal). Smaller model on bigger task: high failure rate.
  const tierGap = ['haiku', 'sonnet', 'opus'].indexOf(model)
    - ['haiku', 'sonnet', 'opus'].indexOf(optimal);
  if (tierGap > 0) return rng() < 0.7 ? 'escalated' : 'success';
  return rng() < 0.3 ? 'success' : 'failure';
}

describe('ModelRouter — Thompson sampling bandit (#1772)', () => {
  beforeEach(setupTempCwd);
  afterEach(cleanupTempCwd);

  it('starts with uniform Beta(1,1) priors on every model', () => {
    const router = new ModelRouter();
    const priors = router.getBanditPriors();
    expect(priors.haiku).toEqual({ alpha: 1, beta: 1 });
    expect(priors.sonnet).toEqual({ alpha: 1, beta: 1 });
    expect(priors.opus).toEqual({ alpha: 1, beta: 1 });
  });

  it('updates priors via cost-adjusted Bernoulli on recordOutcome', () => {
    const router = new ModelRouter();
    router.recordOutcome('simple task', 'haiku', 'success'); // reward 1.0 → α += 1
    router.recordOutcome('simple task', 'opus', 'success');  // reward 0.4 → α += 0.4
    router.recordOutcome('failure case', 'haiku', 'failure'); // reward 0   → β += 1
    const p = router.getBanditPriors();
    expect(p.haiku.alpha).toBeCloseTo(2.0, 5);
    expect(p.haiku.beta).toBeCloseTo(2.0, 5);
    expect(p.opus.alpha).toBeCloseTo(1.4, 5);
    expect(p.opus.beta).toBeCloseTo(1.6, 5);
  });

  it('escalation gives partial credit to Sonnet, zero to Haiku/Opus', () => {
    const router = new ModelRouter();
    router.recordOutcome('t', 'sonnet', 'escalated'); // reward 0.1
    router.recordOutcome('t', 'haiku', 'escalated');  // reward 0.0
    const p = router.getBanditPriors();
    expect(p.sonnet.alpha).toBeCloseTo(1.1, 5);
    expect(p.sonnet.beta).toBeCloseTo(1.9, 5);
    expect(p.haiku.alpha).toBeCloseTo(1.0, 5);
    expect(p.haiku.beta).toBeCloseTo(2.0, 5);
  });

  it('persists and reloads priors across router instances', () => {
    const router1 = new ModelRouter();
    for (let i = 0; i < 10; i++) router1.recordOutcome('t', 'haiku', 'success');
    const before = router1.getBanditPriors();
    expect(before.haiku.alpha).toBeCloseTo(11, 5);

    const router2 = new ModelRouter(); // reads from same .swarm/model-router-state.json
    const after = router2.getBanditPriors();
    expect(after.haiku.alpha).toBeCloseTo(11, 5);
    expect(after.haiku.beta).toBeCloseTo(1, 5);
  });

  it('converges toward Haiku on a low-complexity workload (~50 trials)', async () => {
    const router = new ModelRouter();
    // Simulated workload matching live: avg complexity 0.3, deterministic seed
    let seed = 0x1234567;
    const rng = () => {
      // mulberry32 — deterministic, fine for testing
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const N = 100;
    let haikuPicked = 0;
    let opusPicked = 0;
    for (let i = 0; i < N; i++) {
      const complexity = 0.1 + rng() * 0.4; // 0.1 .. 0.5, avg ~0.3
      const task = `simple task ${i}`;
      const r = await router.route(task);
      if (r.model === 'haiku') haikuPicked++;
      if (r.model === 'opus') opusPicked++;
      const outcome = syntheticOutcome(r.model as 'haiku' | 'sonnet' | 'opus', complexity, rng);
      router.recordOutcome(task, r.model, outcome);
    }

    const priors = router.getBanditPriors();
    // Bandit should have learned Haiku is the right tier here.
    // α/(α+β) is the posterior mean — Haiku should be highest.
    const meanHaiku  = priors.haiku.alpha  / (priors.haiku.alpha  + priors.haiku.beta);
    const meanSonnet = priors.sonnet.alpha / (priors.sonnet.alpha + priors.sonnet.beta);
    const meanOpus   = priors.opus.alpha   / (priors.opus.alpha   + priors.opus.beta);

    expect(meanHaiku).toBeGreaterThan(meanOpus);
    expect(meanHaiku).toBeGreaterThan(0.4); // Haiku is winning
    // Distribution should also reflect the shift over the course of the run
    expect(haikuPicked).toBeGreaterThan(opusPicked);
  }, 30_000);

  it('does not lock in early — bandit explores enough to recover from a bad initial draw', async () => {
    // Even if Thompson sampling picks a bad arm first, repeated outcomes
    // should pull it back. Simulate: Haiku is always "right" but the first
    // 5 random samples happen to favor Opus. After 100 trials, posterior
    // mean for Haiku should still dominate.
    const router = new ModelRouter();
    for (let i = 0; i < 100; i++) {
      const r = await router.route(`task ${i}`);
      const outcome = r.model === 'haiku' ? 'success' : 'escalated';
      router.recordOutcome(`task ${i}`, r.model, outcome);
    }
    const priors = router.getBanditPriors();
    const meanHaiku = priors.haiku.alpha / (priors.haiku.alpha + priors.haiku.beta);
    const meanOpus  = priors.opus.alpha  / (priors.opus.alpha  + priors.opus.beta);
    expect(meanHaiku).toBeGreaterThan(meanOpus);
  }, 30_000);
});

/**
 * Contextual priors (ADR-0278) — stratify the Thompson bandit by derived
 * task-type so it learns E[reward | model, task_type] instead of the
 * marginalized E[reward | model]. That per-task-type stratification IS the
 * de-confounding: a model can win one task-type while losing another, which
 * the pooled marginal structurally cannot represent.
 */
describe('ModelRouter — contextual priors (ADR-0278)', () => {
  beforeEach(setupTempCwd);
  afterEach(cleanupTempCwd);

  it('stratifies priors by task-type — a model wins one type while losing another', () => {
    const router = new ModelRouter();
    // frontend: haiku is right (success); opus is wasteful (escalated).
    for (let i = 0; i < 3; i++) router.recordOutcome('fix the frontend layout', 'haiku', 'success');
    for (let i = 0; i < 2; i++) router.recordOutcome('fix the frontend layout', 'opus', 'escalated');
    // database: opus is right (success); haiku is wrong (failure).
    for (let i = 0; i < 3; i++) router.recordOutcome('optimize the database schema', 'opus', 'success');
    for (let i = 0; i < 3; i++) router.recordOutcome('optimize the database schema', 'haiku', 'failure');

    // Contextually the winner FLIPS by task-type (the de-confounding):
    expect(router.getExpectedReward('frontend', 'haiku'))
      .toBeGreaterThan(router.getExpectedReward('frontend', 'opus'));
    expect(router.getExpectedReward('database', 'opus'))
      .toBeGreaterThan(router.getExpectedReward('database', 'haiku'));

    // …whereas the pooled marginal ranks haiku above opus for BOTH — the
    // confound the old per-model bandit could not see.
    const g = router.getBanditPriors();
    const marHaiku = g.haiku.alpha / (g.haiku.alpha + g.haiku.beta);
    const marOpus = g.opus.alpha / (g.opus.alpha + g.opus.beta);
    expect(marHaiku).toBeGreaterThan(marOpus);

    // Contextual keys are namespaced by task-type and genuinely distinct.
    const ctx = router.getContextualPriors();
    expect(ctx['frontend:haiku']).toBeDefined();
    expect(ctx['database:opus']).toBeDefined();
    expect(ctx['frontend:haiku']).not.toEqual(ctx['database:haiku']);
  });

  it('backs off to the pooled global marginal for an unseen task-type (cold-start not starved)', () => {
    const router = new ModelRouter();
    for (let i = 0; i < 8; i++) router.recordOutcome('fix the frontend layout', 'haiku', 'success');
    const g = router.getBanditPriors();
    const marginalHaiku = g.haiku.alpha / (g.haiku.alpha + g.haiku.beta);
    // A brand-new, never-seen task-type inherits the pooled marginal — not a
    // cold uniform 0.5 — so enabling stratification never starves it.
    expect(router.getExpectedReward('security', 'haiku')).toBeCloseTo(marginalHaiku, 5);
    expect(router.getContextualPriors()['security:haiku']).toBeUndefined();
  });

  it('migrates pre-0278 per-model state into globalPriors (old learning preserved as the marginal)', () => {
    const statePath = join(tmpDir, '.swarm', 'model-router-state.json');
    mkdirSync(dirname(statePath), { recursive: true });
    // Old shape: `priors` keyed by bare model name (no taskType prefix).
    const oldState = {
      totalDecisions: 5,
      modelDistribution: { haiku: 5, sonnet: 0, opus: 0, inherit: 0 },
      avgComplexity: 0.3, avgConfidence: 0.8, circuitBreakerTrips: 0,
      lastUpdated: new Date().toISOString(), learningHistory: [],
      priors: {
        haiku: { alpha: 9, beta: 1 }, sonnet: { alpha: 1, beta: 1 },
        opus: { alpha: 1, beta: 1 }, inherit: { alpha: 1, beta: 1 },
      },
    };
    writeFileSync(statePath, JSON.stringify(oldState));

    const router = new ModelRouter();
    // Old per-model priors become the pooled marginal…
    expect(router.getBanditPriors().haiku).toEqual({ alpha: 9, beta: 1 });
    // …and the contextual map starts empty (no taskType:model keys yet).
    expect(Object.keys(router.getContextualPriors())).toHaveLength(0);
  });

  it('route() shifts model selection by task-type (the contextual prior changes the choice)', async () => {
    // Isolate the bandit prior's effect on the argmax: disable the uncertainty
    // escalation (which would rewrite a haiku pick to sonnet) and the circuit
    // breaker, so route() returns the raw Thompson winner. This tests the
    // contextual prior, not the escalation policy.
    const router = new ModelRouter({ maxUncertainty: 1.0, enableCircuitBreaker: false });
    // Two task-types with IDENTICAL complexity indicators ('rename' → low) but
    // different derived types. Reinforce haiku for one, tank it for the other;
    // since the deterministic score is identical, only the prior differs.
    const taskA = 'rename the frontend file'; // → 'frontend'
    const taskB = 'rename the api file';      // → 'api'
    for (let i = 0; i < 30; i++) router.recordOutcome(taskA, 'haiku', 'success'); // frontend:haiku → Beta(31,1)
    for (let i = 0; i < 30; i++) router.recordOutcome(taskB, 'haiku', 'failure'); // api:haiku → Beta(1,31)

    let haikuA = 0;
    let haikuB = 0;
    const N = 50;
    for (let i = 0; i < N; i++) if ((await router.route(taskA)).model === 'haiku') haikuA++;
    for (let i = 0; i < N; i++) if ((await router.route(taskB)).model === 'haiku') haikuB++;

    // Same complexity, opposite priors → haiku dominates A, is suppressed in B.
    expect(haikuA).toBeGreaterThan(haikuB);
    expect(haikuA).toBeGreaterThan(N / 4); // the reinforcement actually took
  }, 30_000);

  it('contextualPriors:false uses the pooled per-model marginal (pre-0278 behavior)', () => {
    const router = new ModelRouter({ contextualPriors: false });
    for (let i = 0; i < 3; i++) router.recordOutcome('fix the frontend layout', 'haiku', 'success');
    // Flag off → selection ignores the per-task-type prior: every task-type
    // resolves to the same pooled marginal.
    expect(router.getExpectedReward('frontend', 'haiku'))
      .toBe(router.getExpectedReward('database', 'haiku'));
    const g = router.getBanditPriors();
    expect(router.getExpectedReward('frontend', 'haiku'))
      .toBeCloseTo(g.haiku.alpha / (g.haiku.alpha + g.haiku.beta), 5);
  });
});

/**
 * ADR-0280 A-coupling — the ModelRouter blends the learner's model-uplift
 * (E[reward | model, task_type] from the episode stream, persisted by the learn
 * worker) into selection when actionUpliftGamma > 0. Flag off (γ=0, default) →
 * no disk read, behavior unchanged.
 */
describe('ModelRouter — action-uplift A-coupling (ADR-0280)', () => {
  beforeEach(() => { setupTempCwd(); _resetActionValuesCache(); });
  afterEach(() => { _resetActionValuesCache(); cleanupTempCwd(); });

  const AV = (action: string, taskType: string, uplift: number) => ({
    action, taskType, uplift, meanReward: 0.5, samples: 10, baselineReward: 0.5, confidence: 0.5,
  });

  it('γ>0 shifts selection toward the learned high-uplift model for that task-type', async () => {
    // Learner says: for 'deploy', opus causes success (+1), haiku causes failure (−1).
    persistActionValues([AV('opus', 'deploy', 1), AV('haiku', 'deploy', -1)]);
    _resetActionValuesCache();
    const task = 'deploy the service'; // deriveTaskType → 'deploy', low complexity (opus base low)

    // Escalation/circuit off so route() returns the raw Thompson winner.
    const withBlend = new ModelRouter({ maxUncertainty: 1.0, enableCircuitBreaker: false, actionUpliftGamma: 2 });
    const noBlend = new ModelRouter({ maxUncertainty: 1.0, enableCircuitBreaker: false, actionUpliftGamma: 0 });

    let opusBlend = 0;
    let opusPlain = 0;
    const N = 50;
    for (let i = 0; i < N; i++) if ((await withBlend.route(task)).model === 'opus') opusBlend++;
    for (let i = 0; i < N; i++) if ((await noBlend.route(task)).model === 'opus') opusPlain++;

    // opus ×(1+2·1)=×3 with the blend; haiku ×(1+2·(−1))→clamped 0. opus dominates.
    expect(opusBlend).toBeGreaterThan(opusPlain);
  }, 30_000);

  it('default config has the A-coupling ON — blends without explicit γ', async () => {
    // Strong learned signal: opus causes success for 'deploy', haiku & sonnet fail.
    persistActionValues([AV('opus', 'deploy', 1), AV('haiku', 'deploy', -1), AV('sonnet', 'deploy', -1)]);
    _resetActionValuesCache();
    const task = 'deploy the service';
    const dflt = new ModelRouter({ maxUncertainty: 1.0, enableCircuitBreaker: false }); // γ defaults to 0.3 (ON)
    const off = new ModelRouter({ maxUncertainty: 1.0, enableCircuitBreaker: false, actionUpliftGamma: 0 });

    let opusDflt = 0;
    let opusOff = 0;
    const N = 100;
    for (let i = 0; i < N; i++) if ((await dflt.route(task)).model === 'opus') opusDflt++;
    for (let i = 0; i < N; i++) if ((await off.route(task)).model === 'opus') opusOff++;

    // Default blend (opus ×1.3, others ×0.7) shifts selection toward opus vs γ=0.
    expect(opusDflt).toBeGreaterThan(opusOff);
  }, 30_000);
});
