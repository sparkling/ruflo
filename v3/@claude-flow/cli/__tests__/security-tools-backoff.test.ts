/**
 * ADR-0247 site #3 (F-04-011) — installAttemptedAt 5-minute backoff.
 *
 * Before: `installAttempted: boolean` set true on first install-fail; the
 * gate permanently blocked re-install for the rest of the process lifetime.
 * After: `installAttemptedAt: number | null` records WHEN install was last
 * attempted; second call within 5 minutes throws the cached error WITHOUT
 * calling autoInstallPackage again; third call past the window resets the
 * gate and re-enters the install path.
 *
 * The behaviour probes (per ADR-0247 site #3 §Behaviour probe):
 *   1. First call fails install → cached error thrown
 *   2. Second call within 5 minutes throws cached error WITHOUT re-install
 *      (verified via spy: autoInstallPackage call-count stays at 1)
 *   3. Third call after Date.now() advanced past 5*60*1000+1 re-enters the
 *      install path (spy call-count rises to 2)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy that we can interrogate from tests. Resolved-false simulates a failed
// npm install (the `if (!installed)` branch in getAIDefence). vi.mock factories
// hoist above imports — we cannot reference closures inside.
vi.mock('../src/mcp-tools/auto-install.js', () => {
  const fn = vi.fn(async (_pkg: string) => false);
  return { autoInstallPackage: fn, default: fn };
});

// Force the first `await import('@claude-flow/aidefence')` inside getAIDefence
// down the install path. In the workspace the real package IS symlinked into
// node_modules, so without this mock the test never exercises the backoff
// path. The thrown message must contain 'Cannot find package' or
// 'ERR_MODULE_NOT_FOUND' to match the source's catch-filter at
// security-tools.ts:74 — otherwise the source re-throws as
// `AIDefence failed to load: ...` and never reaches the install gate.
// vi.mock factories cannot throw at the module-load boundary (vitest wraps
// the failure into a "There was an error when mocking" string that the source
// catch-filter then doesn't recognize). Instead we mock the module shape so
// `aidefence.createAIDefence(...)` throws an error WHOSE MESSAGE matches the
// catch-filter, routing the code through the install path.
vi.mock('@claude-flow/aidefence', () => ({
  createAIDefence: () => {
    throw Object.assign(
      new Error("Cannot find package '@claude-flow/aidefence' imported from test"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    );
  },
  isSafe: () => true,
}));

describe('ADR-0247 site #3 — security-tools installAttemptedAt 5-minute backoff', () => {
  let getAIDefence: () => Promise<unknown>;
  let autoInstallSpy: ReturnType<typeof vi.fn>;
  let dateNowSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    vi.resetModules();
    // Pull the freshly-loaded mock module so module-scope installAttemptedAt
    // resets between tests, and grab a reference to the spy.
    const autoMod = (await import('../src/mcp-tools/auto-install.js')) as unknown as {
      autoInstallPackage: ReturnType<typeof vi.fn>;
    };
    autoInstallSpy = autoMod.autoInstallPackage;
    autoInstallSpy.mockClear();
    autoInstallSpy.mockImplementation(async () => false);

    const mod = (await import('../src/mcp-tools/security-tools.js')) as unknown as {
      securityTools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }>;
    };
    const tool = mod.securityTools.find(t => t.name === 'aidefence_scan');
    if (!tool) throw new Error('aidefence_scan tool not found');
    getAIDefence = async () => tool.handler({ input: 'hello world', quick: true });
  });

  afterEach(() => {
    if (dateNowSpy) {
      dateNowSpy.mockRestore();
      dateNowSpy = undefined;
    }
  });

  it('first call attempts install, captures error, returns isError envelope', async () => {
    const result = (await getAIDefence()) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(autoInstallSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(result.content[0].text);
    expect(String(body.error)).toContain('AIDefence package not available');
  });

  it('second call within 5 minutes returns cached error WITHOUT re-installing', async () => {
    const first = (await getAIDefence()) as { isError?: boolean; content: Array<{ text: string }> };
    expect(first.isError).toBe(true);
    expect(autoInstallSpy).toHaveBeenCalledTimes(1);

    // Advance time by 1 minute (within backoff)
    const baseNow = Date.now();
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow + 60_000);

    const second = (await getAIDefence()) as { isError?: boolean; content: Array<{ text: string }> };
    expect(second.isError).toBe(true);
    // Critical: autoInstallPackage MUST NOT have been called again
    expect(autoInstallSpy).toHaveBeenCalledTimes(1);
    // Error message should indicate cached + show backoff hint
    const body = JSON.parse(second.content[0].text);
    expect(String(body.error)).toContain('cached');
    expect(String(body.error)).toContain('auto-retry after');
  });

  it('third call after 5*60*1000+1 ms re-enters the install path', async () => {
    const baseNow = 1_700_000_000_000;
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    await getAIDefence();
    expect(autoInstallSpy).toHaveBeenCalledTimes(1);

    // Call 2: within backoff window — must NOT re-install
    dateNowSpy.mockReturnValue(baseNow + 60_000);
    await getAIDefence();
    expect(autoInstallSpy).toHaveBeenCalledTimes(1);

    // Call 3: past backoff window (5min + 1ms) — MUST re-install
    dateNowSpy.mockReturnValue(baseNow + 5 * 60 * 1000 + 1);
    await getAIDefence();
    expect(autoInstallSpy).toHaveBeenCalledTimes(2);
  });

  it('backoff message includes ISO-8601 retry-at timestamp', async () => {
    const baseNow = Date.UTC(2026, 4, 24, 12, 0, 0); // 2026-05-24T12:00:00Z
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    await getAIDefence();

    // Advance 1 minute, second call returns cached error with retry hint
    dateNowSpy.mockReturnValue(baseNow + 60_000);
    const result = (await getAIDefence()) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text);
    // Expected retry-at: baseNow + 5min = 2026-05-24T12:05:00.000Z
    expect(String(body.error)).toContain('2026-05-24T12:05:00.000Z');
  });
});
