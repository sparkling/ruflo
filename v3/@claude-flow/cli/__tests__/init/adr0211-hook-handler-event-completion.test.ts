/**
 * ADR-0211 — init-emitted hook handler event completion (Option C′).
 *
 * The init template emits `.claude/settings.json` wiring 16 hook
 * subcommands to a locally-generated `.claude/helpers/hook-handler.mjs`,
 * which implements 11. Six events fell through to a `[OK] Hook:` no-op
 * (F-02-008); separately, the `post-task` handler hardcoded
 * `intelligence.feedback(true)` regardless of outcome (F-02-009).
 *
 * Option C′: implement the high-value events locally (post-command,
 * pre-edit, notify); trim the no-backend events (user-prompt,
 * teammate-idle, post-tool-failure); remove the fallthrough; fix
 * feedback(true) -> feedback(success); add a build-time subset test.
 *
 * Per ADR Confirmation:
 *   1. Build-time subset test (primary drift guard).
 *   2. `post-command` local effect (file sidecar).
 *   3. `pre-edit` real FS check (not stubbed `fileExists:true`).
 *   4. Trim verification (3 events absent from settings; no
 *      `[OK] Hook:` fallthrough).
 *   5. `feedback(success)` from `tool_response` stdin payload (NOT
 *      hardcoded `true`).
 *   6. Daemon-safety guard (no RVF lock acquisition from any handler).
 */

import { describe, it, expect } from 'vitest';
import { generateHookHandler, generateIntelligenceStub } from '../../src/init/helpers-generator.js';
import { generateSettings } from '../../src/init/settings-generator.js';

// Minimal InitOptions builder — enable all hook surfaces so we can
// audit the full settings-vs-handlers subset at the most-permissive
// expansion.
function buildMaxOptions() {
  return {
    components: {
      settings: true,
      helpers: true,
      statusline: false,
      skills: false,
      commands: false,
      agents: false,
      mcp: false,
      runtime: false,
      embeddings: false,
    },
    hooks: {
      preToolUse: true,
      postToolUse: true,
      userPromptSubmit: true,
      sessionStart: true,
      stop: true,
      preCompact: true,
      notification: true,
      teammateIdle: true,
      taskCompleted: true,
      permissionRequest: true,
      bridgeFallback: false,
      enabled: true,
      autoExecute: true,
      timeout: 5000,
      continueOnError: false,
    },
    skills: { core: false },
    commands: { core: false },
    agents: { core: false },
    statusline: { enabled: false },
    mcp: {},
    runtime: {},
    embeddings: {},
    attribution: false,
  } as any;
}

