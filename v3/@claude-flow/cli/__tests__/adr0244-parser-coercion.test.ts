/**
 * ADR-0244 Site #11 (F-01-009) — parser default coercion.
 *
 * Before: `applyDefaults` did `flags[key] = opt.default as ...` —
 * verbatim cast on `this.globalOptions`. A string default like
 * `default: 'false'` on a `type: 'boolean'` option was assigned the
 * literal string 'false'; `Boolean('false') === true` AND
 * `flags.x === false` strict-equality silently took the wrong branch.
 * Same story for `default: '100'` on `type: 'number'` (assigned the
 * string '100') and `default: 'a,b,c'` on `type: 'array'`.
 *
 * After: `coerceDefault(opt, value)` runs at the seam:
 *   - `'true'`/`'false'` → boolean true/false on `type: 'boolean'`.
 *   - other string on boolean → `Boolean(value)` (truthy non-empty).
 *   - string on number → `Number(value)`.
 *   - string on array → `value.split(',').map(s => s.trim())`.
 *
 * Scope: `applyDefaults` walks `this.globalOptions` (initialised in
 * the constructor) — the seam where help/version/verbose/quiet/
 * format/non-interactive/etc. defaults fire. Command-level option
 * defaults are NOT applied by the parser (handlers use the
 * `(ctx.flags.x as number) || DEFAULT` pattern manually), so the
 * coercion at this seam catches the global-option class — the
 * widest single-seam fix available.
 *
 * The tests exercise the coercion via a SUBCLASS that injects a
 * test-only globalOption with each typed default, since the
 * built-in globalOptions list is hardcoded with already-typed
 * defaults.
 */

import { describe, it, expect } from 'vitest';
import { CommandParser } from '../src/parser.js';
import type { CommandOption } from '../src/types.js';

/**
 * Test-only subclass that lets us inject a globalOption with a
 * string default so we can exercise the coercion seam.
 */
class ProbeParser extends CommandParser {
  injectGlobalOption(opt: CommandOption): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).globalOptions.push(opt);
  }
}

describe('ADR-0244 site #11 — applyDefaults coerces string defaults to declared type', () => {
  it('boolean: default: "false" resolves to the boolean false', () => {
    const parser = new ProbeParser({ allowUnknownFlags: true });
    parser.injectGlobalOption({
      name: 'probe-bool-false',
      type: 'boolean',
      description: 't',
      default: 'false' as unknown as boolean,
    });
    const result = parser.parse([]);
    // Normaliser converts "probe-bool-false" to "probeBoolFalse".
    expect(result.flags.probeBoolFalse).toBe(false);
    expect(typeof result.flags.probeBoolFalse).toBe('boolean');
  });

  it('boolean: default: "true" resolves to the boolean true', () => {
    const parser = new ProbeParser({ allowUnknownFlags: true });
    parser.injectGlobalOption({
      name: 'probe-bool-true',
      type: 'boolean',
      description: 't',
      default: 'true' as unknown as boolean,
    });
    const result = parser.parse([]);
    expect(result.flags.probeBoolTrue).toBe(true);
    expect(typeof result.flags.probeBoolTrue).toBe('boolean');
  });

  it('number: default: "100" resolves to the number 100', () => {
    const parser = new ProbeParser({ allowUnknownFlags: true });
    parser.injectGlobalOption({
      name: 'probe-num',
      type: 'number',
      description: 't',
      default: '100' as unknown as number,
    });
    const result = parser.parse([]);
    expect(result.flags.probeNum).toBe(100);
    expect(typeof result.flags.probeNum).toBe('number');
  });

  it('array: default: "a,b,c" resolves to ["a","b","c"]', () => {
    const parser = new ProbeParser({ allowUnknownFlags: true });
    parser.injectGlobalOption({
      name: 'probe-arr',
      type: 'array',
      description: 't',
      default: 'a,b,c' as unknown as string[],
    });
    const result = parser.parse([]);
    expect(Array.isArray(result.flags.probeArr)).toBe(true);
    expect(result.flags.probeArr).toEqual(['a', 'b', 'c']);
  });

  it('array: default: "a, b, c" (with spaces) trims to ["a","b","c"]', () => {
    const parser = new ProbeParser({ allowUnknownFlags: true });
    parser.injectGlobalOption({
      name: 'probe-arr-spaces',
      type: 'array',
      description: 't',
      default: 'a, b, c' as unknown as string[],
    });
    const result = parser.parse([]);
    expect(result.flags.probeArrSpaces).toEqual(['a', 'b', 'c']);
  });

  it('preserves already-typed defaults (no double-coercion)', () => {
    const parser = new ProbeParser({ allowUnknownFlags: true });
    parser.injectGlobalOption({
      name: 'probe-typed-bool',
      type: 'boolean',
      description: 't',
      default: true,
    });
    parser.injectGlobalOption({
      name: 'probe-typed-num',
      type: 'number',
      description: 't',
      default: 42,
    });
    const result = parser.parse([]);
    expect(result.flags.probeTypedBool).toBe(true);
    expect(result.flags.probeTypedNum).toBe(42);
  });

  it('built-in global "format" string default "text" stays a string', () => {
    // Verify the helper doesn't accidentally rewrite the format
    // global's "text" default.
    const parser = new CommandParser({ allowUnknownFlags: true });
    const result = parser.parse([]);
    expect(result.flags.format).toBe('text');
    expect(typeof result.flags.format).toBe('string');
  });
});
