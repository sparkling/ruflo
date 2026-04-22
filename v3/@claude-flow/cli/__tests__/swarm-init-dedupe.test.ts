/**
 * ADR-0098: Config-fingerprint dedupe for swarm_init
 *
 * Tests the MCP swarm_init handler's reuse semantics:
 * - Reuses a running swarm with matching {topology, maxAgents, strategy} within TTL
 * - force=true bypasses reuse
 * - Terminated and stale (updatedAt > TTL) records are not reuse candidates
 * - Concurrent init under the O_EXCL file lock stays bounded
 *
 * Uses a real temp CWD via CLAUDE_FLOW_CWD env var so the handler's file I/O
 * exercises the actual lock + atomic-write paths. No fs mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swarmTools } from '../src/mcp-tools/swarm-tools.js';

const swarmInit = swarmTools.find((t) => t.name === 'swarm_init');
if (!swarmInit) throw new Error('swarm_init tool not found');

const defaultsConfig = {
  topology: 'hierarchical-mesh',
  maxAgents: 15,
  strategy: 'specialized',
};

describe('ADR-0098: swarm_init config-fingerprint dedupe', () => {
  let tmpCwd: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'swarm-init-dedupe-'));
    prevEnv = process.env.CLAUDE_FLOW_CWD;
    process.env.CLAUDE_FLOW_CWD = tmpCwd;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CLAUDE_FLOW_CWD;
    else process.env.CLAUDE_FLOW_CWD = prevEnv;
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  function readStore(): { swarms: Record<string, { swarmId: string; status: string; updatedAt: string }>; version: string } {
    const p = join(tmpCwd, '.swarm', 'swarm-state.json');
    if (!existsSync(p)) return { swarms: {}, version: '3.0.0' };
    return JSON.parse(readFileSync(p, 'utf-8'));
  }

  function writeStore(store: unknown): void {
    writeFileSync(join(tmpCwd, '.swarm', 'swarm-state.json'), JSON.stringify(store));
  }

  async function init(overrides: Record<string, unknown> = {}): Promise<{
    success: boolean;
    swarmId: string;
    reused?: boolean;
  }> {
    const res = await swarmInit!.handler!({ ...defaultsConfig, ...overrides });
    return res as { success: boolean; swarmId: string; reused?: boolean };
  }

  it('scenario 1: fresh project has 0 records before any init', () => {
    expect(Object.keys(readStore().swarms).length).toBe(0);
  });

  it('scenario 2: first init creates 1 record, reused=false', async () => {
    const r = await init();
    expect(r.success).toBe(true);
    expect(r.reused).toBe(false);
    expect(Object.keys(readStore().swarms).length).toBe(1);
  });

  it('scenario 3: repeated same-config init reuses the record (still 1 record)', async () => {
    const r1 = await init();
    const r2 = await init();
    expect(r1.reused).toBe(false);
    expect(r2.reused).toBe(true);
    expect(r2.swarmId).toBe(r1.swarmId);
    expect(Object.keys(readStore().swarms).length).toBe(1);
  });

  it('scenario 4: different config creates a new record', async () => {
    const r1 = await init();
    const r2 = await init({ topology: 'mesh', maxAgents: 4 });
    expect(r2.reused).toBe(false);
    expect(r2.swarmId).not.toBe(r1.swarmId);
    expect(Object.keys(readStore().swarms).length).toBe(2);
  });

  it('scenario 5: repeated different-config init reuses its own config bucket', async () => {
    await init();
    const r1 = await init({ topology: 'mesh', maxAgents: 4 });
    const r2 = await init({ topology: 'mesh', maxAgents: 4 });
    expect(r2.reused).toBe(true);
    expect(r2.swarmId).toBe(r1.swarmId);
    expect(Object.keys(readStore().swarms).length).toBe(2);
  });

  it('scenario 6: force=true bypasses dedupe even with matching config', async () => {
    const r1 = await init();
    const r2 = await init({ force: true, reason: 'test-force-new' });
    expect(r2.reused).toBe(false);
    expect(r2.swarmId).not.toBe(r1.swarmId);
    expect(Object.keys(readStore().swarms).length).toBe(2);
  });

  it('scenario 7: terminated records are not reuse candidates', async () => {
    const r1 = await init();
    const store = readStore();
    store.swarms[r1.swarmId].status = 'terminated';
    writeStore(store);
    const r2 = await init();
    expect(r2.reused).toBe(false);
    expect(r2.swarmId).not.toBe(r1.swarmId);
  });

  it('scenario 8: stale records (updatedAt > 7d) are not reuse candidates', async () => {
    const r1 = await init();
    const store = readStore();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    store.swarms[r1.swarmId].updatedAt = eightDaysAgo;
    writeStore(store);
    const r2 = await init();
    expect(r2.reused).toBe(false);
    expect(r2.swarmId).not.toBe(r1.swarmId);
  });

  it('scenario 9: concurrent init stays bounded (lock prevents unbounded duplicates)', async () => {
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () => init()),
    );
    const uniqueIds = new Set(results.map((r) => r.swarmId));
    // With the O_EXCL lock + in-lock dedupe check, all N should collapse onto
    // the same swarmId. Allow up to 2 unique (rare scheduling where the lock
    // round-robins and the first caller creates before the others check).
    // The old bug would produce 5 unique IDs.
    expect(uniqueIds.size).toBeLessThanOrEqual(2);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('scenario 10: response includes reused field and correct swarmId', async () => {
    const r1 = await init();
    expect(r1).toMatchObject({
      success: true,
      reused: false,
      topology: 'hierarchical-mesh',
      maxAgents: 15,
      strategy: 'specialized',
    });
    expect(r1.swarmId).toMatch(/^swarm-\d+-[a-z0-9]{6}$/);

    const r2 = await init();
    expect(r2).toMatchObject({
      success: true,
      reused: true,
      swarmId: r1.swarmId,
    });
  });
});
