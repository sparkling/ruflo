/**
 * V3 CLI MCP Server — RVF warm-up retry wrapper tests (ADR-0181 CF#1)
 *
 * Covers the carry-forward from the Phase 5 DA memo: bounded retry-with-
 * backoff around the cold-start `ensureRvfWired()` call so a transient FS
 * lock at MCP server boot does not kill the long-lived process.
 *
 * Discrimination posture: recoverable errors (EBUSY/EAGAIN/EBUSYISH/EMFILE)
 * retry up to MAX_ATTEMPTS; everything else aborts on the first attempt.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isRecoverableRvfWarmupError,
  warmUpRvfWithRetry,
  RVF_WARMUP_MAX_ATTEMPTS,
  RECOVERABLE_RVF_WARMUP_CODES,
} from '../src/mcp-server.js';

describe('isRecoverableRvfWarmupError', () => {
  it('returns true for an Error with .code === EBUSY', () => {
    const err = Object.assign(new Error('busy'), { code: 'EBUSY' });
    expect(isRecoverableRvfWarmupError(err)).toBe(true);
  });

  it('returns true for an Error with .code === EAGAIN', () => {
    const err = Object.assign(new Error('try again'), { code: 'EAGAIN' });
    expect(isRecoverableRvfWarmupError(err)).toBe(true);
  });

  it('returns true for an Error with .code === EBUSYISH', () => {
    const err = Object.assign(new Error('busyish'), { code: 'EBUSYISH' });
    expect(isRecoverableRvfWarmupError(err)).toBe(true);
  });

  it('returns true for an Error with .code === EMFILE', () => {
    const err = Object.assign(new Error('too many files'), { code: 'EMFILE' });
    expect(isRecoverableRvfWarmupError(err)).toBe(true);
  });

  it('returns true when message contains EBUSY substring (no code)', () => {
    const err = new Error('rvf segment write failed: EBUSY: locked');
    expect(isRecoverableRvfWarmupError(err)).toBe(true);
  });

  it('returns true when message contains "resource temporarily unavailable"', () => {
    const err = new Error('resource temporarily unavailable, open .rvf');
    expect(isRecoverableRvfWarmupError(err)).toBe(true);
  });

  it('returns false for a plain Error with no recoverable signal', () => {
    expect(isRecoverableRvfWarmupError(new Error('corrupt segment header'))).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isRecoverableRvfWarmupError(null)).toBe(false);
    expect(isRecoverableRvfWarmupError(undefined)).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isRecoverableRvfWarmupError('EBUSY')).toBe(false);
    expect(isRecoverableRvfWarmupError(42)).toBe(false);
  });

  it('returns false for an Error with an unknown code', () => {
    const err = Object.assign(new Error('weird'), { code: 'EWEIRD' });
    expect(isRecoverableRvfWarmupError(err)).toBe(false);
  });
});

describe('RECOVERABLE_RVF_WARMUP_CODES roster', () => {
  it('contains exactly the 4 expected codes', () => {
    expect(RECOVERABLE_RVF_WARMUP_CODES.size).toBe(4);
    expect(RECOVERABLE_RVF_WARMUP_CODES.has('EBUSY')).toBe(true);
    expect(RECOVERABLE_RVF_WARMUP_CODES.has('EAGAIN')).toBe(true);
    expect(RECOVERABLE_RVF_WARMUP_CODES.has('EBUSYISH')).toBe(true);
    expect(RECOVERABLE_RVF_WARMUP_CODES.has('EMFILE')).toBe(true);
  });
});

describe('warmUpRvfWithRetry', () => {
  it('returns immediately on first-attempt success — no sleep', async () => {
    const ensureRvfWired = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await warmUpRvfWithRetry('test-session', ensureRvfWired, { sleep, log });

    expect(ensureRvfWired).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled(); // No log lines on the happy path
  });

  it('retries on recoverable error and succeeds on second attempt', async () => {
    const transient = Object.assign(new Error('lock contention'), { code: 'EBUSY' });
    const ensureRvfWired = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await warmUpRvfWithRetry('test-session', ensureRvfWired, { sleep, log });

    expect(ensureRvfWired).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // First retry uses backoffMs * 1 (not multiplied by zero)
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0);
    // Exactly one WARN line emitted before the successful retry
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/WARN/);
    expect(log.mock.calls[0][0]).toMatch(/attempt 1/);
  });

  it('throws immediately on non-recoverable error — no retry', async () => {
    const fatal = new Error('corrupt rvf segment header');
    const ensureRvfWired = vi.fn().mockRejectedValue(fatal);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(
      warmUpRvfWithRetry('test-session', ensureRvfWired, { sleep, log }),
    ).rejects.toThrow(/corrupt rvf segment header/);

    expect(ensureRvfWired).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/FATAL/);
    expect(log.mock.calls[0][0]).toMatch(/NON-RECOVERABLE/);
  });

  it('throws after exhausting retries on persistent recoverable error', async () => {
    const transient = Object.assign(new Error('locked'), { code: 'EBUSY' });
    const ensureRvfWired = vi.fn().mockRejectedValue(transient);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(
      warmUpRvfWithRetry('test-session', ensureRvfWired, {
        sleep,
        log,
        maxAttempts: 3,
        backoffMs: 10,
      }),
    ).rejects.toThrow(/locked/);

    expect(ensureRvfWired).toHaveBeenCalledTimes(3);
    // 2 sleeps between 3 attempts (no sleep after final attempt)
    expect(sleep).toHaveBeenCalledTimes(2);
    // 2 WARN lines + 1 FATAL line
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[0][0]).toMatch(/WARN.*attempt 1/);
    expect(log.mock.calls[1][0]).toMatch(/WARN.*attempt 2/);
    expect(log.mock.calls[2][0]).toMatch(/FATAL/);
    expect(log.mock.calls[2][0]).toMatch(/3 attempts/);
  });

  it('uses linear backoff (delay scales with attempt number)', async () => {
    const transient = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const ensureRvfWired = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await warmUpRvfWithRetry('test-session', ensureRvfWired, {
      sleep,
      log,
      backoffMs: 100,
    });

    // attempt 1 -> sleep 100, attempt 2 -> sleep 200
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBe(100);
    expect(sleep.mock.calls[1][0]).toBe(200);
  });

  it('uses default RVF_WARMUP_MAX_ATTEMPTS when maxAttempts not provided', async () => {
    const transient = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const ensureRvfWired = vi.fn().mockRejectedValue(transient);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(
      warmUpRvfWithRetry('test-session', ensureRvfWired, { sleep, log, backoffMs: 1 }),
    ).rejects.toThrow();

    expect(ensureRvfWired).toHaveBeenCalledTimes(RVF_WARMUP_MAX_ATTEMPTS);
  });

  it('does NOT swallow a recoverable error mixed with a non-recoverable terminal one', async () => {
    // Simulates a RVF segment that hits EBUSY twice then surfaces a
    // structural fault. The structural fault is NOT recoverable and must
    // abort even though earlier retries succeeded.
    const transient = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const fatal = new Error('rvf header magic mismatch');
    const ensureRvfWired = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(fatal);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(
      warmUpRvfWithRetry('test-session', ensureRvfWired, { sleep, log, backoffMs: 1 }),
    ).rejects.toThrow(/rvf header magic mismatch/);

    expect(ensureRvfWired).toHaveBeenCalledTimes(3);
    // Two recoverable retries (sleep 1, sleep 2), then non-recoverable abort
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[log.mock.calls.length - 1][0]).toMatch(/FATAL.*NON-RECOVERABLE/);
  });
});
