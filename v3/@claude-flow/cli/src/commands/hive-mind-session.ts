/**
 * ADR-0124 (T6): Hive-mind session lifecycle — checkpoint / resume / export / import.
 *
 * Five subcommand handlers + archive read/write helpers. Wired into
 * `commands/hive-mind.ts` subcommand tree per ADR-0124 §Files.
 *
 * Archive format: gzipped JSON, internal-only contract, `schemaVersion` for
 * forwards-compat. Per ADR-0124 §Specification:
 *
 *   {
 *     "schemaVersion": 1,
 *     "hiveState":     { ... typed memory shape per ADR-0122 ... },
 *     "queenPrompt":   "<original spawn prompt as string>",
 *     "queenType":     "strategic" | "tactical" | "adaptive" | undefined,
 *     "workerManifest": [ { "id", "type", "manifest" }, ... ],
 *     "timestamp":     "<iso8601>"
 *   }
 *
 * Per ADR-0124 §Decision Outcome and `feedback-no-fallbacks.md`:
 *   - schemaVersion mismatch → throws (no silent migration)
 *   - corrupt gzip / bad JSON / missing fields → throws (no partial restore)
 *   - missing queenPrompt → throws (no defaulting)
 *   - spawnability probe failure → throws BEFORE any state mutation
 *
 * H6 row 32 fold-in: queenType is captured into the archive at checkpoint and
 * restored to state.queen.queenType before queen re-spawn at resume.
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, basename, dirname, isAbsolute, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawn as childSpawn, execSync } from 'node:child_process';
import {
  loadHiveState,
  saveHiveState,
  withHiveStoreLock,
  getHiveSessionsDir,
  ensureHiveSessionsDir,
  isHiveQueenType,
  type HiveState,
  type HiveQueenType,
  type MemoryEntry,
} from '../mcp-tools/hive-mind-tools.js';

// ── Archive shape ─────────────────────────────────────────────────────────

/**
 * Internal worker-manifest entry shape. ADR-0124 §Specification:
 * `[ { "id", "type", "manifest" }, ... ]`. `manifest` is an opaque record
 * the spawn path attached at registration time; at restore we hand it back
 * verbatim to whichever code path consumes it.
 */
export interface SessionWorkerEntry {
  id: string;
  type: string;
  manifest?: Record<string, unknown>;
}

export interface SessionArchiveV1 {
  schemaVersion: 1;
  hiveState: HiveState;
  queenPrompt: string;
  queenType?: HiveQueenType;
  workerManifest: SessionWorkerEntry[];
  timestamp: string;
}

/**
 * Current archive schema version. Bumping this is a breaking change per
 * ADR-0124 §Refinement edge case "Resume after fork upgrade with schema
 * drift": `resume`/`import` against an archive with mismatching version
 * throws with the exact error string from §Consequences. No migration tool
 * ships per row 28 (DEFER-TO-FOLLOWUP-ADR — escalates when v2 introduced).
 */
export const SESSION_ARCHIVE_SCHEMA_VERSION = 1 as const;

export class SessionArchiveSchemaMismatchError extends Error {
  constructor(public actualVersion: unknown) {
    super(
      `Archive schemaVersion ${String(actualVersion)} not supported by this build (expected ${SESSION_ARCHIVE_SCHEMA_VERSION}). ` +
      `To migrate, run 'ruflo hive-mind sessions export <id>' on the source build, then 'sessions import <path>' on a compatible build.`,
    );
    this.name = 'SessionArchiveSchemaMismatchError';
  }
}

export class SessionArchiveCorruptError extends Error {
  constructor(public reason: string) {
    super(`hive-mind session archive corrupt: ${reason}`);
    this.name = 'SessionArchiveCorruptError';
  }
}

export class SessionArchiveMissingError extends Error {
  constructor(public sessionId: string) {
    super(`hive-mind session archive not found for sessionId="${sessionId}"`);
    this.name = 'SessionArchiveMissingError';
  }
}

