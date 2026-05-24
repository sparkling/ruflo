/**
 * ADR-0244 Sites #1 + #2 (F-01-001 + F-01-002 CRITICAL) — daemon-PID
 * race closure.
 *
 * Before this ADR, three writers raced on `.claude-flow/daemon.pid`:
 *   1. `commands/process.ts` `daemon --action start` wrote a JSON
 *      object `{pid, port, startedAt}` (with the CLI's own
 *      `process.pid`, not a spawned daemon — stub).
 *   2. `commands/start.ts` `start --daemon` wrote `String(process.pid)`
 *      (raw integer).
 *   3. `commands/daemon.ts` (canonical daemonCommand) writes its
 *      structured shape.
 *
 * `JSON.parse` on the raw integer crashed status reads; the wrong
 * writer pinning its own PID made the file lie about which process
 * was the daemon.
 *
 * Site #1 deletes the `daemon` subcommand from `processCommand`.
 * Site #2 deletes the `daemonPidPath` write block from `startAction`.
 * Together they make the canonical `daemonCommand` the ONLY writer.
 *
 * Behaviour assertions:
 *   - `processCommand.subcommands` no longer includes a 'daemon' entry.
 *   - The source text of `commands/process.ts` no longer contains the
 *     `writePidFile` helper or the `daemonCommand` Command literal
 *     (`name: 'daemon'`).
 *   - The source text of `commands/start.ts` no longer contains a
 *     `daemonPidPath` variable or a `fs.writeFileSync(...daemon.pid...)`
 *     call.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processCommand } from '../src/commands/process.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '../src');

describe('ADR-0244 site #1 — process.ts daemon subcommand removed', () => {
  it('processCommand.subcommands does not include a "daemon" entry', () => {
    const names = (processCommand.subcommands ?? []).map((s) => s.name);
    expect(names).not.toContain('daemon');
    expect(names).toContain('monitor');
    expect(names).toContain('workers');
    expect(names).toContain('signals');
    expect(names).toContain('logs');
  });

  it('process.ts source no longer contains the daemonCommand Command literal', () => {
    const src = fs.readFileSync(path.join(SRC_DIR, 'commands/process.ts'), 'utf-8');
    // The stub used `name: 'daemon'` inside a Command literal. The
    // ADR-0244 divergence comment explicitly carries the rationale.
    expect(src).toContain('ADR-0244 site #1');
    expect(src).not.toMatch(/const\s+daemonCommand\s*:\s*Command\s*=/);
  });

  it('process.ts source no longer contains the writePidFile helper', () => {
    const src = fs.readFileSync(path.join(SRC_DIR, 'commands/process.ts'), 'utf-8');
    expect(src).not.toMatch(/function\s+writePidFile\s*\(/);
    expect(src).not.toMatch(/function\s+removePidFile\s*\(/);
  });
});

describe('ADR-0244 site #2 — start.ts daemonPidPath write block removed', () => {
  it('start.ts no longer writes to daemon.pid (only unlinks for cleanup)', () => {
    const raw = fs.readFileSync(path.join(SRC_DIR, 'commands/start.ts'), 'utf-8');
    // The ADR-0244 divergence comment explicitly carries the rationale.
    expect(raw).toContain('ADR-0244 site #2');
    // The stop command still cleans up `daemon.pid` via unlinkSync —
    // that path is legitimate (canonical daemonCommand wrote the file).
    // What MUST be gone is any `writeFileSync(...daemonPidPath...)`
    // call (this was the third-writer race we closed).
    const codeLines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (line === '' || line.startsWith('//')) return false;
        if (line.startsWith('*') || line.startsWith('/*') || line.startsWith('*/')) return false;
        return true;
      });
    const code = codeLines.join('\n');
    // No write to daemonPidPath anywhere in the file.
    expect(code).not.toMatch(/\bwriteFileSync\s*\([^)]*daemonPidPath/);
    // No keepAlive heartbeat probing daemonPidPath for liveness.
    expect(code).not.toMatch(/setInterval[^)]*daemonPidPath/);
  });
});

describe('ADR-0244 site #1+#2 — closed-form check (single PID-file writer)', () => {
  it('the only remaining file writing .claude-flow/daemon.pid is commands/daemon.ts', () => {
    // Walk commands/*.ts and assert no other file writes daemon.pid
    // via fs.writeFileSync. The canonical daemonCommand owns the
    // PID-file lifecycle.
    const commandsDir = path.join(SRC_DIR, 'commands');
    const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      if (f === 'daemon.ts') continue; // canonical writer
      const src = fs.readFileSync(path.join(commandsDir, f), 'utf-8');
      // Heuristic: a call to writeFileSync near a 'daemon.pid' string.
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/writeFileSync\s*\(/.test(lines[i])) {
          // Look 0..3 lines around for a daemon.pid literal.
          const window = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).join('\n');
          if (/['"`]daemon\.pid['"`]/.test(window) || /\bdaemonPidPath\b/.test(window)) {
            offenders.push(`${f}:${i + 1}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
