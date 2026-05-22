/**
 * Arch-test: no raw `JSON.parse(readFileSync('.claude-flow/config.json'))`
 * anywhere in the substrate (ADR-0224 Confirmation #4).
 *
 * The single canonical accessor `getValidatedConfig()` in
 * `@claude-flow/shared/src/core/config/accessor.ts` is the only allowed entry
 * point — it wraps the Zod-validated load and throws on malformed config
 * (fails loud at the first access, per the no-fallbacks discipline).
 *
 * **Correction (per R3 directive):** the arch-test must NOT honour an
 * `// adr-0100-allow` marker for a `config.json` raw-parse. The marker
 * predates the accessor and only documented "we know this bypasses the Zod
 * loader; it's tracked." Now that the accessor exists, the marker for
 * `config.json` parses is obsolete — leaving a `// adr-0100-allow` escape
 * here would let a future regression re-introduce the bypass behind an
 * annotation, defeating the gate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findImports } from '../helpers/imports.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve fork root: __tests__/arch/ -> __tests__/ -> cli/ -> @claude-flow/ -> v3/ -> ruflo/
const CLI_PKG_DIR = resolve(__dirname, '../..');
const V3_ROOT = resolve(CLI_PKG_DIR, '..');

// All substrate packages — every src/ directory under v3/@claude-flow/*.
// The accessor lives under shared/src/core/config/; we explicitly allow that
// one file because it is the canonical wrapper. Tests/dist/node_modules are
// excluded as they are not shipped substrate code.
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

const ACCESSOR_FILE = resolve(V3_ROOT, 'shared/src/core/config/accessor.ts');

// Pattern: `JSON.parse(<anything-incl-newlines>config.json<anything>)` —
// matches the substrate's previous shape:
//   `JSON.parse(readFileSync(join(process.cwd(), '.claude-flow', 'config.json'), 'utf-8'))`
// and any minor variations (resolve(), path.join(), fs.readFileSync, etc.).
// The `findImports` helper scans line-by-line — so we restrict to lines that
// already contain both `JSON.parse` and `config.json`.
const CONFIG_RAW_PARSE: RegExp = /JSON\.parse\s*\(.*config\.json/;

describe('arch-test: no raw JSON.parse of .claude-flow/config.json (ADR-0224)', () => {
  it('only the canonical accessor (shared/src/core/config/accessor.ts) may raw-parse config.json', () => {
    const offenders = findImports({
      roots: SUBSTRATE_ROOTS,
      patterns: [CONFIG_RAW_PARSE],
    }).filter(o => o.file !== ACCESSOR_FILE);

    // The arch-test does NOT honour an `// adr-0100-allow` escape for
    // config.json raw-parse (per R3 directive / ADR-0224 Direct review).
    // Every offender is a violation regardless of annotation.
    if (offenders.length > 0) {
      const detail = offenders.map(o => `  ${o.file}:${o.line}: ${o.text}`).join('\n');
      throw new Error(
        `Found forbidden raw JSON.parse of config.json — migrate to ` +
        `getValidatedConfig() from '@claude-flow/shared' (ADR-0224):\n${detail}`,
      );
    }

    expect(offenders).toEqual([]);
  });

  it('the accessor file itself contains the canonical raw-parse (sanity check)', () => {
    const accessor = readFileSync(ACCESSOR_FILE, 'utf8');
    expect(accessor).toMatch(/JSON\.parse/);
    // Must use Zod safeParse — the validation step is what distinguishes
    // this from a bare `JSON.parse(readFileSync)`.
    expect(accessor).toMatch(/RuntimeConfigSchema\.safeParse/);
  });
});