export class QueenSpawnabilityProbeError extends Error {
  constructor(public reason: string) {
    super(`hive-mind queen spawnability probe failed: ${reason}`);
    this.name = 'QueenSpawnabilityProbeError';
  }
}

// ── Archive serialization ─────────────────────────────────────────────────

/**
 * Produce a gzipped JSON archive byte sequence from an in-memory archive
 * object. Pure function — no I/O. Round-trips with `decodeArchive` per the
 * unit tests (`adr0124-session-lifecycle.test.mjs`).
 *
 * Returns `Uint8Array` (Buffer's superclass) so the exported declaration
 * doesn't drag the Node-specific `Buffer` private name into `.d.ts` emit
 * (per `tsconfig --composite` declaration-file requirements). At runtime
 * gzipSync returns a Buffer, which IS-A Uint8Array, so callers receive
 * the same bytes.
 */
export function encodeArchive(archive: SessionArchiveV1): Uint8Array {
  const json = JSON.stringify(archive);
  return gzipSync(Buffer.from(json, 'utf-8'));
}

/**
 * Decode a gzipped JSON archive byte sequence. Throws on:
 *   - gzip CRC failure or truncated stream → SessionArchiveCorruptError
 *   - JSON parse failure → SessionArchiveCorruptError
 *   - schemaVersion mismatch (must be SESSION_ARCHIVE_SCHEMA_VERSION) →
 *     SessionArchiveSchemaMismatchError (per ADR-0124 §Consequences exact
 *     error string contract)
 *   - structural validation failure (missing queenPrompt, malformed
 *     workerManifest, missing hiveState) → SessionArchiveCorruptError
 *
 * Per `feedback-no-fallbacks.md`: every error throws; no silent fallback
 * restores partial state. Per ADR-0124 §Refinement, distinct errors per
 * failure mode so the operator can tell what went wrong.
 */
