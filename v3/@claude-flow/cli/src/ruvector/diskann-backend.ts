/**
 * DiskANN Vector Search Backend
 *
 * SSD-friendly approximate nearest neighbor search using Vamana graph.
 *
 * ADR-0234: fork diverges from upstream (which ships a silent three-tier
 * cascade `diskann → hnsw → cosine-js` by design — see ADR-0234 §Check 2
 * site 2; verified byte-identical with `ruvnet/ruflo` at 2026-05-24). Per
 * `feedback-no-fallbacks`, the silent cascade is replaced by fail-loud
 * throws at each loader boundary. `createJsFallbackIndex` is preserved as
 * a test-only helper (unreachable from `getDiskAnnIndex` production path).
 * INTEGRATION-LEDGER: this fork patch is a perpetual merge tax — sync
 * agents preserve the throws via the labelled `{code, path, adr}` shape.
 *
 * @module v3/cli/ruvector/diskann-backend
 */

import { throwLoaderUnavailable } from './loader-errors.js';

// ===== Types =====

export interface DiskAnnConfig {
  dim: number;
  maxDegree?: number;
  buildBeam?: number;
  searchBeam?: number;
  alpha?: number;
  pqSubspaces?: number;
  storagePath?: string;
}

export interface SearchResult {
  id: string;
  distance: number;
  score: number; // Converted to similarity (1 / (1 + distance))
}

export type VectorBackend = 'diskann' | 'hnsw' | 'cosine-js';

// ===== Lazy loading =====

let diskannInstance: any = null;
let diskannAvailable: boolean | null = null;
let activeBackend: VectorBackend = 'cosine-js';

/**
 * Check if @ruvector/diskann is available.
 *
 * ADR-0234: this remains a non-throwing probe — callers use it to branch
 * BEFORE invoking `getDiskAnnIndex`. The throw happens at `getDiskAnnIndex`
 * (the loader boundary) so a missing binding cannot silently degrade the
 * runtime backend tier.
 */
export async function isDiskAnnAvailable(): Promise<boolean> {
  if (diskannAvailable !== null) return diskannAvailable;
  try {
    const { createRequire } = await import('module');
    const require2 = createRequire(import.meta.url);
    const mod = require2('@ruvector/diskann');
    diskannAvailable = typeof mod.DiskAnn === 'function';
    return diskannAvailable;
  } catch {
    diskannAvailable = false;
    return false;
  }
}

/**
 * Create or get a DiskANN index instance.
 *
 * ADR-0234: fork diverges from upstream (which ships silent cascade by
 * design). Throws via `throwLoaderUnavailable` at each missing tier rather
 * than falling through. The three throw shapes share the labelled
 * `{code, path, adr: 'ADR-0234'}` template (per F-06-002 cross-cutting
 * observation 3) so sync agents can preserve them mechanically.
 */
export async function getDiskAnnIndex(config: DiskAnnConfig): Promise<{
  index: any;
  backend: VectorBackend;
}> {
  if (diskannInstance) return { index: diskannInstance, backend: activeBackend };

  // Tier 1: DiskANN
  if (await isDiskAnnAvailable()) {
    let DiskAnn: any;
    try {
      const { createRequire } = await import('module');
      const require2 = createRequire(import.meta.url);
      DiskAnn = require2('@ruvector/diskann').DiskAnn;
    } catch (err) {
      // ADR-0234: probe said available but require failed — surface it.
      throwLoaderUnavailable(
        'DISKANN_TIER_UNAVAILABLE',
        '@ruvector/diskann',
        'DiskANN binding probe succeeded but require() failed. Re-install @ruvector/diskann.',
        err,
      );
    }

    const index = new DiskAnn({
      dim: config.dim,
      maxDegree: config.maxDegree ?? 64,
      buildBeam: config.buildBeam ?? 128,
      searchBeam: config.searchBeam ?? 64,
      alpha: config.alpha ?? 1.2,
      pqSubspaces: config.pqSubspaces ?? 0,
      storagePath: config.storagePath,
    });

    diskannInstance = index;
    activeBackend = 'diskann';
    return { index, backend: 'diskann' };
  }

  // Tier 2: HNSW (@ruvector/router VectorDb)
  let router: any;
  try {
    const { createRequire } = await import('module');
    const require2 = createRequire(import.meta.url);
    router = require2('@ruvector/router');
  } catch (err) {
    // ADR-0234: no diskann + no router → fail loud; do NOT fall through to
    // pure-JS cosine. Pure-JS is a test fixture, not a production tier.
    throwLoaderUnavailable(
      'HNSW_TIER_UNAVAILABLE',
      '@ruvector/router',
      'Neither @ruvector/diskann nor @ruvector/router is installed. Install one to enable vector search.',
      err,
    );
  }
  if (router.VectorDb && router.DistanceMetric) {
    const index = new router.VectorDb({
      dimensions: config.dim,
      distanceMetric: router.DistanceMetric.Cosine,
      hnswM: 16,
      hnswEfConstruction: 200,
      hnswEfSearch: 100,
    });
    diskannInstance = index;
    activeBackend = 'hnsw';
    return { index, backend: 'hnsw' };
  }

  // ADR-0234: router import succeeded but expected exports missing → fail
  // loud. The pure-JS fallback below is reserved for tests; production
  // callers cannot silently land on it.
  throwLoaderUnavailable(
    'PURE_JS_DISALLOWED',
    '@ruvector/router#VectorDb',
    '@ruvector/router loaded but does not export VectorDb/DistanceMetric. Verify the package version.',
  );
}

