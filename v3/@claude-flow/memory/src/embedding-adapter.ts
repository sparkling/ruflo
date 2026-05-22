/**
 * embedding-adapter.ts — CLI-facing embedding API on top of EmbeddingPipeline.
 *
 * ADR-0086 T1.3: Relocated from memory-initializer.ts. Preserves the unique
 * logic that EmbeddingPipeline alone does not provide:
 *   - Batch concurrency with progress callbacks (generateBatchEmbeddings)
 *   - Adaptive similarity thresholds (getAdaptiveThreshold)
 *   - agentdb applyTaskPrefix for intent-aware embedding (generateEmbedding)
 *   - CLI-shaped return types (object with { embedding, dimensions, model })
 *
 * All functions delegate to EmbeddingPipeline for actual vector generation.
 *
 * @module @claude-flow/memory/embedding-adapter
 */

import { getPipeline, initPipeline } from './embedding-pipeline.js';
import { getConfig } from './resolve-config.js';

// ---------------------------------------------------------------------------
// loadEmbeddingModel
// ---------------------------------------------------------------------------

/**
 * Ensure the EmbeddingPipeline singleton is initialized.
 * Returns a CLI-friendly status object.
 */
export async function loadEmbeddingModel(options?: {
  verbose?: boolean;
}): Promise<{
  success: boolean;
  dimensions: number;
  modelName: string;
  loadTime?: number;
  error?: string;
}> {
  const startTime = Date.now();

  // Already initialized
  const existing = getPipeline();
  if (existing?.isInitialized()) {
    return {
      success: true,
      dimensions: existing.getDimension(),
      modelName: existing.getModel(),
      loadTime: 0,
    };
  }

  try {
    const config = getConfig();
    const pipeline = await initPipeline(config.embedding);
    return {
      success: true,
      dimensions: pipeline.getDimension(),
      modelName: pipeline.getModel(),
      loadTime: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      dimensions: 0,
      modelName: 'none',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// generateEmbedding
// ---------------------------------------------------------------------------

/**
 * Generate an embedding for a single text.
 *
 * Routes through EmbeddingPipeline. Applies agentdb task prefix when
 * available (intent-aware embedding for query vs. document).
 */
export async function generateEmbedding(
  text: string,
  options?: { intent?: 'query' | 'document' },
): Promise<{
  embedding: number[];
  dimensions: number;
  model: string;
}> {
  // Apply model-specific task prefix via agentdb (if available)
  let processedText = text;
  try {
    const agentdb: any = await import('agentdb');
    if (agentdb.applyTaskPrefix) {
      processedText = agentdb.applyTaskPrefix(text, options?.intent || 'document');
    }
  } catch { /* no prefix available */ }

  // Ensure pipeline is initialized
  let pipeline = getPipeline();
  if (!pipeline?.isInitialized()) {
    await loadEmbeddingModel();
    pipeline = getPipeline();
  }

  if (pipeline) {
    const vec = await pipeline.embed(processedText);
    return {
      embedding: Array.from(vec),
      dimensions: vec.length,
      model: pipeline.getModel(),
    };
  }

  // Should not reach here — initPipeline uses hash fallback as last resort
  throw new Error('EmbeddingPipeline failed to initialize');
}

// ---------------------------------------------------------------------------
// generateBatchEmbeddings
// ---------------------------------------------------------------------------

/**
 * Generate embeddings for multiple texts with optional concurrency limit
 * and progress callback. Unique logic not in EmbeddingPipeline.
 */
export async function generateBatchEmbeddings(
  texts: string[],
  options?: {
    concurrency?: number;
    onProgress?: (completed: number, total: number) => void;
  },
): Promise<{
  results: Array<{ text: string; embedding: number[]; dimensions: number; model: string }>;
  totalTime: number;
  avgTime: number;
}> {
  const { concurrency = texts.length, onProgress } = options || {};
  const startTime = Date.now();

  // Ensure pipeline is initialized before parallel work (prevents cold-start race)
  await loadEmbeddingModel();

  if (concurrency >= texts.length) {
    // Full parallelism
    const results = await Promise.all(
      texts.map(async (text, i) => {
        const result = await generateEmbedding(text);
        onProgress?.(i + 1, texts.length);
        return { text, ...result };
      }),
    );
    const totalTime = Date.now() - startTime;
    return { results, totalTime, avgTime: totalTime / texts.length };
  }

  // Chunked concurrency
  const results: Array<{ text: string; embedding: number[]; dimensions: number; model: string }> = [];
  let completed = 0;

  for (let i = 0; i < texts.length; i += concurrency) {
    const chunk = texts.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (text) => {
        const result = await generateEmbedding(text);
        completed++;
        onProgress?.(completed, texts.length);
        return { text, ...result };
      }),
    );
    results.push(...chunkResults);
  }

  const totalTime = Date.now() - startTime;
  return { results, totalTime, avgTime: totalTime / texts.length };
}

// ---------------------------------------------------------------------------
// getAdaptiveThreshold
// ---------------------------------------------------------------------------

/**
 * Return the appropriate similarity threshold for the current embedding model.
 *
 * Hash fallback embeddings produce similarity ~0.05-0.28 (not semantic).
 * ONNX (mpnet, ADR-0069) RELATED content scores ~0.25-0.65 cosine; UNRELATED ~0
 * (measured 2026-05-22, ADR-0227). The earlier "ONNX 0.3-0.95" assumption was
 * wrong for mpnet — a 0.3 floor cut into the related band and dropped recall.
 * FB-004: Adaptive thresholds prevent silent empty results across providers.
 */
export async function getAdaptiveThreshold(explicitThreshold?: number): Promise<number> {
  if (explicitThreshold !== undefined && explicitThreshold !== null) {
    return explicitThreshold;
  }

  let pipeline = getPipeline();
  if (!pipeline?.isInitialized()) {
    await loadEmbeddingModel();
    pipeline = getPipeline();
  }

  if (pipeline) {
    // ADR-0227 (2026-05-22): 0.15 for real ONNX, not 0.3. Measured mpnet
    // (ADR-0069) cosine: RELATED content ~0.25-0.65 (e.g. 0.28/0.38/0.52/0.62),
    // UNRELATED ~0 (e.g. -0.01/0.04). The separating gap is ~0.05-0.25, so 0.15
    // admits related (>=0.28) and rejects unrelated (<=0.04). The old 0.3 assumed
    // "ONNX 0.3-0.95" (wrong for mpnet) and cut into the related band, dropping
    // weak-but-genuine matches. Supersedes ADR-0167's "keep 0.3" stance.
    return pipeline.getProvider() === 'hash-fallback' ? 0.05 : 0.15;
  }

  return 0.05; // Permissive fallback
}
