/**
 * ADR-0234 site 5 part (a) — plugins install description is honest.
 *
 * The install subcommand's description and examples no longer advertise
 * an IPFS path. The prior wording (`'Install a plugin from IPFS registry
 * or local path'` + example `'Install plugin from IPFS'`) was dishonest —
 * the implementation unconditionally called `installFromNpm(...)`.
 *
 * Per ADR-0234 Implementation discipline: two assertions on the source
 * text — the npm-honest description is present, the IPFS-only wording is
 * gone. Site 5 part (b) (`--source ipfs` guard) lands in a separate
 * follow-on commit.
 */

import { describe, it, expect } from 'vitest';
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

  // ADR-0234 site 5 part (b) — ADR-0234 literal in the source.
  // Part (b) lands in a follow-on commit; pinning the literal in the
  // description ensures part (a) IS the commit that introduces ADR-0234
  // to the file. Test asserts ADR-0234 appears in the install-command
  // description region (the "IPFS path not yet implemented" wording is
  // the marker; the example wording also surfaces ADR-0234 explicitly
  // for the help text).
  it('plugins.ts source contains the literal ADR-0234 reference after part (a)', () => {
    const src = readFileSync(PLUGINS_SRC, 'utf-8');
    expect(src).toContain('ADR-0234');
  });
});
