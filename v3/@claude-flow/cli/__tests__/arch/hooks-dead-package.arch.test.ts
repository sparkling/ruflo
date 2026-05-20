/**
 * Arch-test: @claude-flow/hooks is eliminated from cli/src and guidance/src.
 *
 * Asserts (per ADR-0203 Confirmation #1):
 *  1. Neither cli/src nor guidance/src import @claude-flow/hooks via static
 *     `from '...'` OR dynamic `await import('...')` syntax.
 *  2. optional-modules.d.ts has no `declare module '@claude-flow/hooks'`.
 *
 * The publish-set guard (config/publish-levels.json has no @sparkleideas/hooks)
 * lives in ruflo-patch (scripts/lint-no-hooks-publish.mjs, wired into preflight)
 * because that file is owned by the patch repo, not the fork — a fork test
 * cannot soundly assume ruflo-patch is a sibling on disk.
 *
 * If the inevitable upstream re-merge re-introduces the dead package, this
 * test fails loud rather than silently re-diverging.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { findImports } from '../helpers/imports.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to this test file's location:
// __tests__/arch/ -> __tests__/ -> cli/ -> @claude-flow/ -> v3/ -> ruflo/ (fork root)
const CLI_PKG_DIR = resolve(__dirname, '../..');
const FORK_ROOT = resolve(CLI_PKG_DIR, '../../..');
const CLI_SRC = resolve(CLI_PKG_DIR, 'src');
const GUIDANCE_SRC = resolve(FORK_ROOT, 'v3/@claude-flow/guidance/src');
const OPTIONAL_MODULES_DTS = resolve(CLI_SRC, 'types/optional-modules.d.ts');

const HOOKS_IMPORT_PATTERNS: RegExp[] = [
  // Static: from '@claude-flow/hooks' or '@claude-flow/hooks/subpath'
  /from\s+['"]@claude-flow\/hooks(\/[\w-]+)?['"]/,
  // Dynamic: import('@claude-flow/hooks') or await import('@claude-flow/hooks/...')
  /(?:await\s+)?import\s*\(\s*['"]@claude-flow\/hooks(\/[\w-]+)?['"]/,
];

it('cli/src and guidance/src do not import @claude-flow/hooks (static OR dynamic)', () => {
  const offenders = findImports({
    roots: [CLI_SRC, GUIDANCE_SRC],
    patterns: HOOKS_IMPORT_PATTERNS,
  });

  if (offenders.length > 0) {
    const detail = offenders.map(o => `  ${o.file}:${o.line}: ${o.text}`).join('\n');
    throw new Error(
      `Found forbidden @claude-flow/hooks imports (ADR-0203):\n${detail}`,
    );
  }

  expect(offenders).toEqual([]);
});

it('optional-modules.d.ts has no declare module @claude-flow/hooks', () => {
  const dts = readFileSync(OPTIONAL_MODULES_DTS, 'utf8');
  expect(dts).not.toMatch(/declare\s+module\s+['"]@claude-flow\/hooks/);
});
