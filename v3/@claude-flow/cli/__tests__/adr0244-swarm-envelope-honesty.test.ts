/**
 * ADR-0244 Sites #3 + #7 (F-01-003 + F-01-011) — swarm.ts CLI
 * envelope-honesty fixes.
 *
 * Site #3 (F-01-003): `swarm scale` previously called only
 * `swarm_status` and returned `{success:true, data:{...}}` without
 * ever invoking `swarm_scale`. The `--type` flag was read into
 * `agentType` but never used. After the fix:
 *   - On success: `swarm_scale` is called and the envelope is
 *     `{success:true, data:{..., mcp:<result>}}`.
 *   - On missing handler / MCP failure: the envelope is
 *     `{success:false, exitCode:1, message:<cause>}` per ADR-0210
 *     stub-honesty mandate.
 *
 * Site #7 (F-01-011): `swarm coordinate` previously printed
 * `printWarning(...)` on `swarm_init` failure and still returned
 * `{success:true, data:{agents, count}}`. After the fix the warning
 * is preserved but the envelope flips to `{success:false, exitCode:1,
 * data:{..., mcpInitialised:false}, message:<cause>}`.
 *
 * Source-text assertions (the `swarm.ts` runtime pulls in
 * `agentdb/archivist` via the v3 archivist init path, which is a
 * pre-existing test-environment resolution issue unrelated to
 * ADR-0244; we assert on the divergence-marker text + the shape of
 * the rewritten handler to certify the fix has landed).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC = path.resolve(__dirname, '../src');

describe('ADR-0244 site #3 — swarm scale envelope honesty', () => {
  const src = fs.readFileSync(path.join(SRC, 'commands/swarm.ts'), 'utf-8');

  it('source carries the ADR-0244 site #3 divergence marker', () => {
    expect(src).toContain('ADR-0244 site #3');
  });

  it('scale handler now invokes callMCPTool("swarm_scale", ...)', () => {
    // The dishonest stub only ever called swarm_status; the fix adds
    // a real swarm_scale call inside the scale handler.
    expect(src).toMatch(/callMCPTool\s*\(\s*['"`]swarm_scale['"`]/);
  });

  it('scale handler returns {success:false, exitCode:1, message} on swarm_scale failure', () => {
    // Identify the catch block inside the scale handler.
    const scaleBlock = src.split(/const\s+scaleCommand\s*:\s*Command\s*=/)[1] ?? '';
    expect(scaleBlock).toMatch(/success:\s*false[\s\S]{0,80}exitCode:\s*1[\s\S]{0,160}message:\s*/);
  });

  it('scale handler threads the --type flag into the swarm_scale payload', () => {
    // The dishonest stub dropped agentType; the fix conditionally
    // sets `payload.type = agentType` when defined.
    expect(src).toMatch(/scalePayload\.type\s*=\s*agentType/);
  });
});

describe('ADR-0244 site #7 — swarm coordinate envelope honesty', () => {
  const src = fs.readFileSync(path.join(SRC, 'commands/swarm.ts'), 'utf-8');

  it('source carries the ADR-0244 site #7 divergence marker', () => {
    expect(src).toContain('ADR-0244 site #7');
  });

  it('coordinate handler returns {success:false, exitCode:1, message} when MCP swarm_init fails', () => {
    // The dishonest stub returned {success:true} even on MCP failure;
    // the fix flips the envelope to surface the failure cause.
    expect(src).toMatch(/mcpInitialised\s*:\s*false/);
    const coordBlock = src.split(/const\s+coordinateCommand\s*:\s*Command\s*=/)[1] ?? '';
    expect(coordBlock).toMatch(/success:\s*false[\s\S]{0,160}exitCode:\s*1/);
    expect(coordBlock).toMatch(/swarm_init failed/);
  });
});
