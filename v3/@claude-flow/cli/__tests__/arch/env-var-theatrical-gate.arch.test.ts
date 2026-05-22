/**
 * Arch-test: theatrical-var gate for init-generated env vars (ADR-0214).
 *
 * Every env var that init writes into:
 *   1. `.mcp.json -> mcpServers.ruflo.env`  (via `generateMCPConfig`)
 *   2. `.claude/settings.json -> env`        (via `generateSettings`)
 * MUST have at least one non-test, non-dist source consumer that reads it,
 * or be on the explicit allow-list.
 *
 * Allow-list:
 *  - Anything in the `CLAUDE_CODE_*` namespace — owned/read by Claude Code,
 *    not ruflo (out of this ADR's scope).
 *  - Anything in the `npm_config_*` namespace — owned/read by npm itself
 *    (e.g. `npm_config_update_notifier=false` silences the update notifier
 *    when ruflo spawns subprocesses via npx). Same rationale as
 *    `CLAUDE_CODE_*`: foreign namespace, not a ruflo theatrical knob.
 *  - Anything matching the `CLAUDE_FLOW_ENABLE_*` prefix — the
 *    `feature-flags.ts` module reads these via a dynamic template loop
 *    (`process.env[\`CLAUDE_FLOW_${flag}\`]`) which a literal `process.env.X`
 *    grep can't see. (Init injects ZERO `ENABLE_*` vars today, so this
 *    allowance is a safety net for future regressions, not a current
 *    blanket exemption.)
 *
 * The gate explicitly fails on `CLAUDE_FLOW_MODE`, `CLAUDE_FLOW_HOOKS_ENABLED`,
 * `CLAUDE_FLOW_TOPOLOGY` (old writer name), `CLAUDE_FLOW_MEMORY_BACKEND`
 * (old writer name), `CLAUDE_FLOW_V3_ENABLED`, the 9 `GUIDANCE_*` vars, and
 * `CLAUDE_FLOW_TOKEN` — all of which had zero consumers per the F-14-001/003
 * audit + second-pass review. After the ADR-0214 fix these names no longer
 * appear in the writers; the gate keeps them out on every future re-sync.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMCPConfig } from '../../src/init/mcp-generator.js';
import { generateSettings } from '../../src/init/settings-generator.js';
import { findImports } from '../helpers/imports.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve fork root: __tests__/arch/ -> __tests__/ -> cli/ -> @claude-flow/ -> v3/ -> ruflo/
const CLI_PKG_DIR = resolve(__dirname, '../..');
const V3_ROOT = resolve(CLI_PKG_DIR, '..');

const SUBSTRATE_ROOTS = [
  resolve(V3_ROOT, 'aidefence/src'),
  resolve(V3_ROOT, 'cli/src'),
  resolve(V3_ROOT, 'cli-core/src'),
  resolve(V3_ROOT, 'config-chain/src'),
  resolve(V3_ROOT, 'embeddings/src'),
  resolve(V3_ROOT, 'guidance/src'),
  resolve(V3_ROOT, 'hooks/src'),
  resolve(V3_ROOT, 'integration/src'),
  resolve(V3_ROOT, 'mcp/src'),
  resolve(V3_ROOT, 'memory/src'),
  resolve(V3_ROOT, 'neural/src'),
  resolve(V3_ROOT, 'plugins/src'),
  resolve(V3_ROOT, 'security/src'),
  resolve(V3_ROOT, 'shared/src'),
  resolve(V3_ROOT, 'swarm/src'),
];

/** Minimum InitOptions for invoking generators. Real consumers pass more. */
function makeInitOptions(): any {
  return {
    mcp: { claudeFlow: true, ruvSwarm: false, flowNexus: false, autoStart: true, port: 3000 },
    runtime: {
      topology: 'hierarchical-mesh',
      maxAgents: 15,
      memoryBackend: 'hybrid',
      enableHNSW: true,
      enableLearningBridge: true,
      enableMemoryGraph: true,
      enableAgentScopes: true,
      enableNeural: true,
    },
    components: { settings: true, helpers: true, statusline: false },
    statusline: { enabled: false },
    hooks: {
      preToolUse: true,
      postToolUse: true,
      userPromptSubmit: true,
      sessionStart: true,
      stop: true,
      preCompact: true,
      notification: true,
      timeout: 30000,
    },
    skills: { all: false },
  };
}

/** Walk both init writers, gather every emitted env-var name. */
function collectEmittedEnvVars(): string[] {
  const opts = makeInitOptions();
  const names = new Set<string>();

  const mcp = generateMCPConfig(opts) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  for (const server of Object.values(mcp.mcpServers ?? {})) {
    for (const name of Object.keys(server.env ?? {})) {
      names.add(name);
    }
  }

  const settings = generateSettings(opts) as { env?: Record<string, string> };
  for (const name of Object.keys(settings.env ?? {})) {
    names.add(name);
  }

  return Array.from(names).sort();
}