export function decodeArchive(compressed: Uint8Array): SessionArchiveV1 {
  let payload: Buffer;
  try {
    payload = gunzipSync(compressed);
  } catch (err) {
    throw new SessionArchiveCorruptError(
      `gunzip failed (truncated or non-gzip data): ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf-8'));
  } catch (err) {
    throw new SessionArchiveCorruptError(
      `JSON.parse failed: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new SessionArchiveCorruptError('archive root is not an object');
  }

  const obj = parsed as Record<string, unknown>;
  // Schema-version gate first — distinct exception type so callers can tell
  // a mismatch from a corruption case (the §Consequences error message is
  // user-visible; corruption errors are operator-debug).
  if (obj.schemaVersion !== SESSION_ARCHIVE_SCHEMA_VERSION) {
    throw new SessionArchiveSchemaMismatchError(obj.schemaVersion);
  }

  // Structural validation. Each missing/malformed field throws a distinct
  // SessionArchiveCorruptError reason so the user-visible error names which
  // field failed.
  if (typeof obj.queenPrompt !== 'string') {
    throw new SessionArchiveCorruptError(
      `queenPrompt missing or not a string (got ${typeof obj.queenPrompt})`,
    );
  }
  if (obj.queenPrompt.length === 0) {
    throw new SessionArchiveCorruptError('queenPrompt is empty string');
  }
  if (!obj.hiveState || typeof obj.hiveState !== 'object') {
    throw new SessionArchiveCorruptError('hiveState missing or not an object');
  }
  if (!Array.isArray(obj.workerManifest)) {
    throw new SessionArchiveCorruptError(
      `workerManifest must be an array (got ${typeof obj.workerManifest})`,
    );
  }
  // Validate each worker-manifest entry has id + type strings. Per ADR-0124
  // §Refinement edge case "Partial worker manifest", any malformed entry
  // rejects the whole archive — no partial-restore.
  for (let i = 0; i < obj.workerManifest.length; i++) {
    const w = obj.workerManifest[i];
    if (!w || typeof w !== 'object') {
      throw new SessionArchiveCorruptError(`workerManifest[${i}] is not an object`);
    }
    const wo = w as Record<string, unknown>;
    if (typeof wo.id !== 'string' || wo.id.length === 0) {
      throw new SessionArchiveCorruptError(`workerManifest[${i}].id missing or not a non-empty string`);
    }
    if (typeof wo.type !== 'string' || wo.type.length === 0) {
      throw new SessionArchiveCorruptError(`workerManifest[${i}].type missing or not a non-empty string`);
    }
  }
  if (typeof obj.timestamp !== 'string') {
    throw new SessionArchiveCorruptError(
      `timestamp missing or not a string (got ${typeof obj.timestamp})`,
    );
  }
  // queenType is optional but if present MUST be one of the enum values.
  if (obj.queenType !== undefined && obj.queenType !== null) {
    if (!isHiveQueenType(obj.queenType)) {
      throw new SessionArchiveCorruptError(
        `queenType must be one of strategic|tactical|adaptive (got "${String(obj.queenType)}")`,
      );
    }
  }

  return parsed as SessionArchiveV1;
}

// ── Archive directory helpers ─────────────────────────────────────────────

/**
 * Build an archive filename: `<session-id>-<iso8601>.json.gz`. The ISO
 * timestamp uses `:` and `.` which are filesystem-safe on Unix and on macOS;
 * we sanitize them for portability so a checkpoint produced on Linux can be
 * imported on a Windows fork build without renaming.
 */
export function buildArchiveFilename(sessionId: string, isoTimestamp: string): string {
  const safeTs = isoTimestamp.replace(/[:.]/g, '-');
  return `${sessionId}-${safeTs}.json.gz`;
}

/**
 * Parse a session id and timestamp from an archive filename. Returns
 * `undefined` if the filename does not match the expected pattern (used by
 * `sessions list` to filter out unrelated files).
 */
export function parseArchiveFilename(name: string): { sessionId: string; checkpointAt: string } | undefined {
  if (!name.endsWith('.json.gz')) return undefined;
  const stripped = name.slice(0, -'.json.gz'.length);
  // Split on the FIRST occurrence of `-2` to separate sessionId from the
  // ISO timestamp prefix `2026-...`. Session IDs may contain `-`, but they
  // do not start with a digit; the timestamp always does.
  const idx = stripped.search(/-\d{4}-\d{2}-\d{2}T/);
  if (idx === -1) return undefined;
  const sessionId = stripped.slice(0, idx);
  const checkpointAt = stripped.slice(idx + 1);
  return { sessionId, checkpointAt };
}

/**
 * List every archive in the canonical sessions directory. Returns
 * `{ sessionId, checkpointAt, archivePath, sizeBytes }[]` sorted by
 * `checkpointAt` desc (newest first). Empty directory returns `[]`; missing
 * directory returns `[]` (does NOT auto-create per ADR-0124 §Refinement).
 */
export function listSessionArchives(): Array<{
  sessionId: string;
  checkpointAt: string;
  archivePath: string;
  sizeBytes: number;
}> {
  const dir = getHiveSessionsDir();
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const archives = entries
    .map(name => {
      const parsed = parseArchiveFilename(name);
      if (!parsed) return undefined;
      const archivePath = join(dir, name);
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(archivePath).size;
      } catch {
        // File vanished between readdirSync and statSync; skip silently
        // (other process is mid-write/delete). This is the only "tolerated"
        // race in this module — race-driven phantom entries vanish naturally.
        return undefined;
      }
      return { sessionId: parsed.sessionId, checkpointAt: parsed.checkpointAt, archivePath, sizeBytes };
    })
    .filter((x): x is { sessionId: string; checkpointAt: string; archivePath: string; sizeBytes: number } => x !== undefined)
    .sort((a, b) => (a.checkpointAt < b.checkpointAt ? 1 : a.checkpointAt > b.checkpointAt ? -1 : 0));
  return archives;
}