/**
 * Get the active backend name
 */
export function getActiveBackend(): VectorBackend {
  return activeBackend;
}

/**
 * Reset the index (for testing)
 */
export function resetIndex(): void {
  diskannInstance = null;
  diskannAvailable = null;
  activeBackend = 'cosine-js';
}

// ===== Unified search interface =====

/**
 * Insert a vector into the active backend
 */
export async function insertVector(
  id: string,
  vector: Float32Array,
  config: DiskAnnConfig = { dim: 384 }
): Promise<{ backend: VectorBackend }> {
  const { index, backend } = await getDiskAnnIndex(config);

  if (backend === 'diskann') {
    index.insert(id, vector);
  } else if (backend === 'hnsw') {
    index.insert(id, vector);
  } else {
    index.insert(id, vector);
  }

  return { backend };
}

/**
 * Build the index (required for DiskANN before search)
 */
export async function buildIndex(config: DiskAnnConfig = { dim: 384 }): Promise<void> {
  const { index, backend } = await getDiskAnnIndex(config);
  if (backend === 'diskann' && typeof index.build === 'function') {
    index.build();
  }
  // HNSW and JS fallback don't need explicit build
}

/**
 * Search for k nearest neighbors
 */
export async function searchVectors(
  query: Float32Array,
  k: number,
  config: DiskAnnConfig = { dim: 384 }
): Promise<SearchResult[]> {
  const { index, backend } = await getDiskAnnIndex(config);

  if (backend === 'diskann') {
    const results = index.search(query, k);
    return results.map((r: any) => ({
      id: r.id,
      distance: r.distance,
      score: 1 / (1 + r.distance), // Convert L2 distance to similarity
    }));
  }

  if (backend === 'hnsw') {
    const results = index.search(query, k);
    return results.map((r: any) => ({
      id: r.id,
      distance: r.score, // VectorDb returns distance as 'score'
      score: 1 / (1 + r.score),
    }));
  }

  // JS fallback
  return index.search(query, k);
}

// ===== Pure JS fallback — test-only fixture (ADR-0234) =====
// Retained so `benchmark()` can compare backends and tests can construct a
// brute-force reference impl; `getDiskAnnIndex` no longer falls back here in
// production (throws via `throwLoaderUnavailable` when neither
// @ruvector/diskann nor @ruvector/router is installed).

function createJsFallbackIndex(dim: number) {
  const vectors = new Map<string, Float32Array>();

  return {
    insert(id: string, vector: Float32Array): void {
      vectors.set(id, new Float32Array(vector));
    },
    search(query: Float32Array, k: number): SearchResult[] {
      const results: SearchResult[] = [];
      for (const [id, vec] of vectors) {
        let dot = 0, normQ = 0, normV = 0;
        for (let i = 0; i < dim; i++) {
          dot += query[i] * vec[i];
          normQ += query[i] * query[i];
          normV += vec[i] * vec[i];
        }
        const cosine = dot / (Math.sqrt(normQ) * Math.sqrt(normV) || 1);
        const distance = 1 - cosine;
        results.push({ id, distance, score: cosine });
      }
      return results.sort((a, b) => a.distance - b.distance).slice(0, k);
    },
    count(): number { return vectors.size; },
    delete(id: string): boolean { return vectors.delete(id); },
    build(): void { /* no-op */ },
  };
}

// ===== Benchmark utility =====

export interface BenchmarkResult {
  backend: VectorBackend;
  dim: number;
  vectorCount: number;
  insertTimeMs: number;
  buildTimeMs: number;
  searchTimeMs: number;
  searchesPerSecond: number;
  recall: number; // vs brute force
  memoryMB: number;
}

