/**
 * Type definitions and constants for the RVF backend.
 *
 * Extracted from rvf-backend.ts (ADR-0154 G7 follow-up 2026-05-07) to
 * keep the file under the project's 500-line guidance and to make the
 * type surface independently importable. The runtime semantics are
 * identical — this is a pure code-organisation move.
 */

import { resolve } from 'node:path';

/** Validate a file path is safe (no null bytes, no traversal above root) */
export function validatePath(p: string): void {
  if (p === ':memory:') return;
  if (p.includes('\0')) throw new Error('Path contains null bytes');
  const resolved = resolve(p);
  if (resolved.includes('\0')) throw new Error('Resolved path contains null bytes');
}

export const DEFAULT_WAL_COMPACTION_THRESHOLD = 100;

export interface RvfBackendConfig {
  databasePath: string;
  dimensions?: number;
  metric?: 'cosine' | 'euclidean' | 'dot';
  quantization?: 'fp32' | 'fp16' | 'int8';
  hnswM?: number;
  hnswEfConstruction?: number;
  hnswEfSearch?: number;
  maxElements?: number;
  verbose?: boolean;
  defaultNamespace?: string;
  autoPersistInterval?: number;
  walCompactionThreshold?: number;
}

export interface RvfHeader {
  magic: string;
  version: number;
  dimensions: number;
  metric: string;
  quantization: string;
  entryCount: number;
  createdAt: number;
  updatedAt: number;
}

export const MAGIC = 'RVF\0';
// Native @ruvector/rvf-node file format (written by RvfDatabase.create()).
// When the pure-TS backend initializes on a project that previously used the
// native backend, the main `.rvf` path holds `SFVR` bytes and pure-TS metadata
// was written to the `.meta` sidecar. Treat this as a valid native-owned file,
// NOT corruption.
export const NATIVE_MAGIC = 'SFVR';
export const VERSION = 1;
export const DEFAULT_DIMENSIONS = 768;
export const DEFAULT_M = 16;
export const DEFAULT_EF_CONSTRUCTION = 200;
export const DEFAULT_MAX_ELEMENTS = 100000;
export const DEFAULT_PERSIST_INTERVAL = 30000;
