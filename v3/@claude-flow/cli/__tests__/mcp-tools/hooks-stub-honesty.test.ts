/**
 * ADR-0210 — stub honesty envelope mandate (per-handler dispositions).
 *
 * Behavior tests asserting real outcomes for each handler the ADR
 * dispositions:
 *
 *   - hooks_explain         (item 1; hand-port real matchScore + outcomes)
 *   - hooks_pretrain        (item 1; hand-port FS scan; store via routeMemoryOp)
 *   - hooks_intelligence-reset (item 1; real unlinkSync + activeTrajectories.clear)
 *   - hooks_list            (item 2; live-registry filter, not literal 26)
 *   - hooks_init            (item 2; writeFileSync settings.json — real disk effect)
 *   - hooks_build-agents    (item 3; delete fabricated patternsApplied sub-field)
 *   - hooks_notify          (item 4; honest _note marker — no delivery backend)
 *   - hooks_session-restore (F-01-004; drop faked originalSessionId)
 *   - hooks_session-end     (F-03-013; real duration or _note honest)
 *   - hooks_post-task       (F-02-007; real trajectoryId from active trajectory
 *                            registry, NOT `traj-${Date.now()}`)
 *   - hooks_worker-detect   (F-03-007; delete fake setTimeout(1500) completion)
 *
 * Per ADR-0210 Confirmation: "Behaviour, not syntax: integration tests
 * assert real outcomes." This file's tests exercise each handler via
 * direct import (the same surface `callMCPTool` reaches) and assert
 * either a real-disk/real-state effect OR an honest `_note` marker.
 *
 * Out of scope (per ADR-0210):
 *   - Tool description rewrites (item 6) — covered by description-honesty
 *     ledger; landing the dispositions first.
 *   - `coordination_orchestrate` (already partial-real; not in scope).
 *   - performance_bottleneck/profile/optimize (item 5; perf-tools.ts —
 *     not in this commit's surface).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  hooksList,
  hooksInit,
  hooksExplain,
  hooksPretrain,
  hooksIntelligenceReset,
  hooksBuildAgents,
  hooksNotify,
  hooksSessionRestore,
  hooksSessionEnd,
  hooksPostTask,
  hooksWorkerDetect,
  hooksWorkerStatus,
} from '../../src/mcp-tools/hooks-tools.js';
// NOTE: NOT importing `listMCPTools` from `../../src/mcp-client.js` —
// that module pulls `archivist-init.ts` which has a pre-baseline
// `agentdb/archivist` resolution issue under vitest's transformer
// (orthogonal to this ADR; same baseline failure as
// commands-deep.test.ts / worker-daemon-resource-thresholds.test.ts).
// For hooks_list we assert structural properties instead of a strict
// cardinality match against the live registry.

// Sandbox is an absolute path; we never chdir (vitest's worker pool
// blocks `process.chdir()`). Handlers that take a `path` param receive
// `sandbox` directly. Handlers keyed on `findProjectRoot()` resolve via
// `process.env.CLAUDE_FLOW_CWD` (ADR-0100's documented override) — set
// per-test so the sandbox is the project root.
let sandbox: string;
let prevCwdEnv: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'r5-adr0210-'));
  writeFileSync(join(sandbox, '.ruflo-project'), '');
  prevCwdEnv = process.env.CLAUDE_FLOW_CWD;
  process.env.CLAUDE_FLOW_CWD = sandbox;
});

afterEach(() => {
  if (prevCwdEnv === undefined) delete process.env.CLAUDE_FLOW_CWD;
  else process.env.CLAUDE_FLOW_CWD = prevCwdEnv;
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// item 2: hooks_list — live registry filter (not literal 26)
// ---------------------------------------------------------------------------

describe('ADR-0210 item 2 — hooks_list returns live-registry count', () => {
  it('hooks_list.total equals hooks.length (derived, not hardcoded literal)', async () => {
    const result = await hooksList.handler({}) as { hooks: unknown[]; total: number };
    // The honest disposition derives `total` from `hooks.length`. A
    // regression hardcoding `total: <N>` will desync from the array
    // length on the next edit. Pin equality at runtime AND assert the
    // source contains no `total: <literal>` line in this handler (the
    // arch-side pin lives in the source-scan below).
    expect(result.total).toBe(result.hooks.length);
    expect(result.hooks.length).toBeGreaterThan(0);
  });

  it('hooks_list source has no hardcoded `total: <literal>` line', () => {
    // Source-side pin: the handler must compute total from hooks.length,
    // not a numeric literal. Catches the prior `total: 26` regression
    // even when the array length happens to equal the literal.
    const src = readFileSync(
      new URL('../../src/mcp-tools/hooks-tools.ts', import.meta.url),
      'utf8',
    );
    // Slice from the `name: 'hooks_list'` line to the next handler-end
    // ('};'). Within that block, any non-comment `total: <integer>`
    // line is the regression. Strip line-comments before checking so
    // ADR commentary that mentions the old literal does not false-positive.
    const m = src.match(/name:\s*'hooks_list'[\s\S]*?\n\};/);
    expect(m, 'expected to find the hooks_list handler block').not.toBeNull();
    const block = m![0];
    const codeOnly = block
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(codeOnly).not.toMatch(/\btotal:\s*\d+\b/);
  });
});

// ---------------------------------------------------------------------------
// item 2: hooks_init — writes real settings.json
// ---------------------------------------------------------------------------

describe('ADR-0210 item 2 — hooks_init writes a real settings.json to disk', () => {
  it('hooks_init persists .claude/settings.json under the requested path', async () => {
    const targetPath = sandbox;
    const result = await hooksInit.handler({ path: targetPath, template: 'minimal' }) as {
      path: string;
      created: { settingsJson: string };
    };
    // Real disk effect: the file claimed in `created.settingsJson` must
    // actually exist after the call. A fabricated handler returns the
    // path string without writing the file.
    expect(result.created.settingsJson).toBeTruthy();
    expect(existsSync(result.created.settingsJson)).toBe(true);
    // The contents must be valid JSON with a `hooks` block.
    const parsed = JSON.parse(readFileSync(result.created.settingsJson, 'utf-8'));
    expect(parsed).toHaveProperty('hooks');
  });
});

// ---------------------------------------------------------------------------
// item 3: hooks_build-agents — fabricated patternsApplied removed
// ---------------------------------------------------------------------------

describe('ADR-0210 item 3 — hooks_build-agents drops fabricated patternsApplied', () => {
  it('hooks_build-agents result has no patternsApplied numeric stat', async () => {
    const outputDir = join(sandbox, 'agents');
    const result = await hooksBuildAgents.handler({ outputDir, persist: false, focus: 'all' }) as {
      stats: Record<string, unknown>;
    };
    // The fabricated `patternsApplied: count*3` is a multiplied literal
    // with no real provenance (no patterns were "applied"). The ADR's
    // disposition is surgical deletion (no marker needed; it's a
    // delete). Assert the key is gone.
    expect(result.stats).not.toHaveProperty('patternsApplied');
  });
});

// ---------------------------------------------------------------------------
// item 4: hooks_notify — honest _note marker (no delivery backend)
// ---------------------------------------------------------------------------

describe('ADR-0210 item 4 — hooks_notify carries honest _note marker', () => {
  it('hooks_notify does NOT advertise delivered:true (no backend)', async () => {
    const result = await hooksNotify.handler({ message: 'test' }) as Record<string, unknown>;
    // Upstream itself still hardcodes `delivered:true` (hooks-tools.ts:2067
    // in upstream HEAD per the ADR's 2nd-pass evidence) — there is no real
    // delivery to restore. The honest disposition is either delete the
    // tool OR mark `_note` pending. We chose mark; assert it.
    expect(result.delivered).not.toBe(true);
    expect(result).toHaveProperty('_note');
    expect(String(result._note)).toMatch(/no delivery backend|pending|stub|not implemented/i);
  });
});

// ---------------------------------------------------------------------------
// F-01-004: hooks_session-restore — no faked originalSessionId
// ---------------------------------------------------------------------------

describe('ADR-0210 F-01-004 — hooks_session-restore drops faked originalSessionId', () => {
  it('hooks_session-restore does NOT synthesize a fake session-Date.now()-86400000 id', async () => {
    const result = await hooksSessionRestore.handler({ sessionId: 'latest' }) as {
      originalSessionId?: string | null;
      _note?: string;
    };
    // The prior fabrication was `session-${Date.now() - 86400000}` —
    // a synthetic "yesterday" timestamp dressed as a real prior session.
    // Honest disposition: either return null/undefined for unknown OR
    // mark `_note` honest. Either way, the `Date.now()-86400000`
    // synthesis MUST be gone.
    if (result.originalSessionId) {
      // If the field is non-null, it must NOT be the synthesized form.
      // The synthesized form is "session-<thirteen-digit-timestamp>"
      // where the timestamp is ~24h in the past from now.
      const m = String(result.originalSessionId).match(/^session-(\d{13})$/);
      if (m) {
        const ts = Number(m[1]);
        const ageMs = Date.now() - ts;
        // Reject "exactly ~24h ago, synthesized just now". Real
        // restored session ids would either be `latest` echoed back
        // or a stored real id from prior session state.
        const looksSynthesized = Math.abs(ageMs - 86400000) < 5000;
        expect(looksSynthesized).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// F-03-013: hooks_session-end — real duration or honest _note
// ---------------------------------------------------------------------------

describe('ADR-0210 F-03-013 — hooks_session-end returns real duration or _note', () => {
  it('hooks_session-end does NOT hardcode duration: 3600000', async () => {
    const result = await hooksSessionEnd.handler({}) as { duration?: number; _note?: string };
    // The prior fabrication was `duration: 3600000` (1h) regardless of
    // session length. Honest dispositions: real duration computed from
    // a stored session-start, OR `_note`-marked unknown. Either way, the
    // exact-3600000 literal is gone.
    if (typeof result.duration === 'number') {
      expect(result.duration).not.toBe(3600000);
    }
  });
});

// ---------------------------------------------------------------------------
// F-02-007: hooks_post-task — real trajectoryId, not `traj-${Date.now()}`
// ---------------------------------------------------------------------------

describe('ADR-0210 F-02-007 — hooks_post-task surfaces a real trajectoryId or null', () => {
  it('hooks_post-task does NOT synthesize trajectoryId as `traj-${Date.now()}` literal', () => {
    // Source-side pin: the handler must NOT contain the synthesized
    // template `traj-${Date.now()}` in its return body. Runtime
    // invocation requires `routeFeedbackOp` (which depends on
    // `@claude-flow/memory/storage-factory` — pre-baseline vitest
    // resolution issue, orthogonal to ADR-0210), so we assert the
    // source has the disposition instead.
    const src = readFileSync(
      new URL('../../src/mcp-tools/hooks-tools.ts', import.meta.url),
      'utf8',
    );
    // Slice the hooks_post-task handler block.
    const m = src.match(/name:\s*'hooks_post-task'[\s\S]*?\n\};/);
    expect(m, 'expected to find the hooks_post-task handler block').not.toBeNull();
    const block = m![0];
    // Strip line comments so commentary describing the old literal
    // doesn't false-positive.
    const codeOnly = block
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    // Pin: no `trajectoryId: \`traj-${Date.now()}\`` synthesis in code.
    // The real disposition uses the active-trajectory registry.
    expect(codeOnly).not.toMatch(/trajectoryId:\s*`traj-\$\{Date\.now\(\)\}`/);
    // And the block must reference the activeTrajectories lookup we
    // wired (positive pin that the disposition is implemented, not
    // just textually absent).
    expect(codeOnly).toMatch(/activeTrajectories/);
  });
});

// ---------------------------------------------------------------------------
// F-03-007: hooks_worker-detect — no fake setTimeout(1500) completion
// ---------------------------------------------------------------------------

describe('ADR-0210 F-03-007 — hooks_worker-detect does NOT flip workers to completed via setTimeout', () => {
  it('autoDispatched workers are honest about their dispatch path', async () => {
    const result = await hooksWorkerDetect.handler({
      prompt: 'optimize the codebase performance',
      autoDispatch: true,
      minConfidence: 0,  // accept any detection
    }) as { autoDispatched?: boolean; workerIds?: string[] };
    // The prior fabrication was `setTimeout(() => { ... status='completed' }, 1500)`
    // — a fake completion flip with no real work. The disposition is to
    // DELETE the fake flip; honest workers stay `pending`/`queued` (the
    // ADR-0218 queue producer's real path) or fall back to honest
    // `mcp-only` / `no-daemon`. Wait briefly to ensure the prior
    // setTimeout would have fired (if still present); then assert no
    // synthesized "completed" status was injected without real work.
    if (result.autoDispatched && result.workerIds && result.workerIds.length > 0) {
      await new Promise((r) => setTimeout(r, 1700));
      // Inspect activeWorkers via hooks_worker-status (in-process Map
      // shared with worker-detect, set during autoDispatch).
      for (const workerId of result.workerIds) {
        const status = await hooksWorkerStatus.handler({ workerId }) as { worker?: { status: string } };
        if (status.worker) {
          // The fake flip set status to 'completed' after 1500ms with
          // no real work done. Reject that exact regression. Honest
          // statuses are pending/queued/no-daemon/mcp-only/failed.
          // (A real completion via the daemon queue is fine; but in a
          // fresh sandbox with no daemon, completion can't be real.)
          expect(status.worker.status).not.toBe('completed');
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// item 1: hooks_explain — real matchScore (not Math.random)
// ---------------------------------------------------------------------------

describe('ADR-0210 item 1 — hooks_explain uses real matchScore (not Math.random)', () => {
  it('hooks_explain matchScore is deterministic for the same input', async () => {
    // Use a task whose words match TASK_PATTERNS keys ("security-task")
    // so the loop emits at least one matched pattern (the body that
    // carried the `Math.random()` fabrication). Falling back to
    // `general-task` would only return a single literal 0.7 score and
    // hide the regression.
    const task = 'security-task work on user authentication';
    const a = await hooksExplain.handler({ task }) as {
      patterns: Array<{ matchScore: number }>;
    };
    const b = await hooksExplain.handler({ task }) as {
      patterns: Array<{ matchScore: number }>;
    };
    // The prior fabrication was `matchScore: 0.85 + Math.random() * 0.1`
    // — two calls with identical input returned different scores.
    // Upstream's real impl computes `pattern.length / max(taskLower.length,1)`,
    // which is deterministic. Pin determinism on a matched-pattern result.
    expect(a.patterns.length).toBe(b.patterns.length);
    expect(a.patterns.length).toBeGreaterThan(0);
    for (let i = 0; i < a.patterns.length; i++) {
      expect(a.patterns[i].matchScore).toBeCloseTo(b.patterns[i].matchScore, 10);
    }
  });
});

// ---------------------------------------------------------------------------
// item 1: hooks_intelligence-reset — real unlinkSync
// ---------------------------------------------------------------------------

describe('ADR-0210 item 1 — hooks_intelligence-reset performs real deletions', () => {
  it('hooks_intelligence-reset actually deletes data files when present', async () => {
    const dataDir = join(sandbox, '.claude-flow', 'data');
    mkdirSync(dataDir, { recursive: true });
    const targetFile = join(dataDir, 'auto-memory-store.json');
    writeFileSync(targetFile, JSON.stringify({ canary: true }));
    expect(existsSync(targetFile)).toBe(true);

    const result = await hooksIntelligenceReset.handler({}) as {
      cleared: Record<string, unknown>;
      deletedFiles?: string[];
    };
    // Real deletion effect: the file we created must be gone.
    expect(existsSync(targetFile)).toBe(false);
    // The cleared report must NOT be the fabricated `trajectories: 156,
    // patterns: 89, hnswIndex: 12500` triplet. Either a real count OR
    // an honest `_note` is acceptable.
    expect(result.cleared).not.toMatchObject({ trajectories: 156, patterns: 89, hnswIndex: 12500 });
  });
});

// ---------------------------------------------------------------------------
// item 1: hooks_pretrain — real FS scan (not 42 * multiplier literal)
// ---------------------------------------------------------------------------

describe('ADR-0210 item 1 — hooks_pretrain performs a real FS scan', () => {
  it('hooks_pretrain.stats.filesAnalyzed reflects actual files in the path', async () => {
    // Create a small fixture corpus
    writeFileSync(join(sandbox, 'a.ts'), 'import { x } from "y";\nexport const a = 1;\n');
    writeFileSync(join(sandbox, 'b.js'), 'const b = require("c");\n');
    writeFileSync(join(sandbox, 'c.md'), '# readme\n');

    const result = await hooksPretrain.handler({ path: sandbox, depth: 'shallow' }) as {
      stats: { filesAnalyzed: number };
    };
    // The prior fabrication returned `filesAnalyzed: 42 * multiplier`
    // regardless of corpus contents. Pin: the real scan must surface
    // the actual fixture count (3 files in the sandbox root), NOT 42.
    expect(result.stats.filesAnalyzed).toBeGreaterThan(0);
    expect(result.stats.filesAnalyzed).toBeLessThan(42); // sandbox has 3 files, not 42+
  });
});
