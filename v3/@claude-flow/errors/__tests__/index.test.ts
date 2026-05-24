/**
 * @claude-flow/errors — behaviour tests for the canonical hierarchy.
 *
 * Round-trip assertions per ADR-0242 §Confirmation:
 *   - RufloError preserves `.cause`, `.code`, `.context`, `.timestamp`.
 *   - wrapError(parent) yields `.cause === parent` (preserves chain).
 *   - wrapError on RufloError returns it unchanged (no double-wrap).
 *   - isRufloError type-narrows correctly.
 *   - toJSON() shape is log-safe.
 */

import { describe, it, expect } from 'vitest';
import {
  RufloError,
  RufloErrorCode,
  wrapError,
  getErrorMessage,
  isRufloError,
} from '../src/index.js';

describe('RufloError', () => {
  it('constructs with all fields', () => {
    const cause = new Error('parent');
    const err = new RufloError(
      'init failed',
      RufloErrorCode.INITIALIZATION_FAILED,
      { tier: 'l1' },
      cause
    );

    expect(err.message).toBe('init failed');
    expect(err.code).toBe('RUFLO_E_INITIALIZATION_FAILED');
    expect(err.context).toEqual({ tier: 'l1' });
    expect(err.cause).toBe(cause);
    expect(err.timestamp).toBeInstanceOf(Date);
    expect(err.name).toBe('RufloError');
    expect(err instanceof RufloError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('defaults code to UNKNOWN when omitted', () => {
    const err = new RufloError('something went wrong');
    expect(err.code).toBe('RUFLO_E_UNKNOWN');
  });

  it('toJSON produces log-safe shape', () => {
    const cause = new Error('parent reason');
    const err = new RufloError(
      'wrapper',
      RufloErrorCode.VALIDATION_FAILED,
      { field: 'name' },
      cause
    );

    const json = err.toJSON();
    expect(json.name).toBe('RufloError');
    expect(json.message).toBe('wrapper');
    expect(json.code).toBe('RUFLO_E_VALIDATION_FAILED');
    expect(json.context).toEqual({ field: 'name' });
    expect(json.cause).toBe('parent reason');
    expect(typeof json.timestamp).toBe('string');
    expect(typeof json.stack).toBe('string');
  });

  it('toString includes code, context, cause', () => {
    const cause = new Error('parent');
    const err = new RufloError(
      'wrapper',
      RufloErrorCode.DATA_INTEGRITY,
      { id: 'abc' },
      cause
    );

    const str = err.toString();
    expect(str).toContain('[RUFLO_E_DATA_INTEGRITY]');
    expect(str).toContain('wrapper');
    expect(str).toContain('id');
    expect(str).toContain('Caused by: parent');
  });
});

describe('wrapError', () => {
  it('preserves .cause === parent on round-trip', () => {
    const parent = new Error('parent');
    const wrapped = wrapError(parent, RufloErrorCode.VALIDATION_FAILED);

    expect(wrapped).toBeInstanceOf(RufloError);
    expect(wrapped.cause).toBe(parent);
    expect(wrapped.message).toBe('parent');
    expect(wrapped.code).toBe('RUFLO_E_VALIDATION_FAILED');
  });

  it('returns RufloError unchanged (no double-wrap)', () => {
    const original = new RufloError('original', RufloErrorCode.NOT_FOUND);
    const wrapped = wrapError(original);
    expect(wrapped).toBe(original);
  });

  it('stringifies non-Error inputs', () => {
    const wrapped = wrapError('plain string');
    expect(wrapped).toBeInstanceOf(RufloError);
    expect(wrapped.message).toBe('plain string');
    expect(wrapped.code).toBe('RUFLO_E_UNKNOWN');
  });

  it('defaults code to UNKNOWN when omitted', () => {
    const wrapped = wrapError(new Error('x'));
    expect(wrapped.code).toBe('RUFLO_E_UNKNOWN');
  });
});

describe('getErrorMessage', () => {
  it('extracts message from Error', () => {
    expect(getErrorMessage(new Error('foo'))).toBe('foo');
  });

  it('extracts message from RufloError', () => {
    expect(getErrorMessage(new RufloError('bar'))).toBe('bar');
  });

  it('stringifies non-Error values', () => {
    expect(getErrorMessage('plain string')).toBe('plain string');
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage(null)).toBe('null');
  });
});

describe('isRufloError', () => {
  it('narrows RufloError instances', () => {
    const err: unknown = new RufloError('x');
    expect(isRufloError(err)).toBe(true);
    if (isRufloError(err)) {
      // Type narrowed — .code is accessible.
      expect(err.code).toBe('RUFLO_E_UNKNOWN');
    }
  });

  it('rejects plain Error', () => {
    expect(isRufloError(new Error('x'))).toBe(false);
  });

  it('rejects non-Error values', () => {
    expect(isRufloError('string')).toBe(false);
    expect(isRufloError(null)).toBe(false);
    expect(isRufloError(undefined)).toBe(false);
    expect(isRufloError({})).toBe(false);
  });

  it('narrows subclass instances (extends RufloError)', () => {
    class FooError extends RufloError {}
    const err = new FooError('x');
    expect(isRufloError(err)).toBe(true);
    expect(err instanceof RufloError).toBe(true);
  });
});
