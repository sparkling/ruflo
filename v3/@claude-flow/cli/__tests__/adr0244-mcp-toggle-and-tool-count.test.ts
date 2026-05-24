/**
 * ADR-0244 Sites #6 + #8 — commands/mcp.ts honesty fixes.
 *
 * Site #6 (F-01-006 HIGH): `mcp toggle --disable foo` previously
 * printed "Disabled 1 tools" and returned `{success:true}` without
 * writing anything. The tool remained enabled. After the fix the
 * handler persists `mcp.disabledTools` to `.claude-flow/config.json`
 * via `configManager.set` AND prints/returns a "Restart required for
 * changes to take effect" note (E5 expert amendment).
 *
 * Site #8 (F-01-007 HIGH): the success table previously printed
 * literal `'27 enabled'` regardless of actual count (~298+). After
 * the fix the value is derived at runtime via `listMCPTools().length`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC = path.resolve(__dirname, '../src');

describe('ADR-0244 site #8 — mcp.ts removes literal "27 enabled"', () => {
  const src = fs.readFileSync(path.join(SRC, 'commands/mcp.ts'), 'utf-8');

  it('source carries the ADR-0244 site #8 divergence marker', () => {
    expect(src).toContain('ADR-0244 site #8');
  });

  it('no longer contains the literal string "27 enabled" in executable code', () => {
    // The divergence comment intentionally names the literal it
    // replaces; strip comments before checking.
    const codeLines = src
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !(line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')));
    const code = codeLines.join('\n');
    expect(code).not.toContain("'27 enabled'");
    expect(code).not.toContain('"27 enabled"');
  });

  it('derives count from listMCPTools().length at runtime', () => {
    expect(src).toMatch(/listMCPTools\s*\(\s*\)\s*\.length/);
  });
});

describe('ADR-0244 site #6 — mcp.ts toggle persists to config', () => {
  const src = fs.readFileSync(path.join(SRC, 'commands/mcp.ts'), 'utf-8');

  it('source carries the ADR-0244 site #6 divergence marker', () => {
    expect(src).toContain('ADR-0244 site #6');
  });

  it('imports configManager', () => {
    expect(src).toMatch(/import\s*\{\s*configManager\s*\}\s*from\s*['"]\.\.\/services\/config-file-manager\.js['"]/);
  });

  it('writes mcp.disabledTools via configManager.set', () => {
    expect(src).toMatch(/configManager\.set\s*\(\s*ctx\.cwd\s*,\s*['"]mcp\.disabledTools['"]/);
  });

  it('reads mcp.disabledTools via configManager.get', () => {
    expect(src).toMatch(/configManager\.get\s*\(\s*ctx\.cwd\s*,\s*['"]mcp\.disabledTools['"]/);
  });

  it('returns the restart-required note (E5 expert amendment)', () => {
    expect(src).toContain('Restart required for changes to take effect');
  });
});

describe('ADR-0244 site #6 — runtime probe (config write)', () => {
  it('writes mcp.disabledTools to config on toggle --disable', async () => {
    // Build the toggle handler from the source manually since
    // import of commands/mcp.ts triggers heavy MCP server init.
    // Instead, exercise the manager directly using the same key
    // shape the handler writes.
    const { ConfigFileManager } = await import('../src/services/config-file-manager.js');
    const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'adr0244-mcp-'));
    try {
      const mgr = new ConfigFileManager();
      // Initial state: no disabledTools.
      expect(mgr.get(tmpDir, 'mcp.disabledTools')).toBeUndefined();

      // Apply the same write the handler would.
      mgr.set(tmpDir, 'mcp.disabledTools', ['foo', 'bar']);
      const written = mgr.get(tmpDir, 'mcp.disabledTools');
      expect(written).toEqual(['foo', 'bar']);

      // Re-read from disk via a fresh manager to verify persistence.
      const mgr2 = new ConfigFileManager();
      expect(mgr2.get(tmpDir, 'mcp.disabledTools')).toEqual(['foo', 'bar']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
