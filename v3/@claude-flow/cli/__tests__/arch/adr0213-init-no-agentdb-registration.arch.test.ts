/**
 * Arch-test: ADR-0213 — `ruflo init` MUST NOT register a standalone
 * `agentdb` MCP server.
 *
 * Per ADR-0213 (Option B + defer, 2026-05-22): the agentdb tools resolve
 * via the `ruflo` aggregator (`mcp__ruflo__agentdb_*`, RVF-backed). The
 * standalone server is dead-on-arrival (busy_timeout pragma crash) AND
 * SQLite-first (mpnet-768 vs MiniLM-384 substrate split) — registering it
 * by default violates [[project-rvf-primary]] and ships a failed `mcp list`
 * entry. The decision is to NOT default-register the standalone; defer to
 * a future opt-in ADR.
 *
 * R2 deliverable: pin the negative. Future regressions that add an
 * `agentdb` key to init-emitted `.mcp.json` (any variant: full / minimal /
 * partial mcp config) MUST fail this gate.
 *
 * Confirmation #2 ("Init unchanged + correct"): the `.mcp.json` MUST
 * contain `ruflo` (the aggregator surface) AND MUST NOT contain `agentdb`
 * (the dead standalone), regardless of input mode.
 *
 * Confirmation "No SQLite-first default" ([[project-rvf-primary]]): no
 * init-generated `.mcp.json` registers a SQLite-backed agentdb memory
 * server by default. Simplest invariant: no `agentdb` key in any
 * init-emitted `.mcp.json` from any input variation.
 */

import { describe, it, expect } from 'vitest';
import { generateMCPConfig, generateMCPJson } from '../../src/init/mcp-generator.js';
import type { InitOptions } from '../../src/init/types.js';

// Minimal InitOptions builder. The MCP generator reads `mcp.*` keys plus
// `runtime.{maxAgents,topology,memoryBackend}`. Everything else can be
// stubbed.
function buildOptions(overrides: Partial<{
  claudeFlow: boolean;
  ruvSwarm: boolean;
  flowNexus: boolean;
}> = {}): InitOptions {
  return {
    mcp: {
      claudeFlow: overrides.claudeFlow ?? true,
      ruvSwarm: overrides.ruvSwarm ?? false,
      flowNexus: overrides.flowNexus ?? false,
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
    },
  } as any;
}

type MCPJson = { mcpServers: Record<string, { command?: string; args?: string[] }> };

describe('ADR-0213 — init does NOT register standalone `agentdb` MCP server', () => {
  it('default config emits `ruflo` server, NOT `agentdb`', () => {
    const config = generateMCPConfig(buildOptions()) as MCPJson;
    expect(Object.keys(config.mcpServers)).toContain('ruflo');
    expect(Object.keys(config.mcpServers)).not.toContain('agentdb');
  });

  it('all-on config (claudeFlow + ruvSwarm + flowNexus) still has no `agentdb` key', () => {
    const config = generateMCPConfig(
      buildOptions({ claudeFlow: true, ruvSwarm: true, flowNexus: true }),
    ) as MCPJson;
    expect(Object.keys(config.mcpServers)).toContain('ruflo');
    expect(Object.keys(config.mcpServers)).not.toContain('agentdb');
  });

  it('ruv-swarm-only config has no `agentdb` key', () => {
    const config = generateMCPConfig(
      buildOptions({ claudeFlow: false, ruvSwarm: true }),
    ) as MCPJson;
    expect(Object.keys(config.mcpServers)).not.toContain('agentdb');
  });

  it('flow-nexus-only config has no `agentdb` key', () => {
    const config = generateMCPConfig(
      buildOptions({ claudeFlow: false, flowNexus: true }),
    ) as MCPJson;
    expect(Object.keys(config.mcpServers)).not.toContain('agentdb');
  });

  it('claudeFlow=false (skip-default) STILL has no `agentdb` key (rules out an alias surface)', () => {
    const config = generateMCPConfig(buildOptions({ claudeFlow: false })) as MCPJson;
    expect(Object.keys(config.mcpServers)).not.toContain('agentdb');
    // Also: there must be no SQLite-backed registration under ANY key.
    // The standalone's invocation signature is `npx @sparkleideas/agentdb mcp start`
    // (per the upstream `claude mcp add agentdb` recipe). Pin away the
    // command pattern itself, so a future variant under a different key
    // (e.g. `vector-db`) is also caught.
    const json = generateMCPJson(buildOptions({ claudeFlow: false }));
    expect(json).not.toMatch(/@sparkleideas\/agentdb/);
    expect(json).not.toMatch(/['"\s]agentdb\s+mcp\s+start['"]/);
  });

  it('no init-generated `.mcp.json` registers SQLite-backed agentdb (RVF-primary)', () => {
    // Sweep every reasonable input combination and assert the JSON output
    // never strings together a `@sparkleideas/agentdb mcp start` invocation,
    // nor an `agentdb` server key. This is the [[project-rvf-primary]]
    // contract: the default user-facing agentdb memory surface is RVF-backed
    // (via the `ruflo` aggregator), NOT a cwd-local SQLite store.
    const variants = [
      buildOptions({ claudeFlow: true, ruvSwarm: false, flowNexus: false }),
      buildOptions({ claudeFlow: true, ruvSwarm: true, flowNexus: false }),
      buildOptions({ claudeFlow: true, ruvSwarm: false, flowNexus: true }),
      buildOptions({ claudeFlow: true, ruvSwarm: true, flowNexus: true }),
      buildOptions({ claudeFlow: false, ruvSwarm: false, flowNexus: false }),
      buildOptions({ claudeFlow: false, ruvSwarm: true, flowNexus: true }),
    ];

    for (const opts of variants) {
      const json = generateMCPJson(opts);
      expect(json, 'no agentdb key in any variant').not.toMatch(/"agentdb"\s*:/);
      expect(json, 'no @sparkleideas/agentdb invocation').not.toMatch(/@sparkleideas\/agentdb/);
    }
  });
});
