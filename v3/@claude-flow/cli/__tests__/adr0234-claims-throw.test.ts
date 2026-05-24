/**
 * ADR-0234 site 4 — claims.ts fail-closed on policy-load error.
 *
 * Verifies that `claims check` returns `{ success: false, exitCode: 1 }`
 * with an ADR-0234-tagged error when the policy file is unreadable,
 * instead of falling through to a permissive default that grants any
 * non-`admin:*` claim.
 *
 * Fork-only divergence: upstream (`ruvnet/ruflo`) ships permissive-on-error
 * RBAC by design (byte-identical confirmed 2026-05-24). This test pins the
 * fork's fail-closed throw so sync agents preserve it.
 *
 * Per ADR-0234 Implementation discipline: TWO tests — one asserts the
 * exit-code shape, one asserts the printed error contains 'ADR-0234'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

describe('ADR-0234 site 4 — claims check fail-closed on policy-load error', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // claims.ts:193 resolves the third policy-search path against
    // `process.env.HOME`. Setting HOME to an isolated temp dir + writing
    // a malformed JSON file at `<tmpHome>/.config/claude-flow/claims.json`
    // triggers the JSON.parse-error catch at claims.ts:213 → the ADR-0234
    // fail-closed branch — without needing process.chdir() (which vitest
    // workers do not support).
    originalHome = process.env.HOME;
    tempHome = resolve(tmpdir(), `adr0234-claims-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(resolve(tempHome, '.config/claude-flow'), { recursive: true });
    writeFileSync(
      resolve(tempHome, '.config/claude-flow/claims.json'),
      '{ this is not valid json',
      'utf-8',
    );
    process.env.HOME = tempHome;
    // Silence stderr+stdout so test output is clean.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* swallow */ }
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('claims check returns success:false exitCode:1 when policy load fails', async () => {
    const { default: claimsCmd } = await import('../src/commands/claims.js');
    const checkSub = claimsCmd.subcommands?.find((s: any) => s.name === 'check');
    expect(checkSub).toBeDefined();
    const result = await checkSub!.action!({
      flags: { claim: 'swarm:create', user: 'bob' },
      args: [],
    } as any);
    expect(result).toBeDefined();
    expect((result as { success?: boolean }).success).toBe(false);
    expect((result as { exitCode?: number }).exitCode).toBe(1);
  });

  it('printed error from claims check contains the literal ADR-0234 substring', async () => {
    const { default: claimsCmd } = await import('../src/commands/claims.js');
    const checkSub = claimsCmd.subcommands?.find((s: any) => s.name === 'check');
    await checkSub!.action!({
      flags: { claim: 'swarm:create', user: 'bob' },
      args: [],
    } as any);
    // Aggregate all stderr writes; expect ADR-0234 to appear in at least one.
    const allWrites = stderrSpy.mock.calls
      .map((c: any[]) => String(c[0]))
      .join('\n');
    expect(allWrites).toContain('ADR-0234');
  });
});
