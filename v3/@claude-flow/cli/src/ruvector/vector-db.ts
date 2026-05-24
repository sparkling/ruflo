/**
 * Vector Database Module
 *
 * Provides ruvector WASM-accelerated vector operations for:
 * - Semantic similarity search
 * - HNSW indexing (150x faster)
 * - Embedding generation
 *
 * ADR-0234 (extends ADR-0095 amendment 2026-05-23 per feedback-no-fallbacks):
 * fails loud at the loader boundary when ruvector is not installed; the prior
 * silent hash-stretched-sine fallback (FallbackVectorDB / generateHashEmbedding
 * in production paths) is removed. `generateHashEmbedding` is retained in-file
 * as a test-only fixture (callable from `__tests__/`); no production callsite
 * may reach it.
 *
 * Created with love by ruv.io
 */
import { throwLoaderUnavailable } from './loader-errors.js';

// ============================================================================
// Types
// ============================================================================

export interface VectorDB {
  insert(embedding: Float32Array, id: string, metadata?: Record<string, unknown>): void | Promise<void>;
  search(query: Float32Array, k?: number): Array<{ id: string; score: number; metadata?: Record<string, unknown> }> | Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>>;
  remove(id: string): boolean | Promise<boolean>;
  size(): number | Promise<number>;
  clear(): void | Promise<void>;
}

// ADR-0072: EMBEDDING_DIM removed (ADR-0052 superseded); 768 = all-mpnet-base-v2 output
const EMBEDDING_DIM = 768;

export interface RuVectorModule {
  createVectorDB(dimensions: number): Promise<VectorDB>;
  generateEmbedding(text: string, dimensions?: number): Float32Array;
  cosineSimilarity(a: Float32Array, b: Float32Array): number;
  isWASMAccelerated(): boolean;
}

// ============================================================================
// FallbackVectorDB — test-only fixture (ADR-0234)
// ============================================================================
// Retained as an in-file class so unit tests can construct a brute-force
// reference impl when needed; production paths cannot reach it (createVectorDB
// throws on missing ruvector per ADR-0234 / feedback-no-fallbacks).

class FallbackVectorDB implements VectorDB {
  private vectors: Map<string, { embedding: Float32Array; metadata?: Record<string, unknown> }> = new Map();
  private dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  insert(embedding: Float32Array, id: string, metadata?: Record<string, unknown>): void {
    this.vectors.set(id, { embedding, metadata });
  }

  search(query: Float32Array, k: number = 10): Array<{ id: string; score: number; metadata?: Record<string, unknown> }> {
    const results: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> = [];

    for (const [id, { embedding, metadata }] of this.vectors) {
      const score = cosineSimilarity(query, embedding);
      results.push({ id, score, metadata });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  remove(id: string): boolean {
    return this.vectors.delete(id);
  }

  size(): number {
    return this.vectors.size;
  }

  clear(): void {
    this.vectors.clear();
  }
}

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Generate a simple hash-based embedding.
 *
 * ADR-0234: retained ONLY as a test-only fixture. Per `feedback-no-fallbacks`,
 * production callsites must not reach this — they go through `loadRuVector` /
 * `createVectorDB` / `generateEmbedding` which now throw via
 * `throwLoaderUnavailable` when ruvector is missing. Exported so tests in
 * `__tests__/` can still import the deterministic-hash fixture they relied on
 * before the loader cascade was made fail-loud.
 *
 * @internal
 */
export function generateHashEmbedding(text: string, dimensions: number = EMBEDDING_DIM): Float32Array {
  const embedding = new Float32Array(dimensions);
  const normalized = text.toLowerCase().trim();

  // Simple hash function
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }

  // Generate pseudo-random embedding based on hash
  for (let i = 0; i < dimensions; i++) {
    embedding[i] = Math.sin(hash * (i + 1) * 0.001) * 0.5 + 0.5;
  }

  // Normalize
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dimensions; i++) {
    embedding[i] /= norm;
  }

  return embedding;
}

// ============================================================================
// Module State
// ============================================================================

let ruvectorModule: RuVectorModule | null = null;
let loadAttempted = false;
let isAvailable = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * Attempt to load the ruvector module.
 *
 * ADR-0234: throws on import failure or absent VectorDB export. Returns true
 * only on a fully-resolved live binding; never returns false (would mask a
 * deployment fact behind a silent boolean). Idempotent — repeated calls after
 * a successful load short-circuit to `true`.
 */
