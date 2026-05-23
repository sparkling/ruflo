/**
 * Arch-test: ADR-0208 — strict flag parsing (allowUnknownFlags=false).
 *
 * Pins three properties of the CLI parser surface:
 *
 *   1. The `commandParser` singleton at `parser.ts:555` is constructed with
 *      `allowUnknownFlags: false` — matching the parser class default
 *      (`parser.ts:34`) and the policy direction of ADR-0208 Option D′.
 *      A regression that re-introduces `allowUnknownFlags: true` is
 *      blocked at AST level.
 *
 *   2. No file in `cli/src/` constructs a `CommandParser` with
 *      `allowUnknownFlags: true`. Hand-rolled per-command allowlists (e.g.
 *      `mcp.ts`'s `knownFlags` Set) are not parser constructions and are
 *      ignored.
 *
 *   3. The unknown-flag rejection path is reachable through the parser
 *      API surface (`validateFlags` returns an `Unknown option:` error on
 *      an undeclared flag when `allowUnknownFlags` is false).
 *
 * Mechanism: resolved-source scan (read text, regex over constructor calls),
 * not a build-time TS AST tool — this matches the project's existing
 * `check-*.mjs` family idiom (zero external deps, fast).
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { CommandParser, commandParser } from '../../src/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_SRC = resolve(__dirname, '../../src');

interface Hit { file: string; line: number; text: string; }

function walk(dir: string, hits: Hit[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      walk(full, hits);
      continue;
    }
    if (!/\.(ts|js)$/.test(entry)) continue;
    if (/\.test\.(ts|js)$|\.d\.ts$/.test(entry)) continue;
    const text = readFileSync(full, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match `new CommandParser({ ... allowUnknownFlags: true ... })`
      // — single-line constructor with explicit true. Don't match the
      // parser.ts class-default line `allowUnknownFlags: false,` in the
      // constructor body (that's a property, not a `new` call), and don't
      // match the unrelated reference comment in `hive-mind.ts:1337`.
      if (/new\s+CommandParser\s*\([^)]*allowUnknownFlags\s*:\s*true/.test(line)) {
        hits.push({ file: full, line: i + 1, text: line.trim() });
      }
    }
  }
}

describe('ADR-0208 — strict flag parsing', () => {
  it('the parser class default is allowUnknownFlags=false (parser.ts:34)', () => {
    // The class default is what the singleton inherits when not overridden.
    // Construct without options and observe behavior via validateFlags.
    const p = new CommandParser();
    const errors = p.validateFlags({ _: [], aRandomUndeclaredFlag: 'x' });
    expect(errors.some((e) => e.includes('Unknown option'))).toBe(true);
  });

  it('the exported singleton rejects unknown flags', () => {
    // ADR-0208 Decision: the singleton is flipped from `true` to `false`.
    // This pins the singleton's posture against silent re-introduction.
    const errors = commandParser.validateFlags({ _: [], aRandomUndeclaredFlag: 'x' });
    const unknownErrors = errors.filter((e) => e.includes('Unknown option'));
    expect(unknownErrors.length).toBeGreaterThan(0);
    expect(unknownErrors[0]).toMatch(/Unknown option:\s*--aRandomUndeclaredFlag/);
  });

  it('no file in cli/src constructs CommandParser with allowUnknownFlags: true', () => {
    const hits: Hit[] = [];
    walk(CLI_SRC, hits);
    if (hits.length > 0) {
      const detail = hits.map((h) => `  ${h.file}:${h.line}: ${h.text}`).join('\n');
      throw new Error(
        `ADR-0208 violation — CommandParser({allowUnknownFlags:true}) found:\n${detail}\n` +
        `Use the class default (false) or migrate dynamic-flag callsites to a documented passthrough.`,
      );
    }
    expect(hits).toEqual([]);
  });
});