/**
 * Locate the most recent archive for the given sessionId. Throws
 * `SessionArchiveMissingError` if none exists. Used by `resume <session-id>`.
 */
export function locateLatestArchive(sessionId: string): string {
  const all = listSessionArchives();
  const match = all.find(a => a.sessionId === sessionId);
  if (!match) throw new SessionArchiveMissingError(sessionId);
  return match.archivePath;
}

// ── Snapshot collection ───────────────────────────────────────────────────

/**
 * Collect the in-memory snapshot for an archive. Reads under the hive-store
 * lock so the snapshot is row-coherent (ADR-0124 §Refinement edge case
 * "Concurrent checkpoint vs active session writes" accepts row-level
 * consistency, not cross-row atomicity).
 *
 * `queenPrompt` and `workerManifest` are loaded from the typed memory backend
 * via well-known keys — checkpoint persists what the spawn path stored.
 *
 * Per `feedback-no-fallbacks.md`: missing queenPrompt is a hard error, not a
 * silent default to empty.
 */
export interface CollectedSnapshot {
  hiveState: HiveState;
  queenPrompt: string;
  queenType?: HiveQueenType;
  workerManifest: SessionWorkerEntry[];
}

export const SESSION_QUEEN_PROMPT_MEMORY_KEY = 'hive-mind/queen-prompt';
export const SESSION_WORKER_MANIFEST_MEMORY_KEY = 'hive-mind/worker-manifest';

export async function collectHiveStateSnapshot(_sessionId: string): Promise<CollectedSnapshot> {
  return withHiveStoreLock(async () => {
    const hiveState = loadHiveState();

    // queenPrompt: required. Stored at SESSION_QUEEN_PROMPT_MEMORY_KEY by
    // the spawn path. Missing → throw per `feedback-no-fallbacks.md` (the
    // alternative would be silently checkpointing an empty prompt that
    // resume cannot restore from).
    const promptEntry = hiveState.sharedMemory[SESSION_QUEEN_PROMPT_MEMORY_KEY];
    if (!promptEntry || typeof promptEntry.value !== 'string' || promptEntry.value.length === 0) {
      throw new Error(
        `cannot checkpoint hive: queenPrompt absent from hive memory at key "${SESSION_QUEEN_PROMPT_MEMORY_KEY}". ` +
        `Spawn path must store the queen prompt before checkpoint can capture it.`,
      );
    }
    const queenPrompt = promptEntry.value;

    // queenType: optional capture (older hives spawned without explicit
    // type produce undefined; archive shape preserves this).
    const queenType = hiveState.queen?.queenType;

    // workerManifest: optional. Absent → empty array (a hive with zero
    // registered workers is a valid checkpoint state — fresh spawn, awaiting
    // workers).
    const manifestEntry = hiveState.sharedMemory[SESSION_WORKER_MANIFEST_MEMORY_KEY];
    let workerManifest: SessionWorkerEntry[] = [];
    if (manifestEntry !== undefined) {
      if (!Array.isArray(manifestEntry.value)) {
        throw new Error(
          `cannot checkpoint hive: workerManifest at key "${SESSION_WORKER_MANIFEST_MEMORY_KEY}" is not an array`,
        );
      }
      // Shallow-validate each entry; full validation happens at decode.
      workerManifest = (manifestEntry.value as unknown[]).map((w, i) => {
        if (!w || typeof w !== 'object') {
          throw new Error(`cannot checkpoint hive: workerManifest[${i}] is not an object`);
        }
        const wo = w as Record<string, unknown>;
        if (typeof wo.id !== 'string') {
          throw new Error(`cannot checkpoint hive: workerManifest[${i}].id missing or not a string`);
        }
        if (typeof wo.type !== 'string') {
          throw new Error(`cannot checkpoint hive: workerManifest[${i}].type missing or not a string`);
        }
        const entry: SessionWorkerEntry = { id: wo.id, type: wo.type };
        if (wo.manifest !== undefined) {
          if (typeof wo.manifest !== 'object' || wo.manifest === null) {
            throw new Error(`cannot checkpoint hive: workerManifest[${i}].manifest must be an object if present`);
          }
          entry.manifest = wo.manifest as Record<string, unknown>;
        }
        return entry;
      });
    }

    return { hiveState, queenPrompt, queenType, workerManifest };
  });
}