export async function loadRuVector(): Promise<boolean> {
  if (loadAttempted) {
    if (isAvailable) return true;
    // Re-throw on every call so callers can't silently degrade past an
    // earlier failed load attempt.
    throwLoaderUnavailable(
      'RUVECTOR_UNAVAILABLE',
      'ruvector',
      'Install ruvector (or @ruvector/*) and retry. The previous load attempt failed; restart the process after install.',
    );
  }

  loadAttempted = true;

  let ruvector: any;
  try {
    // Dynamic import — throws are surfaced (no silent .catch(() => null)).
    ruvector = await import('ruvector');
  } catch (err) {
    isAvailable = false;
    throwLoaderUnavailable(
      'RUVECTOR_UNAVAILABLE',
      'ruvector',
      'Install ruvector (or the @ruvector/* native binding) to enable vector search.',
      err,
    );
  }

  // ruvector exports VectorDB class, not createVectorDB function
  if (ruvector && (typeof ruvector.VectorDB === 'function' || typeof ruvector.VectorDb === 'function')) {
    // Create adapter module that matches our expected interface
    const VectorDBClass = ruvector.VectorDB || ruvector.VectorDb;
    ruvectorModule = {
      createVectorDB: async (dimensions: number): Promise<VectorDB> => {
        const db = new VectorDBClass({ dimensions });
        // Wrap ruvector's VectorDB to match our interface
        return {
          insert: (embedding: Float32Array, id: string, metadata?: Record<string, unknown>) => {
            db.insert({ id, vector: embedding, metadata });
          },
          search: async (query: Float32Array, k: number = 10) => {
            const results = await db.search({ vector: query, k });
            return results.map((r: any) => ({
              id: r.id,
              score: r.score,
              metadata: r.metadata,
            }));
          },
          remove: (id: string) => {
            db.delete(id);
            return true;
          },
          size: async () => {
            const len = await db.len();
            return len;
          },
          clear: () => {
            // Not directly supported - would need to recreate
          },
        } as VectorDB;
      },
      generateEmbedding: (text: string, dimensions: number = EMBEDDING_DIM): Float32Array => {
        // Native ruvector binding may not expose `embed`; surface that as a
        // load failure rather than substituting a hash fixture in production.
        if (typeof (ruvector as any).embed === 'function') {
          const result = (ruvector as any).embed(text, dimensions);
          if (result instanceof Float32Array) return result;
          if (Array.isArray(result)) return new Float32Array(result);
        }
        throwLoaderUnavailable(
          'RUVECTOR_UNAVAILABLE',
          'ruvector#embed',
          'Installed ruvector binding does not expose a text-embedding API. Upgrade to a build that exports `embed(text, dims)`.',
        );
      },
      cosineSimilarity: (a: Float32Array, b: Float32Array): number => {
        return cosineSimilarity(a, b);
      },
      isWASMAccelerated: (): boolean => {
        return ruvector.isWasm?.() ?? false;
      },
    };
    isAvailable = true;
    return true;
  }

  // Import succeeded but the expected VectorDB class is missing.
  isAvailable = false;
  throwLoaderUnavailable(
    'RUVECTOR_UNAVAILABLE',
    'ruvector#VectorDB',
    'Installed ruvector package does not export VectorDB/VectorDb. Verify the binding version.',
  );
}

/**
 * Check if ruvector is available
 */
export function isRuVectorAvailable(): boolean {
  return isAvailable;
}

/**
 * Check if WASM acceleration is enabled
 */
export function isWASMAccelerated(): boolean {
  if (ruvectorModule && typeof ruvectorModule.isWASMAccelerated === 'function') {
    return ruvectorModule.isWASMAccelerated();
  }
  return false;
}

/**
 * Create a vector database.
 *
 * ADR-0234: uses ruvector HNSW (throws if unavailable). The prior silent
 * fallback to `FallbackVectorDB` is removed; missing-binding now surfaces
 * as a labelled error per `feedback-no-fallbacks`. `FallbackVectorDB`
 * remains in-file as a test-only fixture.
 */
export async function createVectorDB(dimensions: number = EMBEDDING_DIM): Promise<VectorDB> {
  await loadRuVector();

  if (ruvectorModule && typeof ruvectorModule.createVectorDB === 'function') {
    return await ruvectorModule.createVectorDB(dimensions);
  }

  // loadRuVector() already throws on absence; defense-in-depth in case the
  // module shape mutates after the load gate passes.
  throwLoaderUnavailable(
    'RUVECTOR_UNAVAILABLE',
    'ruvector#createVectorDB',
    'ruvector loaded but createVectorDB factory unavailable.',
  );
}

/**
 * Generate an embedding for text.
 *
 * ADR-0234: routes through the loaded ruvector binding (throws if
 * unavailable). The prior silent fall-through to `generateHashEmbedding`
 * is removed; production callsites cannot reach the hash fixture.
 */
export function generateEmbedding(text: string, dimensions: number = EMBEDDING_DIM): Float32Array {
  if (ruvectorModule && typeof ruvectorModule.generateEmbedding === 'function') {
    return ruvectorModule.generateEmbedding(text, dimensions);
  }

  // Module not loaded — call sites must call loadRuVector() first (which
  // throws on missing binding) so this state is only reachable when the
  // module was loaded but then unloaded.
  throwLoaderUnavailable(
    'RUVECTOR_UNAVAILABLE',
    'ruvector#generateEmbedding',
    'Call loadRuVector() before generateEmbedding() and install ruvector if not present.',
  );
}

/**
 * Compute cosine similarity between two vectors.
 *
 * The pure-JS `cosineSimilarity` path is mathematically equivalent to the
 * native binding and is NOT a degraded fallback — ADR-0234 only governs
 * loader cascades that change the SEMANTIC surface (embedding provider,
 * search backend). Cosine similarity over a known pair of vectors is
 * deterministic across runtimes.
 */
export function computeSimilarity(a: Float32Array, b: Float32Array): number {
  if (ruvectorModule && typeof ruvectorModule.cosineSimilarity === 'function') {
    try {
      return ruvectorModule.cosineSimilarity(a, b);
    } catch {
      // Pure-JS cosine is mathematically equivalent; keep this path.
    }
  }

  return cosineSimilarity(a, b);
}

/**
 * Get status information about the ruvector module.
 *
 * ADR-0234: `backend: 'fallback'` is removed from the return shape — there
 * is no fallback any more. When `available === false`, callers must treat
 * subsequent ruvector calls as throwing.
 */
export function getStatus(): {
  available: boolean;
  wasmAccelerated: boolean;
  backend: 'ruvector-wasm' | 'ruvector' | 'unavailable';
} {
  if (!isAvailable) {
    return {
      available: false,
      wasmAccelerated: false,
      backend: 'unavailable',
    };
  }

  const wasmAccelerated = isWASMAccelerated();
  return {
    available: true,
    wasmAccelerated,
    backend: wasmAccelerated ? 'ruvector-wasm' : 'ruvector',
  };
}
