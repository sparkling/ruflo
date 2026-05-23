/**
 * Arch-test: ADR-0212 — `ruflo` bin removed from CLI bin map.
 *
 * Option B (chosen, 2026-05-22): the `@sparkleideas/cli` package's `bin`
 * map MUST NOT contain a `ruflo` key. The wrapper (`@sparkleideas/ruflo`)
 * becomes the sole declarer of `ruflo`, so `node_modules/.bin/ruflo`
 * resolves deterministically to the wrapper on every platform.
 *
 * Catches an upstream `--theirs` merge re-adding `ruflo` (which has
 * happened twice before per the ADR-0212 archaeology section).
 *
 * Settled KEEP: `ruflo-mcp` stays — it has an active acceptance
 * consumer (`lib/acceptance-adr0113-plugin-checks.sh` spawns the bin
 * directly). Only `ruflo` is removed.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_JSON = resolve(__dirname, '../../package.json');

describe('ADR-0212 — CLI bin map has no `ruflo` key', () => {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));

  it('bin map is an object (defensive)', () => {
    expect(typeof pkg.bin).toBe('object');
    expect(pkg.bin).not.toBeNull();
  });

  it('bin.ruflo is ABSENT (Option B — wrapper owns `ruflo`)', () => {
    expect(pkg.bin).not.toHaveProperty('ruflo');
  });

  it('bin.ruflo-mcp is PRESENT (settled KEEP — active acceptance consumer)', () => {
    expect(pkg.bin['ruflo-mcp']).toBe('./bin/mcp-server.js');
  });

  it('bin.cli is PRESENT (npx auto-invocation; @sparkleideas/cli derives `cli` bin name)', () => {
    expect(pkg.bin.cli).toBe('./bin/cli.js');
  });

  it('bin.claude-flow is PRESENT (backwards-compat alias)', () => {
    expect(pkg.bin['claude-flow']).toBe('./bin/cli.js');
  });

  it('bin.claude-flow-mcp is PRESENT (backwards-compat alias)', () => {
    expect(pkg.bin['claude-flow-mcp']).toBe('./bin/mcp-server.js');
  });

  it('bin keys are POSIX-valid (no slashes, no @-prefix)', () => {
    for (const key of Object.keys(pkg.bin)) {
      expect(key.includes('/')).toBe(false);
      expect(key.startsWith('@')).toBe(false);
    }
  });
});
