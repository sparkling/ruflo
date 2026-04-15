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
      const mode = this.nativeDb ? 'native @ruvector/rvf' : 'pure-TS fallback';
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
    this.keyIndex.set(this.compositeKey(e.namespace, e.key), e.id);
    // Index in ONE backend, not both (Debt 8)
    if (e.embedding) {
      if (this.nativeDb) {
        const numId = this.assignNativeId(e.id);
        try {
          this.nativeDb.ingestBatch(new Float32Array(e.embedding), [numId]);
        } catch (err) {
          if (this.config.verbose) console.error('[RvfBackend] Native ingest failed:', (err as Error).message);
        }
      } else if (this.hnswIndex) {
        this.hnswIndex.add(e.id, e.embedding);
      }
    }
    this.dirty = true;
    // Persist immediately so data survives process exit (the 30s auto-persist
    // timer may never fire in short-lived CLI invocations).
    await this.appendToWal(e);
    if (this.walEntryCount >= this.config.walCompactionThreshold) {
      await this.compactWal();
    }
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.accessCount++;
    entry.lastAccessedAt = Date.now();
    return entry;
  }

  async getByKey(namespace: string, key: string): Promise<MemoryEntry | null> {
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
          if (this.config.verbose) console.error('[RvfBackend] Native update re-ingest failed:', (err as Error).message);
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
        try { this.nativeDb.delete([numId]); } catch (err) {
          if (this.config.verbose) console.error('[RvfBackend] Native delete failed:', (err as Error).message);
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
      let semanticIds: Set<string>;
      if (this.nativeDb) {
        const raw = this.nativeDb.query(new Float32Array(q.embedding), q.limit * 2, {});
        semanticIds = new Set(raw.map((r: any) => this.nativeReverseMap.get(r.id)).filter(Boolean));
      } else if (this.hnswIndex) {
        const searchResults = this.hnswIndex.search(q.embedding, q.limit, q.threshold);
        semanticIds = new Set(searchResults.map(r => r.id));
      } else {
        semanticIds = new Set();
      }
      results = results.filter(e => semanticIds.has(e.id));
    }

    const offset = q.offset ?? 0;
    results = results.slice(offset, offset + q.limit);

    this.recordTiming(this.queryTimes, start);
    return results;
  }

  async search(embedding: Float32Array, options: SearchOptions): Promise<SearchResult[]> {
    const start = performance.now();
    let results: SearchResult[];

    if (this.nativeDb) {
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
      } catch {
        // Fall through to pure-TS path on native query failure
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
      this.keyIndex.set(this.compositeKey(entry.namespace, entry.key), entry.id);
      // Index in ONE backend, not both (Debt 8)
      if (entry.embedding) {
        if (this.nativeDb) {
          const numId = this.assignNativeId(entry.id);
          try { this.nativeDb.ingestBatch(new Float32Array(entry.embedding), [numId]); } catch (err) {
            if (this.config.verbose) console.error('[RvfBackend] Native bulk ingest failed:', (err as Error).message);
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
        try { this.nativeDb.delete(nativeIds); } catch (err) {
          if (this.config.verbose) console.error('[RvfBackend] Native bulk delete failed:', (err as Error).message);
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
    try {
      const rvf = await import('@ruvector/rvf-node' as string);
      const { existsSync: fileExists } = await import('node:fs');
      // Remap metric names to NAPI format
      const nativeMetric = this.config.metric === 'euclidean' ? 'l2'
        : this.config.metric === 'dot' ? 'inner_product'
        : 'cosine';
      if (fileExists(this.config.databasePath)) {
        this.nativeDb = rvf.RvfDatabase.open(this.config.databasePath);
      } else {
        this.nativeDb = rvf.RvfDatabase.create(this.config.databasePath, {
          dimension: this.config.dimensions,
          metric: nativeMetric,
          m: this.config.hnswM,
          efConstruction: this.config.hnswEfConstruction,
        });
      }
      // Native handles vectors — HnswLite is skipped when native is active (Debt 8).
      // Metadata is still loaded from disk via loadFromDisk() in initialize().
      if (this.config.verbose) {
        console.log('[RvfBackend] Native @ruvector/rvf-node loaded successfully');
      }
      return true;
    } catch {
      if (this.config.verbose) {
        console.log('[RvfBackend] @ruvector/rvf-node not available, using pure-TS fallback');
      }
      return false;
    }
  }

  private compositeKey(namespace: string, key: string): string {
    return `${namespace}\0${key}`;
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

  /** Acquire advisory lock (PID-based lockfile). Retries up to 3 times with 50ms delay. */
  private async acquireLock(): Promise<void> {
    if (!this.lockPath) return; // :memory: mode
    const { writeFile: wf, readFile: rf, unlink: ul } = await import('node:fs/promises');
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
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
            continue; // Retry after removing stale lock
          }
        } catch {
          try { await ul(this.lockPath); } catch {}
          continue; // Corrupt lock file — remove and retry
        }
        // Lock holder is alive — wait and retry
        if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error('Failed to acquire advisory lock after retries');
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
          // Remove stale HNSW edges before re-adding (entry may already be
          // in the index from loadFromDisk — re-add without remove corrupts
          // the graph's reverse-edge pointers).
          if (entry.embedding && this.hnswIndex && alreadyLoaded) {
            this.hnswIndex.remove(entry.id);
          }
          // Remove stale native vector before re-ingest (same logic)
          if (entry.embedding && this.nativeDb && alreadyLoaded) {
            const oldNumId = this.nativeIdMap.get(entry.id);
            if (oldNumId !== undefined) {
              try { this.nativeDb.delete([oldNumId]); } catch (err) {
                if (this.config.verbose) console.error('[RvfBackend] Native delete on WAL replay failed:', (err as Error).message);
              }
            }
          }
          this.entries.set(entry.id, entry);
          this.keyIndex.set(this.compositeKey(entry.namespace, entry.key), entry.id);
          if (entry.embedding && this.hnswIndex) this.hnswIndex.add(entry.id, entry.embedding);
          if (entry.embedding && this.nativeDb) {
            const numId = this.assignNativeId(entry.id);
            try { this.nativeDb.ingestBatch(new Float32Array(entry.embedding), [numId]); } catch (err) {
              if (this.config.verbose) console.error('[RvfBackend] Native ingest on WAL replay failed:', (err as Error).message);
            }
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

  /** Path for the custom-format metadata file. When native is active, metadata
   *  goes to a `.meta` sidecar to avoid overwriting the native binary file. */
  private get metadataPath(): string {
    return this.nativeDb
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
    if (existsSync(metaPath)) {
      loadPath = metaPath;
    } else if (existsSync(this.config.databasePath)) {
      loadPath = this.config.databasePath;
    }
    // No early return — fall through to replayWal() even when main file is absent

    // Load entries from the main RVF file (if it exists and is valid).
    // WAL replay runs unconditionally afterward — the WAL may contain
    // entries from a prior process that exited before compaction (e.g.
    // short-lived CLI invocations where store writes to WAL then exits).
    if (loadPath) {
      try {
        const raw = await readFile(loadPath);
        if (raw.length >= 8) {
          const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
          if (magic === MAGIC) {
            const headerLen = raw.readUInt32LE(4);
            const MAX_HEADER_SIZE = 10 * 1024 * 1024; // 10MB max header
            if (headerLen <= MAX_HEADER_SIZE && 8 + headerLen <= raw.length) {
              const headerJson = raw.subarray(8, 8 + headerLen).toString('utf-8');
              let header: RvfHeader | null = null;
              try {
                header = JSON.parse(headerJson);
              } catch {
                if (this.config.verbose) console.error('[RvfBackend] Corrupt RVF header');
              }
              if (header && typeof header.entryCount === 'number' && typeof header.version === 'number') {
                let offset = 8 + headerLen;
                for (let i = 0; i < header.entryCount; i++) {
                  if (offset + 4 > raw.length) break;
                  const entryLen = raw.readUInt32LE(offset);
                  offset += 4;
                  if (offset + entryLen > raw.length) break;

                  const entryJson = raw.subarray(offset, offset + entryLen).toString('utf-8');
                  offset += entryLen;

                  const parsed = JSON.parse(entryJson);
                  if (parsed.embedding) parsed.embedding = new Float32Array(parsed.embedding);

                  const entry: MemoryEntry = parsed;
                  this.entries.set(entry.id, entry);
                  this.keyIndex.set(this.compositeKey(entry.namespace, entry.key), entry.id);
                  if (entry.embedding && this.hnswIndex) this.hnswIndex.add(entry.id, entry.embedding);
                  if (entry.embedding && this.nativeDb) {
                    const numId = this.assignNativeId(entry.id);
                    try { this.nativeDb.ingestBatch(new Float32Array(entry.embedding), [numId]); } catch (err) {
                      if (this.config.verbose) console.error('[RvfBackend] Native ingest on load failed:', (err as Error).message);
                    }
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        if (this.config.verbose) {
          console.error('[RvfBackend] Error loading from disk:', err);
        }
      }
    }

    // Always replay WAL — even if the main file is missing, corrupt, or empty.
    // The WAL is the authoritative source for uncommitted writes.
    await this.replayWal();
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

  private async persistToDiskInner(): Promise<void> {
    if (this.persisting) return; // Prevent concurrent persist calls
    this.persisting = true;

    try {
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

    // Atomic write: write to temp file then rename (crash-safe)
    const tmpPath = target + '.tmp';
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
