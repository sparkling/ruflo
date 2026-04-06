/**
 * Embedding dimension constant — re-exported from centralized config.
 * ADR-0076 Phase 2: single source of truth via resolve-config.ts
 */
import { getConfig } from '@claude-flow/memory';

export const EMBEDDING_DIM: number = getConfig().embedding.dimension;
