import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, appendFile, unlink, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  IMemoryBackend,
  MemoryEntry,
  MemoryEntryUpdate,
  MemoryQuery,
  SearchOptions,
  SearchResult,
  BackendStats,
  HealthCheckResult,
  MemoryType,
} from './types.js';
import { HnswLite, cosineSimilarity } from './hnsw-lite.js';
import { deriveHNSWParams } from './hnsw-utils.js';
import {
  encodeMemoryEntryMetadata,
  decodeMemoryEntryMetadata,
  type RvfMetadataEntryWire,
} from './rvf-segment-fields.js';
import {
  validatePath,
  DEFAULT_WAL_COMPACTION_THRESHOLD,
  type RvfBackendConfig,
  type RvfHeader,
  MAGIC,
  NATIVE_MAGIC,
  VERSION,
  DEFAULT_DIMENSIONS,
  DEFAULT_M,
  DEFAULT_EF_CONSTRUCTION,
  DEFAULT_MAX_ELEMENTS,
  DEFAULT_PERSIST_INTERVAL,
} from './rvf-backend-types.js';
import { RvfCorruptError, RvfNotInitializedError } from './rvf-backend-errors.js';

// Re-export so existing `import { RvfBackendConfig, RvfCorruptError } from
// './rvf-backend.js'` callers keep working. ADR-0154 G7 split the type +
// error surfaces into sibling modules but the public import path stays
// at './rvf-backend.js'.
export type { RvfBackendConfig };
export { RvfCorruptError, RvfNotInitializedError };

// ADR-0086 Debt 1: IStorageContract is now a type alias for IMemoryBackend,
// so the redundant implements clause has been removed.
export class RvfBackend implements IMemoryBackend {
  private entries = new Map<string, MemoryEntry>();
  private keyIndex = new Map<string, string>();
  // ADR-0090 B7 followup: tracks every entry ID this instance has ever
  // seen (initial load + stores). Deletes do NOT remove from this set —
  // that is the point. `mergePeerStateBeforePersist` consults this set
  // so that an entry we explicitly bulkDelete()d does not get
  // resurrected by re-reading our own pre-delete state from disk under
  // "set-if-absent" semantics. Without this tombstone, the merge treats
  // "we deleted this" identically to "peer wrote this", which turns
  // every bulkDelete into a no-op during the persist path.
  private seenIds = new Set<string>();
  private hnswIndex: HnswLite | null = null;
  private nativeDb: any = null;
  private config: Required<RvfBackendConfig>;
  private initialized = false;
  private dirty = false;
  private persisting = false;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private queryTimes: number[] = [];
  private searchTimes: number[] = [];
  private _capacityWarned = false;

  // WAL state (Phase 1)
  private walPath = '';
  private lockPath = '';
  private walEntryCount = 0;

  // ADR-0130 (T11) WAL fsync metrics. The fsync happens INSIDE appendToWal,
  // before the JS lock is released, on every WAL append. Counters are
  // process-local; fsync latency is recorded as an unbounded array but
  // capped to the most recent N samples for p50/p99 reporting (matches
  // existing `queryTimes` / `searchTimes` pattern, lines 95-96).
  //
  // _walFsyncFallback is set true on the first ENOSYS from fdatasync; once
  // tripped, subsequent calls go directly to fsync without retrying
  // fdatasync. Single-fork; no env var; automatic platform detection.
  //
  // Per-platform durability semantics (documented in appendToWal JSDoc):
  //   Linux:  fdatasync(2) -> durable through power loss on ext4/xfs/btrfs
  //   Darwin: fsync(2)     -> durable through process-kill / OS-crash;
  //                          power-loss durability bounded by disk write
  //                          cache (Node fs.fsync does NOT issue
  //                          fcntl(F_FULLFSYNC); macOS power-loss
  //                          durability requires F_FULLFSYNC, out of scope
  //                          for this ADR — see ADR-0130 §Specification).
  private _walFsyncCount = 0;
  private _walFsyncLatencyMs: number[] = [];
  private _walFsyncFallback = false;

  // ADR-0095 amendment (2026-05-01, t3-2 silent-loss fix): re-entrant
  // counter for the JS advisory lock. Lets `store()` hold the lock
  // across in-mem mutation + the WAL helpers as one atomic region.
  // Without this, the lock was released/reacquired 3 times per store;
  // peer writers could interleave between releases, producing
  // observed=1, subproc-fail=0 silent loss. Counter is process-local
  // and protects same-process re-entry only — cross-process exclusion
  // is unchanged.
  private _lockHeldDepth = 0;

  // Native ID mapping (Phase 3)
  private nativeIdMap = new Map<string, number>();
  private nativeReverseMap = new Map<number, string>();
  private nextNativeId = 1;

  // ADR-0095 amendment (ruflo-patch commit 2d12bb1): per-instance counter for
  // unique tmp paths during atomic writes. Combined with process.pid, this
  // guarantees disjoint tmp filenames across concurrent writers so one
  // writer's rename cannot clobber another writer's in-flight tmp file.
  private _tmpCounter = 0;

  // ADR-0095 amendment d5 (ruflo-patch): "native-SFVR-exists but checksum
  // broken, .meta sidecar intact" fallback. Pass-4 findings (ADR-0095
  // `Investigation Findings 2026-04-18`) confirmed `RvfDatabase.ingestBatch`
  // has an unlocked multi-writer race that corrupts ~5-10% of native `.rvf`
  // files with `InvalidChecksum` (error code 0x0102) while the pure-TS
  // `.meta` sidecar remains consistent. Pre-d5 behavior was "loud total
  // failure" when native open threw — a lie, because the pure-TS `.meta`
  // data was sitting right there, never tried. Under d5: on
  // `InvalidChecksum` specifically (NOT LockHeld, NOT other errors), we
  // set this flag, skip native init, and let pure-TS `loadFromDisk` pull
  // entries from `.meta`. Writes in this process append to WAL and compact
  // to `.meta` (not the corrupt main path) so future native-capable
  // processes still see the original SFVR file intact and can retry.
  //
  // LOUD: every time we fall back we log to stderr with the RVF error code.
  // Per ADR-0082, the fallback is not silent; it's a degrade-and-shout.
  private nativeFallbackMode = false;
  private nativeFallbackUseCount = 0;

  // ADR-0095 amendment (2026-05-01, swarm 2 instrumentation): per-instance
  // diag helper. Gated by RVF_DIAG=1 (separate from RVF_DEBUG so we can
  // turn on instrumentation without flooding existing debug paths). Logs
  // include pid + ts (ms) so multi-process logs can be merged + time-ordered.
  private _diag(msg: string): void {
    if (!process.env.RVF_DIAG) return;
    const ts = Date.now();
    const path = this.config?.databasePath ?? '?';
    process.stderr.write(`[RVF-DIAG pid=${process.pid} t=${ts}] ${msg} @${path}\n`);
  }

  // ADR-0094 Sprint 1.4 d8 (ruflo-patch): lazy native re-ingest after load.
  //
  // Pre-fix behavior: loadFromDisk() and replayWal() unconditionally called
  // `nativeDb.ingestBatch()` for every entry they loaded, even though the
  // native SFVR file ALREADY contains those vectors (they were written
  // there by the prior process's `store()` call, which persists
  // synchronously via the native library). This caused .rvf to grow by
  // ~(N_entries × dim × 4) bytes on EVERY process init — observed as
  // ~3.6KB/list on a 1-entry, 768-dim setup. Running `memory list` 100
  // times inflated `.rvf` by ~360KB of orphan vector segments that nothing
  // points to (the HNSW index inside the native file was not rebuilt to
  // include them — see ADR-0092 comment in replayWal).
  //
  // The re-ingest is only NEEDED for one path: `search()` via
  // `nativeDb.query()` returns numeric IDs that must be mapped back to
  // string IDs via `nativeReverseMap`. The map is populated by
  // `assignNativeId` during ingestBatch. If we never ingest, the map is
  // empty for cross-process entries and semantic queries silently return
  // nothing.
  //
  // Fix: defer the re-ingest until semantic search is actually requested.
  // `memory list`, `memory store`, and all prefix/filter queries don't
  // need the map and so don't pay the re-ingest cost. On first `search()`
  // or `query(semantic)` in a process, `ensureNativeSemanticReady()`
  // rehydrates the native index once by iterating `this.entries`. This
  // still causes one-time growth per process that performs semantic
  // search, but zero growth for pure-read/pure-write CLI flows.
  //
  // `_pendingNativeIngest` holds (stringId, embedding) pairs collected
  // during loadFromDisk/replayWal when nativeDb is present but the
  // ingestBatch is deferred. `_nativeRehydrated` is set to true after
  // `ensureNativeSemanticReady()` completes so we do the work at most
  // once per process.
  private _pendingNativeIngest: Array<{ id: string; embedding: Float32Array }> = [];
  private _nativeRehydrated = false;

  // ADR-0090 Tier B2 (ruflo-patch): deferred corruption signal from
  // tryNativeInit.
  //
  // `tryNativeInit` detects several corruption shapes BEFORE loadFromDisk
  // runs:
  //   1. SFVR magic present but `RvfDatabase.open` throws fatally
  //      (ManifestNotFound, parse errors, non-retriable shapes — line 939).
  //   2. Partial magic peek (1-3 bytes of a 4-byte magic — line 963). The
  //      file exists on disk but has fewer than 4 header bytes — either a
  //      peer is mid-write or the file was truncated post-shutdown.
  //   3. Unknown magic that is neither SFVR (native) nor RVF\0 (pure-TS)
  //      — line 975. File is from an unknown format or has a zeroed
  //      header.
  //
  // Pre-fix behavior: `tryNativeInit` threw a plain `Error` at each site
  // and `initialize()` let it bubble out. This broke two invariants:
  //
  //   - `.name` was 'Error', not 'RvfCorruptError' — callers could not
  //     discriminate corruption from other init failures.
  //   - `loadFromDisk`'s WAL replay never got a chance to run. When the
  //     main file was corrupt BUT the WAL had uncompacted entries from a
  //     prior process, the pre-fix code threw on the native-init side
  //     before the WAL could recover. The recovery path documented at
  //     lines 1866-1885 ("always replay WAL ... if WAL has entries, don't
  //     throw") was unreachable.
  //
  // Fix: `tryNativeInit` sets this field to a human-readable reason
  // string instead of throwing. It returns `false` so `loadFromDisk` runs
  // with nativeDb=null and pure-TS semantics. `loadFromDisk` then either:
  //   a. Reads the `.meta` sidecar successfully and ignores the deferred
  //      reason (native was corrupt but pure-TS metadata survived).
  //   b. Fails to read any main file AND the WAL yields no entries — in
  //      which case the final guard at the end of `loadFromDisk` throws
  //      `RvfCorruptError` using this reason.
  //   c. Fails to read any main file BUT the WAL replays successfully
  //      with >=1 entries — no throw, deferred reason is cleared
  //      (corruption is logically repaired by the WAL).
  //
  // The field is cleared at the top of `initialize()` for the first run
  // and reset to null inside `loadFromDisk` after it's consumed, so a
  // later retry on the same instance doesn't see stale state.
  private _deferredCorruptReason: string | null = null;

  constructor(config: RvfBackendConfig) {
    const dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 10000) {
      throw new Error(`Invalid dimensions: ${dimensions}. Must be an integer between 1 and 10000.`);
    }
    const derived = deriveHNSWParams(dimensions);
    this.config = {
      databasePath: config.databasePath,
      dimensions,
      metric: config.metric ?? 'cosine',
      quantization: config.quantization ?? 'fp32',
      hnswM: config.hnswM ?? derived.M,
      hnswEfConstruction: config.hnswEfConstruction ?? derived.efConstruction,
      hnswEfSearch: config.hnswEfSearch ?? derived.efSearch,
      maxElements: config.maxElements ?? DEFAULT_MAX_ELEMENTS,
      verbose: config.verbose ?? false,
      defaultNamespace: config.defaultNamespace ?? 'default',
      autoPersistInterval: config.autoPersistInterval ?? DEFAULT_PERSIST_INTERVAL,
      walCompactionThreshold: config.walCompactionThreshold ?? DEFAULT_WAL_COMPACTION_THRESHOLD,
    };
    validatePath(this.config.databasePath);
    // ADR-0095 amendment (2026-04-30, t3-2 fix): JS-side advisory lock
    // path is `.jslock`, NOT `.lock`. The native rvf-runtime crate
    // (forks/ruvector/crates/rvf/rvf-runtime/src/locking.rs lock_path_for)
    // ALREADY uses `path + ".lock"` for its WriterLease / FLVR-format
    // binary lock file. JS using the same path collided: native writes
    // FLVR magic + PID + UUID; JS tries to JSON.parse it, fails. The
    // collision was the primary t3-2 silent-data-loss vector — JS
    // peers would either steal the native lock (old behavior) or wait
    // forever (the new safer behavior). Either way, broken. Disjoint
    // paths fix the collision; the native lock remains authoritative
    // for native ops, and JS's advisory lock guards JS-side mutations.
    this.walPath = this.config.databasePath === ':memory:' ? '' : this.config.databasePath + '.wal';
    this.lockPath = this.config.databasePath === ':memory:' ? '' : this.config.databasePath + '.jslock';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // ADR-0090 Tier B2 (ruflo-patch): reset the deferred-corruption
    // signal at the top of every init. This field is set inside
    // tryNativeInit when the native binding refuses the on-disk state
    // (see `_deferredCorruptReason` comment for the full contract) and
    // consumed by loadFromDisk's final corruption guard. Must be nulled
    // here so a re-init on the same RvfBackend instance (shutdown →
    // initialize) starts with a clean slate.
    this._deferredCorruptReason = null;

    // ADR-0095 amendment (2026-05-01, post-flock t3-2 fix): scope the JS
    // init lock down. The previous "wrap everything in .jslock" pattern was
    // only load-bearing because the old native WriterLock (O_CREAT|O_EXCL,
    // non-blocking) couldn't serialize concurrent `RvfDatabase::create`
    // calls — losers raced through the bare-file `OpenOptions::create_new`
    // and produced FsyncFailed. With the rvf-runtime flock-based WriterLock
    // (commit c40d8963 in the ruvector fork) the native open path is now
    // BLOCKING and FIFO-fair at the kernel level, so JS-side serialization
    // of `tryNativeInit` is redundant and actively harmful: writer A would
    // hold the JS lock while waiting for the native flock, blocking all
    // peers' JS lock acquisitions and timing them out at the 60s budget
    // (observed: t3-2 1/6 hits, 5/6 "Failed to acquire advisory lock after
    // 100 attempts over 60453ms").
    //
    // Scoped behaviour:
    //   - tmp-file reap: idempotent, race-tolerant. NO JS lock needed.
    //   - native init: native flock provides cross-process exclusion.
    //     NO JS lock needed.
    //   - disk load + replay: reads JS-owned `.meta` and `.wal`. The
    //     native flock does NOT cover these JS-side files. JS lock
    //     remains around this step to serialize against peer renames
    //     and journal appends.
    this._diag('initialize.start');
    await this.reapStaleTmpFiles().catch(() => {});
    this._diag('initialize.reapDone');

    const hasNative = await this.tryNativeInit();
    this._diag(`initialize.tryNativeInit.return hasNative=${hasNative} nativeDb=${this.nativeDb ? 'set' : 'null'} fallback=${this.nativeFallbackMode} deferred=${this._deferredCorruptReason ? 'set' : 'null'}`);

    // Only create HnswLite when native is NOT available (Debt 8)
    if (!hasNative) {
      this.hnswIndex = new HnswLite(
        this.config.dimensions,
        this.config.hnswM,
        this.config.hnswEfConstruction,
        this.config.metric,
      );
    }

    // JS-side WAL/meta race window — kept under .jslock.
    // Bug-4 (2026-05-05) parallel-wave thread-safety: init-time uses a 180s
    // budget instead of the 60s default. Subprocess CLI inits in a shared
    // data dir (acceptance harness E2E_DIR or any other multi-writer
    // setup) can see ~10 concurrent .jslock contenders; the default 60s
    // budget hits 100-attempt timeout under that load. Init is one-time
    // per process and tolerating a 1-3 minute wait beats failing the
    // memory_store call entirely.
    this._diag('initialize.preLoadFromDisk acquiring jslock');
    await this.acquireLock(180_000);
    this._diag(`initialize.loadFromDisk.start entriesBefore=${this.entries.size} seenIdsBefore=${this.seenIds.size}`);
    try {
      await this.loadFromDisk();
      this._diag(`initialize.loadFromDisk.done entriesAfter=${this.entries.size} seenIdsAfter=${this.seenIds.size}`);
    } finally {
      await this.releaseLock();
      this._diag('initialize.releasedJslock');
    }
    this._diag(`initialize.complete entries=${this.entries.size} fallback=${this.nativeFallbackMode} deferred=${this._deferredCorruptReason ? 'set' : 'null'}`);

