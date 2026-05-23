/**
 * ADR-0214 MUST-FIX #2 (item #10 in the 2026-05-28 handover): honoured-by-loader
 * behavioural test.
 *
 * The previous USERGUIDE arch-test (config-no-raw-parse) verifies emission /
 * surface shape. This test verifies the **read path**: that the runtime
 * configuration loader actually consumes the documented env vars and reflects
 * them in the loaded SystemConfig.
 *
 * Coverage matches the canonical `CLAUDE_FLOW_*` set the USERGUIDE keeps
 * untagged (the ones NOT marked `[doc-only]` after the 2026-05-24 alignment):
 *
 *   - CLAUDE_FLOW_MAX_AGENTS         → orchestrator.lifecycle.maxConcurrentAgents
 *   - CLAUDE_FLOW_DATA_DIR           → orchestrator.session.dataDir
 *   - CLAUDE_FLOW_MEMORY_TYPE        → memory.type
 *   - CLAUDE_FLOW_MCP_TRANSPORT      → mcp.transport.type
 *   - CLAUDE_FLOW_MCP_PORT           → mcp.transport.port
 *   - CLAUDE_FLOW_SWARM_TOPOLOGY     → swarm.topology
 *
 * Negative cases: unset → documented default.
 *
 * If the loader silently drops one of these (or a future refactor moves the
 * read site without updating this test), the test fails loudly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigLoader } from '../src/core/config/loader.js';

const TRACKED_VARS = [
  'CLAUDE_FLOW_MAX_AGENTS',
  'CLAUDE_FLOW_DATA_DIR',
  'CLAUDE_FLOW_MEMORY_TYPE',
  'CLAUDE_FLOW_MCP_TRANSPORT',
  'CLAUDE_FLOW_MCP_PORT',
  'CLAUDE_FLOW_SWARM_TOPOLOGY',
] as const;

describe('config loader honours documented env vars (ADR-0214 MUST-FIX #2)', () => {
  let tempDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-loader-env-'));
    savedEnv = {};
    for (const k of TRACKED_VARS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TRACKED_VARS) {
      const v = savedEnv[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('CLAUDE_FLOW_MAX_AGENTS — runtime honours the env value', async () => {
    process.env.CLAUDE_FLOW_MAX_AGENTS = '42';
    const loaded = await new ConfigLoader([tempDir]).load();
    expect(loaded.config.orchestrator.lifecycle.maxConcurrentAgents).toBe(42);
  });

  it('CLAUDE_FLOW_DATA_DIR — runtime honours the env value', async () => {
    process.env.CLAUDE_FLOW_DATA_DIR = '/custom/data/dir';
    const loaded = await new ConfigLoader([tempDir]).load();
    expect(loaded.config.orchestrator.session.dataDir).toBe('/custom/data/dir');
  });

  it('CLAUDE_FLOW_MEMORY_TYPE — runtime honours the env value', async () => {
    process.env.CLAUDE_FLOW_MEMORY_TYPE = 'agentdb';
    const loaded = await new ConfigLoader([tempDir]).load();
    expect(loaded.config.memory?.type).toBe('agentdb');
  });

  it('CLAUDE_FLOW_MEMORY_TYPE — invalid value silently rejected (validator gate)', async () => {
    process.env.CLAUDE_FLOW_MEMORY_TYPE = 'not-a-valid-backend';
    const loaded = await new ConfigLoader([tempDir]).load();
    // Loader rejects unknown enum values silently (validates against the
    // sqlite/agentdb/hybrid/redis/memory enum at loader.ts:105). It does not
    // throw — it falls through to the default. This documents the gate.
    expect(loaded.config.memory?.type).not.toBe('not-a-valid-backend');
  });

  it('CLAUDE_FLOW_MCP_TRANSPORT — runtime honours the env value', async () => {
    process.env.CLAUDE_FLOW_MCP_TRANSPORT = 'http';
    const loaded = await new ConfigLoader([tempDir]).load();
    expect(loaded.config.mcp?.transport.type).toBe('http');
  });

  it('CLAUDE_FLOW_MCP_PORT — runtime honours the env value', async () => {
    process.env.CLAUDE_FLOW_MCP_PORT = '3838';
    const loaded = await new ConfigLoader([tempDir]).load();
    expect(loaded.config.mcp?.transport.port).toBe(3838);
  });

  it('CLAUDE_FLOW_SWARM_TOPOLOGY — runtime honours the env value', async () => {
    process.env.CLAUDE_FLOW_SWARM_TOPOLOGY = 'mesh';
    const loaded = await new ConfigLoader([tempDir]).load();
    expect(loaded.config.swarm?.topology).toBe('mesh');
  });

  it('CLAUDE_FLOW_SWARM_TOPOLOGY — bare CLAUDE_FLOW_TOPOLOGY is NOT honoured (rebrand correctness)', async () => {
    // The 2026-05-24 USERGUIDE alignment renamed the documented name to
    // SWARM_TOPOLOGY because the loader only reads CLAUDE_FLOW_SWARM_TOPOLOGY.
    // Bare CLAUDE_FLOW_TOPOLOGY must not affect topology.
    process.env.CLAUDE_FLOW_TOPOLOGY = 'mesh';
    try {
      const loaded = await new ConfigLoader([tempDir]).load();
      // Topology stays at the default (hierarchical-mesh per defaults.ts)
      expect(loaded.config.swarm?.topology).not.toBe('mesh');
    } finally {
      delete process.env.CLAUDE_FLOW_TOPOLOGY;
    }
  });

  it('unset env — loader returns documented defaults', async () => {
    // All TRACKED_VARS are unset in beforeEach. Load should return defaults.
    const loaded = await new ConfigLoader([tempDir]).load();
    // Default memory type is hybrid (per USERGUIDE.md table)
    expect(loaded.config.memory?.type).toBe('hybrid');
    // Default MCP transport is stdio (per USERGUIDE.md table)
    expect(loaded.config.mcp?.transport.type).toBe('stdio');
  });
});
