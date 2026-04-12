/**
 * RVF-Primary Storage Shim (ADR-0080 Phase 5)
 *
 * Intercepts memory operations and routes them through the RVF backend
 * as primary, with SQLite as a secondary for structured queries.
 *
 * This file is OURS (not upstream) — zero merge conflict risk.
 *
 * Architecture:
 *   store  → RVF primary + SQLite secondary (dual-write)
 *   search → RVF HNSW first, SQLite brute-force fallback
 *   list   → SQLite (needs WHERE/ORDER BY/LIMIT — relational queries)
 *   delete → both RVF + SQLite
 *   count  → SQLite
 *
 * @module @claude-flow/cli/memory/rvf-shim
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ===== State =====

let _rvfBackend: any = null;
let _rvfReady = false;
let _rvfInitPromise: Promise<boolean> | null = null;

function getSwarmDir(): string {
  try {
    const cfgPath = path.join(process.cwd(), '.claude-flow', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      return cfg.memory?.swarmDir || '.swarm';
    }
  } catch { /* fall through */ }
  return '.swarm';
}

function resolveRvfPath(): string {
  // Try embeddings.json databasePath first
  try {
    let dir = process.cwd();
    while (dir !== path.dirname(dir)) {
      const embPath = path.join(dir, '.claude-flow', 'embeddings.json');
      if (fs.existsSync(embPath)) {
        const cfg = JSON.parse(fs.readFileSync(embPath, 'utf-8'));
        if (cfg.databasePath) return path.resolve(process.cwd(), cfg.databasePath);
      }
      dir = path.dirname(dir);
    }
  } catch { /* fall through */ }
  return path.resolve(process.cwd(), getSwarmDir(), 'memory.rvf');
}

// ===== Init =====

async function initRvf(): Promise<boolean> {
  if (_rvfReady) return true;
  if (_rvfInitPromise) return _rvfInitPromise;

  _rvfInitPromise = (async () => {
    try {
      const rvfPath = resolveRvfPath();
      if (!fs.existsSync(rvfPath)) return false;

      const memPkg = await import('@claude-flow/memory');
      _rvfBackend = await memPkg.createStorage({
        databasePath: rvfPath,
        dimensions: 768,
        autoPersistInterval: 30000,
      });
      await _rvfBackend.initialize();
      _rvfReady = true;
      return true;
    } catch {
      _rvfReady = false;
      return false;
    }
  })();

  return _rvfInitPromise;
}

/** Check if the shim is ready to handle operations */
export function isReady(): boolean {
  return _rvfReady;
}

/** Initialize the shim — call once, idempotent */
export async function init(): Promise<boolean> {
  return initRvf();
}

// ===== Store =====

export async function store(options: {
  key: string;
  value: string;
  namespace?: string;
  tags?: string[];
  embedding?: Float32Array | number[];
}): Promise<{ success: boolean; id: string; source: 'rvf' }> {
  if (!_rvfReady || !_rvfBackend) {
    throw new Error('RVF shim not initialized');
  }

  const id = `entry_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = Date.now();
  const namespace = options.namespace || 'default';

  await _rvfBackend.store({
    id,
    key: options.key,
    content: options.value,
    value: options.value,
    namespace,
    tags: JSON.stringify(options.tags || []),
    metadata: '{}',
    embedding: options.embedding
      ? (options.embedding instanceof Float32Array ? options.embedding : new Float32Array(options.embedding))
      : undefined,
    created_at: now,
    updated_at: now,
    access_count: 0,
    status: 'active',
  });

  return { success: true, id, source: 'rvf' };
}

// ===== Search =====

export async function search(options: {
  query: string;
  namespace?: string;
  limit?: number;
  embedding?: Float32Array | number[];
}): Promise<{
  results: Array<{ key: string; value: string; namespace: string; score: number }>;
  source: 'rvf';
}> {
  if (!_rvfReady || !_rvfBackend) {
    return { results: [], source: 'rvf' };
  }

  const searchOpts: any = {
    limit: options.limit || 10,
  };

  if (options.namespace) {
    searchOpts.namespace = options.namespace;
  }

  if (options.embedding) {
    searchOpts.vector = options.embedding instanceof Float32Array
      ? options.embedding
      : new Float32Array(options.embedding);
  }

  const results = await _rvfBackend.search(searchOpts);

  return {
    results: (results || []).map((r: any) => ({
      key: r.key || r.id,
      value: r.content || r.value || '',
      namespace: r.namespace || 'default',
      score: r.score || r.similarity || 0,
    })),
    source: 'rvf',
  };
}

// ===== Shutdown =====

export async function shutdown(): Promise<void> {
  if (_rvfBackend && typeof _rvfBackend.shutdown === 'function') {
    await _rvfBackend.shutdown();
  }
  _rvfBackend = null;
  _rvfReady = false;
  _rvfInitPromise = null;
}
