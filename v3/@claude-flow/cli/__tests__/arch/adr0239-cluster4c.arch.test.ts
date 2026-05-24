/**
 * Arch-test for ADR-0239 cluster 4.
 *
 * dead @claude-flow/embeddings package deleted (CVE-loader already relocated to memory in step a)
 *
 * Trip-wire: re-adding any of the forbidden paths below sends the
 * matching it() RED. Generated from
 * ruflo-patch/lib/adr0239-arch-test-template.mjs — edit there to
 * change the template shape uniformly across clusters.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FORK_ROOT = resolve(__dirname, "../../../../");

describe('ADR-0239 cluster 4: dead @claude-flow/embeddings package deleted (CVE-loader already relocated to memory in step a)', () => {
  it("v3/@claude-flow/embeddings must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/@claude-flow/embeddings");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 4)`,
    ).toBe(false);
  });
});