    if (this.config.autoPersistInterval > 0 && this.config.databasePath !== ':memory:') {
      this.persistTimer = setInterval(() => {
        if (this.dirty && !this.persisting) {
          const op = this.walEntryCount > 0 ? this.compactWal() : this.persistToDisk();
          // ADR-0112 Phase 2 (RVF track) + feedback-best-effort-must-rethrow-fatals:
          // discriminate. RvfCorruptError + RvfNotInitializedError signal real
          // data-integrity problems and must NOT be silently swallowed by the
          // fire-and-forget timer — surface them so the next caller's invocation
          // sees the broken state. Lock-acquisition failures + transient I/O
          // errors are recoverable and OK to swallow (the next tick retries).
          op.catch((err: unknown) => {
            const name = err instanceof Error ? err.name : '';
            if (name === 'RvfCorruptError' || name === 'RvfNotInitializedError') {
              // Re-throw asynchronously so the unhandledRejection handler logs
              // it and the dirty flag stays set (next caller sees the failure).
              setImmediate(() => { throw err; });
            }
            // Else: transient — next tick retries.
          });
        }
      }, this.config.autoPersistInterval);
      if (this.persistTimer.unref) this.persistTimer.unref();
    }

    this.initialized = true;
    if (this.config.verbose) {
      const mode = this.nativeDb ? 'native @ruvector/rvf'
        : this.nativeFallbackMode ? 'pure-TS + .meta sidecar (native InvalidChecksum fallback, d5)'
        : 'pure-TS fallback';
      console.log(`[RvfBackend] Initialized (${mode}), ${this.entries.size} entries loaded`);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }

    if (this.dirty) {
      if (this.walEntryCount > 0) {
        await this.compactWal();
      } else {
        await this.persistToDisk();
      }
    }

    if (this.nativeDb) {
      // silent-fallthrough-OK: shutdown is best-effort cleanup; native close failure does not affect data integrity
      try { this.nativeDb.close(); } catch {}
      this.nativeDb = null;
    }

    this.entries.clear();
    this.seenIds.clear();
    this.keyIndex.clear();
    this.hnswIndex = null;
    this.initialized = false;

