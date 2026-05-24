/**
 * ADR-0244 Site #9 — register swarm_scale handler in
 * mcp-tools/swarm-tools.ts.
 *
 * Before: `swarm_scale` was advertised at mcp.ts:503 ("Scale swarm
 * size") but had zero handler implementation in mcp-tools/. CLI calls
 * to swarm_scale (added in ADR-0244 site #3) would hit the
 * "tool not found" branch and fail-loud — correct safety net but
 * not the disposition. Site #9 lands the actual handler so the
 * happy-path also works.
 *
 * Behaviour:
 *  - swarm_scale {swarmId, agents} updates the named swarm's
 *    maxAgents in `.swarm/swarm-state.json` and bumps updatedAt.
 *  - Optional `type` is stored as advisory `config.scaleTypeFilter`.
 *  - Validation: swarmId required (string); agents must be [1, 50].
 *  - Failure modes: swarm not found, swarm not running, persistence
 *    failure → `{success:false, error:<cause>}` envelope (matches
 *    existing swarm_init / swarm_shutdown shape).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC = path.resolve(__dirname, '../src');

describe('ADR-0244 site #9 — swarm_scale handler registered', () => {
  const src = fs.readFileSync(path.join(SRC, 'mcp-tools/swarm-tools.ts'), 'utf-8');

  it('source carries the ADR-0244 site #9 divergence marker', () => {
    expect(src).toContain('ADR-0244 site #9');
  });

  it('swarm_scale tool is declared in the swarmTools array', () => {
    expect(src).toMatch(/name:\s*['"]swarm_scale['"]/);
  });

  it('swarm_scale declares required swarmId + agents input schema', () => {
    // Find the swarm_scale block.
    const block = src.match(/name:\s*['"]swarm_scale['"][\s\S]*?required:\s*\[['"]swarmId['"]\s*,\s*['"]agents['"]\]/);
    expect(block).not.toBeNull();
  });

  it('swarm_scale handler validates agents in [1, 50]', () => {
    const block = src.match(/name:\s*['"]swarm_scale['"][\s\S]*?Failed to persist swarm state/);
    const content = block?.[0] ?? '';
    expect(content).toMatch(/agents\s*<\s*1\s*\|\|\s*agents\s*>\s*50/);
  });

  it('swarm_scale handler returns failure envelopes for not-found / not-running', () => {
    const block = src.match(/name:\s*['"]swarm_scale['"][\s\S]*?Failed to persist swarm state/);
    const content = block?.[0] ?? '';
    // Both failure messages exist in the handler body.
    expect(content).toContain('not found');
    expect(content).toContain('is not running');
    // success:false appears at least twice (validation + business-logic).
    const successFalseCount = (content.match(/success:\s*false/g) ?? []).length;
    expect(successFalseCount).toBeGreaterThanOrEqual(2);
  });
});
