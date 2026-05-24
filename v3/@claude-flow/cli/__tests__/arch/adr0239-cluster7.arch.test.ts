/**
 * Arch-test for ADR-0239 cluster 7.
 *
 * orphan cli/runtime/headless + benchmarks/pretrain + production + v3/agents yaml deleted
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

describe('ADR-0239 cluster 7: orphan cli/runtime/headless + benchmarks/pretrain + production + v3/agents yaml deleted', () => {
  it("v3/@claude-flow/cli/src/runtime/headless.ts must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/@claude-flow/cli/src/runtime/headless.ts");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 7)`,
    ).toBe(false);
  });

  it("v3/@claude-flow/cli/src/benchmarks/pretrain must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/@claude-flow/cli/src/benchmarks/pretrain");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 7)`,
    ).toBe(false);
  });

  it("v3/@claude-flow/cli/src/production must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/@claude-flow/cli/src/production");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 7)`,
    ).toBe(false);
  });

  it("v3/agents/architect.yaml must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/agents/architect.yaml");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 7)`,
    ).toBe(false);
  });

  it("v3/agents/coder.yaml must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/agents/coder.yaml");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 7)`,
    ).toBe(false);
  });

  it("v3/agents/reviewer.yaml must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/agents/reviewer.yaml");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 7)`,
    ).toBe(false);
  });

  it("v3/agents/security-architect.yaml must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/agents/security-architect.yaml");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 7)`,
    ).toBe(false);
  });

  it("v3/agents/tester.yaml must not exist", () => {
    const target = resolve(FORK_ROOT, "v3/agents/tester.yaml");
    expect(
      existsSync(target),
      `${target} should have been deleted (ADR-0239 cluster 7)`,
    ).toBe(false);
  });
});