/**
 * Look for a literal/bracket/template consumer of `varName` in the substrate.
 * Matches:
 *   - `process.env.VAR`
 *   - `process.env['VAR']` / `process.env["VAR"]`
 *   - `process.env[\`VAR\`]`
 */
function hasConsumer(varName: string, allowlistTemplatePrefixes: string[]): boolean {
  // Template-prefix shortcut: e.g. `CLAUDE_FLOW_ENABLE_FOO` matches the
  // dynamic `process.env[\`CLAUDE_FLOW_${flag}\`]` loop.
  for (const prefix of allowlistTemplatePrefixes) {
    if (varName.startsWith(prefix)) {
      const suffix = varName.slice(prefix.length);
      // The dynamic loop accesses CLAUDE_FLOW_ENABLE_* — match by prefix.
      // Real check that this loop exists:
      const dynLoop = new RegExp(`process\\.env\\[\\s*\`${prefix.replace(/_/g, '_')}\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}\``);
      const dynLoopMatches = findImports({
        roots: SUBSTRATE_ROOTS,
        patterns: [dynLoop],
      });
      if (dynLoopMatches.length > 0 && suffix.length > 0) return true;
    }
  }

  const literal = new RegExp(`process\\.env\\.${varName}\\b`);
  const bracket = new RegExp(`process\\.env\\[['"\`]${varName}['"\`]\\]`);

  const matches = findImports({
    roots: SUBSTRATE_ROOTS,
    patterns: [literal, bracket],
  });
  return matches.length > 0;
}

describe('arch-test: theatrical env-var gate (ADR-0214)', () => {
  it('every env var written into .mcp.json + settings.json has a consumer or allow-list match', () => {
    const emitted = collectEmittedEnvVars();
    const offenders: string[] = [];

    for (const name of emitted) {
      // Allow-list 1: CLAUDE_CODE_* is owned by Claude Code, not ruflo.
      if (name.startsWith('CLAUDE_CODE_')) continue;

      // Allow-list 2: npm_config_* is owned by npm itself.
      if (name.startsWith('npm_config_')) continue;

      // Allow-list 3: CLAUDE_FLOW_ENABLE_* matches the dynamic-prefix loop
      // in feature-flags.ts (init writes ZERO such vars today, so this is a
      // safety net for future regressions). hasConsumer() checks that the
      // template loop actually exists in the substrate before whitelisting.
      if (hasConsumer(name, ['CLAUDE_FLOW_ENABLE_'])) continue;

      // Literal/bracket consumer required.
      if (!hasConsumer(name, [])) {
        offenders.push(name);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `Theatrical env vars (no source consumer in shipping code) found in init output ` +
        `(ADR-0214 Confirmation #1):\n  ${offenders.join('\n  ')}\n\n` +
        `Either wire a real consumer or drop the var from the writer.`,
      );
    }

    expect(offenders).toEqual([]);
  });

  it('init no longer emits the 5 theatrical CLAUDE_FLOW_* vars + 9 GUIDANCE_* + CLAUDE_FLOW_TOKEN', () => {
    const emitted = new Set(collectEmittedEnvVars());

    // Specific names called out in the F-14-001/003 audit + second-pass review.
    const mustNotEmit = [
      'CLAUDE_FLOW_MODE',
      'CLAUDE_FLOW_HOOKS_ENABLED',
      'CLAUDE_FLOW_TOPOLOGY',          // old writer name (now SWARM_TOPOLOGY)
      'CLAUDE_FLOW_MEMORY_BACKEND',    // old writer name (now MEMORY_TYPE)
      'CLAUDE_FLOW_V3_ENABLED',
      'CLAUDE_FLOW_TOKEN',
      'GUIDANCE_EVENT_WIRING_ENABLED',
      'GUIDANCE_PRE_EDIT_HOOK',
      'GUIDANCE_POST_COMMAND_SENTINEL',
      'GUIDANCE_TEAMMATE_IDLE_HOOK',
      'GUIDANCE_POST_TOOL_FAILURE',
      'GUIDANCE_SESSION_SENTINEL',
      'GUIDANCE_AUTO_MEMORY',
      'GUIDANCE_LEARNING_BRIDGE',
      'GUIDANCE_STATUS_LINE',
    ];

    const stillEmitted = mustNotEmit.filter(name => emitted.has(name));
    expect(stillEmitted).toEqual([]);
  });

  it('init emits the canonical reader names (SWARM_TOPOLOGY + MEMORY_TYPE) so loader.ts reads init defaults', () => {
    const emitted = new Set(collectEmittedEnvVars());
    expect(emitted.has('CLAUDE_FLOW_SWARM_TOPOLOGY')).toBe(true);
    expect(emitted.has('CLAUDE_FLOW_MEMORY_TYPE')).toBe(true);
    // MAX_AGENTS stays — loader.ts reads it (no rename needed).
    expect(emitted.has('CLAUDE_FLOW_MAX_AGENTS')).toBe(true);
  });
});
