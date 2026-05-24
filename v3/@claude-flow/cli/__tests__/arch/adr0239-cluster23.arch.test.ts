/**
 * Arch-test for ADR-0239 cluster 23.
 *
 * v3/mcp parallel server tree and v3/src DDD scaffold deleted (closes F-10-002 F-05-001 F-11-016)
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

describe('ADR-0239 cluster 23: v3/mcp parallel server tree and v3/src DDD scaffold deleted (closes F-10-002 F-05-001 F-11-016)', () => {
  it("v3/mcp must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/mcp");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 23)`,
    ).toBe(false);
  });

  it("v3/src must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/src");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 23)`,
    ).toBe(false);
  });

  it("v3/__tests__/integration/mcp-integration.test.ts must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/__tests__/integration/mcp-integration.test.ts");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 23)`,
    ).toBe(false);
  });
});
