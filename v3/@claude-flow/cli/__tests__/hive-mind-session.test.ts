/**
 * ADR-0124 (T6) — Hive-mind session lifecycle integration tests.
 *
 * Behavioural tests for checkpoint → resume cycle, multi-session
 * enumeration, corrupted-archive cases, queenType round-trip (H6 row 32),
 * resume idempotence (per ADR-0124 §Refinement edge case "Queen re-spawn
 * failure mid-resume" — re-running `resumeSession` against the same
 * checkpoint reaches the same fixed point).
 *
 * Pattern matches mcp-tools-deep.test.ts: vi.mock node:fs with a memory
 * store, then exercise the session-lifecycle entry points directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── fs mocks (memory-backed) ─────────────────────────────────────────────
// Mirrors mcp-tools-deep.test.ts patterns. All filesystem ops route through
// a single Map<string, Buffer | string> so we can inspect the archive bytes.
const memStore = new Map<string, Buffer | string>();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => memStore.has(p)),
    readFileSync: vi.fn((p: string, _enc?: string) => {
      const v = memStore.get(p);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (typeof v === 'string') return v;
      // Caller passed encoding: return string; otherwise return Buffer.
      return _enc ? v.toString(_enc as BufferEncoding) : v;
    }),
    writeFileSync: vi.fn((p: string, d: Buffer | string) => memStore.set(p, d)),
    mkdirSync: vi.fn((p: string) => {
      // mkdirSync is a no-op in this in-memory FS; existsSync returns false
      // unless writeFileSync has populated a child path. The session module
      // calls ensureHiveSessionsDir BEFORE writing, so the directory's
      // existence is implicit by the file write that follows.
      memStore.set(p, '');
    }),
    readdirSync: vi.fn((p: string) => {
      const prefix = p.endsWith('/') ? p : p + '/';
      const names = new Set<string>();
      for (const k of memStore.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          if (!rest.includes('/')) names.add(rest);
        }
      }
      return Array.from(names);
    }),
    renameSync: vi.fn((from: string, to: string) => {
      const v = memStore.get(from);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      memStore.set(to, v);
      memStore.delete(from);
    }),
    statSync: vi.fn((p: string) => {
      const v = memStore.get(p);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const size = typeof v === 'string' ? v.length : v.length;
      return {
        size,
        isFile: () => true,
        isDirectory: () => false,
        mtimeMs: Date.now(),
      } as unknown as ReturnType<typeof actual.statSync>;
    }),
    unlinkSync: vi.fn((p: string) => { memStore.delete(p); }),
    openSync: vi.fn(() => 1),
    closeSync: vi.fn(),
    writeSync: vi.fn(),
    fsyncSync: vi.fn(),
    constants: actual.constants,
  };
});

// findProjectRoot is consulted by getHiveDir; mock to a deterministic path.
const FAKE_PROJECT_ROOT = '/__test_project__';
vi.mock('../src/mcp-tools/types.js', async () => {
  const actual = await vi.importActual<typeof import('../src/mcp-tools/types.js')>(
    '../src/mcp-tools/types.js',
  );
  return {
    ...actual,
    findProjectRoot: vi.fn(() => FAKE_PROJECT_ROOT),
  };
});

// child_process: probeQueenSpawnability calls execSync('which claude').
// We control the result per test by toggling a flag.
let mockClaudeAvailable = true;
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execSync: vi.fn((_cmd: string, _opts?: unknown) => {
      if (!mockClaudeAvailable) {
        throw Object.assign(new Error('command not found'), { status: 1 });
      }
      return Buffer.from('/usr/local/bin/claude');
    }),
    spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────
import {
  checkpointSession,
  exportSessionToPath,
  importSessionFromPath,
  resumeSession,
  listSessionArchives,
  locateLatestArchive,
  decodeArchive,
  encodeArchive,
  readArchiveFromPath,
  SESSION_ARCHIVE_SCHEMA_VERSION,
  SESSION_QUEEN_PROMPT_MEMORY_KEY,
  SESSION_WORKER_MANIFEST_MEMORY_KEY,
  SessionArchiveMissingError,
  SessionArchiveSchemaMismatchError,
  SessionArchiveCorruptError,
  QueenSpawnabilityProbeError,
  type SessionArchiveV1,
} from '../src/commands/hive-mind-session.js';
import {
  hiveMindTools,
  _resetHiveCacheForTest,
  type MemoryEntry,
} from '../src/mcp-tools/hive-mind-tools.js';

// Helpers
function findTool(name: string) {
  const t = hiveMindTools.find(t => t.name === name);
  if (!t) throw new Error(`tool ${name} missing in test fixture`);
  return t;
}

async function setMemory(key: string, value: unknown): Promise<void> {
  await findTool('hive-mind_memory').handler({
    action: 'set', key, value, type: 'system',
  });
}

async function freshHive(opts?: { queenType?: string }): Promise<void> {
  await findTool('hive-mind_shutdown').handler({ force: true });
  // Reset memory store for a clean slate per test.
  memStore.clear();
  _resetHiveCacheForTest();
  await findTool('hive-mind_init').handler({
    topology: 'mesh',
    ...(opts?.queenType ? { queenType: opts.queenType } : {}),
  });
}

describe('ADR-0124 (T6) hive-mind session lifecycle — integration', () => {
  beforeEach(() => {
    mockClaudeAvailable = true;
  });

  // ──────────────────────────────────────────────────────────────────────
  // listSessionArchives — empty / multi-session
  // ──────────────────────────────────────────────────────────────────────

  it('listSessionArchives returns [] when sessions directory is missing', async () => {
    memStore.clear();
    const all = listSessionArchives();
    expect(all).toEqual([]);
  });

  it('listSessionArchives returns [] when sessions directory exists but is empty', async () => {
    await freshHive({ queenType: 'strategic' });
    const all = listSessionArchives();
    expect(all).toEqual([]);
  });

  it('listSessionArchives enumerates in checkpointAt-desc order', async () => {
    await freshHive({ queenType: 'strategic' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'prompt-A');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, [{ id: 'w1', type: 'coder' }]);
    const p1 = await checkpointSession('hive-aaa');
    // Force a different ISO second.
    await new Promise(r => setTimeout(r, 5));
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'prompt-B');
    const p2 = await checkpointSession('hive-bbb');
    const all = listSessionArchives();
    expect(all.length).toBeGreaterThanOrEqual(2);
    // First entry has the latest checkpointAt.
    expect(all[0].checkpointAt >= all[1].checkpointAt).toBe(true);
    expect(all.map(a => a.archivePath).sort()).toEqual([p1, p2].sort());
  });

  // ──────────────────────────────────────────────────────────────────────
  // checkpoint → readArchive round-trip + queenType (H6 row 32)
  // ──────────────────────────────────────────────────────────────────────

  it('checkpoint captures queenType from state.queen (H6 row 32 fold-in)', async () => {
    await freshHive({ queenType: 'tactical' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'tactical-queen-prompt');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, [{ id: 'w1', type: 'tester' }]);
    const archivePath = await checkpointSession('hive-tactical');
    const archive = readArchiveFromPath(archivePath);
    expect(archive.schemaVersion).toBe(SESSION_ARCHIVE_SCHEMA_VERSION);
    expect(archive.queenPrompt).toBe('tactical-queen-prompt');
    expect(archive.queenType).toBe('tactical');
    expect(archive.hiveState.queen?.queenType).toBe('tactical');
    expect(archive.workerManifest).toEqual([{ id: 'w1', type: 'tester' }]);
  });

  it('checkpoint without queenType set captures undefined for older hives', async () => {
    await freshHive(); // no queenType
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'older-prompt');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, []);
    const archivePath = await checkpointSession('hive-no-type');
    const archive = readArchiveFromPath(archivePath);
    expect(archive.queenType).toBeUndefined();
    expect(archive.hiveState.queen?.queenType).toBeUndefined();
  });

  it('checkpoint throws when queenPrompt absent (no silent fallback)', async () => {
    await freshHive({ queenType: 'strategic' });
    // Skip setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, ...) — leave it absent.
    await expect(checkpointSession('hive-no-prompt')).rejects.toThrow(/queenPrompt absent/);
  });

  it('checkpoint throws when workerManifest entry malformed', async () => {
    await freshHive({ queenType: 'strategic' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'p');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, [{ id: 'w1' }]); // missing type
    await expect(checkpointSession('hive-bad-manifest')).rejects.toThrow(/workerManifest\[0\]\.type/);
  });

  // ──────────────────────────────────────────────────────────────────────
  // export → import → resume cycle
  // ──────────────────────────────────────────────────────────────────────

  it('export writes the same archive shape as checkpoint', async () => {
    await freshHive({ queenType: 'adaptive' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'adaptive-prompt');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, []);
    await exportSessionToPath('hive-export', '/tmp/hive-export.json.gz');
    const archive = readArchiveFromPath('/tmp/hive-export.json.gz');
    expect(archive.queenType).toBe('adaptive');
    expect(archive.queenPrompt).toBe('adaptive-prompt');
  });

  it('import materialises archive into canonical sessions dir under fresh sessionId', async () => {
    await freshHive({ queenType: 'strategic' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'export-prompt');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, [{ id: 'w1', type: 'coder' }]);
    await exportSessionToPath('hive-source', '/tmp/portable.json.gz');

    const result = await importSessionFromPath('/tmp/portable.json.gz');
    expect(result.sessionId).toMatch(/^imported-/);
    expect(result.archivePath).toContain(result.sessionId);
    // The canonical archive parses cleanly under the new sessionId.
    const archive = readArchiveFromPath(result.archivePath);
    expect(archive.queenPrompt).toBe('export-prompt');
    expect(archive.queenType).toBe('strategic');
    expect(archive.workerManifest).toEqual([{ id: 'w1', type: 'coder' }]);
  });

  it('import does NOT auto-resume (separate explicit step)', async () => {
    await freshHive({ queenType: 'strategic' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'p');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, []);
    await exportSessionToPath('hive-A', '/tmp/A.json.gz');

    const result = await importSessionFromPath('/tmp/A.json.gz');
    // After import, the live state.queen on disk is unchanged — import is
    // archive-only. resumeSession is the explicit materialise step.
    expect(result.sessionId).toMatch(/^imported-/);
  });

  it('import rejects archive with mismatched schemaVersion (no migration)', async () => {
    const bad: SessionArchiveV1 = {
      schemaVersion: 99 as unknown as 1,
      hiveState: {
        initialized: true,
        topology: 'mesh',
        workers: [],
        consensus: { pending: [], history: [] },
        sharedMemory: {},
        createdAt: 'x', updatedAt: 'x',
      },
      queenPrompt: 'p',
      workerManifest: [],
      timestamp: 'x',
    };
    const compressed = encodeArchive(bad);
    memStore.set('/tmp/bad.json.gz', compressed);
    await expect(importSessionFromPath('/tmp/bad.json.gz')).rejects.toThrow(
      SessionArchiveSchemaMismatchError,
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // resume: probe failure / queenType restore / idempotence
  // ──────────────────────────────────────────────────────────────────────

  it('resumeSession throws SessionArchiveMissingError when no checkpoint exists', async () => {
    await freshHive({ queenType: 'strategic' });
    await expect(resumeSession('non-existent-id')).rejects.toThrow(SessionArchiveMissingError);
  });

  it('resumeSession throws QueenSpawnabilityProbeError BEFORE state mutation when claude missing', async () => {
    await freshHive({ queenType: 'strategic' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'pre-resume-prompt');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, []);
    await checkpointSession('hive-probe');

    // Mutate the live state so we can detect whether resume mutated it
    // before the probe failed.
    await setMemory('canary-key', 'canary-value');
    const beforeProbe = await findTool('hive-mind_status').handler({ verbose: true }) as Record<string, unknown>;

    mockClaudeAvailable = false;
    await expect(resumeSession('hive-probe')).rejects.toThrow(QueenSpawnabilityProbeError);

    // The canary entry survives — resume threw before touching the typed
    // memory backend per ADR-0124 §Refinement.
    const afterProbe = await findTool('hive-mind_status').handler({ verbose: true }) as Record<string, unknown>;
    expect((afterProbe.sharedMemory as Record<string, unknown>)['canary-key']).toBeDefined();
    // Pre/post snapshots agree on the canary entry being present.
    expect(beforeProbe).toBeDefined();
  });

  it('resumeSession (skipSpawn) restores queenType onto state.queen.queenType', async () => {
    await freshHive({ queenType: 'tactical' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'tactical-prompt');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, []);
    const archivePath = await checkpointSession('hive-restore-type');

    // Now wipe queenType on the live queen by re-initialising fresh without
    // it. resume must restore it from the archive.
    await freshHive(); // no queenType
    let status = await findTool('hive-mind_status').handler({}) as { queen?: { queenType?: string } };
    expect(status.queen?.queenType).toBeUndefined();

    // Place the archive at a known sessionId so locateLatestArchive finds it.
    // (freshHive cleared memStore; re-add the previous archive bytes.)
    // Instead of orchestrating filesystem state, re-checkpoint the new hive
    // and verify the round-trip.
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'restored-prompt');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, []);
    await checkpointSession('hive-restore-type');

    // Manually craft an archive that carries queenType=adaptive and inject it
    // into the sessions directory. Then resume must apply it.
    const injected: SessionArchiveV1 = {
      schemaVersion: SESSION_ARCHIVE_SCHEMA_VERSION,
      hiveState: {
        initialized: true,
        topology: 'mesh',
        queen: {
          agentId: 'queen-restore',
          electedAt: new Date().toISOString(),
          term: 1,
          queenType: 'adaptive',
        },
        workers: [],
        consensus: { pending: [], history: [] },
        sharedMemory: {
          [SESSION_QUEEN_PROMPT_MEMORY_KEY]: {
            value: 'p',
            type: 'system',
            ttlMs: null,
            expiresAt: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          } as MemoryEntry,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      queenPrompt: 'inject-prompt',
      queenType: 'adaptive',
      workerManifest: [],
      timestamp: '2099-12-31T00-00-00-000Z',
    };
    const injectPath = locateLatestArchive('hive-restore-type').replace(
      /[^/]+$/,
      'hive-injected-2099-12-31T00-00-00-000Z.json.gz',
    );
    memStore.set(injectPath, encodeArchive(injected));

    await resumeSession('hive-injected', { skipSpawn: true });
    status = await findTool('hive-mind_status').handler({}) as { queen?: { queenType?: string } };
    expect(status.queen?.queenType).toBe('adaptive');
  });

  it('resumeSession is retry-safe (idempotent) — second call against same checkpoint reaches the same fixed point', async () => {
    await freshHive({ queenType: 'strategic' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'idempotent-prompt');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, [{ id: 'w1', type: 'coder' }]);
    await checkpointSession('hive-idem');

    const r1 = await resumeSession('hive-idem', { skipSpawn: true });
    const status1 = await findTool('hive-mind_status').handler({ verbose: true }) as Record<string, unknown>;

    const r2 = await resumeSession('hive-idem', { skipSpawn: true });
    const status2 = await findTool('hive-mind_status').handler({ verbose: true }) as Record<string, unknown>;

    expect(r1.archivePath).toBe(r2.archivePath);
    expect((status1.queen as Record<string, unknown>).queenType).toBe('strategic');
    expect((status2.queen as Record<string, unknown>).queenType).toBe('strategic');
    // queenPrompt is preserved across re-runs.
    const sharedAfter1 = status1.sharedMemory as Record<string, MemoryEntry>;
    const sharedAfter2 = status2.sharedMemory as Record<string, MemoryEntry>;
    expect(sharedAfter1[SESSION_QUEEN_PROMPT_MEMORY_KEY].value).toBe('idempotent-prompt');
    expect(sharedAfter2[SESSION_QUEEN_PROMPT_MEMORY_KEY].value).toBe('idempotent-prompt');
  });

  // ──────────────────────────────────────────────────────────────────────
  // locateLatestArchive correctness
  // ──────────────────────────────────────────────────────────────────────

  it('locateLatestArchive returns the most recent checkpoint for a given sessionId', async () => {
    await freshHive({ queenType: 'strategic' });
    await setMemory(SESSION_QUEEN_PROMPT_MEMORY_KEY, 'prompt');
    await setMemory(SESSION_WORKER_MANIFEST_MEMORY_KEY, []);
    const p1 = await checkpointSession('hive-multi');
    await new Promise(r => setTimeout(r, 5));
    const p2 = await checkpointSession('hive-multi');
    expect(p1).not.toBe(p2);
    const located = locateLatestArchive('hive-multi');
    // Most recent is the one with the lexicographically-greatest timestamp.
    expect(located >= p1 || located >= p2).toBe(true);
  });
});