// ── Archive write (atomic) ────────────────────────────────────────────────

/**
 * Atomic archive write: write to a temp file, fsync, rename.
 *
 * Per ADR-0124 §Pseudocode "Checkpoint sequence":
 *   1. write tmp file
 *   2. atomic rename tmp → final
 *
 * Per ADR-0123 §Architecture (durability via tmp+rename), the rename is
 * atomic at the directory-entry layer. Concurrent checkpoints for the same
 * `<session-id>-<timestamp>` (sub-second collision) overwrite each other —
 * acceptable per ADR-0124 §Refinement edge case "Concurrent checkpoint vs
 * concurrent checkpoint".
 */
export function writeArchiveAtomic(archivePath: string, compressed: Uint8Array): void {
  const dir = dirname(archivePath);
  const name = basename(archivePath);
  const tmpPath = join(dir, `.${name}.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tmpPath, compressed);
  renameSync(tmpPath, archivePath);
}

// ── Checkpoint / Resume / Export / Import core ────────────────────────────

/**
 * Snapshot the active hive state to a versioned gzipped JSON archive at the
 * canonical path. Returns the archive path. Per ADR-0124 §Pseudocode.
 */
export async function checkpointSession(sessionId: string): Promise<string> {
  const snapshot = await collectHiveStateSnapshot(sessionId);
  const timestamp = new Date().toISOString();
  const archive: SessionArchiveV1 = {
    schemaVersion: SESSION_ARCHIVE_SCHEMA_VERSION,
    hiveState: snapshot.hiveState,
    queenPrompt: snapshot.queenPrompt,
    workerManifest: snapshot.workerManifest,
    timestamp,
    ...(snapshot.queenType !== undefined ? { queenType: snapshot.queenType } : {}),
  };
  const compressed = encodeArchive(archive);

  ensureHiveSessionsDir();
  const filename = buildArchiveFilename(sessionId, timestamp);
  const archivePath = join(getHiveSessionsDir(), filename);
  writeArchiveAtomic(archivePath, compressed);
  return archivePath;
}

/**
 * Snapshot the active hive state to a user-supplied path. Per ADR-0124
 * §Pseudocode "Export = checkpoint to user-supplied path".
 */
export async function exportSessionToPath(sessionId: string, outputPath: string): Promise<void> {
  const snapshot = await collectHiveStateSnapshot(sessionId);
  const archive: SessionArchiveV1 = {
    schemaVersion: SESSION_ARCHIVE_SCHEMA_VERSION,
    hiveState: snapshot.hiveState,
    queenPrompt: snapshot.queenPrompt,
    workerManifest: snapshot.workerManifest,
    timestamp: new Date().toISOString(),
    ...(snapshot.queenType !== undefined ? { queenType: snapshot.queenType } : {}),
  };
  const compressed = encodeArchive(archive);
  const absolute = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath); // adr-0100-allow: intentional-cwd — resolves a user-supplied --output path relative to where the user invoked the export, standard CLI semantics
  writeArchiveAtomic(absolute, compressed);
}

/**
 * Read + decode an archive from disk. Throws (with distinct exception types
 * per failure mode) on any error.
 */
export function readArchiveFromPath(archivePath: string): SessionArchiveV1 {
  if (!existsSync(archivePath)) {
    throw new SessionArchiveCorruptError(`archive not found: ${archivePath}`);
  }
  const compressed = readFileSync(archivePath);
  return decodeArchive(compressed);
}

/**
 * Materialise an exported archive into local state under a fresh sessionId.
 * Per ADR-0124 §Pseudocode "Import = checkpoint from user-supplied path":
 *   1. read + gunzip + parse user-supplied archive
 *   2. validate schemaVersion (decodeArchive does this)
 *   3. write into canonical archive directory under fresh sessionId
 *   4. import does NOT auto-resume — caller invokes `resume` separately
 */
export async function importSessionFromPath(archivePath: string): Promise<{
  sessionId: string;
  archivePath: string;
}> {
  const archive = readArchiveFromPath(archivePath);
  const sessionId = `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = archive.timestamp; // preserve original checkpoint timestamp
  ensureHiveSessionsDir();
  const filename = buildArchiveFilename(sessionId, timestamp);
  const canonicalPath = join(getHiveSessionsDir(), filename);
  const compressed = encodeArchive(archive);
  writeArchiveAtomic(canonicalPath, compressed);
  return { sessionId, archivePath: canonicalPath };
}

/**
 * Probe whether the `claude` CLI is available before any state mutation.
 * Per ADR-0124 §Pseudocode "Resume sequence" step 5: "throw BEFORE state
 * mutation". Mirrors the `which claude` probe used by `spawnClaudeCodeInstance`
 * in commands/hive-mind.ts (`execSync('which claude', { stdio: 'ignore' })`).
 */
export function probeQueenSpawnability(): void {
  try {
    execSync('which claude', { stdio: 'ignore' });
  } catch {
    throw new QueenSpawnabilityProbeError(
      `'which claude' failed — claude CLI not found on PATH. Install with: npm install -g @anthropic-ai/claude-code`,
    );
  }
}

/**
 * Restore the hive state contained in an archive into the typed memory
 * backend, register worker manifest, set queen.queenType, then re-spawn the
 * queen. Per ADR-0124 §Pseudocode "Resume sequence". Idempotent: a re-run of
 * `resume <id>` against the same checkpoint reaches the same fixed point per
 * §Refinement edge case "Queen re-spawn failure mid-resume".
 */
export async function resumeSession(
  sessionId: string,
  options?: { skipSpawn?: boolean },
): Promise<{ sessionId: string; archivePath: string; spawned: boolean }> {
  const archivePath = locateLatestArchive(sessionId);
  const archive = readArchiveFromPath(archivePath);

  // Probe BEFORE state mutation per ADR-0124 §Refinement.
  if (!options?.skipSpawn) {
    probeQueenSpawnability();
  }

  // Restore typed memory state under the lock so a sibling read sees the
  // restored snapshot atomically. The lock is the same one withHiveStoreLock
  // uses elsewhere — restore is a normal write-through path.
  await withHiveStoreLock(async () => {
    const restored = archive.hiveState;
    // H6 row 32: restore queenType onto state.queen so the new process reads
    // the right type. Per ADR-0124 §Pseudocode step 8.
    if (restored.queen) {
      if (archive.queenType !== undefined) {
        restored.queen.queenType = archive.queenType;
      }
    }
    // Re-anchor queenPrompt + workerManifest into typed memory so the
    // newly-restored hive can re-checkpoint without losing them.
    const now = Date.now();
    const promptEntry: MemoryEntry = {
      value: archive.queenPrompt,
      type: 'system',
      ttlMs: null,
      expiresAt: null,
      createdAt: restored.sharedMemory[SESSION_QUEEN_PROMPT_MEMORY_KEY]?.createdAt ?? now,
      updatedAt: now,
    };
    const manifestEntry: MemoryEntry = {
      value: archive.workerManifest,
      type: 'system',
      ttlMs: null,
      expiresAt: null,
      createdAt: restored.sharedMemory[SESSION_WORKER_MANIFEST_MEMORY_KEY]?.createdAt ?? now,
      updatedAt: now,
    };
    restored.sharedMemory[SESSION_QUEEN_PROMPT_MEMORY_KEY] = promptEntry;
    restored.sharedMemory[SESSION_WORKER_MANIFEST_MEMORY_KEY] = manifestEntry;
    saveHiveState(restored);
  });

  // Re-spawn the queen. Per `reference-ruflo-architecture.md`:
  //   ruflo orchestrates → child_process.spawn('claude', ...) executes
  //   against user's Claude subscription (NEVER an API key per
  //   `feedback-no-api-keys.md`).
  // The continuation marker tells the resumed queen it is resuming, not
  // initialising. Per ADR-0104, the queen's prompt template is responsible
  // for honouring `--continuation` / treating the prompt body as already-
  // established context.
  let spawned = false;
  if (!options?.skipSpawn) {
    childSpawn('claude', [archive.queenPrompt, '--continuation', sessionId], {
      stdio: 'inherit',
      shell: false,
      detached: true,
    }).unref();
    spawned = true;
  }

  return { sessionId, archivePath, spawned };
}

// ── Session subcommand handlers (CLI-side) ────────────────────────────────

const sessionsListSubcommand: Command = {
  name: 'list',
  description: 'List persisted hive-mind session checkpoints',
  options: [],
  examples: [{ command: 'claude-flow hive-mind sessions list', description: 'Enumerate checkpoints' }],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const archives = listSessionArchives();
    if (ctx.flags.format === 'json') {
      output.printJson({ sessions: archives });
      return { success: true, data: { sessions: archives } };
    }
    if (archives.length === 0) {
      output.printInfo('No hive-mind session checkpoints found.');
      output.writeln(output.dim(`  Looked under: ${getHiveSessionsDir()}`));
      return { success: true, data: { sessions: [] } };
    }
    output.writeln();
    output.printTable({
      columns: [
        { key: 'sessionId', header: 'Session ID', width: 28 },
        { key: 'checkpointAt', header: 'Checkpoint At', width: 28 },
        { key: 'sizeBytes', header: 'Bytes', width: 10 },
      ],
      data: archives.map(a => ({
        sessionId: a.sessionId,
        checkpointAt: a.checkpointAt,
        sizeBytes: a.sizeBytes,
      })),
    });
    return { success: true, data: { sessions: archives } };
  },
};

