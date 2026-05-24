/**
 * EmbeddingPipeline — single embedding entry point (ADR-0076 Phase 2).
 *
 * Replaces 6 scattered embedding implementations with one class:
 *   1. memory-initializer.ts generateEmbedding()
 *   2. rvf-backend.ts brute-force cosineSimilarity (via hnsw-lite)
 *   3. controller-registry.ts createEmbeddingService()
 *   4. memory-bridge.ts cosineSim()
 *   5. hnsw-lite.ts cosineSimilarity()
 *   6. embedding-constants.ts (hooks/swarm/neural/guidance)
 *
 * Constructed once from ResolvedConfig, injected into every consumer.
 * Dimension mismatch fails loudly at startup and at every embed call.
 */

import type { ResolvedConfig } from './resolve-config.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DimensionMismatchError extends Error {
  constructor(expected: number, actual: number) {
    super(`Embedding dimension mismatch: expected ${expected}, got ${actual}`);
    this.name = 'DimensionMismatchError';
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity — canonical, dimension-strict (ADR-0076 A1)
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors.
 *
 * Accepts both Float32Array and number[] so callers from hnsw-lite (Float32Array)
 * and memory-bridge (number[]) can share one implementation.
 *
 * THROWS DimensionMismatchError when vector lengths differ. Never truncates,
 * never pads — mismatched dimensions indicate a configuration or data bug.
 */
export function cosineSimilarity(
  a: Float32Array | number[],
  b: Float32Array | number[],
): number {
  if (a.length !== b.length) {
    throw new DimensionMismatchError(a.length, b.length);
  }
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Hash-based fallback embedder — test-only fixture (ADR-0234)
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic embedding from text using character-level hashing.
 * Produces a unit-length vector of the requested dimension.
 *
 * This is NOT semantic. ADR-0234 (extends ADR-0095 amendment 2026-05-23 per
 * `feedback-no-fallbacks`) removes the silent fall-through to this function
 * from production paths — `_doInitialize` now throws when neither
 * `@xenova/transformers` nor `ruvector` is available, and `embedInternal`
 * no longer routes to `generateHashEmbedding` as a degraded provider. The
 * function is retained as an in-file fixture so unit tests can construct a
 * deterministic reference vector without spinning up a real model.
 *
 * @internal — production callsites cannot reach this; see `_doInitialize`.
 */
export function generateHashEmbedding(text: string, dimension: number): Float32Array {
  const embedding = new Float32Array(dimension);
  const words = text.toLowerCase().split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    for (let j = 0; j < word.length; j++) {
      const charCode = word.charCodeAt(j);
      const idx = (charCode * (i + 1) * (j + 1)) % dimension;
      embedding[idx] += Math.sin(charCode * 0.1) * 0.1;
    }
  }

  // Normalize to unit vector
  let mag = 0;
  for (let i = 0; i < dimension; i++) mag += embedding[i] * embedding[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < dimension; i++) embedding[i] /= mag;

  return embedding;
}

// ---------------------------------------------------------------------------
// EmbeddingPipeline
// ---------------------------------------------------------------------------

/** Configuration subset used by the pipeline (mirrors ResolvedConfig.embedding). */
export interface EmbeddingConfig {
  readonly model: string;
  readonly dimension: number;
  readonly provider: string;
}

export class EmbeddingPipeline {
  private readonly embeddingConfig: EmbeddingConfig;
  private model: any = null; // loaded model instance (pipeline function or embedder object)
  private initialized = false;
  // ADR-0234: 'hash-fallback' removed. `_doInitialize` throws when no real
  // provider is available; `provider` only ever becomes one of the two
  // real values after successful init. `'uninitialized'` is the only
  // pre-init state.
  private provider: 'transformers.js' | 'ruvector' | 'uninitialized' = 'uninitialized';

  constructor(config: EmbeddingConfig) {
    this.embeddingConfig = config;
  }

  /**
   * Load the embedding model. Tries providers in order:
   *   1. @xenova/transformers  (ONNX, highest quality)
   *   2. ruvector              (bundled MiniLM)
   *   3. hash-fallback         (deterministic, non-semantic)
   *
   * Validates dimension on a probe embedding to fail loudly at startup.
   */
  private _initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Serialize concurrent callers behind one initialization attempt
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInitialize();
    return this._initPromise;
  }

  private async _doInitialize(): Promise<void> {
    if (this.initialized) return;

    // Set TRANSFORMERS_CACHE to user-writable path (EM-002)
    if (!process.env.TRANSFORMERS_CACHE) {
      const os = await import('node:os');
      const path = await import('node:path');
      process.env.TRANSFORMERS_CACHE = path.join(os.homedir(), '.cache', 'transformers');
    }

    // Try 1: @xenova/transformers
    let transformersErr: unknown = null;
    try {
      const transformers = await import('@xenova/transformers');
      const { pipeline } = transformers;
      this.model = await pipeline('feature-extraction', this.embeddingConfig.model);
      this.provider = 'transformers.js';
    } catch (e: any) {
      transformersErr = e;
      // Try 2: ruvector
      try {
        const ruvector = await import('ruvector');
        if (ruvector && typeof (ruvector as any).embed === 'function') {
          this.model = ruvector;
          this.provider = 'ruvector';
        } else {
          // ADR-0234: ruvector imported but doesn't expose embed() — fail loud.
          throw new Error(
            'ruvector loaded but does not export an embed(text) function',
          );
        }
      } catch (e2: any) {
        // ADR-0234 (extends ADR-0095 amendment 2026-05-23 to sibling loaders
        // per feedback-no-fallbacks): neither @xenova/transformers nor
        // ruvector is available. The prior console.warn + silent hash
        // fallback in embedInternal made search quality degrade invisibly
        // (operators only noticed when recall dropped to ~0.05-0.28 on
        // mpnet-related queries — see ADR-0227). Surface as a labelled
        // throw so the deployment fact (missing embedding provider) is
        // visible at init time.
        const transformersMsg = (transformersErr as { message?: string })?.message ?? String(transformersErr);
        const ruvectorMsg = e2?.message ?? String(e2);
        throw new Error(
          `[embedding-pipeline] No embedding provider available. ` +
          `transformers.js failed: ${transformersMsg}. ` +
          `ruvector failed: ${ruvectorMsg}. ` +
          `Silent hash-fallback is removed (ADR-0234, extends ADR-0095 amendment 2026-05-23 per feedback-no-fallbacks). ` +
          `Install @xenova/transformers (preferred, ONNX) or ruvector (bundled MiniLM) to proceed.`,
        );
      }
    }

    // Validate dimension with a probe embedding
    const probe = await this.embedInternal('dimension probe');
    if (probe.length !== this.embeddingConfig.dimension) {
      throw new DimensionMismatchError(this.embeddingConfig.dimension, probe.length);
    }

    this.initialized = true;
    this._initPromise = null;
  }

  /**
   * Generate an embedding for the given text.
   *
   * @throws DimensionMismatchError if the produced embedding has a different
   *         length than the configured dimension.
   */
  async embed(text: string): Promise<Float32Array> {
    if (!this.initialized) {
      await this.initialize();
    }
    const embedding = await this.embedInternal(text);
    if (embedding.length !== this.embeddingConfig.dimension) {
      throw new DimensionMismatchError(this.embeddingConfig.dimension, embedding.length);
    }
    return embedding;
  }

  /** Configured dimension (e.g. 768). */
  getDimension(): number {
    return this.embeddingConfig.dimension;
  }

  /** Configured model name (e.g. "Xenova/all-mpnet-base-v2"). */
  getModel(): string {
    return this.embeddingConfig.model;
  }

  /** Which provider is actually active after initialize(). */
  getProvider(): string {
    return this.provider;
  }

  /** Whether initialize() has completed successfully. */
  isInitialized(): boolean {
    return this.initialized;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async embedInternal(text: string): Promise<Float32Array> {
    // ADR-0234: throw on provider failure rather than falling through to
    // generateHashEmbedding. _doInitialize guarantees `provider` is one of
    // the two real providers before embedInternal is reached; any error
    // from the real provider must surface, not be masked by a hash vector.

    // Transformers.js: pipeline returns { data: Float32Array }
    if (this.provider === 'transformers.js' && this.model) {
      const output = await this.model(text, { pooling: 'mean', normalize: true });
      if (output?.data) return new Float32Array(output.data);
      throw new Error(
        `[embedding-pipeline] transformers.js returned no data (ADR-0234, feedback-no-fallbacks).`,
      );
    }

    // ruvector: embed(text) returns Float32Array or number[]
    if (this.provider === 'ruvector' && this.model) {
      const result = await this.model.embed(text);
      if (result instanceof Float32Array) return result;
      if (Array.isArray(result)) return new Float32Array(result);
      throw new Error(
        `[embedding-pipeline] ruvector.embed returned unsupported shape ` +
        `(ADR-0234, feedback-no-fallbacks).`,
      );
    }

    // Should be unreachable: _doInitialize throws when no provider is
    // available, so `provider` is always one of the two above by the time
    // embedInternal runs. If we get here, something bypassed init.
    throw new Error(
      `[embedding-pipeline] embedInternal reached with no active provider ` +
      `(provider=${this.provider}; ADR-0234, feedback-no-fallbacks). ` +
      `Call initialize() before embed().`,
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let _pipeline: EmbeddingPipeline | null = null;

/** Return the current singleton, or null if not yet initialized. */
export function getPipeline(): EmbeddingPipeline | null {
  return _pipeline;
}

/**
 * Create and initialize the singleton pipeline from config.
 * Returns the existing instance if already initialized.
 */
let _initPromise: Promise<EmbeddingPipeline> | null = null;

export async function initPipeline(
  config: ResolvedConfig['embedding'],
): Promise<EmbeddingPipeline> {
  if (_pipeline) return _pipeline;
  // Serialize concurrent callers behind one initialization
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (_pipeline) return _pipeline;
    const p = new EmbeddingPipeline(config);
    await p.initialize();
    _pipeline = p;
    _initPromise = null;
    return p;
  })();
  return _initPromise;
}

/** Reset the singleton (for testing only). */
export function resetPipeline(): void {
  _pipeline = null;
}
