/**
 * Shared HNSW parameter derivation — single source of truth (ADR-0065 P3-3).
 * Used by AgentDBBackend, RvfBackend, and HNSWIndex.
 */

export interface HNSWParams {
  M: number;
  efConstruction: number;
  efSearch: number;
  maxElements: number; // ADR-0069: config-chain capacity
}

/**
 * Derive optimal HNSW parameters from embedding dimension.
 * M = floor(sqrt(dim) / 1.2), clamped to [8, 48]
 * efConstruction = 4 * M, clamped to [100, 500]
 * efSearch = 2 * M, clamped to [50, 400]
 */
export function deriveHNSWParams(dimension: number, maxElements: number = 100000): HNSWParams {
  const rawM = Math.floor(Math.sqrt(dimension) / 1.2);
  const M = Math.max(8, Math.min(48, rawM));
  const efConstruction = Math.max(100, Math.min(500, 4 * M));
  const efSearch = Math.max(50, Math.min(400, 2 * M));
  // ADR-0069: config-chain capacity
  return { M, efConstruction, efSearch, maxElements };
}
