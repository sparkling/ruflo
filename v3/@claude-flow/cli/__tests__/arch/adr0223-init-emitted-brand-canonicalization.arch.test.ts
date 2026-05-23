/**
 * Arch-test: ADR-0223 — canonicalize init-emitted MCP commands + brand
 * hints to `@sparkleideas/ruflo` wrapper.
 *
 * Four init-emitted user-facing drifts from ADR-0143's canonical brand
 * are pinned here:
 *
 *   F-11-001 [HIGH H13] — `mcp-generator.ts:generateMCPCommands()` manual-
 *     setup hint uses wrong key (`claude-flow`) AND wrong binary
 *     (`@sparkleideas/cli@latest`). Canonical: `ruflo` key + `@sparkleideas/ruflo@latest`.
 *
 *   F-11-002 [LOW] — `ruv-swarm` invocation not `@latest`-pinned (one-char
 *     fix: `'ruv-swarm'` → `'ruv-swarm@latest'`). Brings into line with
 *     ADR-0155 freshness invariant.
 *
 *   F-11-004 [MEDIUM] — `claudemd-generator.ts` `/plugin marketplace add`
 *     hint cites `ruvnet/ruflo` (upstream, 395+ commits behind) instead of
 *     `sparkling/ruflo` (the actual marketplace owner per
 *     `.claude-plugin/marketplace.json`).
 *
 *   F-11-005 [LOW] — `init.ts` "Next steps" output mixes `claude-flow`
 *     (4 occurrences in init flow + 4 in upgrade flow) and `ruflo` (2)
 *     in the same block — internal inconsistency. Canonicalize to `ruflo`.
 *
 * Grep-guard rule: `init.ts` + `mcp-generator.ts` + `claudemd-generator.ts`
 * MUST NOT contain `@sparkleideas/cli@latest` in any user-facing emission.
 * (Internal pipeline / publish-time references would be in different
 * modules — these three are pure user-facing emitters.)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  generateMCPCommands,
  generateMCPConfig,
} from '../../src/init/mcp-generator.js';
import { generateClaudeMd } from '../../src/init/claudemd-generator.js';
import type { InitOptions } from '../../src/init/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_SRC = resolve(__dirname, '../../src');

// Minimal InitOptions for invoking generators. The MCP generator reads
// `mcp.*` + `runtime.{maxAgents,topology,memoryBackend}`. The CLAUDE.md
// generator reads `runtime.claudeMdTemplate`. Stub everything else.
function buildOptions(opts: Partial<{
  claudeFlow: boolean;
  ruvSwarm: boolean;
  flowNexus: boolean;
}> = {}): InitOptions {
  return {
    mcp: {
      claudeFlow: opts.claudeFlow ?? true,
      ruvSwarm: opts.ruvSwarm ?? true,
      flowNexus: opts.flowNexus ?? false,
      autoStart: true,
      port: 3000,
    },
    runtime: {
      topology: 'hierarchical-mesh',
      maxAgents: 15,
      memoryBackend: 'hybrid',
      enableHNSW: true,
      enableNeural: true,
      enableLearningBridge: true,
      enableMemoryGraph: true,
      enableAgentScopes: true,
      similarityThreshold: 0.7,
      claudeMdTemplate: 'standard',
    },
  } as any;
}

describe('ADR-0223 — init-emitted brand canonicalization', () => {
  describe('F-11-001: manual-setup hint uses ruflo wrapper, not @sparkleideas/cli', () => {
    it('claudeFlow hint emits `ruflo` key + `@sparkleideas/ruflo@latest` binary', () => {
      const commands = generateMCPCommands(buildOptions({ claudeFlow: true }));
      const ruflo = commands.find((c) => c.includes('mcp add'));
      expect(ruflo).toBeDefined();
      // Server-key must be `ruflo`, NOT `claude-flow` (matches the
      // .mcp.json entry's key in mcp-generator.ts:87).
      expect(ruflo).toContain('claude mcp add ruflo');
      expect(ruflo).not.toMatch(/claude mcp add claude-flow\b/);
      // Binary must be `@sparkleideas/ruflo@latest`, NOT
      // `@sparkleideas/cli@latest` (per ADR-0143 + feedback-always-npx-for-ruflo).
      expect(ruflo).toContain('@sparkleideas/ruflo@latest');
      expect(ruflo).not.toContain('@sparkleideas/cli@latest');
    });

    it('NO command in generateMCPCommands() references @sparkleideas/cli@latest', () => {
      const variants = [
        buildOptions({ claudeFlow: true, ruvSwarm: true, flowNexus: true }),
        buildOptions({ claudeFlow: true, ruvSwarm: false, flowNexus: false }),
        buildOptions({ claudeFlow: false, ruvSwarm: true, flowNexus: false }),
      ];
      for (const opts of variants) {
        const commands = generateMCPCommands(opts);
        for (const cmd of commands) {
          expect(cmd, `command must not cite @sparkleideas/cli@latest: ${cmd}`)
            .not.toContain('@sparkleideas/cli@latest');
        }
      }
    });
  });

  describe('F-11-002: ruv-swarm is pinned to @latest', () => {
    it('generateMCPConfig() emits `ruv-swarm@latest` in args', () => {
      const config = generateMCPConfig(buildOptions({ ruvSwarm: true })) as {
        mcpServers: Record<string, { args?: string[] }>;
      };
      const ruvSwarm = config.mcpServers['ruv-swarm'];
      expect(ruvSwarm).toBeDefined();
      expect(ruvSwarm.args).toContain('ruv-swarm@latest');
      expect(ruvSwarm.args).not.toContain('ruv-swarm');
    });

    it('generateMCPCommands() hint emits `ruv-swarm@latest`', () => {
      const commands = generateMCPCommands(buildOptions({ ruvSwarm: true }));
      const ruvSwarmCmd = commands.find((c) => c.includes('ruv-swarm'));
      expect(ruvSwarmCmd).toBeDefined();
      expect(ruvSwarmCmd).toContain('ruv-swarm@latest');
      // ADR-0155 freshness invariant: no bare `ruv-swarm` (without @latest)
      // remains in the hint.
      expect(ruvSwarmCmd).not.toMatch(/\bruv-swarm\s+mcp\s+start/);
    });
  });

  describe('F-11-004: marketplace hint cites sparkling/ruflo, not ruvnet/ruflo', () => {
    it('CLAUDE.md (standard template) `/plugin marketplace add` cites sparkling/ruflo', () => {
      const md = generateClaudeMd(buildOptions(), 'standard');
      // The plugin-install hint must point at the maintained marketplace,
      // not the upstream read-only repo (per [[feedback-upstream-means-upstream]]).
      expect(md).not.toMatch(/\/plugin marketplace add ruvnet\/ruflo\b/);
      expect(md).toMatch(/\/plugin marketplace add sparkling\/ruflo\b/);
    });

    it('CLAUDE.md (full template) `/plugin marketplace add` cites sparkling/ruflo', () => {
      const md = generateClaudeMd(buildOptions(), 'full');
      expect(md).not.toMatch(/\/plugin marketplace add ruvnet\/ruflo\b/);
      expect(md).toMatch(/\/plugin marketplace add sparkling\/ruflo\b/);
    });
  });

  describe('F-11-005: init.ts "Next steps" uses ruflo, not claude-flow', () => {
    // The "Next steps" block is in source — assert at source level (the
    // generator doesn't expose it as a pure function). This is the same
    // grep-guard idiom as adr0208-strict-flag-parsing.arch.test.ts.
    it('init.ts: no `claude-flow daemon|memory|swarm` invocations in output.printList blocks', () => {
      const src = readFileSync(resolve(CLI_SRC, 'commands/init.ts'), 'utf8');

      // Slice down to lines that look like CLI hints emitted to the user
      // (output.highlight wrapping a backtick-quoted CLI command).
      // We forbid:
      //   `claude-flow daemon start`
      //   `claude-flow memory init`
      //   `claude-flow swarm init`
      //   `claude-flow init --start-all`
      const forbidden = [
        /output\.highlight\(['"`]claude-flow daemon start['"`]\)/,
        /output\.highlight\(['"`]claude-flow memory init['"`]\)/,
        /output\.highlight\(['"`]claude-flow swarm init['"`]\)/,
        /output\.highlight\(['"`]claude-flow init --start-all['"`]\)/,
      ];
      for (const re of forbidden) {
        expect(src, `forbidden mixed-brand pattern in init.ts: ${re}`)
          .not.toMatch(re);
      }
    });

    it('init.ts: contains `ruflo daemon|memory|swarm` invocations (the canonical replacements)', () => {
      const src = readFileSync(resolve(CLI_SRC, 'commands/init.ts'), 'utf8');
      // Positive check: the "Next steps" block in BOTH init flow (~:519)
      // AND upgrade flow (~:878) uses `ruflo` invocations now. Per ADR
      // F-11-005 there are 4 swaps in each block = 8 total `ruflo` hints.
      expect(src).toMatch(/output\.highlight\(['"`]ruflo daemon start['"`]\)/);
      expect(src).toMatch(/output\.highlight\(['"`]ruflo memory init['"`]\)/);
      expect(src).toMatch(/output\.highlight\(['"`]ruflo swarm init['"`]\)/);
      // The `init --start-all` variant uses the wrapper too — `ruflo init --start-all`.
      // (We don't pin the prose of the upgrade-flow re-run line because
      // its text uses `--start-all` without the `init` prefix; the gate
      // above is sufficient.)
      expect(src).toMatch(/ruflo init --start-all/);
    });
  });

  describe('Grep-guard: user-facing emitters do not reference @sparkleideas/cli@latest', () => {
    // Note: the ADR's grep-guard says the 3 emitters MUST NOT contain
    // `@sparkleideas/cli@latest`. The `setupAndBoundary()` Support
    // section in claudemd-generator carries the historical "one-time
    // bootstrap" line `claude mcp add claude-flow -- npx -y
    // @sparkleideas/cli@latest`. ADR-0143's Pass 7 promotes this on
    // user-facing surfaces too — the cli@latest must flip to
    // ruflo@latest here as well.
    const FILES = [
      'commands/init.ts',
      'init/mcp-generator.ts',
      'init/claudemd-generator.ts',
    ];
    for (const f of FILES) {
      it(`${f} has no @sparkleideas/cli@latest substring`, () => {
        const src = readFileSync(resolve(CLI_SRC, f), 'utf8');
        // Strip comments first so a `// (was @sparkleideas/cli@latest)` retro-comment
        // doesn't trip the gate.
        const noLineComments = src.split('\n')
          .map((l) => l.replace(/(?<![:"'])\/\/.*$/, ''))
          .join('\n');
        const noBlockComments = noLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(noBlockComments, `${f} must not emit @sparkleideas/cli@latest`)
          .not.toContain('@sparkleideas/cli@latest');
      });
    }
  });
});
