// Unit tests for safeJsonParse — prototype-pollution defense.
//
// Ported alongside upstream commit e50df6722 (issue #1558) via ADR-0111
// orphan-deletion audit item #15. The helper is invoked from
// agentdb-backend.ts's rowToEntry on row.tags / row.metadata / row.references
// from a SQLite-backed memory path that may contain attacker-influenced JSON.

import { describe, it, expect } from 'vitest';
import { safeJsonParse } from './json-security.js';

describe('safeJsonParse', () => {
  // ---------------------------------------------------------------------
  // Sanity: benign JSON round-trips unchanged.
  // ---------------------------------------------------------------------

  describe('benign JSON', () => {
    it('round-trips primitive numbers', () => {
      expect(safeJsonParse<number>('42')).toBe(42);
      expect(safeJsonParse<number>('-3.14')).toBe(-3.14);
    });

    it('round-trips primitive strings', () => {
      expect(safeJsonParse<string>('"hello"')).toBe('hello');
    });

    it('round-trips null', () => {
      expect(safeJsonParse<null>('null')).toBeNull();
    });

    it('round-trips booleans', () => {
      expect(safeJsonParse<boolean>('true')).toBe(true);
      expect(safeJsonParse<boolean>('false')).toBe(false);
    });

    it('round-trips flat objects', () => {
      const parsed = safeJsonParse<Record<string, unknown>>(
        '{"a":1,"b":"two","c":null}',
      );
      expect(parsed).toEqual({ a: 1, b: 'two', c: null });
    });

    it('round-trips nested objects', () => {
      const parsed = safeJsonParse<Record<string, unknown>>(
        '{"outer":{"inner":{"deep":true}}}',
      );
      expect(parsed).toEqual({ outer: { inner: { deep: true } } });
    });

    it('round-trips arrays', () => {
      expect(safeJsonParse<unknown[]>('[1,2,3]')).toEqual([1, 2, 3]);
      expect(safeJsonParse<unknown[]>('[{"a":1},{"b":2}]')).toEqual([
        { a: 1 },
        { b: 2 },
      ]);
    });

    it('round-trips the realistic agentdb-backend payload shapes', () => {
      // tags: string[]
      expect(safeJsonParse<string[]>('["alpha","beta","gamma"]')).toEqual([
        'alpha',
        'beta',
        'gamma',
      ]);
      // metadata: Record<string, unknown>
      expect(
        safeJsonParse<Record<string, unknown>>(
          '{"author":"henrik","priority":3,"tags":["x"]}',
        ),
      ).toEqual({ author: 'henrik', priority: 3, tags: ['x'] });
      // references: string[]
      expect(safeJsonParse<string[]>('["mem-1","mem-2"]')).toEqual([
        'mem-1',
        'mem-2',
      ]);
      // empty defaults from rowToEntry
      expect(safeJsonParse<string[]>('[]')).toEqual([]);
      expect(safeJsonParse<Record<string, unknown>>('{}')).toEqual({});
    });
  });

  // ---------------------------------------------------------------------
  // Top-level prototype pollution.
  // ---------------------------------------------------------------------

  describe('top-level prototype pollution', () => {
    it('strips __proto__ at root and leaves Object.prototype unpolluted', () => {
      const parsed = safeJsonParse<Record<string, unknown>>(
        '{"__proto__":{"polluted_top":true}}',
      );
      expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(
        false,
      );
      // Verify Object.prototype was not poisoned by the parse.
      const probe: Record<string, unknown> = {};
      expect(probe.polluted_top).toBeUndefined();
    });

    it('strips constructor at root', () => {
      const parsed = safeJsonParse<Record<string, unknown>>(
        '{"constructor":{"prototype":{"polluted_ctor":true}}}',
      );
      expect(Object.prototype.hasOwnProperty.call(parsed, 'constructor')).toBe(
        false,
      );
      const probe: Record<string, unknown> = {};
      expect(probe.polluted_ctor).toBeUndefined();
    });

    it('strips prototype at root', () => {
      const parsed = safeJsonParse<Record<string, unknown>>(
        '{"prototype":{"polluted_proto":true}}',
      );
      expect(Object.prototype.hasOwnProperty.call(parsed, 'prototype')).toBe(
        false,
      );
      const probe: Record<string, unknown> = {};
      expect(probe.polluted_proto).toBeUndefined();
    });

    it('preserves sibling keys when stripping polluting ones', () => {
      const parsed = safeJsonParse<Record<string, unknown>>(
        '{"safe":"keep me","__proto__":{"polluted_sib":true}}',
      );
      expect(parsed.safe).toBe('keep me');
      expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(
        false,
      );
      const probe: Record<string, unknown> = {};
      expect(probe.polluted_sib).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // Nested prototype pollution at depth.
  // ---------------------------------------------------------------------

  describe('nested prototype pollution', () => {
    it('strips __proto__ one level deep', () => {
      const parsed = safeJsonParse<Record<string, unknown>>(
        '{"a":{"__proto__":{"polluted_n1":true}}}',
      );
      const a = parsed.a as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(a, '__proto__')).toBe(false);
      const probe: Record<string, unknown> = {};
      expect(probe.polluted_n1).toBeUndefined();
    });

    it('strips __proto__ multiple levels deep', () => {
      const parsed = safeJsonParse<Record<string, unknown>>(
        '{"a":{"b":{"c":{"__proto__":{"polluted_n3":true}}}}}',
      );
      const c = ((parsed.a as Record<string, unknown>).b as Record<
        string,
        unknown
      >).c as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(c, '__proto__')).toBe(false);
      const probe: Record<string, unknown> = {};
      expect(probe.polluted_n3).toBeUndefined();
    });

    it('strips constructor / prototype at depth too', () => {
      const parsed = safeJsonParse<Record<string, unknown>>(
        '{"x":{"constructor":{"polluted_x_ctor":true},"prototype":{"polluted_x_proto":true}}}',
      );
      const x = parsed.x as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(x, 'constructor')).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(x, 'prototype')).toBe(false);
      const probe: Record<string, unknown> = {};
      expect(probe.polluted_x_ctor).toBeUndefined();
      expect(probe.polluted_x_proto).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // Arrays — JS technically allows __proto__ as an array element string key,
  // but the helper deliberately leaves arrays alone so legitimate string
  // payloads in `tags` / `references` are not mangled.
  // ---------------------------------------------------------------------

  describe('arrays unmodified', () => {
    it('leaves array of strings intact even if a value equals "__proto__"', () => {
      const parsed = safeJsonParse<string[]>('["__proto__","constructor","ok"]');
      expect(parsed).toEqual(['__proto__', 'constructor', 'ok']);
    });

    it('leaves array of objects intact and still strips pollution within', () => {
      const parsed = safeJsonParse<Array<Record<string, unknown>>>(
        '[{"safe":1},{"__proto__":{"polluted_arr":true}}]',
      );
      expect(parsed.length).toBe(2);
      expect(parsed[0]).toEqual({ safe: 1 });
      // The object element had its __proto__ stripped, but the array itself
      // is unmodified (still 2 elements).
      expect(
        Object.prototype.hasOwnProperty.call(parsed[1], '__proto__'),
      ).toBe(false);
      const probe: Record<string, unknown> = {};
      expect(probe.polluted_arr).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // Error contract: invalid JSON propagates as SyntaxError, same as
  // vanilla JSON.parse.
  // ---------------------------------------------------------------------

  describe('error propagation', () => {
    it('throws SyntaxError on invalid JSON', () => {
      expect(() => safeJsonParse('{not json')).toThrow(SyntaxError);
    });

    it('throws SyntaxError on empty string', () => {
      expect(() => safeJsonParse('')).toThrow(SyntaxError);
    });
  });
});