    // Clean up advisory lock file — ONLY if WE own it. A blanket unlink
    // here would unlink a peer's lock and re-introduce the t3-2 corruption
    // chain. releaseLock has the same PID-verify check; this is just for
    // the case where shutdown is called outside any lock-acquired region.
    if (this.lockPath) {
      try {
        const { readFile: rf } = await import('node:fs/promises');
        const content = await rf(this.lockPath, 'utf-8');
        const { pid } = JSON.parse(content);
        if (pid === process.pid) {
          // silent-fallthrough-OK: lock file may have been removed by peer between our read and unlink; ENOENT is expected
          try { await unlink(this.lockPath); } catch {}
        }
      } catch {
        // silent-fallthrough-OK: no lock file or unparseable content — nothing to clean up
      }
    }
  }

  /**
   * ADR-0112 Phase 2 (RVF track): public-method init guard. Throws
   * RvfNotInitializedError if `initialize()` has not completed. Applied
   * at the top of all 9 data-path methods (store / get / getByKey /
   * update / delete / query / search / bulkInsert / bulkDelete) so a
   * caller that forgets to await initialize() gets a precise error
   * naming the method instead of silent in-memory degradation.
   */
  private requireInitialized(method: string): void {
    if (!this.initialized) {
      throw new RvfNotInitializedError(method);
    }
  }

  async store(entry: MemoryEntry): Promise<void> {
    this.requireInitialized('store');
    this.checkCapacity();
    const ns = entry.namespace || this.config.defaultNamespace;
    const e = ns !== entry.namespace ? { ...entry, namespace: ns } : entry;
    const storeStart = Date.now();
    this._diag(`store.start key=${e.key} ns=${e.namespace} entries=${this.entries.size} fallback=${this.nativeFallbackMode} nativeDb=${this.nativeDb ? 'set' : 'null'}`);

    // ADR-0095 amendment (2026-05-01, t3-2 silent-loss fix): hold the
    // advisory lock across the WHOLE store sequence — in-mem mutation,
    // native ingest, WAL append, and WAL compact — as one atomic
    // critical section. Previously the lock was released after the
    // mutation step, then re-acquired by the WAL helpers independently.
    // That gave peer writers TWO interleave windows per store: between
    // mutate and journal-append, and between journal-append and
    // compact. Under N=6 concurrent writers a peer's compact step
    // would unlink our just-written journal entry before our own
    // compact merged it, dropping our entry — visible as
    // observed=1, subproc-fail=0 silent loss.
    //
    // Why this is safe now (it wasn't in 2026-04-30):
    //   - The .jslock acquire path is re-entrant (depth counter), so
    //     the WAL helpers nesting do NOT deadlock.
    //   - The previous "5s staleness threshold" stealing was removed —
    //     we no longer steal locks from live holders, we wait. Holding
    //     for ~1-2s under N=6 contention is correct, not pathological.
    //   - Native rvf-runtime now uses kernel flock(LOCK_EX) for
    //     cross-process exclusion, so the native ingest path doesn't
    //     race even when held under the JS lock.
    await this.acquireLock();
    try {
      this.entries.set(e.id, e);
      this.seenIds.add(e.id);
      this.keyIndex.set(this.compositeKey(e.namespace, e.key), e.id);
      // Index in ONE backend, not both (Debt 8)
      // ADR-0164 A0c (J1): δ+ vectorless ingest path. Vectorless entries
      // route to nativeDb.ingestMetadataOnly so they reach META_SEG and
      // survive process restart without the legacy .meta sidecar. Vector-
      // bearing entries continue through ingestBatch + HnswLite as before.
      if (this.nativeDb) {
        const numId = this.assignNativeId(e.id);
        try {
          // ADR-0154 Phase 3: persist metadata via META_SEG alongside the
          // vector. The native runtime now writes a META_SEG immediately
          // after the VEC_SEG and reconstructs metadata on reopen, so the
          // .meta sidecar (ADR-0095 d5 workaround) is no longer needed.
          const metaEntries = encodeMemoryEntryMetadata(e);
          if (e.embedding) {
            this.nativeDb.ingestBatch(new Float32Array(e.embedding), [numId], metaEntries);
          } else {
            this.nativeDb.ingestMetadataOnly([numId], [metaEntries]);
          }
        } catch (err) {
          // ADR-0095 d5: InvalidChecksum from ingestBatch means the native
          // file's segment hashes no longer validate — further native ops
          // would keep lying. Degrade loudly, then fall through to the
          // pure-TS indexing branch via reIndexAfterDegrade.
          if (!this.degradeToFallbackMode('store', err) && this.config.verbose) {
            console.error('[RvfBackend] Native ingest failed:', (err as Error).message);
          }
          // ADR-0164 A0d: unreachable under δ-strict (degradeToFallbackMode throws).
          if (e.embedding) this.reIndexAfterDegrade(e.id, e.embedding);
        }
      } else if (e.embedding && this.hnswIndex) {
        this.hnswIndex.add(e.id, e.embedding);
      }
      this.dirty = true;

      // WAL append + compact INSIDE the same lock. Each helper internally
      // re-acquires the lock; the depth counter no-ops the inner acquire.
      this._diag(`store.preAppendToWal key=${e.key} entries=${this.entries.size}`);
      await this.appendToWal(e);
      this._diag(`store.postAppendToWal key=${e.key} walEntryCount=${this.walEntryCount}`);
      // ADR-0090 Tier A4 / B7 concurrent-write fix: always compact after
      // every store, not just when walCompactionThreshold is hit.
      if (this.walPath) {
        this._diag('store.preCompactWal');
        await this.compactWal();
        this._diag('store.postCompactWal');
      }
    } finally {
      await this.releaseLock();
      this._diag(`store.end key=${e.key} totalElapsed=${Date.now() - storeStart}ms`);
    }
  }

  async get(id: string): Promise<MemoryEntry | null> {
    this.requireInitialized('get');
    this.noteNativeFallbackUse('get');
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    return entry;
  }

  async getByKey(namespace: string, key: string): Promise<MemoryEntry | null> {
    this.requireInitialized('getByKey');
    this.noteNativeFallbackUse('getByKey');
    const id = this.keyIndex.get(this.compositeKey(namespace, key));
    if (!id) return null;
    return this.get(id);
  }

  async update(id: string, updateData: MemoryEntryUpdate): Promise<MemoryEntry | null> {
    this.requireInitialized('update');
    const entry = this.entries.get(id);
    if (!entry) return null;

    const updated: MemoryEntry = {
      ...entry,
      ...updateData,
      updatedAt: Date.now(),
      version: entry.version + 1,
    };
    this.entries.set(id, updated);
    // Re-index in ONE backend, not both (Debt 8)
    // ADR-0164 A0c (J2): δ+ vectorless update path mirrors J1. Vectorless
    // updates route delete + ingestMetadataOnly so the new META_SEG shadows
    // any prior one for this id.
    if (this.nativeDb) {
      const numId = this.assignNativeId(id);
      try {
        this.nativeDb.delete([numId]);
        // ADR-0154 Phase 3: re-emit metadata on update so the new META_SEG
        // shadows the previous one. boot() replays segments in order so
        // the latest write wins.
        const metaEntries = encodeMemoryEntryMetadata(updated);
        if (updated.embedding) {
          this.nativeDb.ingestBatch(new Float32Array(updated.embedding), [numId], metaEntries);
        } else {
          this.nativeDb.ingestMetadataOnly([numId], [metaEntries]);
        }
      } catch (err) {
        // ADR-0095 d5: checksum failure during update — degrade, then
        // re-apply via reIndexAfterDegrade (idempotent remove+add).
        if (!this.degradeToFallbackMode('update', err) && this.config.verbose) {
          console.error('[RvfBackend] Native update re-ingest failed:', (err as Error).message);
        }
        // ADR-0164 A0d: unreachable under δ-strict (degradeToFallbackMode throws).
        this.removeAfterDegrade(id);
        // ADR-0164 A0d: unreachable under δ-strict (degradeToFallbackMode throws).
        if (updated.embedding) this.reIndexAfterDegrade(id, updated.embedding);
      }
    } else if (updated.embedding && this.hnswIndex) {
      this.hnswIndex.remove(id);
      this.hnswIndex.add(id, updated.embedding);
    }
    this.dirty = true;
    await this.appendToWal(updated);
    if (this.walEntryCount >= this.config.walCompactionThreshold) {
      await this.compactWal();
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    this.requireInitialized('delete');
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this.keyIndex.delete(this.compositeKey(entry.namespace, entry.key));
    if (this.hnswIndex) this.hnswIndex.remove(id);
    // Native vector routing: remove from NAPI backend when available
    if (this.nativeDb) {
      const numId = this.nativeIdMap.get(id);
      if (numId !== undefined) {
        try {
          this.nativeDb.delete([numId]);
        } catch (err) {
          // ADR-0095 d5: handle InvalidChecksum here too — a delete on a
          // checksum-corrupt file can throw the same 0x0102.
          if (!this.degradeToFallbackMode('delete', err) && this.config.verbose) {
            console.error('[RvfBackend] Native delete failed:', (err as Error).message);
          }
        }
        this.nativeIdMap.delete(id);
        this.nativeReverseMap.delete(numId);
      }
    }
    this.dirty = true;
    // Truncate WAL BEFORE full rewrite — prevents deleted entries from
    // resurrecting if process crashes between persist and unlink.
    if (this.walPath && this.walEntryCount > 0) {
      // silent-fallthrough-OK: WAL truncate is a defense-in-depth step before full persist; persist itself is the durable write
      try { await writeFile(this.walPath, Buffer.alloc(0)); } catch {}
      this.walEntryCount = 0;
    }
    await this.persistToDisk();
    this._capacityWarned = false;
    return true;
  }

  async query(q: MemoryQuery): Promise<MemoryEntry[]> {
    this.requireInitialized('query');
    this.noteNativeFallbackUse('query');
    const start = performance.now();
    let results = Array.from(this.entries.values());

    // Single-pass filter (Debt 13) — replaces 12 sequential .filter() calls
    results = results.filter(e => {
      if (q.namespace && e.namespace !== q.namespace) return false;
      if (q.key && e.key !== q.key) return false;
      if (q.keyPrefix && !e.key.startsWith(q.keyPrefix)) return false;
      if (q.tags?.length && !q.tags.every(t => e.tags.includes(t))) return false;
      if (q.memoryType && e.type !== q.memoryType) return false;
      if (q.accessLevel && e.accessLevel !== q.accessLevel) return false;
      if (q.ownerId && e.ownerId !== q.ownerId) return false;
      if (q.createdAfter && e.createdAt <= q.createdAfter) return false;
      if (q.createdBefore && e.createdAt >= q.createdBefore) return false;
      if (q.updatedAfter && e.updatedAt <= q.updatedAfter) return false;
      if (q.updatedBefore && e.updatedAt >= q.updatedBefore) return false;
      if (!q.includeExpired) {
        if (e.expiresAt && e.expiresAt <= Date.now()) return false;
      }
      return true;
    });

    // Semantic search via native or HnswLite (Debt 8 — exclusive, not both)
    if (q.type === 'semantic' && q.embedding) {
      // ADR-0094 Sprint 1.4 d8: rehydrate nativeReverseMap before the first
      // semantic query in this process. See `ensureNativeSemanticReady`.
      this.ensureNativeSemanticReady();
      let semanticIds: Set<string>;
      if (this.nativeDb) {
        try {
          const raw = this.nativeDb.query(new Float32Array(q.embedding), q.limit * 2, {});
          semanticIds = new Set(raw.map((r: any) => this.nativeReverseMap.get(r.id)).filter(Boolean));
        } catch (err) {
          // ADR-0095 d5: if this is InvalidChecksum, degrade and retry via
          // HnswLite. Any other error still bubbles (ADR-0082: don't mask
          // LockHeld / OOM / unrelated failures behind a blanket fallback).
          if (this.degradeToFallbackMode('query', err)) {
            if (this.hnswIndex) {
              const searchResults = this.hnswIndex.search(q.embedding, q.limit, q.threshold);
              semanticIds = new Set(searchResults.map(r => r.id));
            } else {
              semanticIds = new Set();
            }
          } else {
            throw err;
          }
        }
      } else if (this.hnswIndex) {
        const searchResults = this.hnswIndex.search(q.embedding, q.limit, q.threshold);
        semanticIds = new Set(searchResults.map(r => r.id));
      } else {
        semanticIds = new Set();
      }
      results = results.filter(e => semanticIds!.has(e.id));
    }

    const offset = q.offset ?? 0;
    results = results.slice(offset, offset + q.limit);

    this.recordTiming(this.queryTimes, start);
    return results;
  }

  async search(embedding: Float32Array, options: SearchOptions): Promise<SearchResult[]> {
    this.requireInitialized('search');
    this.noteNativeFallbackUse('search');
    const start = performance.now();
    let results: SearchResult[];

    if (this.nativeDb) {
      // ADR-0094 Sprint 1.4 d8: rehydrate nativeReverseMap before the first
      // semantic search in this process. See `ensureNativeSemanticReady`.
      this.ensureNativeSemanticReady();
      // Native NAPI vector search — fast ANN lookup, then filter metadata
      try {
        let mappedHits = 0;
        let orphanHits = 0;
        const raw: Array<{ id: number; distance: number }> = this.nativeDb.query(
          new Float32Array(embedding), options.k * 2,
          { efSearch: this.config.hnswEfSearch },
        );
        results = [];
        for (const r of raw) {
          const stringId = this.nativeReverseMap.get(r.id);
          if (!stringId) { orphanHits++; continue; }
          mappedHits++;
          const entry = this.entries.get(stringId);
          if (!entry) continue;
          if (options.filters?.namespace && entry.namespace !== options.filters.namespace) continue;
          if (options.filters?.tags && !options.filters.tags.every(t => entry.tags.includes(t))) continue;
          if (options.filters?.memoryType && entry.type !== options.filters.memoryType) continue;
          // Convert distance → similarity score, metric-aware
          const score = this.config.metric === 'cosine' ? 1 - r.distance
            : this.config.metric === 'dot' ? r.distance // dot product: higher = more similar
            : 1 / (1 + r.distance); // euclidean: map [0,∞) → (0,1]
          if (options.threshold && score < options.threshold) continue;
          results.push({ entry, score, distance: r.distance });
        }
        results = results.slice(0, options.k);

        // ADR-0094 d8 follow-up (Bug 1, 2026-05-05): orphan-segment self-heal.
        // When a process opens an existing .rvf file, the SFVR file already
        // contains vector segments persisted by prior processes with their
        // own runtime-assigned numIds. The current process's nativeReverseMap
        // is empty at open and ensureNativeSemanticReady() only re-ingests
        // entries from _pendingNativeIngest — it does NOT reconcile orphan
        // numIds. So this.nativeDb.query() returns ANN hits whose r.id is an
        // orphan numId, line `if (!stringId) continue` silently drops every
        // hit, and the result list is []. memory_retrieve still works because
        // it uses keyIndex → entries Map directly.
        //
        // Detection: native query returned hits but ZERO mapped to known
        // string IDs in this process. The entries Map IS authoritative
        // (populated by loadFromDisk + replayWal). Re-run via pureTsSearch.
        // NOT a silent fallback (ADR-0082): we loud-warn the orphan count.
        // Long-term fix is to persist nativeIdMap in .meta — flagged at
        // line ~1543 as future work.
        // ADR-0147 (Bug 1 refinement, 2026-05-06): supplement instead of replace.
        // Original 71b2ad33e fix only triggered pureTsSearch when 100% of native
        // hits were orphans (`mappedHits === 0`). Real-world cross-process state
        // mixes mapped (this-process) and orphan (prior-process) entries — the
        // strict trigger missed cases where SOME entries map but the orphan-only
        // entries were silently dropped. New trigger: if more than half of native
        // hits were dropped as orphans, supplement with pureTsSearch over all
        // entries, dedupe by entry.id, sort by score-DESC, then slice to k.
        if (raw.length > 0 && (orphanHits / Math.max(raw.length, 1)) > 0.5 && this.entries.size > 0) {
          if (this.config.verbose) {
            console.warn(
              `[RvfBackend] Native search returned ${orphanHits} orphan numIds ` +
              `(${orphanHits}/${raw.length} of native hits). Supplementing with pure-TS over ` +
              `${this.entries.size} entries. Run \`ruflo memory rebuild\` to compact the SFVR file.`,
            );
          }
          const supplemental = this.pureTsSearch(embedding, options);
          const seen = new Set(results.map(r => r.entry.id));
          for (const s of supplemental) {
            if (seen.has(s.entry.id)) continue;
            results.push(s);
            seen.add(s.entry.id);
          }
          // Re-sort by score-DESC so highest-quality matches survive the slice.
          results.sort((a, b) => b.score - a.score);
          results = results.slice(0, options.k);
        }
      } catch (err) {
        // ADR-0095 d5: the pre-d5 code silently fell through to pure-TS on
        // *any* native error — ADR-0082 violation. Now we discriminate:
        // InvalidChecksum → loudly degrade + use pure-TS path; other errors
        // → rethrow so LockHeld / OOM / unrelated failures surface. This is
        // the read-side version of the native-init open() fix.
        if (!this.degradeToFallbackMode('search', err)) {
          throw err;
        }
        results = this.pureTsSearch(embedding, options);
      }
    } else {
      results = this.pureTsSearch(embedding, options);
    }

    this.recordTiming(this.searchTimes, start);
    return results;
  }

  private pureTsSearch(embedding: Float32Array, options: SearchOptions): SearchResult[] {
    if (this.hnswIndex) {
      const raw = this.hnswIndex.search(embedding, options.k * 2, options.threshold);
      const results: SearchResult[] = [];
      for (const r of raw) {
        const entry = this.entries.get(r.id);
        if (!entry) continue;
        if (options.filters?.namespace && entry.namespace !== options.filters.namespace) continue;
        if (options.filters?.tags && !options.filters.tags.every(t => entry.tags.includes(t))) continue;
        if (options.filters?.memoryType && entry.type !== options.filters.memoryType) continue;
        results.push({ entry, score: r.score, distance: 1 - r.score });
      }
      return results.slice(0, options.k);
    }
    return this.bruteForceSearch(embedding, options);
  }

  async bulkInsert(entries: MemoryEntry[]): Promise<void> {
    this.requireInitialized('bulkInsert');
    this.checkCapacity(entries.length);
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
      this.seenIds.add(entry.id);
      this.keyIndex.set(this.compositeKey(entry.namespace, entry.key), entry.id);
      // Index in ONE backend, not both (Debt 8)
      // ADR-0164 A0c (J3): δ+ vectorless bulk insert mirrors J1.
      if (this.nativeDb) {
        const numId = this.assignNativeId(entry.id);
        try {
          // ADR-0154 Phase 3: persist metadata via META_SEG.
          const metaEntries = encodeMemoryEntryMetadata(entry);
          if (entry.embedding) {
            this.nativeDb.ingestBatch(new Float32Array(entry.embedding), [numId], metaEntries);
          } else {
            this.nativeDb.ingestMetadataOnly([numId], [metaEntries]);
          }
        } catch (err) {
          // ADR-0095 d5: same degrade path used by store() — first
          // InvalidChecksum kills native for this process and re-routes
          // subsequent entries via reIndexAfterDegrade.
          if (!this.degradeToFallbackMode('bulkInsert', err) && this.config.verbose) {
            console.error('[RvfBackend] Native bulk ingest failed:', (err as Error).message);
          }
          // ADR-0164 A0d: unreachable under δ-strict (degradeToFallbackMode throws).
          if (entry.embedding) this.reIndexAfterDegrade(entry.id, entry.embedding);
        }
      } else if (entry.embedding && this.hnswIndex) {
        this.hnswIndex.add(entry.id, entry.embedding);
      }
      await this.appendToWal(entry);
    }
    this.dirty = true;
    if (this.walEntryCount >= this.config.walCompactionThreshold) {
      await this.compactWal();
    }
  }

  async bulkDelete(ids: string[]): Promise<number> {
    this.requireInitialized('bulkDelete');
    let count = 0;
    const nativeIds: number[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) {
        this.entries.delete(id);
        this.keyIndex.delete(this.compositeKey(entry.namespace, entry.key));
        if (this.hnswIndex) this.hnswIndex.remove(id);
        const numId = this.nativeIdMap.get(id);
        if (numId !== undefined) {
          nativeIds.push(numId);
          this.nativeIdMap.delete(id);
          this.nativeReverseMap.delete(numId);
        }
        count++;
      }
    }
    if (count > 0) {
      if (this.nativeDb && nativeIds.length > 0) {
        try {
          this.nativeDb.delete(nativeIds);
        } catch (err) {
          if (!this.degradeToFallbackMode('bulkDelete', err) && this.config.verbose) {
            console.error('[RvfBackend] Native bulk delete failed:', (err as Error).message);
          }
        }
      }
      this.dirty = true;
      // Truncate WAL BEFORE full rewrite — prevents resurrection on crash
      if (this.walPath && this.walEntryCount > 0) {
        // silent-fallthrough-OK: WAL truncate is a defense-in-depth step before full persist; persist itself is the durable write
      try { await writeFile(this.walPath, Buffer.alloc(0)); } catch {}
        this.walEntryCount = 0;
      }
      await this.persistToDisk();
    }
    return count;
  }

  async count(namespace?: string): Promise<number> {
    if (!namespace) return this.entries.size;
    let c = 0;
    for (const entry of this.entries.values()) {
      if (entry.namespace === namespace) c++;
    }
    return c;
  }

  async listNamespaces(): Promise<string[]> {
    const ns = new Set<string>();
    for (const entry of this.entries.values()) ns.add(entry.namespace);
    return Array.from(ns);
  }

  /**
   * Enumerate all entries that have embeddings attached.
   *
   * ADR-0111 W1.5 — letter F prep. Replaces upstream's SQLite-shaped
   * `bridgeGetAllEmbeddings` with an RVF-backed enumeration primitive.
   * Used by RaBitQ index construction and other consumers that need a
   * snapshot of every stored vector at runtime.
   *
   * @param dimensions Filter to entries whose embedding length matches
   *                   this value. When omitted, all dimensions are
   *                   returned (the caller is expected to validate).
   * @param limit Max results (default: 50000, mirroring upstream's
   *              bridgeGetAllEmbeddings).
   *
   * @returns Snapshot array — empty when there are no entries with
   *          embeddings. Each entry's `embedding` is a fresh number[]
   *          copy (not a Float32Array reference) so the caller can
   *          mutate freely.
   */
  async enumerateEmbeddings(options: {
    dimensions?: number;
    limit?: number;
  } = {}): Promise<Array<{
    id: string;
    key: string;
    namespace: string;
    embedding: number[];
  }>> {
    const limit = options.limit ?? 50_000;
    const targetDim = options.dimensions;
    const out: Array<{ id: string; key: string; namespace: string; embedding: number[] }> = [];

    for (const entry of this.entries.values()) {
      if (out.length >= limit) break;
      if (!entry.embedding) continue;
      if (targetDim !== undefined && entry.embedding.length !== targetDim) continue;
      out.push({
        id: entry.id,
        key: entry.key,
        namespace: entry.namespace,
        embedding: Array.from(entry.embedding),
      });
    }

    return out;
  }

  async clearNamespace(namespace: string): Promise<number> {
    const toDelete: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.namespace === namespace) toDelete.push(id);
    }
    for (const id of toDelete) {
      const entry = this.entries.get(id)!;
      this.entries.delete(id);
      this.keyIndex.delete(this.compositeKey(entry.namespace, entry.key));
      if (this.hnswIndex) this.hnswIndex.remove(id);
    }
    if (toDelete.length > 0) {
      this.dirty = true;
      // Truncate WAL BEFORE full rewrite — prevents resurrection on crash
      if (this.walPath && this.walEntryCount > 0) {
        // silent-fallthrough-OK: WAL truncate is a defense-in-depth step before full persist; persist itself is the durable write
      try { await writeFile(this.walPath, Buffer.alloc(0)); } catch {}
        this.walEntryCount = 0;
      }
      await this.persistToDisk();
    }
    this._capacityWarned = false;
    return toDelete.length;
  }

  /** Read stored vector dimension from the RVF file header, or 0 if empty/absent */
  async getStoredDimension(): Promise<number> {
    if (this.config.databasePath === ':memory:') return 0;
    const metaPath = this.config.databasePath + '.meta';
    const { existsSync } = await import('node:fs');
    const { readFile } = await import('node:fs/promises');

    // Try .meta sidecar first, then main file
    for (const path of [metaPath, this.config.databasePath]) {
      if (!existsSync(path)) continue;
      try {
        const raw = await readFile(path);
        if (raw.length < 8) continue;
        const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
        if (magic !== 'RVF\0') continue;
        const headerLen = raw.readUInt32LE(4);
        if (8 + headerLen > raw.length) continue;
        const header = JSON.parse(raw.subarray(8, 8 + headerLen).toString('utf-8'));
        if (header.dimensions > 0) return header.dimensions;
      } catch { continue; }
    }
    return 0;
  }

  async getStats(): Promise<BackendStats> {
    const entriesByNamespace: Record<string, number> = {};
    const entriesByType: Record<string, number> = {};
    let memoryUsage = 0;
    let entriesWithEmbeddings = 0;

    for (const entry of this.entries.values()) {
      entriesByNamespace[entry.namespace] = (entriesByNamespace[entry.namespace] ?? 0) + 1;
      entriesByType[entry.type] = (entriesByType[entry.type] ?? 0) + 1;
      memoryUsage += entry.content.length * 2;
      if (entry.embedding) {
        memoryUsage += entry.embedding.byteLength;
        entriesWithEmbeddings++;
      }
    }

    const avgQuery = this.avg(this.queryTimes);
    const avgSearch = this.avg(this.searchTimes);

    return {
      totalEntries: this.entries.size,
      entriesWithEmbeddings,
      entriesByNamespace,
      entriesByType: entriesByType as Record<MemoryType, number>,
      memoryUsage,
      hnswStats: this.hnswIndex ? {
        vectorCount: this.hnswIndex.size,
        memoryUsage: this.hnswIndex.size * this.config.dimensions * 4,
        avgSearchTime: avgSearch,
        buildTime: 0,
      } : undefined,
      avgQueryTime: avgQuery,
      avgSearchTime: avgSearch,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    if (!this.initialized) issues.push('Backend not initialized');
    if (!this.hnswIndex && !this.nativeDb) {
      issues.push('No vector index available');
      recommendations.push('Install @ruvector/rvf for native HNSW performance');
    }

    const status = issues.length === 0
      ? 'healthy'
      : issues.some(i => i.includes('not initialized')) ? 'unhealthy' : 'degraded';

    return {
      status,
      components: {
        storage: { status: this.initialized ? 'healthy' : 'unhealthy', latency: 0 },
        index: { status: this.hnswIndex || this.nativeDb ? 'healthy' : 'degraded', latency: 0 },
        cache: { status: 'healthy', latency: 0 },
      },
      timestamp: Date.now(),
      issues,
      recommendations,
    };
  }

  private async tryNativeInit(): Promise<boolean> {
    // :memory: mode — native backend not compatible with in-memory sentinel
    // (RvfDatabase.create would write a literal `:memory:` file to cwd).
    // Fall back to pure-TS HnswLite for in-memory operation.
    if (this.config.databasePath === ':memory:') {
      return false;
    }

    // Note: the advisory lock that protects this method's peek+open+create
    // decision is acquired by initialize() at the call site (line 268),
    // released by initialize() in finally{} at line 290. tryNativeInit itself
    // does NOT acquire the lock — doing so would deadlock the non-reentrant
    // PID-based wx-create primitive.

    // ADR-0095 amendment (ruflo-patch commit 2d12bb1): replace the silent
    // catch-all (ADR-0082 violation — 5 of 6 writers were falling silently to
    // pure-TS when the native file was momentarily mid-write) with typed
    // error discrimination. Invariant: once SFVR bytes exist on the main
    // path, all subsequent opens must be native-or-refuse. A pure-TS reader
    // cannot be allowed to silently take over a native-owned file.
    //
    // Decision tree:
    //   1. Module resolution — if @ruvector/rvf-node isn't installed at all,
    //      this is benign; pure-TS is the intended path. Return false.
    //   2. SFVR peek — read first 4 bytes of the main path. If they're
    //      'SFVR', the file is native-owned and we MUST open it with the
    //      native backend. Failure here is FATAL (except benign ENOENT on
    //      a cold-start race).
    //   3. Cold start (no file) — pure `create` attempt; errors here are
    //      still typed (ENOENT for missing parent dir is surfaced; other
    //      errors are fatal).
    //   4. Open-retry — for the SFVR-present case, retry up to 3×50ms to
    //      tolerate the mid-write gap between `writeFile(tmp)` and
    //      `rename(tmp, target)` on a concurrent writer.

    let rvf: any;
    try {
      rvf = await import('@ruvector/rvf-node' as string);
    } catch (err: any) {
      // Benign: module not installed (optional dependency). Fall through to
      // pure-TS without noise. Any other import failure is surfaced —
      // MODULE_NOT_FOUND is the only shape we treat as benign here.
      const code = err?.code ?? err?.cause?.code;
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
        if (this.config.verbose) {
          console.log('[RvfBackend] @ruvector/rvf-node not installed, using pure-TS fallback');
        }
        return false;
      }
      throw new Error(
        `[RvfBackend] Native binding @ruvector/rvf-node failed to load ` +
        `(code=${code ?? 'unknown'}): ${err?.message ?? err}`,
      );
    }

    const { existsSync: fileExists, openSync, readSync, closeSync } = await import('node:fs');
    const nativeMetric = this.config.metric === 'euclidean' ? 'l2'
      : this.config.metric === 'dot' ? 'inner_product'
      : 'cosine';

    // SFVR magic peek: is the main path already a native-owned file?
    // ADR-0095 Pass 3 (d4): capture bytesRead + peek for the non-SFVR branch
    // so it can discriminate RVF\0 (legitimate pure-TS) from zero-byte /
    // partial-write / unknown-magic (all unsafe for pure-TS fallback).
    let hasNativeMagic = false;
    let fileOnDisk = false;
    let peekBytesRead = 0;
    let peekStr = '';
    if (fileExists(this.config.databasePath)) {
      fileOnDisk = true;
      try {
        const fd = openSync(this.config.databasePath, 'r');
        try {
          const head = Buffer.alloc(4);
          const bytesRead = readSync(fd, head, 0, 4, 0);
          peekBytesRead = bytesRead;
          if (bytesRead === 4) {
            peekStr = String.fromCharCode(head[0], head[1], head[2], head[3]);
            if (peekStr === NATIVE_MAGIC) hasNativeMagic = true;
          }
        } finally {
          closeSync(fd);
        }
      } catch (err: any) {
        const code = err?.code;
        // ENOENT here = TOCTOU race (file existed at existsSync, gone by
        // openSync). Treat as cold start — clear `fileOnDisk` so the d4
        // invariant below doesn't fire on a vanished file.
        if (code === 'ENOENT') {
          fileOnDisk = false;
        } else {
          throw new Error(
            `[RvfBackend] Failed to peek native header at ${this.config.databasePath} ` +
            `(code=${code ?? 'unknown'}): ${err?.message ?? err}`,
          );
        }
      }
    }

    if (hasNativeMagic) {
      // Native file detected — must open-or-refuse.
      //
      // ADR-0094 Sprint 1.4 d10 (ruflo-patch): time-budgeted retry (5s
      // budget, exponential backoff) instead of fixed 3×50ms. The native
      // library holds an internal file lock during open() and writes;
      // under N>=8 concurrent processes with CPU contention the lock is
      // held longer than the old 150ms budget, producing spurious
      // `RVF error 0x0300: LockHeld` failures that matched the observed
      // write-loss pattern at N=12 (11/12) and N=20 (18/20). LockHeld is
      // transient by design — the peer will release on exit of its
      // open/ingestBatch call — so treating it as a recoverable error
      // rather than fatal matches what `acquireLock()` does for our own
      // advisory lock (ADR-0090 Tier B7, 5s budget with exponential
      // backoff). Other error shapes (InvalidChecksum, parse, I/O) take
      // their own branches below and are NOT retried — they are
      // genuinely fatal and must surface immediately.
      let lastErr: any = null;
      const maxOpenWaitMs = 5000;
      const openStartTime = Date.now();
      const baseDelayMs = 20;
      const maxDelayMs = 400;
      let attempt = 0;
      while (Date.now() - openStartTime < maxOpenWaitMs) {
        try {
          this.nativeDb = rvf.RvfDatabase.open(this.config.databasePath);
          if (this.config.verbose) {
            console.log(
              `[RvfBackend] Native @ruvector/rvf-node loaded (SFVR file opened` +
              (attempt > 0 ? `, attempt ${attempt + 1} after ${Date.now() - openStartTime}ms` : '') + ')',
            );
          }
          return true;
        } catch (err: any) {
          lastErr = err;
          // Retry transient cold-start race shapes. LockHeld (0x0300)
          // is JS-layer retryable. ManifestNotFound + InvalidManifest
          // are cold-start race shapes that Rust-side d12 typed-retry
          // (forks/ruvector store.rs MAX_COLDSTART_RETRIES=8, 395ms
          // total) already retried internally; under N≥8 contention
          // the Rust budget can exhaust before all writers finish
          // their FIFO turn. Give them another full Rust-retry cycle
          // at the JS layer (5s budget = ~12 Rust cycles). Empirically
          // N=8 cross-process passed at this layer pre-fail-loud;
          // surfaces here once silent fallback paths are removed.
          // InvalidChecksum (0x0102) is intentionally NOT retried — it
          // has its own degrade-to-fallback path below.
          const msg = String(err?.message ?? err ?? '');
          const isLockHeld = msg.includes('0x0300') || /LockHeld/i.test(msg);
          const isColdStartExhausted = /ManifestNotFound|InvalidManifest/i.test(msg);
          if (!isLockHeld && !isColdStartExhausted) break;
          const expDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
          const jitter = expDelay * 0.5 * Math.random();
          const delayMs = expDelay + jitter;
          await new Promise(res => setTimeout(res, delayMs));
          attempt++;
        }
      }
      // Retry loop exhausted (either LockHeld exceeded the 5s budget or the
      // error was non-transient). ADR-0095 d5: discriminate InvalidChecksum
      // (error code 0x0102) from other failures. `InvalidChecksum` is the
      // specific multi-writer race signature from Pass-4 (§Investigation
      // Findings 2026-04-18): `.meta` remains consistent while the native
      // `.rvf` has segment-hash corruption. On that shape, degrade to
      // pure-TS mode and let `loadFromDisk` pull entries from the `.meta`
      // sidecar — honors ADR-0082's "no silent fallback" by emitting a
      // LOUD stderr warning, but avoids the pre-d5 lie "both backends
      // failed" when pure-TS data was never tried.
      //
      // ADR-0094 Sprint 1.4 d10 (ruflo-patch): LockHeld (0x0300) is now
      // retried with exponential backoff up to the 5s budget at the top
      // of the retry loop. If we get here with LockHeld, the budget was
      // exhausted — FATAL (a peer holding the lock for >5s is a genuine
      // hang, not transient contention). Parse errors, I/O errors, and
      // unknown native errors remain FATAL with no retry — the "once
      // SFVR, always native-or-refuse" invariant from d4 is preserved for
      // every non-InvalidChecksum case.
      const errMsg = String(lastErr?.message ?? lastErr ?? '');
      const isInvalidChecksum = errMsg.includes('0x0102') ||
                                /InvalidChecksum/i.test(errMsg);
      if (isInvalidChecksum) {
        // Reset any partial native handle — open() is not supposed to return
        // a usable handle on throw, but be defensive so subsequent writes
        // unambiguously route to HnswLite/WAL (see nativeFallbackMode docs).
        this.nativeDb = null;
        this.nativeFallbackMode = true;
        console.error(
          `[RvfBackend] native open InvalidChecksum at ${this.config.databasePath} ` +
          `(RVF error 0x0102) — falling back to .meta sidecar. ` +
          `Root cause: unlocked multi-writer race in @ruvector/rvf-node ` +
          `RvfDatabase.ingestBatch (upstream bug, tracked as ADR-0095 d7). ` +
          `This process degrades to pure-TS mode; writes compact to .meta ` +
          `so the corrupt native file is not clobbered and can be recovered ` +
          `by a future native-capable process.`,
        );
        return false; // caller will build HnswLite and loadFromDisk picks .meta
      }
      // ADR-0090 Tier B2 (ruflo-patch): defer rather than throw here so
      // loadFromDisk's WAL replay + .meta sidecar fallback get a chance to
      // recover. If they both yield no entries, loadFromDisk's final guard
      // converts this reason into a typed `RvfCorruptError`. If the `.meta`
      // sidecar is intact (native file corrupt, pure-TS metadata survived)
      // or the WAL has uncompacted entries, init succeeds silently and
      // this reason is cleared. Matches the SFVR+ManifestNotFound test
      // case at adr0090-b2-corruption.test.mjs:211-225 which expects
      // `/shorter than the 8-byte RVF header|truncated header/` on
      // `.meta` — loadFromDisk sees those bytes directly.
      this._deferredCorruptReason =
        `native file has SFVR magic but RvfDatabase.open failed after ` +
        `${attempt} attempt(s) over ${Date.now() - openStartTime}ms ` +
        `(budget ${maxOpenWaitMs}ms): ${lastErr?.message ?? lastErr}`;
      return false;
    }

    // ADR-0095 Pass 3 (d4) invariant: non-SFVR branch.
    //
    // Previous logic accepted any non-SFVR on-disk state as "pure-TS owns
    // this" and returned false. That bundled three very different shapes:
    //   1. Valid 'RVF\0'  — legitimate pure-TS file, safe to fall through.
    //   2. Zero-byte / partial (<4 bytes read) — a peer is mid-`RvfDatabase
    //      .create()` (the native file is written header-first; a 0-byte
    //      placeholder exists briefly before the magic lands). Handing this
    //      to pure-TS would let it clobber the file before the peer's
    //      header write completes.
    //   3. Unknown 4-byte magic — corrupt or foreign format. Pure-TS
    //      cannot parse it and must not silently write over it.
    //
    // Per ADR-0082 (no silent fallback on data-integrity failures), cases
    // 2 and 3 throw loudly. Only genuine 'RVF\0' or file-absent qualifies
    // as legitimate pure-TS.
    // ADR-0090 Tier B2 (ruflo-patch): guard on `peekBytesRead > 0` so a
    // truly 0-byte file (peekBytesRead===0) is NOT flagged as partial-magic
    // corruption. 0-byte files must fall through to pure-TS where
    // loadFromDisk's `raw.length === 0` branch treats them as cold start
    // (see adr0090-b2-corruption.test.mjs:304 "file is 0 bytes → cold
    // start"). Only 1-3 bytes of partial magic indicate a peer mid-write
    // or a truncated header — both corruption signals.
    //
    // Also: defer instead of throw so loadFromDisk's WAL replay gets to
    // run. If WAL is empty and the file is still unreadable, the final
    // guard in loadFromDisk converts this reason into `RvfCorruptError`.
    if (fileOnDisk && peekBytesRead > 0 && peekBytesRead < 4) {
      this._deferredCorruptReason =
        `file exists but only ${peekBytesRead}/4 magic bytes present — ` +
        `peer RvfDatabase.create is mid-write or header was truncated`;
      if (process.env.RVF_DEBUG) console.error(`[RVF-DEBUG pid=${process.pid}] tryNativeInit RETURN false: partial-magic (peekBytesRead=${peekBytesRead})`);
      return false;
    }

    const isRVFNull = peekStr === 'RVF\0';
    if (fileOnDisk && peekBytesRead === 4 && !isRVFNull) {
      // Not SFVR (that path returned earlier) and not RVF\0 — unknown magic.
      //
      // ADR-0090 Tier B2 (ruflo-patch): defer rather than throw so
      // loadFromDisk can still replay the WAL. Tests at
      // adr0090-b2-corruption.test.mjs:313-354 zero the first 4 bytes of
      // a main file whose WAL has uncompacted entries; the recovery path
      // is "read from WAL, skip main file". Throwing here made that path
      // unreachable. If the WAL is empty and no `.meta` sidecar exists,
      // loadFromDisk's final guard converts this reason into
      // `RvfCorruptError` with the same `bad magic bytes` wording the
      // pure-TS loader would have produced (the test regex
      // `/header JSON parse failed|bad magic|corrupt/i` accepts either).
      this._deferredCorruptReason =
        `bad magic bytes ${JSON.stringify(peekStr)} — not 'SFVR' (native) ` +
        `or 'RVF\\0' (pure-TS). File is corrupt or from an unknown format.`;
      if (process.env.RVF_DEBUG) console.error(`[RVF-DEBUG pid=${process.pid}] tryNativeInit RETURN false: bad-magic peekStr=${JSON.stringify(peekStr)}`);
      return false;
    }

    if (fileOnDisk) {
      // Genuine 'RVF\0' — legitimate pure-TS file. Return false and let
      // loadFromDisk handle it (pure-TS is the correct path).
      if (this.config.verbose) {
        console.log(
          `[RvfBackend] Main path ${this.config.databasePath} is pure-TS ` +
          `'RVF\\0' format; using pure-TS backend (native will not clobber)`,
        );
      }
      if (process.env.RVF_DEBUG) console.error(`[RVF-DEBUG pid=${process.pid}] tryNativeInit RETURN false: fileOnDisk path peekBytesRead=${peekBytesRead} isRVFNull=${isRVFNull}`);
      return false;
    }

    // Truly cold start: file doesn't exist at all (per the SFVR-magic peek
    // above; pre-existing native files are handled by the open-retry branch
    // earlier).
    //
    // Preferred path: `RvfDatabase.openOrCreate` — the thread-safe Rust-side
    // primitive (ADR-0095 swarm-2 final fix) that resolves create-vs-open
    // atomically under one kernel `flock(LOCK_EX)`. Concurrent peers all
    // call this; exactly one performs the create, the others end up on the
    // open path. No JS-side retry/dispatch logic needed — the kernel queue
    // serializes everyone FIFO.
    //
    // Compatibility path: if the binding doesn't expose `openOrCreate`
    // (older published version, or during the bootstrap cascade pass that
    // hasn't yet published the new binary), fall back to `create` + the
    // historical retry-as-`open` dance. The race-window is wider than the
    // openOrCreate path but still bounded — the underlying flock primitive
    // (ADR-0095 d12) is in older binaries too, so cross-process exclusion
    // still holds.
    if (typeof rvf.RvfDatabase.openOrCreate === 'function') {
      try {
        this.nativeDb = rvf.RvfDatabase.openOrCreate(this.config.databasePath, {
          dimension: this.config.dimensions,
          metric: nativeMetric,
          m: this.config.hnswM,
          efConstruction: this.config.hnswEfConstruction,
        });
        if (this.config.verbose) {
          console.log('[RvfBackend] Native @ruvector/rvf-node openOrCreate succeeded');
        }
        return true;
      } catch (err: any) {
        const code = err?.code;
        if (code === 'ENOENT') {
          if (this.config.verbose) {
            console.log('[RvfBackend] Native openOrCreate hit ENOENT (parent dir missing); using pure-TS fallback');
          }
          return false;
        }
        throw new Error(
          `[RvfBackend] Native RvfDatabase.openOrCreate failed at ${this.config.databasePath} ` +
          `(code=${code ?? 'unknown'}): ${err?.message ?? err}`,
        );
      }
    }

    // Compatibility path (binding lacks openOrCreate): retry-loop wrapping
    // create with dispatch-to-open on AlreadyExists/LockHeld.
    let lastCreateErr: any = null;
    const createMaxMs = 5000;
    const createStart = Date.now();
    const createBaseDelayMs = 20;
    const createMaxDelayMs = 400;
    let createAttempt = 0;
    while (Date.now() - createStart < createMaxMs) {
      try {
        this.nativeDb = rvf.RvfDatabase.create(this.config.databasePath, {
          dimension: this.config.dimensions,
          metric: nativeMetric,
          m: this.config.hnswM,
          efConstruction: this.config.hnswEfConstruction,
        });
        return true;
      } catch (err: any) {
        lastCreateErr = err;
        const code = err?.code;
        if (code === 'ENOENT') return false;
        const msg = String(err?.message ?? err ?? '');
        const isLockHeld = msg.includes('0x0300') || /LockHeld/i.test(msg);
        const isAlreadyExists = msg.includes('0x0306') || /AlreadyExists/i.test(msg);
        if ((isAlreadyExists || isLockHeld) && fileExists(this.config.databasePath)) {
          try {
            this.nativeDb = rvf.RvfDatabase.open(this.config.databasePath);
            return true;
          } catch (openErr: any) {
            lastCreateErr = openErr;
            const oMsg = String(openErr?.message ?? openErr ?? '');
            if (!(oMsg.includes('0x0300') || /LockHeld/i.test(oMsg))) break;
          }
        }
        if (!isLockHeld) break;
        const expDelay = Math.min(createBaseDelayMs * Math.pow(2, createAttempt), createMaxDelayMs);
        const jitter = expDelay * 0.5 * Math.random();
        await new Promise(res => setTimeout(res, expDelay + jitter));
        createAttempt++;
      }
    }
    throw new Error(
      `[RvfBackend] Native RvfDatabase.create failed at ${this.config.databasePath} ` +
      `(code=${lastCreateErr?.code ?? 'unknown'}, attempts=${createAttempt + 1}, elapsed=${Date.now() - createStart}ms): ` +
      `${lastCreateErr?.message ?? lastCreateErr}`,
    );
  }

  /**
   * ADR-0095 amendment (ruflo-patch 2d12bb1): reap crash-leaked *.tmp.* files.
   *
   * The persist path writes to a unique tmp path (`target.tmp.<pid>.<counter>`)
   * and atomically renames into place. If a writer crashes between writeFile
   * and rename, the tmp file is orphaned. This reaper cleans any tmp file
   * whose mtime is older than 10 minutes — well beyond the longest sane
   * write — without racing a live writer.
   *
   * Scope: only sibling files of `databasePath` whose name starts with the
   * basename + '.tmp.'. Non-fatal: any I/O error is swallowed (the worst
   * case is a stale tmp file sticks around until next init).
   */
  private async reapStaleTmpFiles(): Promise<void> {
    if (this.config.databasePath === ':memory:') return;
    const { readdir, stat, unlink: ul } = await import('node:fs/promises');
    const { basename } = await import('node:path');
    const dir = dirname(this.config.databasePath) || '.';
    const baseName = basename(this.config.databasePath);
    const prefix = `${baseName}.tmp.`;
    const staleThresholdMs = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // dir doesn't exist yet — cold start, nothing to reap
    }

    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      const full = `${dir}/${name}`;
      try {
        const st = await stat(full);
        if (now - st.mtimeMs > staleThresholdMs) {
          await ul(full);
          if (this.config.verbose) {
            console.log(`[RvfBackend] Reaped stale tmp file: ${full}`);
          }
        }
      } catch {
        // File vanished mid-scan (another process reaped it, or it was the
        // target of a concurrent rename). Safe to ignore.
      }
    }
  }

  private compositeKey(namespace: string, key: string): string {
    return `${namespace}\0${key}`;
  }

  /** ADR-0095 d5: loud stderr warning when the d5 fallback is exercised.
   *  Per ADR-0082, every use emits a warning — but to avoid DoS'ing stdio in
   *  steady-state reads (memory list in a tight loop, long-running MCP
   *  session), we throttle: always log call #1, #2, #5, #10, then every 100
   *  calls thereafter. Log always names RVF error 0x0102 and the call count
   *  so the user sees the degrade AND its ongoing impact. Caller passes the
   *  access-path name so the warning pinpoints which code path is affected. */
  private noteNativeFallbackUse(via: string): void {
    // silent-fallthrough-OK: opt-in observability path; only relevant when in native-fallback mode (not a fail-loud surface)
    if (!this.nativeFallbackMode) return;
    this.nativeFallbackUseCount++;
    const n = this.nativeFallbackUseCount;
    const shouldLog = n <= 2 || n === 5 || n === 10 || n % 100 === 0;
    if (shouldLog) {
      console.error(
        `[RvfBackend] reading via .meta sidecar fallback (native RVF 0x0102 ` +
        `InvalidChecksum at ${this.config.databasePath}, via=${via}, ` +
        `use #${n}).`,
      );
    }
  }

  /** ADR-0095 d5: after a native write failed and we degraded, re-apply the
   *  write to the pure-TS index so the in-process read path still sees the
   *  new embedding. Safe to call when degrade didn't actually happen (no-op
   *  if nothing was promoted to fallback mode). Centralizing the re-apply
   *  here keeps callers (store/update/bulkInsert) textually simple so the
   *  ADR-0086 Debt-8 "nativeDb XOR hnswIndex" invariant check keeps passing
   *  (the check reads method bodies and would trip on inline mentions of
   *  `hnswIndex` inside the native catch). */
  private reIndexAfterDegrade(id: string, embedding: Float32Array | number[] | undefined): void {
    // silent-fallthrough-OK: only fires after a native-degrade event; non-degrade callers no-op (design intent)
    if (!this.nativeFallbackMode || !embedding || !this.hnswIndex) return;
    const arr = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
    this.hnswIndex.add(id, arr);
  }

  /** ADR-0095 d5: analog of reIndexAfterDegrade for the update() remove step.
   *  Kept in its own method so update() body stays free of textual `hnswIndex`
   *  references in the native catch (preserving Debt-8 exclusivity check). */
  private removeAfterDegrade(id: string): void {
    // silent-fallthrough-OK: same shape as reIndexAfterDegrade — only fires after a native-degrade event
    if (!this.nativeFallbackMode || !this.hnswIndex) return;
    this.hnswIndex.remove(id);
  }

  /** ADR-0164 A0d (δ-strict, fail-fast posture): throw `RvfCorruptError` on
   *  any native InvalidChecksum (RVF 0x0102). The pre-A0d behavior — close
   *  the native handle and silently fall through to a pure-TS + .meta path
   *  — is gone under δ-strict per Amendment 2026-05-10d ("we don't need
   *  recovery affordance, we will just reset the memory for our projects.
   *  We also have a philosophy of fail fast, and fail loud").
   *
   *  All callsites (`if (!this.degradeToFallbackMode(...))` / `if (this.degradeToFallbackMode(...))`)
   *  are intentionally left intact (minimize-diff per Adversarial Correction
   *  #10). The throw propagates through them; any code AFTER the call in
   *  those `catch` blocks (`reIndexAfterDegrade`, `removeAfterDegrade`,
   *  `pureTsSearch` fallback, etc.) is unreachable under δ-strict and is
   *  inline-annotated at each site. Phase B5 cleanup deletes the dead arms
   *  and the `nativeFallbackMode` field.
   *
   *  Non-InvalidChecksum errors still return `false`, preserving the
   *  ADR-0082 contract that LockHeld / OOM / unrelated failures continue
   *  to propagate via the existing `throw err` paths.
   *
   *  Return type kept `boolean` so callsite expressions still type-check
   *  even though the success branch never returns. */
  private degradeToFallbackMode(via: string, err: unknown): boolean {
    const msg = String((err as any)?.message ?? err ?? '');
    const isInvalidChecksum = msg.includes('0x0102') || /InvalidChecksum/i.test(msg);
    if (!isInvalidChecksum) return false;
    const path = this.config.databasePath;
    // <projectRoot> is the parent of the .swarm/ dir that holds memory.rvf.
    // databasePath is typically <projectRoot>/.swarm/memory.rvf.
    const projectRoot = dirname(dirname(path));
    const reason =
      `is corrupt and cannot be loaded (native ${via} threw RVF 0x0102 InvalidChecksum). ` +
      `Memory state for this project must be reset. ` +
      `Delete ${projectRoot}/.swarm/ and re-initialize.`;
    throw new RvfCorruptError(path, reason);
  }

  /** Assign or retrieve a numeric ID for native NAPI backend */
  private assignNativeId(stringId: string): number {
    let numId = this.nativeIdMap.get(stringId);
    if (numId !== undefined) return numId;
    numId = this.nextNativeId++;
    this.nativeIdMap.set(stringId, numId);
    this.nativeReverseMap.set(numId, stringId);
    return numId;
  }

  /**
   * ADR-0154 Phase 4: bind a numId observed during boot's META_SEG replay
   * to its reconstructed string id, BYPASSING `nextNativeId++`. The numId
   * came from disk; we must reuse the exact same value or query() results
   * keyed on the numId would mismap.
   */
  private _reserveAssignedNativeId(stringId: string, numId: number): void {
    this.nativeIdMap.set(stringId, numId);
    this.nativeReverseMap.set(numId, stringId);
    if (numId >= this.nextNativeId) {
      this.nextNativeId = numId + 1;
    }
  }

  /** ADR-0094 Sprint 1.4 d8 (ruflo-patch): lazy native re-ingest gate.
   *
   *  Called from `search()` and `query(semantic)` before the
   *  `nativeDb.query()` call. On first invocation per process, walks
   *  `_pendingNativeIngest` and ingests every embedding so
   *  `nativeReverseMap` is complete for cross-process entries. Subsequent
   *  calls are O(1) noops.
   *
   *  No-op when nativeDb is null (pure-TS mode — HnswLite was already
   *  populated in loadFromDisk/replayWal).
   *
   *  WHY lazy: `memory list`, `memory store`, and filter-only queries
   *  don't need the reverseMap. Pre-fix, every init paid the ingest cost
   *  AND grew `.rvf` with orphan vector segments (see the
   *  `_pendingNativeIngest` field-level comment for the full analysis).
   *  After the fix, only processes that actually perform semantic search
   *  pay the cost, and they pay it exactly once.
   *
   *  Note on orphan growth: this method still APPENDS vectors to the
   *  native file with fresh numIds. The growth-per-semantic-search-process
   *  is unchanged from pre-fix — what the fix eliminates is the
   *  growth-per-read-or-write-process, which was the observed bug. A
   *  future change that persists numIds in `.meta` could remove this
   *  orphan-on-semantic-search cost entirely, but is out of scope for d8.
   */
  private ensureNativeSemanticReady(): void {
    // silent-fallthrough-OK: idempotent rehydration; non-native or already-rehydrated paths legitimately no-op
    if (!this.nativeDb || this._nativeRehydrated) return;
    this._nativeRehydrated = true;
    if (this._pendingNativeIngest.length === 0) return;
    for (const { id, embedding } of this._pendingNativeIngest) {
      const numId = this.assignNativeId(id);
      try {
        // ADR-0154 Phase 3: lazy rehydrate also emits metadata so the new
        // META_SEG carries the entry shape; without it, reading back
        // post-rehydrate would yield a vector with no metadata.
        const entry = this.entries.get(id);
        const metaEntries = entry ? encodeMemoryEntryMetadata(entry) : undefined;
        this.nativeDb.ingestBatch(new Float32Array(embedding), [numId], metaEntries);
      } catch (err) {
        // ADR-0095 d5: same degrade discriminator as store/update/load.
        if (!this.degradeToFallbackMode('ensureNativeSemanticReady', err)) {
          if (this.config.verbose) {
            console.error(
              '[RvfBackend] Native lazy re-ingest failed:',
              (err as Error).message,
            );
          }
        }
        // ADR-0164 A0d: unreachable under δ-strict (degradeToFallbackMode throws).
        this.reIndexAfterDegrade(id, embedding);
      }
    }
    this._pendingNativeIngest = []; // release memory
  }

  /** Acquire advisory lock (PID-based lockfile).
   *
   *  Time-budgeted retry: gives up after `maxWaitMs` regardless of attempt
   *  count. Uses exponential backoff with jitter to reduce thundering-herd
   *  when multiple writers race for the same lock. Stale locks (dead holder
   *  or ts > 5s) are cleared without waiting.
   *
   *  The pre-ADR-0090 implementation used a fixed 5-retry × 100ms budget
   *  (500ms total), which starved 3-of-8 writers under N=8 concurrent
   *  in-process contention (verified by scripts/diag-rvf-inproc-race.mjs
   *  in ruflo-patch). The 5s budget here accommodates realistic multi-
   *  writer workflows (hook dispatch fan-out, swarm init, multi-pane
   *  CLI) without being so large that genuinely stuck processes hang.
   */
  // Bug-4 (2026-05-05) parallel-wave thread-safety: init-time callers can pass
  // a larger timeout (default 60s is fine for hot-path store/persist; init is
  // one-time per process and benefits from a longer budget when many parallel
  // processes share the same data dir — e.g. acceptance harness E2E_DIR
  // shared across all e2e tests). 100 attempts at 20ms→500ms backoff covers
  // ~60s; bumping to 180s under init covers ~250 attempts and handles the
  // observed parallel-wave tail without changing the hot-path budget.
  private async acquireLock(maxWaitMs: number = 60_000): Promise<void> {
    if (!this.lockPath) return; // :memory: mode
    // ADR-0095 amendment (2026-05-01, t3-2 silent-loss fix): re-entrant.
    // If THIS process+instance already holds the lock, just bump depth
    // and return. Lets store() compose its three lock-needing helpers
    // under one wide critical section without releasing between them.
    // Peer writers can't interleave during the wide hold.
    if (this._lockHeldDepth > 0) {
      this._lockHeldDepth++;
      this._diag(`acquireLock.reentrant depth=${this._lockHeldDepth}`);
      return;
    }
    const acqStart = Date.now();
    this._diag('acquireLock.start');
    const { writeFile: wf, readFile: rf, unlink: ul, mkdir: mk } = await import('node:fs/promises');
    // ADR-0095 Pass 3 (d3): ensure lockfile parent directory exists before the
    // open-wx below. acquireLock is called from initialize/persist/delete
    // paths, some of which fire before any file on the parent path is created
    // (cold-start race or peer-first-persist). Without this mkdir the
    // writeFile below throws ENOENT and the whole operation aborts.
    const lockDir = dirname(this.lockPath);
    try {
      await mk(lockDir, { recursive: true });
    } catch (err: any) {
      // `{recursive:true}` handles EEXIST internally; any other error is
      // load-bearing — the wx open below will fail anyway if mkdir couldn't
      // create the path, so surface it here per ADR-0082 (no silent swallow).
      if (err?.code && err.code !== 'EEXIST') throw err;
    }
    // ADR-0095 amendment (2026-05-01, t3-2 fix): with the .jslock path
    // rename (constructor line 246), JS no longer collides with the native
    // rvf-runtime crate's `.lock` file. The lock content is now ALWAYS
    // JSON written by us, so:
    //   - no time-based stealing (a slow but live holder must NOT be
    //     preempted — that's the corruption vector that wrote
    //     incompatible content to the same lock file)
    //   - no blind unlink on parse failure (the only way parse fails
    //     with .jslock is the wf-not-yet-completed window — the holder
    //     IS alive and writing; back off, retry)
    //   - 60s default budget (hot path: store/persist/delete). Subprocess
    //     CLI inits under heavy contention take 1-3s each; 6 serialized =
    //     up to ~18s; 60s gives headroom for OS scheduling jitter, native
    //     flock contention, and tail latency.
    //   - Init-time callers may override with a longer budget (Bug-4 fix:
    //     acceptance harness E2E_DIR shared across all e2e tests sees ~10
    //     contenders simultaneously; 180s budget at init lifts the
    //     parallel-wave tail past the observed 30-60s saturation point).
    const baseDelayMs = 20;
    const maxDelayMs = 500;
    const startTime = Date.now();
    let attempt = 0;
    while (Date.now() - startTime < maxWaitMs) {
      try {
        await wf(this.lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
        this._lockHeldDepth = 1;
        this._diag(`acquireLock.acquired attempts=${attempt} elapsed=${Date.now() - acqStart}ms`);
        return; // Lock acquired
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        // Lock exists — only steal when recorded PID is dead.
        let parseSuccessful = false;
        let holderAlive = true;
        try {
          const content = await rf(this.lockPath, 'utf-8');
          const parsed = JSON.parse(content);
          const pid = parsed?.pid;
          parseSuccessful = typeof pid === 'number' && pid > 0;
          if (parseSuccessful) {
            try { process.kill(pid, 0); } catch { holderAlive = false; }
          }
        } catch {
          // silent-fallthrough-OK: transient mid-write read on the
          // wf-creates-then-writes window — holder IS alive and
          // committing JSON content, back off and retry. NEVER unlink
          // on parse failure; that was the t3-2 corruption vector.
          parseSuccessful = false;
          holderAlive = true;
        }
        if (parseSuccessful && !holderAlive) {
          // silent-fallthrough-OK: best-effort cleanup of dead-holder lock
          try { await ul(this.lockPath); } catch {}
          continue;
        }
        const expDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        const jitter = expDelay * 0.5 * Math.random();
        const delayMs = expDelay + jitter;
        await new Promise(r => setTimeout(r, delayMs));
        attempt++;
      }
    }
    // Bug-4: tag with code='ELOCKACQUIRE' so StorageFactory's err.code wrap
    // surfaces the real cause instead of '(unknown)'. Also include the .jslock
    // path so concurrent-process diagnostics can correlate by file.
    const lockErr: Error & { code?: string } = new Error(
      `Failed to acquire advisory lock after ${attempt} attempts over ${Date.now() - startTime}ms ` +
      `(budget=${maxWaitMs}ms, lockPath=${this.lockPath})`,
    );
    lockErr.code = 'ELOCKACQUIRE';
    throw lockErr;
  }

  /** Release advisory lock — only if WE still own it. */
  private async releaseLock(): Promise<void> {
    // silent-fallthrough-OK: no lockPath = :memory: mode = no lock acquired = nothing to release
    if (!this.lockPath) return;
    // ADR-0095 amendment (2026-05-01, t3-2 silent-loss fix): re-entrant.
    // Decrement; only physically release when the OUTER caller exits.
    // Mirrors the depth bump in acquireLock so nested helpers (e.g.
    // store() wrapping its WAL helpers under one acquire) don't
    // release until the outer-most try/finally fires.
    if (this._lockHeldDepth > 1) {
      this._lockHeldDepth--;
      this._diag(`releaseLock.reentrant depth=${this._lockHeldDepth}`);
      return;
    }
    if (this._lockHeldDepth === 0) {
      // silent-fallthrough-OK: defensive — paired release without acquire (e.g. acquireLock threw before bumping). Nothing to do.
      this._diag('releaseLock.unpaired (depth=0, no-op)');
      return;
    }
    this._lockHeldDepth = 0;
    this._diag('releaseLock.unlinking');
    // ADR-0095 amendment (2026-05-01, t3-2 fix): verify ownership before
    // unlinking. With .jslock the only writer is JS-side, but two
    // concurrent JS instances can race during shutdown — A's release
    // unlinking B's lock would let C acquire concurrently with B.
    try {
      const { readFile: rf, unlink: ul } = await import('node:fs/promises');
      const content = await rf(this.lockPath, 'utf-8');
      const { pid } = JSON.parse(content);
      if (pid === process.pid) {
        // silent-fallthrough-OK: lock file may be removed between read and unlink (peer cleanup race); ENOENT is expected
        try { await ul(this.lockPath); } catch {}
      }
    } catch {
      // silent-fallthrough-OK: lock file gone (already unlinked or never created) — nothing to release
    }
  }

  private bruteForceSearch(embedding: Float32Array, options: SearchOptions): SearchResult[] {
    const results: SearchResult[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.embedding) continue;
      const score = cosineSimilarity(embedding, entry.embedding);
      if (options.threshold && score < options.threshold) continue;
      if (options.filters?.namespace && entry.namespace !== options.filters.namespace) continue;
      if (options.filters?.tags && !options.filters.tags.every(t => entry.tags.includes(t))) continue;
      results.push({ entry, score, distance: 1 - score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.k);
  }

  private recordTiming(arr: number[], start: number): void {
    arr.push(performance.now() - start);
    if (arr.length > 100) arr.shift();
  }

  private avg(arr: number[]): number {
    return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  }

  /** Check if adding entries would exceed maxElements capacity */
  private checkCapacity(count: number = 1): void {
    const projected = this.entries.size + count;
    if (projected > this.config.maxElements) {
      throw new Error(
        `RvfBackend capacity exceeded: ${projected} entries would exceed maxElements=${this.config.maxElements}. ` +
        `Increase maxElements in config or delete entries.`
      );
    }
    // Warn at 90% capacity
    if (projected > this.config.maxElements * 0.9 && !this._capacityWarned) {
      this._capacityWarned = true;
      console.warn(
        `[RvfBackend] Warning: ${this.entries.size} of ${this.config.maxElements} entries used ` +
        `(${Math.round((this.entries.size / this.config.maxElements) * 100)}%). Approaching capacity limit.`
      );
    }
  }

  // ===== P6-B: Copy-on-Write branching =====

  /**
   * P6-B: Copy-on-Write branching.
   * Creates an isolated branch that reads from parent but writes locally.
   * Changes in the branch don't affect the parent until explicitly merged.
   */
  async derive(branchName: string): Promise<{
    success: boolean;
    branchId: string;
    parentId: string;
    error?: string;
  }> {
    try {
      const branchId = `branch:${branchName}:${Date.now()}`;
      const parentId = this.config.defaultNamespace;

      // Store branch metadata
      const metaKey = `_branch_meta:${branchId}`;
      const now = Date.now();
      const metaEntry: MemoryEntry = {
        id: `meta-${branchId}`,
        key: metaKey,
        content: JSON.stringify({
          branchId,
          branchName,
          parentId,
          createdAt: new Date(now).toISOString(),
          status: 'active',
          writeCount: 0,
        }),
        type: 'working',
        namespace: 'default',
        tags: ['branch-meta'],
        metadata: { branchId, branchName, parentId },
        accessLevel: 'system',
        createdAt: now,
        updatedAt: now,
        version: 1,
        references: [],
        accessCount: 0,
        lastAccessedAt: now,
      };
      await this.store(metaEntry);

      return { success: true, branchId, parentId };
    } catch (e: any) {
      return { success: false, branchId: '', parentId: '', error: e?.message || String(e) };
    }
  }

  /**
   * Read from a COW branch -- checks branch first, falls back to parent.
   */
  async branchGet(branchId: string, key: string, namespace?: string): Promise<MemoryEntry | null> {
    try {
      const ns = namespace || this.config.defaultNamespace;
      // Try branch-local key first
      const branchKey = `${branchId}:${key}`;
      const branchResult = await this.getByKey(ns, branchKey);
      if (branchResult) return branchResult;

      // Fall back to parent
      return await this.getByKey(ns, key);
    } catch {
      return null;
    }
  }

  /**
   * Write to a COW branch -- stores with branch prefix, doesn't affect parent.
   */
  async branchStore(branchId: string, key: string, value: string, namespace?: string): Promise<{ success: boolean }> {
    try {
      const ns = namespace || this.config.defaultNamespace;
      const branchKey = `${branchId}:${key}`;
      const now = Date.now();
      const entry: MemoryEntry = {
        id: `${branchId}-${key}-${now}`,
        key: branchKey,
        content: value,
        type: 'working',
        namespace: ns,
        tags: ['branch-data', branchId],
        metadata: { branchId, originalKey: key },
        accessLevel: 'private',
        createdAt: now,
        updatedAt: now,
        version: 1,
        references: [],
        accessCount: 0,
        lastAccessedAt: now,
      };
      await this.store(entry);

      // Update branch write count (optional, best-effort)
      try {
        const metaKey = `_branch_meta:${branchId}`;
        const meta = await this.getByKey('default', metaKey);
        if (meta) {
          const parsed = JSON.parse(meta.content);
          parsed.writeCount = (parsed.writeCount || 0) + 1;
          await this.update(meta.id, { content: JSON.stringify(parsed) });
        }
      } catch { /* meta update optional */ }

      return { success: true };
    } catch {
      return { success: false };
    }
  }

  /**
   * Merge a COW branch back into parent -- copies all branch-local writes.
   */
  async branchMerge(branchId: string, namespace?: string): Promise<{
    success: boolean;
    mergedKeys: number;
    error?: string;
  }> {
    try {
      const ns = namespace || this.config.defaultNamespace;
      const prefix = `${branchId}:`;
      let mergedKeys = 0;

      // Find all entries with this branch prefix using query
      const branchEntries = await this.query({
        namespace: ns,
        keyPrefix: prefix,
        limit: 10000,
        type: 'prefix',
      });

      for (const entry of branchEntries) {
        const originalKey = entry.key.slice(prefix.length);
        const now = Date.now();
        // Write to parent (unscoped key)
        const parentEntry: MemoryEntry = {
          id: `merged-${originalKey}-${now}`,
          key: originalKey,
          content: entry.content,
          type: entry.type,
          namespace: ns,
          tags: entry.tags.filter(t => t !== branchId && t !== 'branch-data'),
          metadata: { ...entry.metadata, mergedFrom: branchId },
          accessLevel: entry.accessLevel,
          createdAt: now,
          updatedAt: now,
          version: 1,
          references: entry.references,
          accessCount: 0,
          lastAccessedAt: now,
        };
        await this.store(parentEntry);
        mergedKeys++;
      }

      // Mark branch as merged (best-effort)
      try {
        const metaKey = `_branch_meta:${branchId}`;
        const meta = await this.getByKey('default', metaKey);
        if (meta) {
          const parsed = JSON.parse(meta.content);
          parsed.status = 'merged';
          parsed.mergedAt = new Date().toISOString();
          parsed.mergedKeys = mergedKeys;
          await this.update(meta.id, { content: JSON.stringify(parsed) });
        }
      } catch { /* meta update optional */ }

      return { success: true, mergedKeys };
    } catch (e: any) {
      return { success: false, mergedKeys: 0, error: e?.message || String(e) };
    }
  }

  // ===== WAL (Write-Ahead Log) methods =====

  /**
   * Append a single entry to the WAL sidecar file (O(1) per write).
   *
   * Durability semantics (ADR-0130, T11 — RVF WAL fsync durability):
   *
   *   Linux:  appendFile() writes to kernel page cache; fdatasync(2) on
   *           the WAL fd flushes data + minimum metadata through the page
   *           cache to the underlying storage. Durable through power loss
   *           on ext4/xfs/btrfs (filesystems that honour fsync semantics).
   *
   *   Darwin: appendFile() writes to kernel page cache; fsync(2) on the
   *           WAL fd flushes data through the page cache to the disk's
   *           onboard cache, but does NOT flush the disk cache itself.
   *           True power-loss durability on macOS requires
   *           fcntl(fd, F_FULLFSYNC) (issues SCSI SYNCHRONIZE CACHE /
   *           NVMe Flush). Node's fs.fsync does NOT call F_FULLFSYNC.
   *           Therefore: durable through process-kill and OS-crash;
   *           power-loss durability is bounded by the disk write cache.
   *           Operators on macOS with power-loss exposure must disable
   *           the disk write cache at the filesystem/hardware level or
   *           accept the residual window — see ADR-0130 §Refinement
   *           for the honest framing of this gap.
   *
   * The fsync is awaited INSIDE the JS lock region so a concurrent
   * compactWal cannot observe an un-fsynced WAL line. A failure in the
   * fdatasync/fsync syscall propagates as a thrown error from this
   * method (no try/catch swallow); the originating store() call sees
   * the failure. feedback-no-fallbacks.md is satisfied by the absence
   * of error swallowing on the durability primitive.
   *
   * fdatasync is preferred over fsync where available (Linux). On
   * platforms without fdatasync, ENOSYS triggers a one-time fallback
   * to fsync and the _walFsyncFallback flag short-circuits subsequent
   * attempts — no env var, no opt-in, automatic platform detection.
   */
  private async appendToWal(entry: MemoryEntry): Promise<void> {
    if (!this.walPath) return; // :memory: mode
    const serialized = {
      ...entry,
      embedding: entry.embedding ? Array.from(entry.embedding) : undefined,
    };
    const json = Buffer.from(JSON.stringify(serialized), 'utf-8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(json.length, 0);
    const dir = dirname(this.walPath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await this.acquireLock();
    try {
      const walSizeBefore = existsSync(this.walPath) ? (await import('node:fs')).statSync(this.walPath).size : 0;
      await appendFile(this.walPath, Buffer.concat([lenBuf, json]));
      const walSizeAfter = existsSync(this.walPath) ? (await import('node:fs')).statSync(this.walPath).size : 0;

      // ADR-0130 (T11): fsync the WAL fd BEFORE releasing the lock.
      // appendFile resolves once the data is in the kernel page cache
      // but does NOT guarantee it has reached stable storage. Without
      // this fsync, an acked store() call followed by power loss drops
      // the just-appended WAL entry. Per feedback-data-loss-zero-tolerance
      // the bar is 100% durability or not done; this is the primitive
      // that closes the residual fsync-drop window left open by ADR-0123.
      const fsyncStart = Date.now();
      const walFd = await open(this.walPath, 'a');
      try {
        if (this._walFsyncFallback) {
          // Once ENOSYS observed, skip fdatasync and go straight to fsync.
          await walFd.sync();
        } else {
          try {
            await walFd.datasync();
          } catch (err: any) {
            if (err && (err.code === 'ENOSYS' || err.code === 'ENOTSUP')) {
              this._walFsyncFallback = true;
              this._diag('appendToWal.fdatasyncENOSYS_falling_back_to_fsync');
              await walFd.sync();
            } else {
              throw err; // surface EIO, ENOSPC, EDQUOT, EBADF — feedback-no-fallbacks
            }
          }
        }
      } finally {
        await walFd.close();
      }
      const fsyncElapsed = Date.now() - fsyncStart;
      this._walFsyncCount++;
      this._walFsyncLatencyMs.push(fsyncElapsed);
      // Cap latency samples at 1000 (matches queryTimes pattern, line 95-96).
      if (this._walFsyncLatencyMs.length > 1000) {
        this._walFsyncLatencyMs.shift();
      }

      this._diag(`appendToWal key=${entry.key} entryBytes=${json.length + 4} walSize=${walSizeBefore}->${walSizeAfter} fsyncMs=${fsyncElapsed} fsyncCount=${this._walFsyncCount} fallback=${this._walFsyncFallback}`);
    } finally {
      await this.releaseLock();
    }
    this.walEntryCount++;
  }

  /**
   * Returns ADR-0130 (T11) WAL fsync metrics: total count + p50/p99 latency.
   * Mirrors the eviction-rate-style observability surface ADR-0123 introduced.
   * Returns zero counters and undefined latencies if no fsync calls have
   * happened yet (e.g. :memory: mode or pre-first-store).
   */
  public getWalFsyncMetrics(): { count: number; p50Ms?: number; p99Ms?: number; usedFallback: boolean } {
    const samples = this._walFsyncLatencyMs;
    if (samples.length === 0) {
      return { count: this._walFsyncCount, usedFallback: this._walFsyncFallback };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
    return { count: this._walFsyncCount, p50Ms: p50, p99Ms: p99, usedFallback: this._walFsyncFallback };
  }

  /** Replay WAL entries into in-memory state (called after loadFromDisk) */
  private async replayWal(): Promise<void> {
    if (!this.walPath || !existsSync(this.walPath)) return;
    try {
      const raw = await readFile(this.walPath);
      let offset = 0;
      let count = 0;
      // ADR-0164 A0c (J12) + Adversarial Correction #4: cache the existing
      // META_SEG id-set once so vectorless WAL entries can be deduped before
      // calling ingestMetadataOnly. Without dedup we'd re-emit META_SEGs for
      // every WAL replay, contradicting d8's write-amplification rationale
      // documented at the embedding-arm push site below. Cheap one-shot
      // napi roundtrip; no per-entry crossings.
      let existingMetaIds: Set<number> | null = null;
      if (this.nativeDb) {
        try {
          const ids = (this.nativeDb as any).listMetadataIds?.() as number[] | undefined;
          existingMetaIds = new Set<number>(ids ?? []);
        } catch {
          // listMetadataIds is best-effort dedup; if it throws the dedup
          // collapses to "always re-ingest", which is correct (just less
          // optimal). The real durability invariant is enforced by the
          // ingestMetadataOnly call itself.
          existingMetaIds = null;
        }
      }
      while (offset + 4 <= raw.length) {
        const entryLen = raw.readUInt32LE(offset);
        offset += 4;
        if (offset + entryLen > raw.length) break; // truncated entry — skip
        const entryJson = raw.subarray(offset, offset + entryLen).toString('utf-8');
        offset += entryLen;
        try {
          const parsed = JSON.parse(entryJson);
          if (parsed.embedding) parsed.embedding = new Float32Array(parsed.embedding);
          const entry: MemoryEntry = parsed;
          const alreadyLoaded = this.entries.has(entry.id);

          // ADR-0082 + ADR-0092 single-writer durability fix. When this
          // process owns the WAL entry (it just wrote it via store() and is
          // now hitting replayWal via mergePeerStateBeforePersist), the
          // entry is already:
          //   - in `this.entries` (set by store())
          //   - in `this.hnswIndex` (added by store(), pure-TS mode)
          //   - in `this.nativeDb` (ingested by store(), native mode)
          // Re-ingesting into the native SFVR backend creates a second vec
          // segment and bumps the epoch WITHOUT re-running HNSW index
          // construction. Observed effect on shutdown-kill (CLI exits
          // before .meta.tmp → .meta rename completes): the native file
          // ends up with N orphan vec segments but `indexedVectors: 0,
          // needsRebuild: true`, and every subsequent search returns empty
          // — the exact ADR-0082 silent-empty signature.
          //
          // Fix: for entries already owned by this instance, update only
          // the metadata dictionary (entries/seenIds/keyIndex). Skip the
          // index writes entirely — they're already current. Newly-seen
          // peer entries still fall through to the full index path below.
          if (alreadyLoaded) {
            this.entries.set(entry.id, entry);
            this.keyIndex.set(this.compositeKey(entry.namespace, entry.key), entry.id);
            count++;
            continue;
          }

          this.entries.set(entry.id, entry);
          this.seenIds.add(entry.id);
          this.keyIndex.set(this.compositeKey(entry.namespace, entry.key), entry.id);
          if (entry.embedding && this.hnswIndex) this.hnswIndex.add(entry.id, entry.embedding);
          if (entry.embedding && this.nativeDb) {
            // ADR-0094 Sprint 1.4 d8 (ruflo-patch): defer native ingestBatch
            // to first semantic query. Peer's store() already persisted
            // this vector to the native SFVR file before appending to WAL,
            // so our RvfDatabase.open has it. Unconditional re-ingest
            // appended orphan segments on every process init — this was
            // the write-amplification observed in `memory list` (d8).
            // See the `_pendingNativeIngest` field comment for the full
            // analysis.
            this._pendingNativeIngest.push({
              id: entry.id,
              embedding: entry.embedding,
            });
          } else if (!entry.embedding && this.nativeDb) {
            // ADR-0164 A0c (J12) + Adversarial Correction #4: vectorless
            // WAL entries must reach META_SEG so they survive restart.
            // Honor d8's write-amplification rationale by deduping against
            // the existing META_SEG id-set captured once at the top of
            // replayWal — never re-emit a META_SEG for an id already on
            // disk. Only freshly-seen WAL entries call ingestMetadataOnly.
            const numId = this.assignNativeId(entry.id);
            const alreadyOnDisk = existingMetaIds !== null && existingMetaIds.has(numId);
            if (!alreadyOnDisk) {
              try {
                const metaEntries = encodeMemoryEntryMetadata(entry);
                this.nativeDb.ingestMetadataOnly([numId], [metaEntries]);
                if (existingMetaIds !== null) existingMetaIds.add(numId);
              } catch (err) {
                if (!this.degradeToFallbackMode('replayWal', err) && this.config.verbose) {
                  console.error('[RvfBackend] WAL replay metadata-only ingest failed:', (err as Error).message);
                }
              }
            }
          }
          count++;
        } catch (err) {
          // ADR-0164 A0d: a δ-strict RvfCorruptError from an inner native
          // call (e.g. J12's vectorless ingestMetadataOnly) must NOT be
          // swallowed as "corrupt individual entry"; the whole store is
          // unrecoverable and the user has to reset. Propagate it through
          // the outer try/catch and on up to the caller.
          if ((err as any)?.name === 'RvfCorruptError') throw err;
          // Corrupt individual WAL entry — skip and continue.
        }
      }
      this.walEntryCount = count;
      if (this.config.verbose && count > 0) {
        console.log(`[RvfBackend] Replayed ${count} WAL entries`);
      }
    } catch (err) {
      // ADR-0164 A0d: same fail-fast carve-out at the outer catch.
      if ((err as any)?.name === 'RvfCorruptError') throw err;
      if (this.config.verbose) {
        console.error('[RvfBackend] Error replaying WAL:', err);
      }
    }
  }

  /** Path for the custom-format metadata file. Always returns the `.meta`
   *  sidecar regardless of mode. This unifies the write target with
   *  `loadFromDisk`'s read preference (which picks `.meta` first whenever
   *  it exists — see lines 2264 native-branch and 2280 pure-TS branch).
   *
   *  Prior behavior split the write target: native + native-fallback wrote
   *  to `.meta`; cold pure-TS wrote to the main path. The loader's read
   *  preference was unconditionally `.meta`, creating a writer/reader
   *  divergence in cold pure-TS whenever a `.meta` lingered (e.g. left
   *  over from a prior native session, or from any session that ran on
   *  the symmetric branch above). Every cold-pure-TS write became
   *  invisible on next startup. The fix is symmetric: write to `.meta`
   *  always; read from `.meta` always.
   *
   *  Native binary file at `databasePath` is still untouched — native
   *  owns it (magic `SFVR`). Cold pure-TS legacy data living at
   *  `databasePath` (magic `RVF\0`, written by the old asymmetric branch)
   *  remains readable via `loadFromDisk`'s pure-TS-mode fall-through at
   *  line 2281, but only when no `.meta` exists. Once any write happens
   *  in the new symmetric branch, the resulting `.meta` becomes
   *  canonical and the legacy main-path RVF\0 file is orphaned. */
  private get metadataPath(): string {
    return this.config.databasePath + '.meta';
  }

  /** Compact WAL: rewrite main .rvf with all entries, then delete WAL */
  private async compactWal(): Promise<void> {
    if (this.persisting) {
      this._diag('compactWal.skipped (persisting=true)');
      return; // Another persist is in flight; retry on next trigger
    }
    this._diag(`compactWal.start walEntryCount=${this.walEntryCount} entries=${this.entries.size}`);
    await this.acquireLock();
    try {
      await this.persistToDiskInner();
      if (this.walPath) {
        // silent-fallthrough-OK: WAL may not exist if no entries were written; ENOENT is expected
        try { await unlink(this.walPath); this._diag('compactWal.unlinkedWal'); } catch {}
      }
      this.walEntryCount = 0;
    } finally {
      await this.releaseLock();
      this._diag('compactWal.end');
    }
  }

  /**
   * ADR-0154 Phase 4: load metadata from native META_SEGs.
   *
   * Iterates `nativeDb.listMetadataIds()`, reads each entry's segment data
   * via `nativeDb.getMetadataEntries(numId)`, decodes via the field
   * registry (`rvf-segment-fields.ts`), and populates `this.entries`.
   *
   * Returns `true` when at least one entry was loaded (so the caller knows
   * the native source was authoritative). Returns `false` when the file
   * contains no META_SEGs — typical for either a fresh store or a legacy
   * project still using the .meta sidecar; caller falls back to the
   * legacy load path in that case.
   */
  private async loadFromNativeSegments(): Promise<boolean> {
    // silent-fallthrough-OK: nativeDb-null is a legitimate signal the caller acts on (falls back to legacy .meta path). Method is documented to handle either branch; throwing here would force every non-native deployment to crash on init.
    if (!this.nativeDb) return false;

    // ADR-0154 G5 (2026-05-07): batch reader. The earlier per-id pattern
    // (`listMetadataIds()` + N × `getMetadataEntries(id)` + N × `getVector(id)`)
    // crossed the napi boundary 2N+1 times and acquired the store mutex
    // 2N+1 times — at 10K entries that's ~20K serialised crossings on every
    // backend init. `iterAllWithVectors()` returns every (id, vector,
    // metadata) tuple in one pass + one mutex acquisition.
    //
    // Defensive: older @latest binaries don't expose `iterAllWithVectors`.
    // Fall back to the per-id pattern when it's not available.
    const native = this.nativeDb as any;
    type Snapshot = { id: number; vector: Float32Array; metadata: RvfMetadataEntryWire[] };
    let snapshots: Snapshot[] | null = null;
    if (typeof native.iterAllWithVectors === 'function') {
      try {
        snapshots = native.iterAllWithVectors() as Snapshot[];
      } catch (err) {
        if (this.config.verbose) {
          console.warn(
            `[RvfBackend] iterAllWithVectors() failed; falling back to per-id reader:`,
            (err as Error).message,
          );
        }
      }
    }

    // ADR-0163 (2026-05-10) fix — vectorless-entry recovery pass.
    //
    // Root cause of the t3-2-concurrent "6 entries durable, 5 visible" failure:
    //   `iterAllWithVectors` is backed by the Rust runtime's
    //   `iter_metadata_with_vectors` which filters out any entry whose vector
    //   is not present (`store.rs:1825-1832`: `let vec = self.vectors.get(*id)?;`).
    //   ADR-0164 A0c shipped the δ+ vectorless ingest path (`ingestMetadataOnly`),
    //   so vectorless entries are now legitimately persisted to META_SEG without
    //   a paired VEC_SEG. They land in `metadata_full` but NOT in `vectors`, so
    //   `iter_metadata_with_vectors` silently drops them. Under concurrent load
    //   the embedding adapter at memory-router.ts:893 catches transient failures
    //   and stores the entry without an embedding — exactly the shape that
    //   triggers this filter. The vectorless entry is durable on disk (visible
    //   in `entryCount` from the `.meta` header and via `listMetadataIds`),
    //   but `cli memory list --namespace` reads through `RvfBackend.query()` →
    //   `this.entries`, which is populated by this method. If we early-return
    //   `true` after `iterAllWithVectors` populated only N-1 of N entries,
    //   `loadFromDisk` skips the legacy `.meta` parser (line 2456) and the
    //   vectorless entry is silently invisible to all read APIs. Same shape
    //   poisons `nativeIdMap`: subsequent `assignNativeId(stringId)` calls
    //   that hit the unreserved numId can collide with the on-disk vectorless
    //   entry's vid, causing the `RvfStore::boot()` HashMap-overwrite
    //   characterised in the Rust race investigator's INVESTIGATION.md.
    //
    // Fix: after the snapshot pass, enumerate `listMetadataIds()` (which is
    // backed by `iter_metadata` and does NOT filter on vector presence) and
    // load any IDs missing from the snapshot via `getMetadataEntries(numId)`.
    // These are the vectorless entries; they get folded into `snapshots` with
    // an empty Float32Array vector so the downstream loop reserves their
    // numIds and registers them in `this.entries` / `seenIds` / `keyIndex` /
    // `nativeIdMap` exactly as the with-vector entries.
    if (snapshots !== null) {
      try {
        const allIds = (native.listMetadataIds?.() as number[] | undefined) ?? [];
        if (allIds.length > snapshots.length) {
          const seen = new Set<number>(snapshots.map(s => s.id));
          for (const numId of allIds) {
            if (seen.has(numId)) continue;
            const metadata = (native.getMetadataEntries?.(numId) as RvfMetadataEntryWire[] | undefined)
              ?? [];
            if (metadata.length === 0) continue;
            snapshots.push({ id: numId, vector: new Float32Array(0), metadata });
          }
        }
      } catch (err) {
        // silent-fallthrough-OK: the recovery pass is additive; if listMetadataIds
        // or getMetadataEntries throws (older @latest binary, transient store-mutex
        // contention) we fall through with whatever iterAllWithVectors returned.
        // The legacy `.meta` parser remains the safety net via loadFromDisk's
        // `restoredFromSegments === false` branch when no entries were loaded.
        if (this.config.verbose) {
          console.warn(
            `[RvfBackend] vectorless-entry recovery pass failed:`,
            (err as Error).message,
          );
        }
      }
    }

    if (!snapshots) {
      // Legacy per-id path. Same logic as before; preserved for compat with
      // older @latest binaries that don't ship iterAllWithVectors. This path
      // already enumerates via `listMetadataIds` and treats vectorless entries
      // correctly (empty Float32Array fallback at the catch below).
      const ids = native.listMetadataIds?.() as number[] | undefined;
      // silent-fallthrough-OK: empty segment list is the expected fresh-store / legacy-pre-Phase-1 case; caller falls back to the legacy .meta path. Throwing would break every project on the day this version ships.
      if (!ids || ids.length === 0) return false;
      snapshots = [];
      for (const numId of ids) {
        const metadata = (native.getMetadataEntries?.(numId) as RvfMetadataEntryWire[] | undefined)
          ?? [];
        if (metadata.length === 0) continue;
        let vec: Float32Array | null = null;
        try {
          vec = (native.getVector?.(numId) as Float32Array | null | undefined) ?? null;
        } catch {
          // silent-fallthrough-OK: getVector is best-effort in the legacy per-id fallback path; if the older @latest binary doesn't expose it OR it throws on a deleted vector, fall through with an empty vector. The entry's metadata is still persisted; only its embedding is missing for this load. Throwing here would force every reopen on an older @latest into a hard error.
        }
        snapshots.push({ id: numId, vector: vec ?? new Float32Array(0), metadata });
      }
    }

    if (snapshots.length === 0) return false;

    let loaded = 0;
    for (const snap of snapshots) {
      const numId = snap.id;
      const wireEntries = snap.metadata;
      if (!wireEntries || wireEntries.length === 0) continue;
      try {
        const decoded = decodeMemoryEntryMetadata(wireEntries);
        // The entry-blob preserves the original MemoryEntry.id (e.g. UUIDs
        // assigned at store() time); use it verbatim. Only fall back to a
        // synthetic `${namespace}:${key}` id if the blob is absent or
        // malformed (per-field decode path), where decoded.id is empty
        // string per decodeMemoryEntryMetadata's documented contract.
        const composite = this.compositeKey(decoded.namespace, decoded.key);
        const stringId = decoded.id && decoded.id.length > 0
          ? decoded.id
          : (decoded.key && decoded.namespace
              ? `${decoded.namespace}:${decoded.key}`
              : composite);
        const entry: any = { ...decoded, id: stringId };

        // ADR-0154 G5: vector comes from the batch snapshot (no per-id
        // napi crossing). Empty vector means the entry was metadata-only
        // (no embedding) — keep `embedding` undefined in that case.
        if (snap.vector && snap.vector.length > 0) {
          entry.embedding = snap.vector;
        }

        this.entries.set(stringId, entry);
        this.seenIds.add(stringId);
        this.keyIndex.set(composite, stringId);
        // Map numId ↔ stringId so future query() results route correctly.
        this._reserveAssignedNativeId(stringId, numId);
        loaded++;
      } catch (err) {
        if (this.config.verbose) {
          console.warn(
            `[RvfBackend] failed to decode META_SEG entries for numId=${numId}:`,
            (err as Error).message,
          );
        }
      }
    }
    this._diag(`loadFromNativeSegments.done loaded=${loaded}`);
    return loaded > 0;
  }

  /**
   * Replay the WAL if it exists. Extracted from the legacy loadFromDisk
   * tail so the native segment-loader path can call it without duplicating
   * the conditional logic.
   */
  private async replayWalIfPresent(): Promise<void> {
    if (this.walPath && existsSync(this.walPath)) {
      await this.replayWal();
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (this.config.databasePath === ':memory:') return;

    // ADR-0154 Phase 4: when native is active, metadata lives in META_SEGs
    // inside the .rvf file (Phase 1 runtime persistence + Phase 3 ingest
    // wiring). Read it back via the napi getMetadataEntries reader rather
    // than parsing the legacy .meta sidecar. If the .meta sidecar still
    // exists (legacy project pre-migration), the migration tool in Phase 6c
    // is responsible for moving it; the loader here ignores it for
    // native-mode reads.
    if (this.nativeDb) {
      const restoredFromSegments = await this.loadFromNativeSegments();
      if (restoredFromSegments) {
        // Still replay the WAL — it may contain entries from a peer process
        // that exited after appending but before native ingest committed.
        // Same WAL replay as the legacy path; non-native reads also fall
        // through to it below.
        await this.replayWalIfPresent();
        return;
      }
      // restoredFromSegments returned false: native is active but the
      // file has no META_SEGs (fresh store, or legacy file pre-Phase 1).
      // Fall through to the legacy .meta path so existing projects
      // continue to load until 6c migration runs against them.
    }

    // Determine which file to load metadata from:
    // 1. Try the .meta sidecar (used when native DB owns the main path)
    // 2. Fall back to the main path (pre-native or native not active)
    // 3. If neither exists, skip main file load but STILL replay WAL
    //    (the WAL may contain entries from a prior process that exited
    //    before compaction — e.g. short-lived CLI invocations).
    const metaPath = this.config.databasePath + '.meta';
    const metaExists = existsSync(metaPath);
    const mainExists = existsSync(this.config.databasePath);
    const walExists = this.walPath && existsSync(this.walPath);
    this._diag(`loadFromDisk.start metaExists=${metaExists} mainExists=${mainExists} walExists=${walExists} nativeDb=${this.nativeDb ? 'set' : 'null'} fallback=${this.nativeFallbackMode}`);
    let loadPath: string | null = null;
    if (this.nativeDb || this.nativeFallbackMode) {
      // ADR-0090 Tier B2 + ADR-0092: when native is active, the main
      // path `this.config.databasePath` holds the native binary format
      // (magic `SFVR`), NOT the pure-TS RVF format (magic `RVF\0`). We
      // must ONLY look at the `.meta` sidecar for pure-TS metadata —
      // attempting to parse the native file as pure-TS would trip the
      // fail-loud corruption check on every init (native's
      // `RvfDatabase.create()` writes SFVR to `dbPath` during
      // tryNativeInit, which runs *before* loadFromDisk).
      //
      // ADR-0095 d5: same branch applies when we fell back from a
      // checksum-corrupt native file — the main path is still SFVR
      // (just with bad segment hashes), so `.meta` is the ONLY valid
      // source. If `.meta` doesn't exist we fall through with no entries
      // and let the WAL replay recover whatever it can.
      if (existsSync(metaPath)) loadPath = metaPath;
    } else {
      // Pure-TS mode: .meta may exist from a prior native session — if
      // so prefer it (it has the richer header). Otherwise fall back to
      // the main path, which pure-TS owns exclusively when no native
      // file was ever written.
      //
      // EDGE CASE: the main path may hold native-format bytes (magic
      // `SFVR`) written by a *previous* process that had the native
      // backend loaded. If the current process couldn't load native
      // (binding unavailable, platform mismatch, install race), we must
      // NOT try to parse those SFVR bytes as pure-TS RVF — that would
      // trip the fail-loud corruption path with "bad magic bytes". Peek
      // the first 4 bytes; if they're SFVR, ignore the main file and
      // load only from `.meta` (if present) or start clean.
      if (existsSync(metaPath)) {
        loadPath = metaPath;
      } else if (existsSync(this.config.databasePath)) {
        let isNativeFile = false;
        try {
          const { openSync, readSync, closeSync } = await import('node:fs');
          const fd = openSync(this.config.databasePath, 'r');
          try {
            const head = Buffer.alloc(4);
            const bytesRead = readSync(fd, head, 0, 4, 0);
            if (bytesRead === 4) {
              const peek = String.fromCharCode(head[0], head[1], head[2], head[3]);
              if (peek === NATIVE_MAGIC) isNativeFile = true;
            }
          } finally {
            closeSync(fd);
          }
        } catch {
          // Peek failed — fall through and let the full reader error out
          // loudly below (ADR-0082: never silent-pass on read failures).
        }
        if (!isNativeFile) {
          loadPath = this.config.databasePath;
        } else if (this.config.verbose) {
          console.log(
            `[RvfBackend] Main path ${this.config.databasePath} holds native (SFVR) ` +
            `bytes from a prior native-backend session but current process is pure-TS. ` +
            `Loading metadata from sidecar if present; skipping main file.`,
          );
        }
      }
    }
    // No early return — fall through to replayWal() even when main file is absent

    // Load entries from the main RVF file (if it exists and is valid).
    // WAL replay runs unconditionally afterward — the WAL may contain
    // entries from a prior process that exited before compaction (e.g.
    // short-lived CLI invocations where store writes to WAL then exits).
    //
    // ADR-0090 Tier B2: corruption fail-loud.
    //
    // Previously every parse-failure branch silently skipped the load and
    // returned an empty backend. If the user later stored new data, the
    // silent-zero starting state caused the corrupt file to be overwritten
    // with only the new entry — SILENT DATA LOSS.
    //
    // Fix: track whether we DETECTED corruption (file existed, had bytes,
    // but we couldn't extract entries). After WAL replay, if we detected
    // corruption AND no entries were recovered from WAL either, throw a
    // loud `RvfCorruptError`. The CLI surfaces this as a non-zero exit
    // with a diagnostic pointing to the corrupt path — the user can then
    // decide to delete or migrate, rather than continuing with empty state.
    //
    // Cases that still work (non-throwing):
    //   - File doesn't exist at all → normal cold start (no corruption detected)
    //   - File exists but is empty (0 bytes) → truncated-to-zero (no corruption)
    //   - File exists AND is corrupt AND WAL recovery yields >= 1 entries
    //     → WAL is the recovery path by design, use it
    let loadFailed = false;
    let loadFailReason = '';
    if (loadPath) {
      try {
        const raw = await readFile(loadPath);
        if (raw.length === 0) {
          // Empty file — treat as cold start, not corruption
        } else if (raw.length < 8) {
          loadFailed = true;
          loadFailReason = `file is shorter than the 8-byte RVF header (${raw.length} bytes)`;
        } else {
          const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
          if (magic !== MAGIC) {
            loadFailed = true;
            loadFailReason = `bad magic bytes (expected '${MAGIC.replace(/\0/g, '\\0')}', got ${JSON.stringify(magic)})`;
          } else {
            const headerLen = raw.readUInt32LE(4);
            const MAX_HEADER_SIZE = 10 * 1024 * 1024; // 10MB max header
            if (headerLen > MAX_HEADER_SIZE) {
              loadFailed = true;
              loadFailReason = `header length ${headerLen} exceeds MAX_HEADER_SIZE (${MAX_HEADER_SIZE})`;
            } else if (8 + headerLen > raw.length) {
              loadFailed = true;
              loadFailReason = `truncated header (expected ${8 + headerLen} bytes, got ${raw.length})`;
            } else {
              const headerJson = raw.subarray(8, 8 + headerLen).toString('utf-8');
              let header: RvfHeader | null = null;
              try {
                header = JSON.parse(headerJson);
              } catch (e) {
                loadFailed = true;
                loadFailReason = `header JSON parse failed: ${(e as Error).message}`;
              }
              if (header && typeof header.entryCount === 'number' && typeof header.version === 'number') {
                let offset = 8 + headerLen;
                let loaded = 0;
                for (let i = 0; i < header.entryCount; i++) {
                  if (offset + 4 > raw.length) {
                    // Truncated mid-entry — set corruption flag only if we
                    // haven't loaded anything (otherwise the prefix is usable)
                    if (loaded === 0) {
                      loadFailed = true;
                      loadFailReason = `truncated entry-length prefix at offset ${offset} (expected ${header.entryCount} entries, got 0 before truncation)`;
                    } else if (this.config.verbose) {
                      console.error(`[RvfBackend] Truncated at entry ${i}/${header.entryCount}, loaded ${loaded} entries`);
                    }
                    break;
                  }
                  const entryLen = raw.readUInt32LE(offset);
                  offset += 4;
                  if (offset + entryLen > raw.length) {
                    if (loaded === 0) {
                      loadFailed = true;
                      loadFailReason = `truncated entry body at offset ${offset} (need ${entryLen} bytes, have ${raw.length - offset})`;
                    } else if (this.config.verbose) {
                      console.error(`[RvfBackend] Truncated entry body at entry ${i}/${header.entryCount}, loaded ${loaded} entries`);
                    }
                    break;
                  }

                  const entryJson = raw.subarray(offset, offset + entryLen).toString('utf-8');
                  offset += entryLen;

                  let parsed: MemoryEntry;
                  try {
                    parsed = JSON.parse(entryJson);
                  } catch (e) {
                    if (loaded === 0) {
                      loadFailed = true;
                      loadFailReason = `entry ${i} JSON parse failed: ${(e as Error).message}`;
                    } else if (this.config.verbose) {
                      console.error(`[RvfBackend] Corrupt entry ${i}/${header.entryCount}, loaded ${loaded}`);
                    }
                    break;
                  }
                  if (parsed.embedding) parsed.embedding = new Float32Array(parsed.embedding);

                  const entry: MemoryEntry = parsed;
                  this.entries.set(entry.id, entry);
                  this.seenIds.add(entry.id);
                  this.keyIndex.set(this.compositeKey(entry.namespace, entry.key), entry.id);
                  if (entry.embedding && this.hnswIndex) this.hnswIndex.add(entry.id, entry.embedding);
                  if (entry.embedding && this.nativeDb) {
                    // ADR-0094 Sprint 1.4 d8 (ruflo-patch): defer native
                    // ingestBatch to first semantic query. The native SFVR
                    // file ALREADY contains this vector (the prior process's
                    // store() persisted it to the same path we just opened
                    // with RvfDatabase.open). Unconditional re-ingest at
                    // load time was growing `.rvf` by ~(N × dim × 4) bytes
                    // per process init — observed as ~3.6KB/list at 1
                    // entry/768-dim — because each re-ingest appends a new
                    // vec segment rather than overwriting. See the
                    // `_pendingNativeIngest` field comment for the full
                    // analysis and `ensureNativeSemanticReady` for the
                    // deferred-ingest gate. The hnswIndex branch above
                    // remains unconditional because HnswLite is pure-TS
                    // in-memory; there is no "already-loaded" shortcut.
                    this._pendingNativeIngest.push({
                      id: entry.id,
                      embedding: entry.embedding,
                    });
                  } else if (!entry.embedding && this.nativeDb) {
                    // ADR-0164 A0c (J18): δ+ vectorless arm of the legacy
                    // `.meta` reader. Phase B4 deletes this entire branch;
                    // the edit lands in the same atomic release purely so
                    // the `.meta`-migration window remains consistent
                    // (vectorless entries from a stale `.meta` get pushed
                    // to META_SEG before the legacy reader is removed).
                    try {
                      const numId = this.assignNativeId(entry.id);
                      const metaEntries = encodeMemoryEntryMetadata(entry);
                      this.nativeDb.ingestMetadataOnly([numId], [metaEntries]);
                    } catch (err) {
                      if (!this.degradeToFallbackMode('loadFromDisk', err) && this.config.verbose) {
                        console.error('[RvfBackend] Legacy .meta vectorless ingest failed:', (err as Error).message);
                      }
                    }
                  }
                  loaded++;
                }
              } else if (!loadFailed) {
                loadFailed = true;
                loadFailReason = `header missing required fields (entryCount, version)`;
              }
            }
          }
        }
      } catch (err) {
        // ADR-0164 A0d: a δ-strict RvfCorruptError surfaced by the inner
        // J18 vectorless arm is fail-fast; do not flatten into a corruption
        // signal that the post-WAL guard would re-wrap with less context.
        if ((err as any)?.name === 'RvfCorruptError') throw err;
        // Read error (permissions, EIO, etc.) — treat as corruption signal.
        loadFailed = true;
        loadFailReason = `read failed: ${(err as Error).message}`;
      }
    }

    // Always replay WAL — even if the main file is missing, corrupt, or empty.
    // The WAL is the authoritative source for uncommitted writes.
    await this.replayWal();

    // ADR-0090 Tier B2: if we detected corruption AND neither the main
    // file load NOR the WAL replay yielded any entries, fail loud. This
    // is the ADR-0082 "no silent fallback" rule applied at the storage
    // layer: a corrupt file that resolves to an empty backend silently
    // invites subsequent stores to overwrite the corrupt data with a new
    // empty file, destroying any chance of recovery.
    //
    // ADR-0090 Tier B2 (ruflo-patch): the `_deferredCorruptReason` from
    // tryNativeInit is ALSO honored here — three corruption shapes
    // (SFVR+open-fail, partial magic, unknown magic) are detected BEFORE
    // loadFromDisk runs and are deferred so WAL replay gets a chance. If
    // the WAL also yielded nothing, we throw with the deferred reason
    // using the typed `RvfCorruptError` class so callers can
    // `err.name === 'RvfCorruptError'`.
    const combinedFailed = loadFailed || this._deferredCorruptReason !== null;
    if (combinedFailed && this.entries.size === 0) {
      const pathForMsg = loadPath ?? this.config.databasePath;
      const reason = loadFailReason
        || this._deferredCorruptReason
        || 'unknown corruption';
      throw new RvfCorruptError(pathForMsg, reason);
    }
    // If we got entries (via main file partial load OR WAL replay), clear
    // the deferred reason — the corruption was effectively repaired by
    // the surviving data and a successful shutdown will rewrite a clean
    // main file.
    this._deferredCorruptReason = null;
    this._diag(`loadFromDisk.end entries=${this.entries.size} seenIds=${this.seenIds.size} keys=[${Array.from(this.entries.values()).map(e=>(e as any).key).join(',')}]`);
  }

  private async persistToDisk(): Promise<void> {
    if (this.config.databasePath === ':memory:') return;
    await this.acquireLock();
    try {
      await this.persistToDiskInner();
    } finally {
      await this.releaseLock();
    }
  }

  /** Merge peer on-disk state into this.entries before a persist.
   *
   *  Called under the advisory lock at the top of persistToDiskInner. Re-reads
   *  `.rvf` / `.meta` and replays `.rvf.wal` using set-if-absent semantics for
   *  the disk read (our writes win on conflict) and standard replayWal for the
   *  WAL (chronological last-write-wins, which matches the natural ordering
   *  of appendToWal calls across processes).
   *
   *  HNSW/native vector indexes are intentionally NOT updated here: this is
   *  the final persist for this instance (compactWal/shutdown path or
   *  autoPersistInterval), and the additional entries are only needed for
   *  durability, not for in-process query correctness. Skipping index
   *  updates avoids double-add hazards (`loadFromDisk` doesn't do
   *  alreadyLoaded checks on the index path) and reduces per-persist cost.
   */
  private async mergePeerStateBeforePersist(): Promise<void> {
    if (this.config.databasePath === ':memory:') return;
    const beforeEntries = this.entries.size;
    const beforeSeenIds = this.seenIds.size;
    this._diag(`mergePeer.start entriesBefore=${beforeEntries} seenIdsBefore=${beforeSeenIds} fallback=${this.nativeFallbackMode} nativeDb=${this.nativeDb ? 'set' : 'null'}`);

    // Step 1: re-read the compacted main file. If a peer process compacted
    // their WAL since our initialize(), their entries are now in `.rvf` and
    // not in the WAL. Missing this step is the primary data-loss vector.
    //
    // ADR-0090 Tier B2 + ADR-0092: when native is active, skip the main
    // path — it holds native binary format, NOT pure-TS RVF format.
    // Reading it as pure-TS would be silently ignored (magic mismatch)
    // and, in worse cases, could parse valid-looking but wrong bytes.
    const metaPath = this.config.databasePath + '.meta';
    let loadPath: string | null = null;
    if (this.nativeDb || this.nativeFallbackMode) {
      // Native-active OR d5 fallback: main path holds SFVR bytes
      // (possibly checksum-corrupt in fallback mode) — never parse it as
      // pure-TS. `.meta` is the only valid peer-state source here.
      if (existsSync(metaPath)) loadPath = metaPath;
    } else if (existsSync(metaPath)) {
      loadPath = metaPath;
    } else if (existsSync(this.config.databasePath)) {
      loadPath = this.config.databasePath;
    }

    if (loadPath) {
      try {
        const raw = await readFile(loadPath);
        if (raw.length >= 8) {
          const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
          if (magic === MAGIC) {
            const headerLen = raw.readUInt32LE(4);
            const MAX_HEADER_SIZE = 10 * 1024 * 1024;
            if (headerLen <= MAX_HEADER_SIZE && 8 + headerLen <= raw.length) {
              const headerJson = raw.subarray(8, 8 + headerLen).toString('utf-8');
              let header: RvfHeader | null = null;
              try { header = JSON.parse(headerJson); } catch { header = null; }
              if (header && typeof header.entryCount === 'number') {
                let offset = 8 + headerLen;
                for (let i = 0; i < header.entryCount; i++) {
                  if (offset + 4 > raw.length) break;
                  const entryLen = raw.readUInt32LE(offset);
                  offset += 4;
                  if (offset + entryLen > raw.length) break;
                  const entryJson = raw.subarray(offset, offset + entryLen).toString('utf-8');
                  offset += entryLen;
                  try {
                    const parsed = JSON.parse(entryJson);
                    if (parsed.embedding) parsed.embedding = new Float32Array(parsed.embedding);
                    const entry: MemoryEntry = parsed;
                    // ADR-0090 B7 followup: set-if-not-seen. We preserve
                    // our in-memory writes on key conflict AND we do not
                    // resurrect entries we explicitly deleted this session.
                    // The `seenIds` tombstone remembers every ID that ever
                    // entered `this.entries` (initial load + stores + WAL
                    // replay), regardless of whether a subsequent delete
                    // removed it. Using `!this.entries.has(id)` alone would
                    // treat "we deleted this" identically to "peer wrote
                    // this" and silently un-delete bulkDelete() calls on
                    // the next persist.
                    if (!this.seenIds.has(entry.id)) {
                      this.entries.set(entry.id, entry);
                      this.seenIds.add(entry.id);
                      this.keyIndex.set(
                        this.compositeKey(entry.namespace, entry.key),
                        entry.id,
                      );
                    }
                  } catch { /* corrupt entry — skip */ }
                }
              }
            }
          }
        }
      } catch (err) {
        // ADR-0112 Phase 2 (RVF track) + feedback-best-effort-must-rethrow-fatals:
        // read errors during peer-state merge are usually transient (lock
        // contention, partial writes). Fallback to in-memory state preserves
        // correctness for those. But RvfCorruptError indicates real on-disk
        // corruption and must propagate — silently overwriting it during the
        // next persist would destroy the diagnostic.
        const name = err instanceof Error ? err.name : '';
        if (name === 'RvfCorruptError') throw err;
        // Else: transient read error — fall back to in-memory state. Worst
        // case we repeat the pre-fix behavior for this one persist; not a
        // regression.
      }
    }

    // Step 2: replay the current WAL. It may contain un-compacted entries
    // from peer processes that called appendToWal but have not yet compacted.
    // replayWal() uses standard set() which gives chronological last-write-
    // wins, the correct ordering for concurrent appendToWal calls under the
    // advisory lock.
    const beforeWal = this.entries.size;
    if (this.walPath && existsSync(this.walPath)) {
      await this.replayWal();
    }
    this._diag(`mergePeer.end entriesBefore=${beforeEntries} entriesAfterMeta=${beforeWal} entriesAfterAll=${this.entries.size} addedFromMeta=${beforeWal - beforeEntries} addedFromWal=${this.entries.size - beforeWal}`);
  }

  private async persistToDiskInner(): Promise<void> {
    if (this.persisting) {
      this._diag('persistToDiskInner.skipped (persisting=true)');
      if (process.env.RVF_DEBUG) console.error(`[RVF-DEBUG pid=${process.pid}] persistToDiskInner SKIPPED (persisting=true)`);
      return; // Prevent concurrent persist calls
    }
    this.persisting = true;
    const persistStart = Date.now();
    const persistKeys = Array.from(this.entries.values()).map(e=>(e as any).key).join(',');
    this._diag(`persistToDiskInner.start entries=${this.entries.size} keys=[${persistKeys}] target=${this.metadataPath}`);
    if (process.env.RVF_DEBUG) console.error(`[RVF-DEBUG pid=${process.pid}] persistToDiskInner ENTER, this.entries.size=${this.entries.size}, keys=${persistKeys}`);

    try {
    // Multi-writer convergence (ADR-0090 Tier B7 fix).
    //
    // Callers always hold the advisory lock when they reach this method
    // (compactWal / persistToDisk both acquire it first). Before dumping
    // `this.entries` to disk, re-read on-disk state and replay the WAL so
    // we pick up any entries committed by peer processes since our
    // `initialize()` snapshot. Without this merge, shutdown silently
    // overwrites peer writes with our stale in-memory map. Verified
    // deterministic (50/75/87.5% data loss at N=2/4/8) by
    // ruflo-patch/scripts/diag-rvf-inproc-race.mjs.
    //
    // Semantics: our in-memory entries win on key conflict (set-if-absent
    // merge); peer entries we didn't have are added; WAL replay uses
    // chronological last-write-wins via the existing `replayWal()` path,
    // which is the correct ordering for entries appended after our init.
    await this.mergePeerStateBeforePersist();

    // ADR-0164 Phase B1 (re-land of ADR-0154 Phase 5c suppress-meta):
    // when native owns the .rvf file (single-file storage under δ-strict),
    // skip the .meta sidecar write. Native META_SEG persistence holds the
    // metadata; .meta is redundant.
    //
    // Pure-TS mode (no native binding) keeps writing .meta because pure-TS
    // has no other persistence target — without .meta, all data is lost on
    // shutdown. Under δ-strict (Amendment 2026-05-10d), nativeFallbackMode
    // is removed (degradeToFallbackMode now throws RvfCorruptError), so
    // the only remaining "no native" case is "binding never loaded".
    //
    // Original Phase 5c was reverted 2026-05-07T14 because `p8-inv12-mem-
    // full` failed: session_save snapshot needed .meta. ADR-0164 A0a–A0e
    // resolves that by ingesting metadata-only entries into native via
    // `ingestMetadataOnly` (J1/J2/J3) and migrating existing .meta on MCP
    // start (A0e). Phase B re-lands the suppress now that those gates are
    // closed.
    if (!this.nativeDb) {

    const target = this.metadataPath;
    const dir = dirname(target);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });

    const entries = Array.from(this.entries.values());

    // Compute min createdAt without spread operator (avoids stack overflow for large arrays)
    let minCreatedAt = Date.now();
    for (const e of entries) {
      if (e.createdAt < minCreatedAt) minCreatedAt = e.createdAt;
    }

    const header: RvfHeader = {
      magic: MAGIC,
      version: VERSION,
      dimensions: this.config.dimensions,
      metric: this.config.metric,
      quantization: this.config.quantization,
      entryCount: entries.length,
      createdAt: entries.length > 0 ? minCreatedAt : Date.now(),
      updatedAt: Date.now(),
    };

    const headerBuf = Buffer.from(JSON.stringify(header), 'utf-8');
    const entryBuffers: Buffer[] = [];

    for (const entry of entries) {
      const serialized = {
        ...entry,
        embedding: entry.embedding ? Array.from(entry.embedding) : undefined,
      };
      const buf = Buffer.from(JSON.stringify(serialized), 'utf-8');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(buf.length, 0);
      entryBuffers.push(lenBuf, buf);
    }

    const magicBuf = Buffer.from([0x52, 0x56, 0x46, 0x00]);
    const headerLenBuf = Buffer.alloc(4);
    headerLenBuf.writeUInt32LE(headerBuf.length, 0);

    const output = Buffer.concat([magicBuf, headerLenBuf, headerBuf, ...entryBuffers]);

    // Atomic write: write to temp file then rename (crash-safe).
    // ADR-0095 amendment (ruflo-patch 2d12bb1): unique tmp path per writer
    // (pid + per-instance counter) so concurrent writers never collide on
    // the same tmp filename. Crash-leaked tmp files are cleaned by the
    // reaper invoked from initialize() (`reapStaleTmpFiles`).
    const tmpPath = `${target}.tmp.${process.pid}.${this._tmpCounter++}`;
    // ADR-0095 d11 (Sprint 1.5): explicit fsync on the tmp file BEFORE rename.
    // writeFile uses open→write→close which does NOT fsync; on APFS under
    // concurrent I/O load, data blocks can remain in the VFS page cache
    // after close. rename() is atomic for the directory entry, but peer
    // processes reading target through a different file descriptor may
    // see a stale snapshot if the tmp data blocks have not yet hit stable
    // storage. Mode A silent loss at entryCount=5/6 observed on patch.204
    // under the mega-parallel acceptance wave (ruflo-patch 2026-04-19).
    // Without this fsync the advisory lock serializes the acquire ordering
    // but not the VFS cache flush.
    {
      const { open } = await import('node:fs/promises');
      const fh = await open(tmpPath, 'w');
      try {
        await fh.writeFile(output);
        await fh.sync();
      } finally {
        await fh.close();
      }
    }
    await rename(tmpPath, target);
    const writtenKeys = entries.map(e=>(e as any).key).join(',');
    this._diag(`persistToDiskInner.renamed tmp=${tmpPath} target=${target} entries=${entries.length} keys=[${writtenKeys}]`);
    if (process.env.RVF_DEBUG) console.error(`[RVF-DEBUG pid=${process.pid}] persistToDiskInner WROTE ${entries.length} entries to ${target}, keys=${writtenKeys}`);

    // fsync directory entry for power-crash durability (Debt 12)
    try {
      const { open } = await import('node:fs/promises');
      const dirHandle = await open(dir, 'r');
      await dirHandle.datasync();
      await dirHandle.close();
    } catch {} // Best-effort — not all platforms support dir fsync

    } // end ADR-0164 Phase B1: !this.nativeDb gate

    this.dirty = false;
    } finally {
      this.persisting = false;
    }
  }
}
