/**
 * ADR-0244 Site #5 (F-01-005) — config reset --section.
 *
 * Before: `--section swarm` and bare `reset` both called
 * `configManager.reset(ctx.cwd)` with no section arg; both printed
 * "Configuration reset to defaults". The advertised `choices` enum
 * was enforced at parse time but the value was discarded.
 *
 * After: the handler passes `ctx.flags.section` through to
 * `configManager.reset(cwd, section?)`. The manager's `reset` now
 * accepts an optional `section`:
 *   - undefined / 'all' → full config reset (legacy behaviour).
 *   - known section (agents/swarm/memory/mcp/providers) → replace
 *     ONLY that top-level key with its default; preserve the rest.
 *   - unknown section → throw.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigFileManager } from '../src/services/config-file-manager.js';

describe('ADR-0244 site #5 — configManager.reset(cwd, section?)', () => {
  let tmpDir: string;
  let mgr: ConfigFileManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr0244-cfg-'));
    mgr = new ConfigFileManager();
  });

  it('full reset (no section) writes the full default config', () => {
    const cfgPath = mgr.reset(tmpDir);
    expect(fs.existsSync(cfgPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    // Default has a 'swarm' section as a baseline assertion.
    expect(typeof written.swarm).toBe('object');
  });

  it('section=all is equivalent to no section (legacy behaviour)', () => {
    const cfgPath = mgr.reset(tmpDir, 'all');
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(typeof written.swarm).toBe('object');
  });

  it('section=swarm replaces ONLY the swarm key with its default', () => {
    // Seed the file with a non-default swarm + a custom top-level key.
    const cfgPath = path.join(tmpDir, 'claude-flow.config.json');
    const customSwarm = { topology: 'custom-from-test', maxAgents: 999 };
    const seed = { swarm: customSwarm, customSentinel: 'must-survive' };
    fs.writeFileSync(cfgPath, JSON.stringify(seed));

    mgr.load(tmpDir);
    const returnedPath = mgr.reset(tmpDir, 'swarm');
    expect(returnedPath).toBe(cfgPath);

    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    // Swarm has been reset (no longer the custom shape).
    expect(after.swarm.topology).not.toBe('custom-from-test');
    expect(after.swarm.maxAgents).not.toBe(999);
    // The unrelated custom sentinel survives.
    expect(after.customSentinel).toBe('must-survive');
  });

  it('unknown section throws (caller surfaces fail-loud)', () => {
    expect(() => mgr.reset(tmpDir, 'not-a-real-section')).toThrow(/Unknown config section/);
  });
});

describe('ADR-0244 site #5 — commands/config.ts source contract', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/commands/config.ts'),
    'utf-8',
  );

  it('source carries the ADR-0244 site #5 divergence marker', () => {
    expect(src).toContain('ADR-0244 site #5');
  });

  it('handler threads section through to configManager.reset', () => {
    expect(src).toMatch(/configManager\.reset\s*\(\s*ctx\.cwd\s*,\s*section\s*\)/);
  });

  it('handler reads section from ctx.flags.section', () => {
    expect(src).toMatch(/ctx\.flags\.section/);
  });
});
