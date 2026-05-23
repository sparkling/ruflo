/**
 * Arch-test: DaemonIPCServer is fully removed from cli/src (ADR-0207).
 *
 * Asserts the F-10-001 evidence-gathering grep returns zero matches against
 * src/ — the deletion is permanent and cannot regress silently.
 *
 * Patterns guarded:
 *   - `DaemonIPCServer` (the class symbol)
 *   - `daemon-ipc` (module path)
 *   - `registerMethod` (the never-called registration verb)
 *
 * --exclude-dir=dist is implicit (we only scan src). The previous (incomplete)
 * 2-line IPC import block in worker-daemon.ts also disappears by symbol match.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_SRC = resolve(__dirname, '../../src');

const FORBIDDEN: RegExp[] = [
  /\bDaemonIPCServer\b/,
  /['"][^'"]*daemon-ipc(?:\.js)?['"]/,
  /\bregisterMethod\b/,
];

function walk(dir: string, hits: { file: string; line: number; text: string }[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walk(full, hits);
      continue;
    }
    if (!/\.(ts|js)$/.test(entry)) continue;
    const text = readFileSync(full, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pat of FORBIDDEN) {
        if (pat.test(lines[i])) {
          hits.push({ file: full, line: i + 1, text: lines[i].trim() });
          break;
        }
      }
    }
  }
}

describe('ADR-0207 — DaemonIPCServer removed', () => {
  it('cli/src has no references to DaemonIPCServer / daemon-ipc / registerMethod', () => {
    const hits: { file: string; line: number; text: string }[] = [];
    walk(CLI_SRC, hits);
    if (hits.length > 0) {
      const detail = hits.map(h => `  ${h.file}:${h.line}: ${h.text}`).join('\n');
      throw new Error(`Forbidden DaemonIPCServer references found (ADR-0207):\n${detail}`);
    }
    expect(hits).toEqual([]);
  });
});