// Extract subcommand tokens from a settings `hooks` block. Each entry
// looks like:
//   { type: 'command', command: 'sh -c \'... node "$D/.claude/helpers/hook-handler.mjs" <subcmd>\'' }
// We want just `<subcmd>` (the first arg after the script path).
function extractSubcommandsFromSettings(settings: any): string[] {
  const subs = new Set<string>();
  function walk(node: any): void {
    if (!node) return;
    if (Array.isArray(node)) { for (const v of node) walk(v); return; }
    if (typeof node !== 'object') return;
    if (typeof node.command === 'string') {
      // Hook command lines invoke `node "$D/.claude/helpers/hook-handler.mjs" <subcmd> [args...]`
      // — the closing `"` immediately follows `.mjs`, so allow it.
      const m = node.command.match(/hook-handler\.(?:mjs|cjs)["']?\s+([\w-]+)/);
      if (m) subs.add(m[1]);
    }
    for (const v of Object.values(node)) walk(v as any);
  }
  walk(settings.hooks ?? {});
  return [...subs];
}

// Extract handler keys from the generated hook-handler.mjs source. The
// handlers object is `const handlers = { 'route': ..., 'pre-bash': ..., }`.
function extractHandlerKeysFromHandlerSrc(src: string): string[] {
  const block = src.match(/const handlers = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('handlers object not found in generated handler');
  const keys = new Set<string>();
  // Match `'<key>'` or `"<key>"` followed by `:` at start of an entry.
  const keyRe = /^\s*['"]([a-z][\w-]+)['"]\s*:/gm;
  for (const m of block[1].matchAll(keyRe)) keys.add(m[1]);
  return [...keys];
}

describe('ADR-0211 — init hook handler completion (Option C′)', () => {
  it('Confirmation #1: every settings hook subcommand has a handler (subset test)', () => {
    const opts = buildMaxOptions();
    const settings = generateSettings(opts) as any;
    const handlerSrc = generateHookHandler();
    const settingsSubs = extractSubcommandsFromSettings(settings);
    const handlerKeys = new Set(extractHandlerKeysFromHandlerSrc(handlerSrc));

    const missing = settingsSubs.filter((s) => !handlerKeys.has(s));
    expect(
      missing,
      `Settings wires subcommand(s) with no handler: ${missing.join(', ')}.\n` +
        `Either implement them in helpers-generator's handlers map OR trim them from settings-generator (with rationale comment).`,
    ).toEqual([]);
  });

  // Helper: strip line + block comments from a generated-source slice
  // so handler-body assertions don't false-positive on commentary that
  // mentions banned tokens (e.g. "// no memory-router" mentions
  // `memory-router` in a comment by design).
  function stripComments(src: string): string {
    // Remove block comments first (multi-line).
    let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
    // Then strip line comments (single-line) — but inside string
    // literals, `//` isn't a comment, so we keep this simple by only
    // stripping comments that appear after the source's `'` quote
    // boundary on the left. The generated handler source is built as
    // an array of JS-string lines; in the resolved-source view of
    // helpers-generator.ts, each line is wrapped in `'` or `"`. We
    // accept the trade-off that this stripper is approximate; we use
    // it for keyword scans where false-positives mostly come from
    // commentary.
    out = out
      .split('\n')
      .map((line) => line.replace(/(?:^|[^:'"])\/\/.*$/, (m) => m.startsWith('/') ? '' : m[0]))
      .join('\n');
    return out;
  }

  it('Confirmation #2: post-command handler is present and writes a local sidecar', () => {
    const src = generateHookHandler();
    const keys = new Set(extractHandlerKeysFromHandlerSrc(src));
    expect(keys.has('post-command')).toBe(true);
    // The handler body must do real local I/O (filesystem-based
    // pending-insights sidecar idiom, mirroring post-edit), NOT call
    // memory-router / RVF lock paths. Pin the local-idiom: it must
    // reference at least one helper module (intelligence / session /
    // memory) and MUST NOT do a real `require('../memory/memory-router')`
    // or `import('memory-router')` (we exclude commentary mentions).
    const block = src.match(/'post-command':\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},/);
    expect(block, 'post-command handler body must exist').not.toBeNull();
    const body = stripComments(block![1]);
    // Must reference a local helper (no MCP delegation / cold-spawn)
    expect(body).toMatch(/intelligence|session|memory/);
    // MUST NOT call/import memory-router in real code (the flock path).
    expect(body).not.toMatch(/require\(['"][^'"]*memory-router/);
    expect(body).not.toMatch(/import\(['"][^'"]*memory-router/);
    expect(body).not.toMatch(/ensureRvfWired\(/);
  });

  it('Confirmation #3: pre-edit handler is present and performs a real FS check', () => {
    const src = generateHookHandler();
    const keys = new Set(extractHandlerKeysFromHandlerSrc(src));
    expect(keys.has('pre-edit')).toBe(true);
    // The handler body must reference fs (existsSync / statSync) for
    // the real check — the upstream MCP `hooks_pre-edit` stub hardcodes
    // `fileExists:true`; the local handler must do better.
    const block = src.match(/'pre-edit':\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\},/);
    expect(block, 'pre-edit handler body must exist').not.toBeNull();
    const body = stripComments(block![1]);
    expect(body).toMatch(/existsSync|statSync|fs\./);
    expect(body).not.toMatch(/require\(['"][^'"]*memory-router/);
    expect(body).not.toMatch(/import\(['"][^'"]*memory-router/);
  });

  it('Confirmation #4: trimmed events are NOT wired in settings', () => {
    // The three fork-introduced, no-backend events must not appear in
    // any settings hook block (no handler, no purpose):
    //   - user-prompt   (duplicates the already-handled `route` on UserPromptSubmit)
    //   - teammate-idle (validator-rejected key; misnamed under SubagentStop)
    //   - post-tool-failure (disposition OPEN per ADR; default-trim until
    //     empirically verified to fire — re-introduce if a sandbox test
    //     proves PostToolUseFailure is invoked from settings.json)
    const opts = buildMaxOptions();
    const settings = generateSettings(opts) as any;
    const subs = extractSubcommandsFromSettings(settings);

    expect(subs).not.toContain('user-prompt');
    expect(subs).not.toContain('teammate-idle');
    expect(subs).not.toContain('post-tool-failure');
  });

  it('Confirmation #4 part 2: no `[OK] Hook:` fallthrough remains', () => {
    const src = stripComments(generateHookHandler());
    // The prior code fell through with:
    //   } else if (command) { console.log('[OK] Hook: ' + command); }
    // The fallthrough is a stub-success and must be removed. Strip
    // commentary first so our own ADR commentary doesn't false-positive
    // (the generator emits descriptive comments that mention the old
    // pattern).
    expect(src).not.toMatch(/\[OK\]\s*Hook:\s*\'\s*\+\s*command/);
  });

  it('Confirmation #4 part 3: no blanket `exit(0)` swallow on runtime errors', () => {
    const src = stripComments(generateHookHandler());
    // The prior code had: `main().catch(() => {}).finally(() => process.exit(0));`
    // — which silently exits 0 even when the handler throws. The fix
    // surfaces failures via non-zero exit or stderr; we pin away the
    // empty-catch swallow form.
    expect(src).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
  });

  it('Confirmation #5: post-task uses dynamic outcome from tool_response stdin, not hardcoded `true`', () => {
    const src = stripComments(generateHookHandler());
    // The prior bug: `intelligence.feedback(true)` regardless of outcome.
    // The fix must derive the boolean from the local handler's stdin
    // `tool_response` payload, NOT from a literal. Pin away the
    // hardcoded-true call (commentary-stripped so the ADR rationale
    // doesn't false-positive).
    expect(src).not.toMatch(/intelligence\.feedback\(\s*true\s*\)/);
    // And the handler must reference `tool_response` somewhere so the
    // outcome plumbing is wired.
    expect(src).toMatch(/tool_response|toolResponse/);
  });

  it('Confirmation #6 daemon-safety: handler imports only local helpers, no flock', () => {
    const src = stripComments(generateHookHandler());
    // The lock-free daemon-safe property is the load-bearing
    // architectural invariant. The generated handler must NOT acquire
    // the RVF flock from any code path — that would regress every
    // high-frequency hook to LockHeld under daemon-up mode. Pin away
    // real require/import calls (commentary-stripped).
    expect(src).not.toMatch(/\.rvf\.lock/);
    expect(src).not.toMatch(/getProcessArchivist\(/);
    expect(src).not.toMatch(/ensureRvfWired\(/);
    // Memory access stays through local helpers / file sidecars.
    expect(src).not.toMatch(/require\(['"][^'"]*memory-router/);
    expect(src).not.toMatch(/import\(['"][^'"]*memory-router/);
    // Imports must be limited to the local helper modules pattern.
    // The handler `require()`s only paths starting with the helpers
    // dir; pin that no external `require('@claude-flow/...')` etc.
    expect(src).not.toMatch(/require\(\s*['"]@claude-flow/);
    expect(src).not.toMatch(/require\(\s*['"]agentdb/);
    expect(src).not.toMatch(/require\(\s*['"]agentic-flow/);
  });
});
