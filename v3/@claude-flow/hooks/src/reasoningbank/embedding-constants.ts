/**
 * Embedding dimension constant for the hooks reasoningbank.
 *
 * ADR-0052: single source of truth per package.
 * Default matches MiniLM-L6 (384-dim) used by this subsystem.
 * To change: update this value (or wire to agentdb getEmbeddingConfig()).
 */
export const EMBEDDING_DIM = 384;