/**
 * Run a benchmark comparing available backends
 */
export async function benchmark(opts: {
  dim?: number;
  vectorCount?: number;
  k?: number;
  queries?: number;
} = {}): Promise<BenchmarkResult[]> {
  const dim = opts.dim ?? 384;
  const n = opts.vectorCount ?? 1000;
  const k = opts.k ?? 10;
  const queryCount = opts.queries ?? 100;
  const results: BenchmarkResult[] = [];

  // Generate random vectors
  const vectors: Array<[string, Float32Array]> = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dim);
    for (let j = 0; j < dim; j++) v[j] = Math.random() * 2 - 1;
    // Normalize
    let norm = 0;
    for (let j = 0; j < dim; j++) norm += v[j] * v[j];
    norm = Math.sqrt(norm);
    for (let j = 0; j < dim; j++) v[j] /= norm;
    vectors.push([`vec-${i}`, v]);
  }

  // Generate query vectors
  const queries: Float32Array[] = [];
  for (let i = 0; i < queryCount; i++) {
    const q = new Float32Array(dim);
    for (let j = 0; j < dim; j++) q[j] = Math.random() * 2 - 1;
    let norm = 0;
    for (let j = 0; j < dim; j++) norm += q[j] * q[j];
    norm = Math.sqrt(norm);
    for (let j = 0; j < dim; j++) q[j] /= norm;
    queries.push(q);
  }

  // Brute force ground truth
  function bruteForceSearch(query: Float32Array): string[] {
    const scores: Array<{ id: string; dist: number }> = [];
    for (const [id, vec] of vectors) {
      let dist = 0;
      for (let j = 0; j < dim; j++) {
        const d = query[j] - vec[j];
        dist += d * d;
      }
      scores.push({ id, dist });
    }
    scores.sort((a, b) => a.dist - b.dist);
    return scores.slice(0, k).map(s => s.id);
  }

  const groundTruth = queries.map(q => bruteForceSearch(q));

  // Test each available backend
  for (const backendName of ['diskann', 'hnsw', 'cosine-js'] as VectorBackend[]) {
    resetIndex();

    try {
      let index: any;
      const memBefore = process.memoryUsage().heapUsed;

      if (backendName === 'diskann') {
        if (!(await isDiskAnnAvailable())) continue;
        const { createRequire } = await import('module');
        const require2 = createRequire(import.meta.url);
        const { DiskAnn } = require2('@ruvector/diskann');
        index = new DiskAnn({ dim, maxDegree: 64, buildBeam: 128, searchBeam: 64 });
      } else if (backendName === 'hnsw') {
        try {
          const { createRequire } = await import('module');
          const require2 = createRequire(import.meta.url);
          const router = require2('@ruvector/router');
          if (!router.VectorDb) continue;
          index = new router.VectorDb({ dimensions: dim, distanceMetric: router.DistanceMetric.Cosine });
        } catch { continue; }
      } else {
        index = createJsFallbackIndex(dim);
      }

      // Insert
      const insertStart = performance.now();
      for (const [id, vec] of vectors) {
        index.insert(id, vec);
      }
      const insertTime = performance.now() - insertStart;

      // Build
      const buildStart = performance.now();
      if (typeof index.build === 'function') index.build();
      const buildTime = performance.now() - buildStart;

      // Search
      const searchStart = performance.now();
      const searchResults: string[][] = [];
      for (const q of queries) {
        const r = index.search(q, k);
        searchResults.push(r.map((x: any) => x.id));
      }
      const searchTime = performance.now() - searchStart;

      // Recall vs ground truth
      let totalRecall = 0;
      for (let i = 0; i < queryCount; i++) {
        const truth = new Set(groundTruth[i]);
        const found = searchResults[i].filter(id => truth.has(id)).length;
        totalRecall += found / k;
      }
      const recall = totalRecall / queryCount;

      const memAfter = process.memoryUsage().heapUsed;

      results.push({
        backend: backendName,
        dim,
        vectorCount: n,
        insertTimeMs: Math.round(insertTime * 100) / 100,
        buildTimeMs: Math.round(buildTime * 100) / 100,
        searchTimeMs: Math.round(searchTime * 100) / 100,
        searchesPerSecond: Math.round(queryCount / (searchTime / 1000)),
        recall: Math.round(recall * 1000) / 1000,
        memoryMB: Math.round((memAfter - memBefore) / 1024 / 1024 * 100) / 100,
      });
    } catch {
      // Backend failed, skip
    }
  }

  resetIndex();
  return results;
}
