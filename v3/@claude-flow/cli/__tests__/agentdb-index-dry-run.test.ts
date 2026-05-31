/**
 * `agentdb index --dry-run` must NOT mutate (ADR-0273 regression).
 *
 * The bug: the parser normalizes kebab flags to camelCase (parser.ts
 * `normalizeKey`), so `--dry-run` arrives in `ctx.flags` as `dryRun`, never
 * `dry-run`. The handler read only `ctx.flags['dry-run']`, so `dryRun` was
 * permanently `false` and the dry-run early-return never fired — a documented
 * "parse + report without writing" run performed the FULL index write (proven
 * in the field: a 223-row hierarchical / 0-edge DB became 287 rows / 890 edges
 * after a `--dry-run`).
 *
 * These tests mock the three write surfaces and assert that a dry-run reaches
 * ZERO of them, while a real (non-dry) run does. The write path's first act is
 * `await import('../mcp-tools/agentdb-orchestration.js')`, so an intact guard
 * means those mocked functions are never called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the three write surfaces the index build dynamically imports. If the
// dry-run guard is broken, the handler will import + invoke these.
const hierarchicalStore = vi.fn(async () => ({ success: true }));
const recordCausalEdge = vi.fn(async () => ({ success: true }));
const routeMemoryOp = vi.fn(async () => ({ success: true }));
const getController = vi.fn(async () => undefined);

vi.mock('../src/mcp-tools/agentdb-orchestration.js', () => ({
  hierarchicalStore,
  recordCausalEdge,
}));
vi.mock('../src/memory/memory-router.js', () => ({
  routeMemoryOp,
  getController,
}));

import { agentdbCommand } from '../src/commands/agentdb.js';
import type { CommandContext } from '../src/types.js';

const indexCommand = agentdbCommand.subcommands!.find((c) => c.name === 'index')!;

let workdir: string;

/** One minimal-but-valid MADR ADR with frontmatter + a relation, so the build
 *  would attempt all three surfaces (hierarchical + adr-patterns + an edge). */
function seedAdrDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adr-dry-'));
  writeFileSync(
    join(dir, 'ADR-0001-seed.md'),
    [
      '---',
      'status: accepted',
      'date: 2026-05-31',
      'tags: [test]',
      'supersedes: ADR-0000',
      '---',
      '# ADR-0001 Seed',
      '',
      '## Context and Problem Statement',
      '',
      'A seed record so the index build has something to write.',
      '',
    ].join('\n'),
    'utf-8',
  );
  return dir;
}

function ctxFor(flags: Record<string, unknown>): CommandContext {
  return {
    args: [],
    // The parser delivers `--dry-run` as the camelCase `dryRun` (parser.ts
    // normalizeKey). Tests use the same shape the real dispatch produces.
    flags: { _: [], ...flags },
    config: {} as any,
    cwd: process.cwd(),
    interactive: false,
  } as CommandContext;
}

beforeEach(() => {
  workdir = seedAdrDir();
  hierarchicalStore.mockClear();
  recordCausalEdge.mockClear();
  routeMemoryOp.mockClear();
  getController.mockClear();
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('agentdb index --dry-run (ADR-0273)', () => {
  it('parses + reports but performs ZERO writes when dryRun is set', async () => {
    const result = await indexCommand.action(ctxFor({ dir: workdir, dryRun: true }));

    expect(result.success).toBe(true);
    expect(result.message).toBe('dry-run complete');
    // Reports the counts it WOULD write...
    expect(result.data).toMatchObject({ records: 1, edges: 1 });
    // ...but mutates nothing on any of the three surfaces.
    expect(hierarchicalStore).not.toHaveBeenCalled();
    expect(routeMemoryOp).not.toHaveBeenCalled();
    expect(recordCausalEdge).not.toHaveBeenCalled();
    expect(getController).not.toHaveBeenCalled();
  });

  it('still performs no writes if the flag arrives under the kebab key', async () => {
    // Defensive: the fix reads both keys, so the legacy kebab spelling is honored too.
    const result = await indexCommand.action(ctxFor({ dir: workdir, 'dry-run': true }));

    expect(result.message).toBe('dry-run complete');
    expect(hierarchicalStore).not.toHaveBeenCalled();
    expect(routeMemoryOp).not.toHaveBeenCalled();
    expect(recordCausalEdge).not.toHaveBeenCalled();
  });

  it('DOES write when not a dry-run (proves the guard is the only thing gating writes)', async () => {
    const result = await indexCommand.action(ctxFor({ dir: workdir }));

    // Hierarchical + adr-patterns get one call each; the edge surface gets the
    // forward edge + its derived inverse.
    expect(hierarchicalStore).toHaveBeenCalledTimes(1);
    expect(routeMemoryOp).toHaveBeenCalledTimes(1);
    expect(recordCausalEdge).toHaveBeenCalled();
    expect(result.message).toBe('index complete');
  });
});
