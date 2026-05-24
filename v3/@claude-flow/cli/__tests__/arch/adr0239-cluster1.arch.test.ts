/**
 * Arch-test for ADR-0239 cluster 1.
 *
 * v3/@claude-flow/testing whole workspace package deleted (16566 LOC)
 *
 * Trip-wire: re-adding any of the forbidden paths below sends the
 * matching it() RED. Generated from
 * ruflo-patch/lib/adr0239-arch-test-template.mjs — edit there to
 * change the template shape uniformly across clusters.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORK_ROOT = resolve(__dirname, "../../../../../");

describe('ADR-0239 cluster 1: v3/@claude-flow/testing whole workspace package deleted (16566 LOC)', () => {
  it("v3/@claude-flow/testing must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/@claude-flow/testing");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 1)`,
    ).toBe(false);
  });

  // E1 amendment: extend cluster 1 confirmation to assert tsconfig
  // project-reference removal alongside file deletion. The 16K LOC is
  // dragged into the TypeScript project graph by `{ "path":
  // "./@claude-flow/testing" }` and a stale reference after deletion
  // silently re-includes the dropped dist on the next `tsc --build`.
  it("v3/tsconfig.json must NOT reference @claude-flow/testing (E1 amendment)", () => {
    const tsconfigPath = resolve(FORK_ROOT, 'v3/tsconfig.json');
    const tsconfigSrc = readFileSync(tsconfigPath, 'utf-8');
    expect(
      /@claude-flow\/testing/.test(tsconfigSrc),
      'v3/tsconfig.json still references @claude-flow/testing. ' +
      'Remove from both `compilerOptions.paths` AND `references[]` so ' +
      '`tsc --build` does not silently re-include the deleted dist.',
    ).toBe(false);
  });

  // The plan also calls out the `cli/src/update/checker.ts` severity
  // list as a cleanup target — assert the dead-package name is gone.
  it("cli/src/update/checker.ts must NOT list @claude-flow/testing in update priorities", () => {
    const checker = readFileSync(
      resolve(FORK_ROOT, 'v3/@claude-flow/cli/src/update/checker.ts'),
      'utf-8',
    );
    // Filter to non-comment lines so JSDoc/comment references to the
    // ADR history don't trip the assertion.
    const liveLines = checker
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
    const liveText = liveLines.join('\n');
    expect(
      /'@claude-flow\/testing'/.test(liveText),
      'cli/src/update/checker.ts still has @claude-flow/testing in a live array. ' +
      'Remove from both `priority` and `CLAUDE_FLOW_PACKAGES`.',
    ).toBe(false);
  });
});
