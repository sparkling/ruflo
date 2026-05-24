/**
 * ADR-0234 site 5 — plugins install --source ipfs guard + honest description.
 *
 * Part (a) source-shape gate: the install subcommand's description and
 * examples no longer advertise an IPFS path. The prior wording
 * (`'Install a plugin from IPFS registry or local path'` + example
 * `'Install plugin from IPFS'`) was dishonest — the implementation
 * unconditionally called `installFromNpm(...)`.
 *
 * Part (b) runtime guard: invoking `plugins install --source ipfs` throws
 * an ADR-0234-tagged error (exit 1) rather than silently substituting
 * npm.
 *
 * Per ADR-0234 Implementation discipline: TWO tests — one asserts the
 * exit-code shape, one asserts the printed error contains 'ADR-0234'.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGINS_SRC = resolve(__dirname, '../src/commands/plugins.ts');

describe('ADR-0234 site 5 part (a) — plugins install description is honest', () => {
  it('installCommand.description references npm and disclaims IPFS-not-implemented', () => {
    const src = readFileSync(PLUGINS_SRC, 'utf-8');
    // Locate the installCommand description string and verify it names
    // npm (the actual implementation) and labels IPFS as not implemented.
    expect(src).toMatch(
      /description:\s*['"]Install a plugin from npm registry or local path \(IPFS path not yet implemented\)['"]/,
    );
    // The pre-fix dishonest wording must be gone from the install command.
    expect(src).not.toMatch(
      /description:\s*['"]Install a plugin from IPFS registry or local path['"]/,
    );
  });

  it('installCommand examples no longer advertise plain "Install from IPFS"', () => {
    const src = readFileSync(PLUGINS_SRC, 'utf-8');
    // The pre-fix example wording `description: 'Install plugin from IPFS'`
    // (single quotes, no qualifier) must be gone.
    expect(src).not.toMatch(/description:\s*['"]Install plugin from IPFS['"]/);
    expect(src).not.toMatch(/description:\s*['"]Install from IPFS['"]/);
  });
});

describe('ADR-0234 site 5 part (b) — plugins install --source ipfs throws', () => {
  it('installCommand action returns success:false exitCode:1 when --source=ipfs', async () => {
    const mod: any = await import('../src/commands/plugins.js');
    const pluginsCommand = mod.default ?? mod.pluginsCommand;
    const installSub = pluginsCommand.subcommands?.find((s: any) => s.name === 'install');
    expect(installSub, 'expected install subcommand to be present').toBeDefined();

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await installSub.action({
        flags: { name: 'community-analytics', source: 'ipfs' },
        args: [],
      });
      expect((result as { success?: boolean }).success).toBe(false);
      expect((result as { exitCode?: number }).exitCode).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('thrown error message from --source ipfs contains literal ADR-0234', async () => {
    const mod: any = await import('../src/commands/plugins.js');
    const pluginsCommand = mod.default ?? mod.pluginsCommand;
    const installSub = pluginsCommand.subcommands?.find((s: any) => s.name === 'install');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await installSub.action({
        flags: { name: 'community-analytics', source: 'ipfs' },
        args: [],
      });
      const allWrites = stderrSpy.mock.calls
        .map((c: any[]) => String(c[0]))
        .join('\n');
      expect(allWrites).toContain('ADR-0234');
      expect(allWrites).toMatch(/IPFS/i);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
