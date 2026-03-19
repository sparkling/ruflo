/**
 * Embedding dimension constant for the memory package.
 *
 * ADR-0052: reads from agentdb getEmbeddingConfig() at import time.
 * Falls back to 768 if agentdb is unavailable.
 */
let _dim = 768;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('agentdb');
  _dim = mod.getEmbeddingConfig().dimension;
} catch {
  // agentdb not available at runtime — use default
}
export const EMBEDDING_DIM: number = _dim;