const sessionsCheckpointSubcommand: Command = {
  name: 'checkpoint',
  description: 'Checkpoint a hive-mind session to a versioned archive',
  options: [],
  examples: [
    { command: 'claude-flow hive-mind sessions checkpoint hive-1234', description: 'Snapshot session "hive-1234"' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sessionId = ctx.args[0];
    if (!sessionId) {
      output.printError('Usage: hive-mind sessions checkpoint <session-id>');
      return { success: false, exitCode: 1 };
    }
    try {
      const archivePath = await checkpointSession(sessionId);
      output.printSuccess(`Checkpoint written: ${archivePath}`);
      return { success: true, data: { sessionId, archivePath } };
    } catch (err) {
      output.printError(`Checkpoint failed: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  },
};

const sessionsExportSubcommand: Command = {
  name: 'export',
  description: 'Export a hive-mind session to a portable archive',
  options: [
    { name: 'output', short: 'o', description: 'Destination path (.json.gz)', type: 'string' },
  ],
  examples: [
    {
      command: 'claude-flow hive-mind sessions export hive-1234 --output /tmp/hive-1234.json.gz',
      description: 'Export to a portable archive',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sessionId = ctx.args[0];
    const outputPath = (ctx.flags.output as string) || ctx.args[1];
    if (!sessionId || !outputPath) {
      output.printError('Usage: hive-mind sessions export <session-id> --output <path>');
      return { success: false, exitCode: 1 };
    }
    try {
      await exportSessionToPath(sessionId, outputPath);
      output.printSuccess(`Exported "${sessionId}" → ${outputPath}`);
      return { success: true, data: { sessionId, outputPath } };
    } catch (err) {
      output.printError(`Export failed: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  },
};

const sessionsImportSubcommand: Command = {
  name: 'import',
  description: 'Import a portable archive into local hive-mind state',
  options: [],
  examples: [
    {
      command: 'claude-flow hive-mind sessions import /tmp/hive-1234.json.gz',
      description: 'Materialise archive under a fresh session id',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const archivePath = ctx.args[0];
    if (!archivePath) {
      output.printError('Usage: hive-mind sessions import <archive-path>');
      return { success: false, exitCode: 1 };
    }
    try {
      const result = await importSessionFromPath(archivePath);
      output.printSuccess(
        `Imported ${archivePath} → sessionId="${result.sessionId}" at ${result.archivePath}`,
      );
      output.writeln(
        output.dim(`  Run 'hive-mind resume ${result.sessionId}' to materialise the queen and workers.`),
      );
      return { success: true, data: result };
    } catch (err) {
      output.printError(`Import failed: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  },
};

/**
 * Top-level `sessions` group: dispatcher for list/checkpoint/export/import.
 * `resume` is a sibling of `sessions` (per ADR-0124 §Decision table) so it
 * lives directly on the hive-mind command, not under `sessions`.
 */
export const sessionsCommand: Command = {
  name: 'sessions',
  description: 'Manage hive-mind session checkpoints (list/checkpoint/export/import)',
  subcommands: [
    sessionsListSubcommand,
    sessionsCheckpointSubcommand,
    sessionsExportSubcommand,
    sessionsImportSubcommand,
  ],
  options: [],
  examples: [
    { command: 'claude-flow hive-mind sessions list', description: 'List all checkpoints' },
    { command: 'claude-flow hive-mind sessions checkpoint hive-1234', description: 'Checkpoint a session' },
    { command: 'claude-flow hive-mind sessions export hive-1234 -o /tmp/hive.json.gz', description: 'Export to a path' },
    { command: 'claude-flow hive-mind sessions import /tmp/hive.json.gz', description: 'Import from a path' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Hive Mind Sessions'));
    output.writeln();
    output.writeln('Usage: claude-flow hive-mind sessions <subcommand> [options]');
    output.writeln();
    output.printList([
      `${output.highlight('list')}        - Enumerate persisted checkpoints`,
      `${output.highlight('checkpoint')}  - Snapshot active hive to a versioned archive`,
      `${output.highlight('export')}      - Dump checkpoint to a portable archive`,
      `${output.highlight('import')}      - Materialise a portable archive into local state`,
    ]);
    output.writeln();
    output.writeln(output.dim('Resume is a sibling: `hive-mind resume <session-id>`.'));
    return { success: true };
  },
};

export const resumeCommand: Command = {
  name: 'resume',
  description: 'Resume a hive-mind session from its most recent checkpoint',
  options: [
    {
      name: 'skip-spawn',
      description: 'Restore typed memory + worker manifest only; do not re-spawn the queen',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow hive-mind resume hive-1234', description: 'Resume session "hive-1234"' },
    { command: 'claude-flow hive-mind resume hive-1234 --skip-spawn', description: 'Restore state without spawning queen' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sessionId = ctx.args[0];
    if (!sessionId) {
      output.printError('Usage: hive-mind resume <session-id> [--skip-spawn]');
      return { success: false, exitCode: 1 };
    }
    const skipSpawn = (ctx.flags.skipSpawn as boolean) || (ctx.flags['skip-spawn'] as boolean) || false;
    try {
      const result = await resumeSession(sessionId, { skipSpawn });
      output.printSuccess(`Resumed session "${result.sessionId}" from ${result.archivePath}`);
      if (!result.spawned) {
        output.writeln(output.dim('  --skip-spawn: queen not re-spawned (typed memory + worker manifest restored).'));
      }
      return { success: true, data: result };
    } catch (err) {
      output.printError(`Resume failed: ${(err as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Cleanup helpers exported for tests — no production caller deletes archives.
// `_unsafeDeleteArchiveForTest` is the only path that removes a checkpoint
// from disk; production code never deletes (per ADR-0124 the user manages
// archive lifecycle externally).
export function _unsafeDeleteArchiveForTest(archivePath: string): void {
  if (existsSync(archivePath)) {
    unlinkSync(archivePath);
  }
}
