/**
 * Gastown-bridge ↔ @claude-flow/errors re-export shim arch-test.
 *
 * Per ADR-0242 §Confirmation: asserts that gastown-bridge/errors.ts
 * preserves backward-compat aliases after the base extraction. The
 * load-bearing invariant is:
 *
 *   new GasTownError('x') instanceof RufloError === true
 *
 * Plus the plugin-specific subclasses (BeadsError, ValidationError,
 * etc.) still extend the chain so `e instanceof RufloError` holds
 * for any plugin-thrown error.
 */

import { describe, it, expect } from 'vitest';
import { RufloError, RufloErrorCode, isRufloError } from '@claude-flow/errors';
import {
  GasTownError,
  GasTownErrorCode,
  BeadsError,
  ValidationError,
  CLIExecutionError,
  FormulaError,
  ConvoyError,
  wrapError,
  isGasTownError,
  hasGasTownCode,
} from '../src/errors.js';

describe('gastown-bridge/errors.ts → @claude-flow/errors re-export shim', () => {
  it('GasTownError is a subclass of RufloError', () => {
    const e = new GasTownError('x');
    expect(e).toBeInstanceOf(GasTownError);
    expect(e).toBeInstanceOf(RufloError);
    expect(e).toBeInstanceOf(Error);
    expect(isRufloError(e)).toBe(true);
    expect(isGasTownError(e)).toBe(true);
  });

  it('plugin-specific subclasses chain through to RufloError', () => {
    const bead = new BeadsError('not found', GasTownErrorCode.BEAD_NOT_FOUND);
    const val = new ValidationError('bad', GasTownErrorCode.VALIDATION_FAILED);
    const cli = new CLIExecutionError('failed', GasTownErrorCode.CLI_EXECUTION_FAILED, { command: 'gt' });
    const fml = new FormulaError('parse', GasTownErrorCode.FORMULA_PARSE_FAILED);
    const cnv = new ConvoyError('not found', GasTownErrorCode.CONVOY_NOT_FOUND);

    for (const e of [bead, val, cli, fml, cnv]) {
      expect(e).toBeInstanceOf(GasTownError);
      expect(e).toBeInstanceOf(RufloError);
      expect(isRufloError(e)).toBe(true);
    }
  });

  it('preserves cause chain through wrapError', () => {
    const parent = new Error('root cause');
    const wrapped = wrapError(parent, GasTownErrorCode.BEAD_PARSE_FAILED);
    expect(wrapped).toBeInstanceOf(GasTownError);
    expect(wrapped).toBeInstanceOf(RufloError);
    expect(wrapped.cause).toBe(parent);
    expect(wrapped.message).toBe('root cause');
  });

  it('hasGasTownCode discriminates on plugin-scoped codes', () => {
    const e = new ConvoyError('cycle', GasTownErrorCode.DEPENDENCY_CYCLE);
    expect(hasGasTownCode(e, GasTownErrorCode.DEPENDENCY_CYCLE)).toBe(true);
    expect(hasGasTownCode(e, GasTownErrorCode.CONVOY_NOT_FOUND)).toBe(false);
    expect(hasGasTownCode(new Error('plain'), GasTownErrorCode.DEPENDENCY_CYCLE)).toBe(false);
  });

  it('GasTownErrorCode is plugin-scoped (GT_* prefix), RufloErrorCode is shared (RUFLO_E_*)', () => {
    // Sanity: both prefixes present in their respective enums.
    expect(GasTownErrorCode.UNKNOWN).toBe('GT_UNKNOWN');
    expect(RufloErrorCode.UNKNOWN).toBe('RUFLO_E_UNKNOWN');
    // Plugin codes do NOT leak into the shared enum.
    expect(Object.values(RufloErrorCode)).not.toContain('GT_UNKNOWN');
  });
});
