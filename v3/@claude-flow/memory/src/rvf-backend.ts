import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, appendFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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

/** Validate a file path is safe (no null bytes, no traversal above root) */
function validatePath(p: string): void {
  if (p === ':memory:') return;
  if (p.includes('\0')) throw new Error('Path contains null bytes');
  const resolved = resolve(p);
  if (resolved.includes('\0')) throw new Error('Resolved path contains null bytes');
}

const DEFAULT_WAL_COMPACTION_THRESHOLD = 100;

export interface RvfBackendConfig {
  databasePath: string;
  dimensions?: number;
  metric?: 'cosine' | 'euclidean' | 'dot';
  quantization?: 'fp32' | 'fp16' | 'int8';
  hnswM?: number;
  hnswEfConstruction?: number;
  maxElements?: number;
  verbose?: boolean;
  defaultNamespace?: string;
  autoPersistInterval?: number;
  walCompactionThreshold?: number;
}

interface RvfHeader {
  magic: string;
  version: number;
  dimensions: number;
  metric: string;
  quantization: string;
  entryCount: number;
  createdAt: number;
  updatedAt: number;
}

const MAGIC = 'RVF\0';
// Native @ruvector/rvf-node file format (written by RvfDatabase.create()).
// When the pure-TS backend initializes on a project that previously used the
// native backend, the main `.rvf` path holds `SFVR` bytes and pure-TS metadata
// was written to the `.meta` sidecar. Treat this as a valid native-owned file,
// NOT corruption.
const NATIVE_MAGIC = 'SFVR';
const VERSION = 1;
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_M = 16;
const DEFAULT_EF_CONSTRUCTION = 200;
const DEFAULT_MAX_ELEMENTS = 100000;
const DEFAULT_PERSIST_INTERVAL = 30000;

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
      maxElements: config.maxElements ?? DEFAULT_MAX_ELEMENTS,
      verbose: config.verbose ?? false,
      defaultNamespace: config.defaultNamespace ?? 'default',
      autoPersistInterval: config.autoPersistInterval ?? DEFAULT_PERSIST_INTERVAL,
      walCompactionThreshold: config.walCompactionThreshold ?? DEFAULT_WAL_COMPACTION_THRESHOLD,
    };
    validatePath(this.config.databasePath);
    this.walPath = this.config.databasePath === ':memory:' ? '' : this.config.databasePath + '.wal';
    this.lockPath = this.config.databasePath === ':memory:' ? '' : this.config.databasePath + '.lock';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // ADR-0095 amendment d1 (ruflo-patch): serialize the entire init sequence
    // through the PID-based advisory lock. Previously `reapStaleTmpFiles →
    // tryNativeInit → loadFromDisk` ran unlocked, so a second process starting
    // up concurrently could race the first in the native create/open and the
    // pure-TS reader paths. Wrapping them under the same advisory lock that
    // persistToDisk / compactWal / appendToWal use makes init serialize
    // against both other initializers AND live writers. :memory: mode is a
    // no-op in the lock path (lockPath is ''), so the guard is free there.
    //
    // Re-entrancy note: reapStaleTmpFiles, tryNativeInit, loadFromDisk
    // (including its replayWal call) do NOT themselves take the lock — all
    // three existing lock-taking sites are in appendToWal/compactWal/
    // persistToDisk, none of which fire during init. Verified against
    // rvf-backend.ts at the time of this change.
    //
    // The lock primitive has a 5s budget + throws on timeout; we let that
    // propagate rather than swallowing — if init can't claim the lock within
    // budget, something upstream is deeply wrong and the caller should see it.
    await this.acquireLock();
    try {
      // Reap stale *.tmp.* files left by crashed writers before native init
      // so the directory state is clean when the native backend peeks at it.
      // Non-fatal — failures here should not block init.
      await this.reapStaleTmpFiles().catch(() => {});

      const hasNative = await this.tryNativeInit();

      // Only create HnswLite when native is NOT available (Debt 8)
      if (!hasNative) {
        this.hnswIndex = new HnswLite(
          this.config.dimensions,
          this.config.hnswM,
          this.config.hnswEfConstruction,
          this.config.metric,
        );
      }

      // Always load metadata from disk (native only handles vectors)
      await this.loadFromDisk();
    } finally {
      await this.releaseLock();
    }

    if (this.config.autoPersistInterval > 0 && this.config.databasePath !== ':memory:') {
      this.persistTimer = setInterval(() => {
        if (this.dirty && !this.persisting) {
          const op = this.walEntryCount > 0 ? this.compactWal() : this.persistToDisk();
          op.catch(() => {});
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
      try { this.nativeDb.close(); } catch {}
      this.nativeDb = null;
    }

    this.entries.clear();
    this.seenIds.clear();
    this.keyIndex.clear();
    this.hnswIndex = null;
    this.initialized = false;

    // Clean up advisory lock file
    if (this.lockPath) {
      try { await unlink(this.lockPath); } catch {}
    }
  }

  async store(entry: MemoryEntry): Promise<void> {
    this.checkCapacity();
    const ns = entry.namespace || this.config.defaultNamespace;
    const e = ns !== entry.namespace ? { ...entry, namespace: ns } : entry;
    this.entries.set(e.id, e);
    this.seenIds.add(e.id);
    this.keyIndex.set(this.compositeKey(e.namespace, e.key), e.id);
    // Index in ONE backend, not both (Debt 8)
    if (e.embedding) {
      if (this.nativeDb) {
        const numId = this.assignNativeId(e.id);
        try {
          this.nativeDb.ingestBatch(new Float32Array(e.embedding), [numId]);
        } catch (err) {
          // ADR-0095 d5: InvalidChecksum from ingestBatch means the native
          // file's segment hashes no longer validate — further native ops
          // would keep lying. Degrade loudly, then fall through to the
          // pure-TS indexing branch via reIndexAfterDegrade.
          if (!this.degradeToFallbackMode('store', err) && this.config.verbose) {
            console.error('[RvfBackend] Native ingest failed:', (err as Error).message);
          }
          this.reIndexAfterDegrade(e.id, e.embedding);
        }
      } else if (this.hnswIndex) {
        this.hnswIndex.add(e.id, e.embedding);
      }
    }
    this.dirty = true;
    // Persist immediately so data survives process exit (the 30s auto-persist
    // timer may never fire in short-lived CLI invocations).
    await this.appendToWal(e);
    // ADR-0090 Tier A4 / B7 concurrent-write fix: always compact after
    // every store, not just when walCompactionThreshold (default 100) is
    // hit. Under concurrent CLI writers (the T3-2 acceptance scenario) the
    // process.exit(0) in @sparkleideas/cli's exit hook can fire BEFORE the
    // beforeExit-registered shutdownRouter, leaving writers B..F with
    // entries only in the WAL while writer A's lucky beforeExit rolled
    // .meta forward to entryCount=1. Compacting under the lock on every
    // store uses mergePeerStateBeforePersist() to merge every peer's
    // on-disk state + every peer's in-flight WAL entry into .meta, so
    // entryCount always reflects the current durable state across all
    // concurrent writers — not just this process's snapshot. The
    // compaction is already serialized by the advisory lock, so this
    // trades a marginal per-store latency cost for a disk header that is
    // always consistent with what `memory list` (or a fresh process)
    // would see via replayWal. Fail-loud on lock failure is preserved
    // because the compaction path still throws on lock starvation after
    // the 5s budget — no silent fallback was introduced.
    if (this.walPath) {
      await this.compactWal();
    }
  }

  async get(id: string): Promise<MemoryEntry | null> {
    this.noteNativeFallbackUse('get');
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    return entry;
  }

  async getByKey(namespace: string, key: string): Promise<MemoryEntry | null> {
    this.noteNativeFallbackUse('getByKey');
    const id = this.keyIndex.get(this.compositeKey(namespace, key));
    if (!id) return null;
    return this.get(id);
  }

  async update(id: string, updateData: MemoryEntryUpdate): Promise<MemoryEntry | null> {
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
    if (updated.embedding) {
      if (this.nativeDb) {
        const numId = this.assignNativeId(id);
        try {
          this.nativeDb.delete([numId]);
          this.nativeDb.ingestBatch(new Float32Array(updated.embedding), [numId]);
        } catch (err) {
          // ADR-0095 d5: checksum failure during update — degrade, then
          // re-apply via reIndexAfterDegrade (idempotent remove+add).
          if (!this.degradeToFallbackMode('update', err) && this.config.verbose) {
            console.error('[RvfBackend] Native update re-ingest failed:', (err as Error).message);
          }
          this.removeAfterDegrade(id);
          this.reIndexAfterDegrade(id, updated.embedding);
        }
      } else if (this.hnswIndex) {
        this.hnswIndex.remove(id);
        this.hnswIndex.add(id, updated.embedding);
      }
    }
    this.dirty = true;
    await this.appendToWal(updated);
    if (this.walEntryCount >= this.config.walCompactionThreshold) {
      await this.compactWal();
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
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
      try { await writeFile(this.walPath, Buffer.alloc(0)); } catch {}
      this.walEntryCount = 0;
    }
    await this.persistToDisk();
    this._capacityWarned = false;
    return true;
  }

  async query(q: MemoryQuery): Promise<MemoryEntry[]> {
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
    this.noteNativeFallbackUse('search');
    const start = performance.now();
    let results: SearchResult[];

    if (this.nativeDb) {
      // ADR-0094 Sprint 1.4 d8: rehydrate nativeReverseMap before the first
      // semantic search in this process. See `ensureNativeSemanticReady`.
      this.ensureNativeSemanticReady();
      // Native NAPI vector search — fast ANN lookup, then filter metadata
      try {
        const raw: Array<{ id: number; distance: number }> = this.nativeDb.query(
          new Float32Array(embedding), options.k * 2,
          { efSearch: this.config.hnswEfConstruction },
        );
        results = [];
        for (const r of raw) {
          const stringId = this.nativeReverseMap.get(r.id);
          if (!stringId) continue;
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
    this.checkCapacity(entries.length);
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
      this.seenIds.add(entry.id);
      this.keyIndex.set(this.compositeKey(entry.namespace, entry.key), entry.id);
      // Index in ONE backend, not both (Debt 8)
      if (entry.embedding) {
        if (this.nativeDb) {
          const numId = this.assignNativeId(entry.id);
          try {
            this.nativeDb.ingestBatch(new Float32Array(entry.embedding), [numId]);
          } catch (err) {
            // ADR-0095 d5: same degrade path used by store() — first
            // InvalidChecksum kills native for this process and re-routes
            // subsequent entries via reIndexAfterDegrade.
            if (!this.degradeToFallbackMode('bulkInsert', err) && this.config.verbose) {
              console.error('[RvfBackend] Native bulk ingest failed:', (err as Error).message);
            }
            this.reIndexAfterDegrade(entry.id, entry.embedding);
          }
        } else if (this.hnswIndex) {
          this.hnswIndex.add(entry.id, entry.embedding);
        }
      }
      await this.appendToWal(entry);
    }
    this.dirty = true;
    if (this.walEntryCount >= this.config.walCompactionThreshold) {
      await this.compactWal();
    }
  }

  async bulkDelete(ids: string[]): Promise<number> {
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
          // Only retry the transient LockHeld shape (0x0300). Every other
          // error falls through to the fatal/InvalidChecksum branch below.
          const msg = String(err?.message ?? err ?? '');
          const isLockHeld = msg.includes('0x0300') || /LockHeld/i.test(msg);
          if (!isLockHeld) break;
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
      throw new Error(
        `[RvfBackend] Native file at ${this.config.databasePath} has SFVR ` +
        `magic but RvfDatabase.open failed after ${attempt} attempt(s) over ` +
        `${Date.now() - openStartTime}ms (budget ${maxOpenWaitMs}ms): ` +
        `${lastErr?.message ?? lastErr}`,
      );
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
    if (fileOnDisk && peekBytesRead < 4) {
      throw new Error(
        `[RvfBackend] Native init refuses ${this.config.databasePath}: file ` +
        `exists but only ${peekBytesRead}/4 magic bytes present — peer ` +
        `RvfDatabase.create is mid-write. Retry once peer releases or ` +
        `inspect the file.`,
      );
    }

    const isRVFNull = peekStr === 'RVF\0';
    if (fileOnDisk && peekBytesRead === 4 && !isRVFNull) {
      // Not SFVR (that path returned earlier) and not RVF\0 — unknown magic.
      throw new Error(
        `[RvfBackend] Native init refuses ${this.config.databasePath}: ` +
        `unknown magic ${JSON.stringify(peekStr)} — not 'SFVR' (native) or ` +
        `'RVF\\0' (pure-TS). File is corrupt or from an unknown format.`,
      );
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
      return false;
    }

    // Truly cold start: file doesn't exist at all. Create a new native DB.
    try {
      this.nativeDb = rvf.RvfDatabase.create(this.config.databasePath, {
        dimension: this.config.dimensions,
        metric: nativeMetric,
        m: this.config.hnswM,
        efConstruction: this.config.hnswEfConstruction,
      });
      if (this.config.verbose) {
        console.log('[RvfBackend] Native @ruvector/rvf-node created new SFVR file');
      }
      return true;
    } catch (err: any) {
      const code = err?.code;
      // ENOENT on create = parent dir missing; benign cold-start race. Let
      // pure-TS handle it (it does its own mkdir recursively). Any other
      // error while we own a clean slate is fatal.
      if (code === 'ENOENT') {
        if (this.config.verbose) {
          console.log('[RvfBackend] Native create hit ENOENT (cold start race); using pure-TS fallback');
        }
        return false;
      }
      throw new Error(
        `[RvfBackend] Native RvfDatabase.create failed at ${this.config.databasePath} ` +
        `(code=${code ?? 'unknown'}): ${err?.message ?? err}`,
      );
    }
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
    if (!this.nativeFallbackMode || !embedding || !this.hnswIndex) return;
    const arr = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
    this.hnswIndex.add(id, arr);
  }

  /** ADR-0095 d5: analog of reIndexAfterDegrade for the update() remove step.
   *  Kept in its own method so update() body stays free of textual `hnswIndex`
   *  references in the native catch (preserving Debt-8 exclusivity check). */
  private removeAfterDegrade(id: string): void {
    if (!this.nativeFallbackMode || !this.hnswIndex) return;
    this.hnswIndex.remove(id);
  }

  /** ADR-0095 d5: downgrade this instance from native → pure-TS + .meta
   *  sidecar when a native runtime call (query/ingestBatch/delete) throws
   *  InvalidChecksum. Called from the native read/write catch sites. Idempotent:
   *  if already degraded, no-op. After degrade, callers fall through to the
   *  pure-TS branches of their respective code paths (HnswLite search, WAL
   *  append + .meta compact — see `metadataPath`).
   *
   *  The degrade is LOUD: one stderr line per invocation (no throttling —
   *  this is a first-time-transition event, not a per-use log). `noteNative
   *  FallbackUse` handles the throttled steady-state per-use logs. */
  private degradeToFallbackMode(via: string, err: unknown): boolean {
    const msg = String((err as any)?.message ?? err ?? '');
    const isInvalidChecksum = msg.includes('0x0102') || /InvalidChecksum/i.test(msg);
    if (!isInvalidChecksum) return false;
    if (!this.nativeFallbackMode) {
      // First transition — emit the loud degrade banner.
      console.error(
        `[RvfBackend] native ${via} threw InvalidChecksum (RVF 0x0102) at ` +
        `${this.config.databasePath} — degrading to pure-TS + .meta sidecar ` +
        `for the remainder of this process. Future writes compact to .meta; ` +
        `the corrupt native file is left intact for upstream recovery. ` +
        `Root cause: unlocked ingestBatch race (ADR-0095 d7).`,
      );
      this.nativeFallbackMode = true;
      // Also rehydrate HnswLite if we haven't already; otherwise pure-TS
      // semantic search has no index to consult and will return empty.
      // Vector fidelity is best-effort: entries loaded from .meta during
      // init have embeddings, so we rebuild from those.
      if (!this.hnswIndex) {
        this.hnswIndex = new HnswLite(
          this.config.dimensions,
          this.config.hnswM,
          this.config.hnswEfConstruction,
          this.config.metric,
        );
        for (const e of this.entries.values()) {
          if (e.embedding) this.hnswIndex.add(e.id, e.embedding);
        }
      }
    }
    // Close and drop the native handle — further native calls MUST NOT run
    // against a corrupt file (they'd produce the same 0x0102 again forever).
    if (this.nativeDb) {
      try { this.nativeDb.close(); } catch { /* native already broken */ }
      this.nativeDb = null;
    }
    return true;
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
    if (!this.nativeDb || this._nativeRehydrated) return;
    this._nativeRehydrated = true;
    if (this._pendingNativeIngest.length === 0) return;
    for (const { id, embedding } of this._pendingNativeIngest) {
      const numId = this.assignNativeId(id);
      try {
        this.nativeDb.ingestBatch(new Float32Array(embedding), [numId]);
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
  private async acquireLock(): Promise<void> {
    if (!this.lockPath) return; // :memory: mode
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
    const maxWaitMs = 5000; // total budget for lock acquisition
    const baseDelayMs = 20;
    const maxDelayMs = 500;
    const startTime = Date.now();
    let attempt = 0;
    while (Date.now() - startTime < maxWaitMs) {
      try {
        await wf(this.lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
        return; // Lock acquired
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        // Lock exists — check if holder is alive
        try {
          const content = await rf(this.lockPath, 'utf-8');
          const { pid, ts } = JSON.parse(content);
          const staleMs = 5000; // 5s stale threshold (CLI processes are short-lived)
          let pidAlive = true;
          try { process.kill(pid, 0); } catch { pidAlive = false; }
          if (!pidAlive || Date.now() - ts > staleMs) {
            try { await ul(this.lockPath); } catch {}
            continue; // Retry immediately after removing stale lock
          }
        } catch {
          try { await ul(this.lockPath); } catch {}
          continue; // Corrupt lock file — remove and retry
        }
        // Lock holder is alive — exponential backoff with jitter
        const expDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        const jitter = expDelay * 0.5 * Math.random();
        const delayMs = expDelay + jitter;
        await new Promise(r => setTimeout(r, delayMs));
        attempt++;
      }
    }
    throw new Error(
      `Failed to acquire advisory lock after ${attempt} attempts over ${Date.now() - startTime}ms (budget=${maxWaitMs}ms)`,
    );
  }

  /** Release advisory lock */
  private async releaseLock(): Promise<void> {
    if (!this.lockPath) return;
    try { await unlink(this.lockPath); } catch {}
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

  /** Append a single entry to the WAL sidecar file (O(1) per write) */
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
      await appendFile(this.walPath, Buffer.concat([lenBuf, json]));
    } finally {
      await this.releaseLock();
    }
    this.walEntryCount++;
  }

  /** Replay WAL entries into in-memory state (called after loadFromDisk) */
  private async replayWal(): Promise<void> {
    if (!this.walPath || !existsSync(this.walPath)) return;
    try {
      const raw = await readFile(this.walPath);
      let offset = 0;
      let count = 0;
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
          }
          count++;
        } catch {
          // Corrupt individual entry — skip and continue
        }
      }
      this.walEntryCount = count;
      if (this.config.verbose && count > 0) {
        console.log(`[RvfBackend] Replayed ${count} WAL entries`);
      }
    } catch (err) {
      if (this.config.verbose) {
        console.error('[RvfBackend] Error replaying WAL:', err);
      }
    }
  }

  /** Path for the custom-format metadata file. When native is active OR we
   *  fell back from a corrupt native file (d5), metadata goes to the `.meta`
   *  sidecar so we never overwrite the native binary file. In pure-cold
   *  pure-TS mode (no native file ever existed), metadata goes to the main
   *  path as before. */
  private get metadataPath(): string {
    return (this.nativeDb || this.nativeFallbackMode)
      ? this.config.databasePath + '.meta'
      : this.config.databasePath;
  }

  /** Compact WAL: rewrite main .rvf with all entries, then delete WAL */
  private async compactWal(): Promise<void> {
    if (this.persisting) return; // Another persist is in flight; retry on next trigger
    await this.acquireLock();
    try {
      await this.persistToDiskInner();
      if (this.walPath) {
        try { await unlink(this.walPath); } catch {}
      }
      this.walEntryCount = 0;
    } finally {
      await this.releaseLock();
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (this.config.databasePath === ':memory:') return;

    // Determine which file to load metadata from:
    // 1. Try the .meta sidecar (used when native DB owns the main path)
    // 2. Fall back to the main path (pre-native or native not active)
    // 3. If neither exists, skip main file load but STILL replay WAL
    //    (the WAL may contain entries from a prior process that exited
    //    before compaction — e.g. short-lived CLI invocations).
    const metaPath = this.config.databasePath + '.meta';
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
    if (loadFailed && this.entries.size === 0) {
      const err = new Error(
        `RVF storage at ${loadPath} is corrupt: ${loadFailReason}. ` +
        `No WAL recovery data available. Refusing to start with empty state ` +
        `to prevent silent overwrite of the corrupt file on next persist. ` +
        `Move or delete the file to start fresh, or restore from a backup.`,
      );
      err.name = 'RvfCorruptError';
      throw err;
    }
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
      } catch {
        // Read error — fall back to in-memory state. Worst case we repeat
        // the pre-fix behavior for this one persist; not a regression.
      }
    }

    // Step 2: replay the current WAL. It may contain un-compacted entries
    // from peer processes that called appendToWal but have not yet compacted.
    // replayWal() uses standard set() which gives chronological last-write-
    // wins, the correct ordering for concurrent appendToWal calls under the
    // advisory lock.
    if (this.walPath && existsSync(this.walPath)) {
      await this.replayWal();
    }
  }

  private async persistToDiskInner(): Promise<void> {
    if (this.persisting) return; // Prevent concurrent persist calls
    this.persisting = true;

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
    await writeFile(tmpPath, output);
    await rename(tmpPath, target);

    // fsync directory entry for power-crash durability (Debt 12)
    try {
      const { open } = await import('node:fs/promises');
      const dirHandle = await open(dir, 'r');
      await dirHandle.datasync();
      await dirHandle.close();
    } catch {} // Best-effort — not all platforms support dir fsync

    this.dirty = false;
    } finally {
      this.persisting = false;
    }
  }
}
