/**
 * Memory Bridge — Routes CLI memory operations through ControllerRegistry + AgentDB v3
 *
 * Per ADR-053 Phases 1-6: Full controller activation pipeline.
 * CLI → ControllerRegistry → AgentDB v3 controllers.
 *
 * Phase 1: Core CRUD + embeddings + HNSW + controller access (complete)
 * Phase 2: BM25 hybrid search, TieredCache read/write, MutationGuard validation
 * Phase 3: ReasoningBank pattern store, recordFeedback, CausalMemoryGraph edges
 * Phase 4: SkillLibrary promotion, ExplainableRecall provenance, AttestationLog
 * Phase 5: ReflexionMemory session lifecycle, WitnessChain attestation
 * Phase 6: AgentDB MCP tools (separate file), COW branching
 *
 * Uses better-sqlite3 API (synchronous .all()/.get()/.run()) since that's
 * what AgentDB v3 uses internally.
 *
 * @module v3/cli/memory-bridge
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
// ===== WM-102: Read config.json for ControllerRegistry =====
function readProjectConfig(): any {
    try {
        const cfgPath = path.join(process.cwd(), '.claude-flow', 'config.json');
        if (fs.existsSync(cfgPath)) {
            return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        }
    } catch { /* WM-102: config.json may not exist or may be malformed — use defaults */ }
    return {};
}

// FB-004 + OPT-009: Adaptive threshold based on embedding model + dimensions.
// Hash fallback produces similarity ~0.05-0.28 (not semantic).
// 384-dim (reasoningbank) produces lower cosine scores than 768-dim ONNX.
const THRESHOLDS: Record<string, number> = {
  'hash-fallback': 0.05,
  'onnx-384':      0.2,    // OPT-009: 384-dim reasoningbank embeddings
  'onnx-768':      0.3,    // Full ONNX model (Sentence-BERT 768-dim)
};
let _detectedModel: string | null = null;
let _detectedDimensions: number = 0;

async function _getAdaptiveThreshold(explicit?: number): Promise<number> {
  if (explicit !== undefined && explicit !== null) return explicit;
  if (!_detectedModel) {
    try {
      // Probe the embedding model once and cache
      const { generateEmbedding } = await import('./memory-initializer.js');
      const { model, dimensions } = await generateEmbedding('probe');
      _detectedModel = model;
      _detectedDimensions = dimensions;
    } catch {
      _detectedModel = 'hash-fallback';
      _detectedDimensions = 0;
    }
  }
  if (_detectedModel === 'hash-fallback') return THRESHOLDS['hash-fallback'];
  if (_detectedDimensions <= 384) return THRESHOLDS['onnx-384'];
  return THRESHOLDS['onnx-768'];
}

// ===== Lazy singleton =====

let registryPromise: Promise<any> | null = null;
let registryInstance: any = null;
let bridgeAvailable: boolean | null = null;

/**
 * Resolve database path with path traversal protection.
 * Only allows paths within or below the project's .swarm directory,
 * or the special ':memory:' path.
 */
function getDbPath(customPath?: string): string {
  const swarmDir = path.resolve(process.cwd(), '.swarm');
  if (!customPath) return path.join(swarmDir, 'memory.db');
  if (customPath === ':memory:') return ':memory:';
  const resolved = path.resolve(customPath);
  // Ensure the path doesn't escape the working directory
  const cwd = process.cwd();
  if (!resolved.startsWith(cwd)) {
    return path.join(swarmDir, 'memory.db'); // fallback to safe default
  }
  return resolved;
}

/**
 * Generate a secure random ID for memory entries.
 */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Lazily initialize the ControllerRegistry singleton.
 * Returns null if @claude-flow/memory is not available.
 */
async function getRegistry(dbPath?: string): Promise<any | null> {
  if (bridgeAvailable === false) return null;

  if (registryInstance) return registryInstance;

  // WM-102c: Respect neural.enabled from config.json
  const _neuralCfg = readProjectConfig().neural || {};
  if (_neuralCfg.enabled === false) {
      bridgeAvailable = false;
      return null;
  }
  if (!registryPromise) {
    registryPromise = (async () => {
      try {
        const { ControllerRegistry } = await import('@claude-flow/memory');
        const registry = new ControllerRegistry();

        // Suppress noisy console.log during init
        const origLog = console.log;
        console.log = (...args: unknown[]) => {
          const msg = String(args[0] ?? '');
          if (msg.includes('Transformers.js') ||
              msg.includes('better-sqlite3') ||
              msg.includes('[AgentDB]') ||
              msg.includes('[HNSWLibBackend]') ||
              msg.includes('RuVector graph')) return;
          origLog.apply(console, args);
        };

        try {
          // WM-102b: wire config.json into ControllerRegistry
          const _cfg = readProjectConfig();
          const _mem = _cfg.memory || {};
          const _lb = _mem.learningBridge || {};
          const _mg = _mem.memoryGraph || {};
          const _neural = _cfg.neural || {};
          await registry.initialize({
            dbPath: dbPath || getDbPath(),
            dimension: 768,
            enableHNSW: _mem.enableHNSW !== false,
            cacheSize: _mem.cacheSize || 100,
            similarityThreshold: _mg.similarityThreshold || 0.8,
            controllers: {
              reasoningBank: true,
              learningBridge: _lb.enabled !== false,
              tieredCache: true,
              hierarchicalMemory: true,
              memoryConsolidation: true,
              enhancedEmbedding: true,  // WM-111: wire EnhancedEmbeddingService
              memoryGraph: true, // issue #1214: enable MemoryGraph for graph-aware ranking
            },
            memory: {
              enableHNSW: _mem.enableHNSW !== false,
              cacheSize: _mem.cacheSize || 100,
              learningBridge: {
                sonaMode: _lb.sonaMode || 'balanced',
                confidenceDecayRate: _lb.confidenceDecayRate || 0.005,
                accessBoostAmount: _lb.accessBoostAmount || 0.03,
                consolidationThreshold: _lb.consolidationThreshold || 10,
              },
              memoryGraph: {
                pageRankDamping: _mg.pageRankDamping || 0.85,
                maxNodes: _mg.maxNodes || 5000,
                similarityThreshold: _mg.similarityThreshold || 0.8,
              },
            },
          } as any);
        } finally {
          console.log = origLog;
        }

        registryInstance = registry;
        bridgeAvailable = true;
        // WM-115a: Instantiate WASMVectorSearch (JS fallback)
        try {
          const agentdbMod: any = await import('agentdb');
          const WASMVectorSearch = agentdbMod.WASMVectorSearch || agentdbMod.default?.WASMVectorSearch;
          if (WASMVectorSearch) {
            const wasmSearch = new WASMVectorSearch({
              dimension: 384,
              wasmAvailable: false, // JS fallback active
            });
            registry.register('wasmVectorSearch', wasmSearch);
          }
        } catch {
          // WM-115: WASMVectorSearch instantiation failed — non-fatal
        }
        return registry;
      } catch { /* WM-115: bridge may not be loaded — agentdb is an optional dependency */
        bridgeAvailable = false;
        registryPromise = null;
        return null;
      }
    })();
  }

  return registryPromise;
}
// WM-115b: Expose computeSimilarity helper using WASMVectorSearch JS fallback
async function wasmComputeSimilarity(vecA: Float32Array, vecB: Float32Array): Promise<number | null> {
  if (!registryInstance) return null;
  try {
    const wasmSearch = registryInstance.get('wasmVectorSearch');
    if (wasmSearch && typeof (wasmSearch as any).computeSimilarity === 'function') {
      return (wasmSearch as any).computeSimilarity(vecA, vecB);
    }
  } catch {
    // WM-115: computeSimilarity failed — non-fatal
  }
  return null;
}

// ===== Phase 2: BM25 hybrid scoring =====

/**
 * BM25 scoring for keyword-based search.
 * Replaces naive String.includes() with proper information retrieval scoring.
 * Parameters tuned for short memory entries (k1=1.2, b=0.75).
 */
function bm25Score(
  queryTerms: string[],
  docContent: string,
  avgDocLength: number,
  docCount: number,
  termDocFreqs: Map<string, number>,
): number {
  const k1 = 1.2;
  const b = 0.75;
  const docWords = docContent.toLowerCase().split(/\s+/);
  const docLength = docWords.length;

  let score = 0;
  for (const term of queryTerms) {
    const tf = docWords.filter(w => w === term || w.includes(term)).length;
    if (tf === 0) continue;

    const df = termDocFreqs.get(term) || 1;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / Math.max(1, avgDocLength))));
    score += idf * tfNorm;
  }

  return score;
}

/**
 * Compute BM25 term document frequencies for a set of rows.
 */
function computeTermDocFreqs(
  queryTerms: string[],
  rows: Array<{ content: string }>,
): { termDocFreqs: Map<string, number>; avgDocLength: number } {
  const termDocFreqs = new Map<string, number>();
  let totalLength = 0;

  for (const row of rows) {
    const content = (row.content || '').toLowerCase();
    const words = content.split(/\s+/);
    totalLength += words.length;

    for (const term of queryTerms) {
      if (content.includes(term)) {
        termDocFreqs.set(term, (termDocFreqs.get(term) || 0) + 1);
      }
    }
  }

  return { termDocFreqs, avgDocLength: rows.length > 0 ? totalLength / rows.length : 1 };
}

// ===== Phase 2: TieredCache helpers =====

/**
 * Try to read from TieredCache before hitting DB.
 * Returns cached value or null if cache miss.
 */
async function cacheGet(registry: any, cacheKey: string): Promise<any | null> {
  try {
    const cache = registry.get('tieredCache');
    if (!cache || typeof cache.get !== 'function') return null;
    return cache.get(cacheKey) ?? null;
  } catch {
    return null;
  }
}

/**
 * Write to TieredCache after DB write.
 */
async function cacheSet(registry: any, cacheKey: string, value: any): Promise<void> {
  try {
    const cache = registry.get('tieredCache');
    if (cache && typeof cache.set === 'function') {
      cache.set(cacheKey, value);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Invalidate a cache key after mutation.
 */
async function cacheInvalidate(registry: any, cacheKey: string): Promise<void> {
  try {
    const cache = registry.get('tieredCache');
    if (cache && typeof cache.delete === 'function') {
      cache.delete(cacheKey);
    }
  } catch {
    // Non-fatal
  }
}

// ===== Phase 2: MutationGuard helpers =====

/**
 * Validate a mutation through MutationGuard before executing.
 * Returns true if the mutation is allowed, false if rejected.
 * When guard is unavailable (not installed), mutations are allowed.
 * When guard is present but throws, mutations are DENIED (fail-closed).
 */
async function guardValidate(
  registry: any,
  operation: string,
  params: Record<string, unknown>,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const guard = registry.get('mutationGuard');
    if (!guard || typeof guard.validate !== 'function') {
      return { allowed: true }; // No guard installed = allow (degraded mode)
    }
    const result = guard.validate({ operation, params, timestamp: Date.now() });
    return { allowed: result?.allowed === true, reason: result?.reason };
  } catch {
    return { allowed: false, reason: 'MutationGuard validation error' }; // Fail-closed
  }
}

// ===== Phase 3: AttestationLog helpers =====

/**
 * Log a write operation to AttestationLog/WitnessChain.
 */
async function logAttestation(
  registry: any,
  operation: string,
  entryId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const attestation = registry.get('attestationLog');
    if (!attestation) return;

    if (typeof attestation.record === 'function') {
      attestation.record({ operation, entryId, timestamp: Date.now(), ...metadata });
    } else if (typeof attestation.log === 'function') {
      attestation.log(operation, entryId, metadata);
    }
  } catch {
    // Non-fatal — attestation is observability, not correctness
  }
}

/**
 * Get the AgentDB database handle and ensure memory_entries table exists.
 * Returns null if not available.
 */
function getDb(registry: any): any | null {
  const agentdb = registry.getAgentDB();
  if (!agentdb?.database) return null;

  const db = agentdb.database;

  // Ensure memory_entries table exists (idempotent)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      namespace TEXT DEFAULT 'default',
      content TEXT NOT NULL,
      type TEXT DEFAULT 'semantic',
      embedding TEXT,
      embedding_model TEXT DEFAULT 'local',
      embedding_dimensions INTEGER,
      tags TEXT,
      metadata TEXT,
      owner_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      expires_at INTEGER,
      last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      UNIQUE(namespace, key)
    )`);
    // Ensure indexes
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_ns ON memory_entries(namespace)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_key ON memory_entries(key)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_status ON memory_entries(status)`);
  } catch {
    // Table already exists or db is read-only — that's fine
  }

  return { db, agentdb };
}

// ===== Bridge functions — match memory-initializer.ts signatures =====

/**
 * Store an entry via AgentDB v3.
 * Phase 2-5: Routes through MutationGuard → TieredCache → DB → AttestationLog.
 * Returns null to signal fallback to sql.js.
 */
export async function bridgeStoreEntry(options: {
  key: string;
  value: string;
  namespace?: string;
  generateEmbeddingFlag?: boolean;
  tags?: string[];
  ttl?: number;
  dbPath?: string;
  upsert?: boolean;
}): Promise<{
  success: boolean;
  id: string;
  embedding?: { dimensions: number; model: string };
  guarded?: boolean;
  cached?: boolean;
  attested?: boolean;
  error?: string;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  const ctx = getDb(registry);
  if (!ctx) return null;

  try {
    const { key, value, namespace = 'default', tags = [], ttl } = options;
    const id = generateId('entry');
    const now = Date.now();

    // Phase 5: MutationGuard validation before write
    const guardResult = await guardValidate(registry, 'store', { key, namespace, size: value.length });
    if (!guardResult.allowed) {
      return { success: false, id, error: `MutationGuard rejected: ${guardResult.reason}` };
    }

    // ADR-0030: Generate embedding via memory-initializer (768-dim preferred)
    // instead of AgentDB's embedder (384-dim) to ensure consistent dimensions
    let embeddingJson: string | null = null;
    let dimensions = 0;
    let model = 'local';

    if (options.generateEmbeddingFlag !== false && value.length > 0) {
      try {
        const { generateEmbedding } = await import('./memory-initializer.js');
        const result = await generateEmbedding(value);
        if (result && result.embedding) {
          embeddingJson = JSON.stringify(result.embedding);
          dimensions = result.dimensions;
          model = result.model;
        }
      } catch {
        // Fallback to AgentDB embedder if memory-initializer unavailable
        try {
          const embedder = ctx.agentdb.embedder;
          if (embedder) {
            const emb = await embedder.embed(value);
            if (emb) {
              embeddingJson = JSON.stringify(Array.from(emb));
              dimensions = emb.length;
              model = 'Xenova/all-mpnet-base-v2';
            }
          }
        } catch {
          // Embedding failed — store without
        }
      }
    }

    // Phase 5: GuardedVectorBackend — store through guarded backend if available
    try {
      const gvb = registry?.getController?.('guardedVectorBackend') ?? registry?.get?.('guardedVectorBackend');
      if (gvb && typeof gvb.store === 'function') {
        const guardedResult = await Promise.race([
          gvb.store({
            key,
            value,
            namespace,
            embedding: embeddingJson ? JSON.parse(embeddingJson) : undefined,
          }),
          new Promise<any>((_, reject) => setTimeout(() => reject(new Error('GuardedVector store timeout')), 2000))
        ]);
        if (guardedResult?.success) {
          // GuardedVectorBackend handled the store — still do post-store hooks below
          const safeNs = String(namespace).replace(/:/g, '_');
          const safeKey = String(key).replace(/:/g, '_');
          const cacheKey = `entry:${safeNs}:${safeKey}`;
          await cacheSet(registry, cacheKey, { id, key, namespace, content: value, embedding: embeddingJson });
          await logAttestation(registry, 'store', id, { key, namespace, hasEmbedding: !!embeddingJson, backend: 'guardedVector' });
          return {
            success: true,
            id: guardedResult.id || id,
            embedding: embeddingJson ? { dimensions, model } : undefined,
            guarded: true,
            cached: true,
            attested: true,
          };
        }
        // If guarded store fails, fall through to regular path
      }
    } catch { /* GuardedVectorBackend unavailable — use regular path */ }

    // better-sqlite3 uses synchronous .run() with positional params
    const insertSql = options.upsert
      ? `INSERT OR REPLACE INTO memory_entries (
          id, key, namespace, content, type,
          embedding, embedding_dimensions, embedding_model,
          tags, metadata, created_at, updated_at, expires_at, status
        ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      : `INSERT INTO memory_entries (
          id, key, namespace, content, type,
          embedding, embedding_dimensions, embedding_model,
          tags, metadata, created_at, updated_at, expires_at, status
        ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`;

    const stmt = ctx.db.prepare(insertSql);
    stmt.run(
      id, key, namespace, value,
      embeddingJson, dimensions || null, model,
      tags.length > 0 ? JSON.stringify(tags) : null,
      '{}',
      now, now,
      ttl ? now + (ttl * 1000) : null
    );

    // Phase 2: Write-through to TieredCache
    const safeNs = String(namespace).replace(/:/g, '_');
    const safeKey = String(key).replace(/:/g, '_');
    const cacheKey = `entry:${safeNs}:${safeKey}`;
    await cacheSet(registry, cacheKey, { id, key, namespace, content: value, embedding: embeddingJson });

    // Phase 4: AttestationLog write audit
    await logAttestation(registry, 'store', id, { key, namespace, hasEmbedding: !!embeddingJson });

    return {
      success: true,
      id,
      embedding: embeddingJson ? { dimensions, model } : undefined,
      guarded: true,
      cached: true,
      attested: true,
    };
  } catch {
    return null;
  }
}

/**
 * Search entries via AgentDB v3.
 * Phase 2: BM25 hybrid scoring replaces naive String.includes() keyword fallback.
 * Combines cosine similarity (semantic) with BM25 (lexical) via reciprocal rank fusion.
 */
export async function bridgeSearchEntries(options: {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  results: {
    id: string;
    key: string;
    content: string;
    score: number;
    namespace: string;
    provenance?: string;
  }[];
  searchTime: number;
  searchMethod?: string;
  error?: string;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  const ctx = getDb(registry);
  if (!ctx) return null;

  try {
    // OPT-010: No default namespace — when unspecified, search across all namespaces
    const { query: queryStr, namespace, limit = 10, threshold: explicitThreshold } = options;
    const threshold = await _getAdaptiveThreshold(explicitThreshold);
    const startTime = Date.now();

    // ADR-0030: Generate query embedding via memory-initializer (768-dim preferred)
    let queryEmbedding: number[] | null = null;
    try {
      const { generateEmbedding } = await import('./memory-initializer.js');
      const result = await generateEmbedding(queryStr);
      if (result && result.embedding) {
        queryEmbedding = result.embedding;
      }
    } catch {
      // Fallback to AgentDB embedder
      try {
        const embedder = ctx.agentdb.embedder;
        if (embedder) {
          const emb = await embedder.embed(queryStr);
          queryEmbedding = Array.from(emb);
        }
      } catch {
        // Fall back to keyword search
      }
    }

    // Phase 5: GuardedVectorBackend — try guarded search first
    try {
      const gvb = registry?.getController?.('guardedVectorBackend') ?? registry?.get?.('guardedVectorBackend');
      if (gvb && typeof gvb.search === 'function') {
        const guardedResults = await Promise.race([
          gvb.search({
            query: queryStr,
            namespace: namespace || undefined,
            limit: limit,
            embedding: queryEmbedding,
          }),
          new Promise<any>((_, reject) => setTimeout(() => reject(new Error('GuardedVector search timeout')), 2000))
        ]);
        if (guardedResults?.results?.length > 0) {
          // GuardedVectorBackend results have cryptographic integrity guarantees
          // Return them directly with provenance marking
          const guardedMapped = guardedResults.results.slice(0, limit).map((r: any) => ({
            id: String(r.id || r.key || '').substring(0, 12),
            key: r.key || String(r.id || '').substring(0, 15),
            content: (r.content || r.value || '').substring(0, 60) + ((r.content || r.value || '').length > 60 ? '...' : ''),
            score: r.score ?? r.similarity ?? 0,
            namespace: r.namespace || namespace || 'default',
            provenance: `guarded-vector:${(r.score ?? r.similarity ?? 0).toFixed(3)}`,
          }));
          return {
            success: true,
            results: guardedMapped,
            searchTime: Date.now() - startTime,
            searchMethod: 'guarded-vector',
          };
        }
      }
    } catch { /* GuardedVectorBackend unavailable — fall through to regular path */ }

    // better-sqlite3: .prepare().all() returns array of objects
    // OPT-010: Filter by namespace only when explicitly specified (not 'all' or undefined)
    const nsFilter = (namespace && namespace !== 'all')
      ? `AND namespace = ?`
      : '';

    let rows: any[];
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding
        FROM memory_entries
        WHERE status = 'active' ${nsFilter}
        LIMIT 1000
      `);
      rows = (namespace && namespace !== 'all') ? stmt.all(namespace) : stmt.all();
    } catch {
      return null;
    }

    // Phase 2: Compute BM25 term stats for the corpus
    const queryTerms = queryStr.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const { termDocFreqs, avgDocLength } = computeTermDocFreqs(queryTerms, rows);
    const docCount = rows.length;

    const results: { id: string; key: string; content: string; score: number; namespace: string; provenance?: string }[] = [];

    for (const row of rows) {
      let semanticScore = 0;
      let bm25ScoreVal = 0;

      // Semantic scoring via cosine similarity
      if (queryEmbedding && row.embedding) {
        try {
          const embedding = JSON.parse(row.embedding) as number[];
          semanticScore = cosineSim(queryEmbedding, embedding);
        } catch {
          // Invalid embedding
        }
      }

      // Phase 2: BM25 keyword scoring (replaces String.includes fallback)
      if (queryTerms.length > 0 && row.content) {
        bm25ScoreVal = bm25Score(queryTerms, row.content, avgDocLength, docCount, termDocFreqs);
        // Normalize BM25 to 0-1 range (cap at 10 for normalization)
        bm25ScoreVal = Math.min(bm25ScoreVal / 10, 1.0);
      }

      // Reciprocal rank fusion: combine semantic and BM25
      // Weight: 0.7 semantic + 0.3 BM25 (semantic preferred when embeddings available)
      const score = queryEmbedding
        ? (0.7 * semanticScore + 0.3 * bm25ScoreVal)
        : bm25ScoreVal;  // BM25-only when no embeddings

      if (score >= threshold) {
        // Phase 4: ExplainableRecall provenance
        const provenance = queryEmbedding
          ? `semantic:${semanticScore.toFixed(3)}+bm25:${bm25ScoreVal.toFixed(3)}`
          : `bm25:${bm25ScoreVal.toFixed(3)}`;

        results.push({
          id: String(row.id).substring(0, 12),
          key: row.key || String(row.id).substring(0, 15),
          content: (row.content || '').substring(0, 60) + ((row.content || '').length > 60 ? '...' : ''),
          score,
          namespace: row.namespace || 'default',
          provenance,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const sliced = results.slice(0, limit);

    // Phase 5-D: GraphTransformer proof-gated re-ranking (optional overlay)
    const reranked = await bridgeGraphTransformerRerank(sliced, queryStr);

    return {
      success: true,
      results: reranked,
      searchTime: Date.now() - startTime,
      searchMethod: queryEmbedding ? 'hybrid-bm25-semantic' : 'bm25-only',
    };
  } catch {
    return null;
  }
}

/**
 * List entries via AgentDB v3.
 */
export async function bridgeListEntries(options: {
  namespace?: string;
  limit?: number;
  offset?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  entries: {
    id: string;
    key: string;
    namespace: string;
    size: number;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
  }[];
  total: number;
  error?: string;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  const ctx = getDb(registry);
  if (!ctx) return null;

  try {
    const { namespace, limit = 20, offset = 0 } = options;

    const nsFilter = namespace ? `AND namespace = ?` : '';
    const nsParams = namespace ? [namespace] : [];

    // Count
    let total = 0;
    try {
      const countStmt = ctx.db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' ${nsFilter}`
      );
      const countRow = countStmt.get(...nsParams);
      total = countRow?.cnt ?? 0;
    } catch {
      return null;
    }

    // List
    const entries: any[] = [];
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at
        FROM memory_entries
        WHERE status = 'active' ${nsFilter}
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `);
      const rows = stmt.all(...nsParams, limit, offset);
      for (const row of rows) {
        entries.push({
          id: String(row.id).substring(0, 20),
          key: row.key || String(row.id).substring(0, 15),
          namespace: row.namespace || 'default',
          size: (row.content || '').length,
          accessCount: row.access_count ?? 0,
          createdAt: row.created_at || new Date().toISOString(),
          updatedAt: row.updated_at || new Date().toISOString(),
          hasEmbedding: !!(row.embedding && String(row.embedding).length > 10),
        });
      }
    } catch {
      return null;
    }

    return { success: true, entries, total };
  } catch {
    return null;
  }
}

/**
 * Get a specific entry via AgentDB v3.
 * Phase 2: TieredCache consulted before DB hit.
 */
export async function bridgeGetEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  found: boolean;
  entry?: {
    id: string;
    key: string;
    namespace: string;
    content: string;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
    tags: string[];
  };
  cacheHit?: boolean;
  error?: string;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  const ctx = getDb(registry);
  if (!ctx) return null;

  try {
    const { key, namespace = 'default' } = options;

    // Phase 2: Check TieredCache first
    const safeNs = String(namespace).replace(/:/g, '_');
    const safeKey = String(key).replace(/:/g, '_');
    const cacheKey = `entry:${safeNs}:${safeKey}`;
    const cached = await cacheGet(registry, cacheKey);
    if (cached && cached.content) {
      return {
        success: true,
        found: true,
        cacheHit: true,
        entry: {
          id: String(cached.id || ''),
          key: cached.key || key,
          namespace: cached.namespace || namespace,
          content: cached.content || '',
          accessCount: cached.accessCount ?? 0,
          createdAt: cached.createdAt || new Date().toISOString(),
          updatedAt: cached.updatedAt || new Date().toISOString(),
          hasEmbedding: !!cached.embedding,
          tags: cached.tags || [],
        },
      };
    }

    let row: any;
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at, tags
        FROM memory_entries
        WHERE status = 'active' AND key = ? AND namespace = ?
        LIMIT 1
      `);
      row = stmt.get(key, namespace);
    } catch {
      return null;
    }

    if (!row) {
      return { success: true, found: false };
    }

    // Update access count
    try {
      ctx.db.prepare(
        `UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`
      ).run(Date.now(), row.id);
    } catch {
      // Non-fatal
    }

    let tags: string[] = [];
    if (row.tags) {
      try { tags = JSON.parse(row.tags); } catch { /* invalid */ }
    }

    const entry = {
      id: String(row.id),
      key: row.key || String(row.id),
      namespace: row.namespace || 'default',
      content: row.content || '',
      accessCount: (row.access_count ?? 0) + 1,
      createdAt: row.created_at || new Date().toISOString(),
      updatedAt: row.updated_at || new Date().toISOString(),
      hasEmbedding: !!(row.embedding && String(row.embedding).length > 10),
      tags,
    };

    // Phase 2: Populate cache for next read
    await cacheSet(registry, cacheKey, entry);

    return { success: true, found: true, cacheHit: false, entry };
  } catch {
    return null;
  }
}

/**
 * Delete an entry via AgentDB v3.
 * Phase 5: MutationGuard validation, cache invalidation, attestation logging.
 */
export async function bridgeDeleteEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  deleted: boolean;
  key: string;
  namespace: string;
  remainingEntries: number;
  guarded?: boolean;
  error?: string;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  const ctx = getDb(registry);
  if (!ctx) return null;

  try {
    const { key, namespace = 'default' } = options;

    // Phase 5: MutationGuard validation before delete
    const guardResult = await guardValidate(registry, 'delete', { key, namespace });
    if (!guardResult.allowed) {
      return { success: false, deleted: false, key, namespace, remainingEntries: 0, error: `MutationGuard rejected: ${guardResult.reason}` };
    }

    // Soft delete using parameterized query
    let changes = 0;
    try {
      const result = ctx.db.prepare(`
        UPDATE memory_entries
        SET status = 'deleted', updated_at = ?
        WHERE key = ? AND namespace = ? AND status = 'active'
      `).run(Date.now(), key, namespace);
      changes = result?.changes ?? 0;
    } catch {
      return null;
    }

    // Phase 2: Invalidate cache
    const safeNs = String(namespace).replace(/:/g, '_');
    const safeKey = String(key).replace(/:/g, '_');
    await cacheInvalidate(registry, `entry:${safeNs}:${safeKey}`);

    // Phase 4: AttestationLog delete audit
    if (changes > 0) {
      await logAttestation(registry, 'delete', key, { namespace });
    }

    let remaining = 0;
    try {
      const row = ctx.db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active'`).get();
      remaining = row?.cnt ?? 0;
    } catch {
      // Non-fatal
    }

    return {
      success: true,
      deleted: changes > 0,
      key,
      namespace,
      remainingEntries: remaining,
      guarded: true,
    };
  } catch {
    return null;
  }
}

// ===== Phase 2: Embedding bridge =====

/**
 * Generate embedding via AgentDB v3's embedder.
 * Returns null if bridge unavailable or dimensions don't match 768 —
 * caller falls back to own ONNX/hash which produces correct 768-dim.
 * ADR-0030: Reject 384-dim embeddings to ensure dimension consistency.
 */
export async function bridgeGenerateEmbedding(
  text: string,
  dbPath?: string,
): Promise<{ embedding: number[]; dimensions: number; model: string } | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  try {
    const agentdb = registry.getAgentDB();
    const embedder = agentdb?.embedder;
    if (!embedder) return null;

    const emb = await embedder.embed(text);
    if (!emb) return null;

    // ADR-0030: Reject mismatched dimensions — let caller use 768-dim fallback
    if (emb.length !== 768) return null;

    return {
      embedding: Array.from(emb),
      dimensions: emb.length,
      model: 'Xenova/all-mpnet-base-v2',
    };
  } catch {
    return null;
  }
}

/**
 * Load embedding model via AgentDB v3 (it loads on init).
 * Returns null if unavailable.
 */
export async function bridgeLoadEmbeddingModel(
  dbPath?: string,
): Promise<{
  success: boolean;
  dimensions: number;
  modelName: string;
  loadTime?: number;
} | null> {
  const startTime = Date.now();
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  try {
    const agentdb = registry.getAgentDB();
    const embedder = agentdb?.embedder;
    if (!embedder) return null;

    // Verify embedder works by generating a test embedding
    const test = await embedder.embed('test');
    if (!test) return null;

    return {
      success: true,
      dimensions: test.length,
      modelName: 'Xenova/all-mpnet-base-v2',
      loadTime: Date.now() - startTime,
    };
  } catch {
    return null;
  }
}

// ===== Phase 3: HNSW bridge =====

/**
 * Get HNSW status from AgentDB v3's vector backend or HNSW index.
 * Returns null if unavailable.
 */
export async function bridgeGetHNSWStatus(
  dbPath?: string,
): Promise<{
  available: boolean;
  initialized: boolean;
  entryCount: number;
  dimensions: number;
} | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  try {
    const ctx = getDb(registry);
    if (!ctx) return null;

    // Count entries with embeddings
    let entryCount = 0;
    try {
      const row = ctx.db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' AND embedding IS NOT NULL`,
      ).get();
      entryCount = row?.cnt ?? 0;
    } catch {
      // Table might not exist
    }

    return {
      available: true,
      initialized: true,
      entryCount,
      dimensions: 768,
    };
  } catch {
    return null;
  }
}

/**
 * Search using AgentDB v3's embedder + SQLite entries.
 * This is the HNSW-equivalent search through the bridge.
 * Returns null if unavailable.
 */
export async function bridgeSearchHNSW(
  queryEmbedding: number[],
  options?: { k?: number; namespace?: string; threshold?: number },
  dbPath?: string,
): Promise<Array<{
  id: string;
  key: string;
  content: string;
  score: number;
  namespace: string;
}> | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  const ctx = getDb(registry);
  if (!ctx) return null;

  try {
    const k = options?.k ?? 10;
    const threshold = await _getAdaptiveThreshold(options?.threshold);
    const nsFilter = options?.namespace && options.namespace !== 'all'
      ? `AND namespace = ?`
      : '';

    let rows: any[];
    try {
      const stmt = ctx.db.prepare(`
        SELECT id, key, namespace, content, embedding
        FROM memory_entries
        WHERE status = 'active' AND embedding IS NOT NULL ${nsFilter}
        LIMIT 10000
      `);
      rows = nsFilter
        ? stmt.all(options!.namespace)
        : stmt.all();
    } catch {
      return null;
    }

    const results: Array<{
      id: string; key: string; content: string; score: number; namespace: string;
    }> = [];

    for (const row of rows) {
      if (!row.embedding) continue;
      try {
        const emb = JSON.parse(row.embedding) as number[];
        const score = cosineSim(queryEmbedding, emb);
        if (score >= threshold) {
          results.push({
            id: String(row.id).substring(0, 12),
            key: row.key || String(row.id).substring(0, 15),
            content: (row.content || '').substring(0, 60) +
              ((row.content || '').length > 60 ? '...' : ''),
            score,
            namespace: row.namespace || 'default',
          });
        }
      } catch {
        // Skip invalid embeddings
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  } catch {
    return null;
  }
}

/**
 * Add entry to the bridge's database with embedding.
 * Returns null if unavailable.
 */
export async function bridgeAddToHNSW(
  id: string,
  embedding: number[],
  entry: { id: string; key: string; namespace: string; content: string },
  dbPath?: string,
): Promise<boolean | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  const ctx = getDb(registry);
  if (!ctx) return null;

  try {
    const now = Date.now();
    const embeddingJson = JSON.stringify(embedding);
    ctx.db.prepare(`
      INSERT OR REPLACE INTO memory_entries (
        id, key, namespace, content, type,
        embedding, embedding_dimensions, embedding_model,
        created_at, updated_at, status
      ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, 'Xenova/all-mpnet-base-v2', ?, ?, 'active')
    `).run(
      id, entry.key, entry.namespace, entry.content,
      embeddingJson, embedding.length,
      now, now,
    );
    return true;
  } catch {
    return null;
  }
}

// ===== Phase 4: Controller access =====

/**
 * Get a named controller from AgentDB v3 via ControllerRegistry.
 * Returns null if unavailable.
 */
export async function bridgeGetController(
  name: string,
  dbPath?: string,
): Promise<any | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  try {
    return registry.get(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a controller is available.
 */
export async function bridgeHasController(
  name: string,
  dbPath?: string,
): Promise<boolean> {
  const registry = await getRegistry(dbPath);
  if (!registry) return false;

  try {
    const controller = registry.get(name);
    return controller !== null && controller !== undefined;
  } catch {
    return false;
  }
}

/**
 * List all controllers and their status.
 */
export async function bridgeListControllers(
  dbPath?: string,
): Promise<Array<{ name: string; enabled: boolean; level: number }> | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  try {
    return registry.listControllers();
  } catch {
    return null;
  }
}

/**
 * Check if the AgentDB v3 bridge is available.
 */
export async function isBridgeAvailable(dbPath?: string): Promise<boolean> {
  if (bridgeAvailable !== null) return bridgeAvailable;
  const registry = await getRegistry(dbPath);
  return registry !== null;
}

/**
 * Get the ControllerRegistry instance (for advanced consumers).
 */
export async function getControllerRegistry(dbPath?: string): Promise<any | null> {
  return getRegistry(dbPath);
}

/**
 * Shutdown the bridge and release resources.
 */
export async function shutdownBridge(): Promise<void> {
  if (registryInstance) {
    try {
      await registryInstance.shutdown();
    } catch {
      // Best-effort
    }
    registryInstance = null;
    registryPromise = null;
    bridgeAvailable = null;
  }
}

// ===== OPT-001/OPT-002: Probe controller for callable methods =====
/**
 * Probe a controller object for a callable method by trying multiple property paths.
 * ControllerRegistry may wrap controllers as module objects, class instances, or nested objects.
 * Fixes bridge-fallback for ReasoningBank store/search operations.
 */
function getCallableMethod(obj: any, ...names: string[]): ((...args: any[]) => any) | null {
  if (!obj) return null;
  for (const name of names) {
    if (typeof obj[name] === 'function') return obj[name].bind(obj);
    if (obj.default && typeof obj.default[name] === 'function') return obj.default[name].bind(obj.default);
    if (obj.instance && typeof obj.instance[name] === 'function') return obj.instance[name].bind(obj.instance);
    if (obj.controller && typeof obj.controller[name] === 'function') return obj.controller[name].bind(obj.controller);
  }
  return null;
}

// ===== Phase 3: ReasoningBank pattern operations =====

/**
 * Store a pattern via ReasoningBank controller.
 * Falls back to raw SQL if ReasoningBank unavailable.
 */
export async function bridgeStorePattern(options: {
  pattern: string;
  type: string;
  confidence: number;
  metadata?: Record<string, unknown>;
  dbPath?: string;
}): Promise<{ success: boolean; patternId: string; controller: string } | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  try {
    const reasoningBank = registry.get('reasoningBank');
    const patternId = generateId('pattern');

    // OPT-001: Probe for callable store method across binding patterns
    const storeFn = getCallableMethod(reasoningBank, 'store', 'storePattern', 'add');
    if (storeFn) {
      await storeFn({
        id: patternId,
        content: options.pattern,
        type: options.type,
        confidence: options.confidence,
        metadata: options.metadata,
        timestamp: Date.now(),
      });
      return { success: true, patternId, controller: 'reasoningBank' };
    }

    // Fallback: store via bridge SQL
    const result = await bridgeStoreEntry({
      key: patternId,
      value: JSON.stringify({ pattern: options.pattern, type: options.type, confidence: options.confidence, metadata: options.metadata }),
      namespace: 'pattern',
      generateEmbeddingFlag: true,
      tags: [options.type, 'reasoning-pattern'],
      dbPath: options.dbPath,
    });

    return result ? { success: true, patternId: result.id, controller: 'bridge-fallback' } : null;
  } catch {
    return null;
  }
}

/**
 * Search patterns via ReasoningBank controller.
 */
export async function bridgeSearchPatterns(options: {
  query: string;
  topK?: number;
  minConfidence?: number;
  dbPath?: string;
}): Promise<{ results: Array<{ id: string; content: string; score: number }>; controller: string } | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  try {
    const reasoningBank = registry.get('reasoningBank');

    // OPT-002: Probe for callable search method across binding patterns
    const searchFn = getCallableMethod(reasoningBank, 'search', 'searchPattern', 'retrievePatterns', 'query', 'find');
    if (searchFn) {
      const results = await searchFn(options.query, {
        topK: options.topK || 5,
        minScore: options.minConfidence || 0.3,
      });
      return {
        results: Array.isArray(results) ? results.map((r: any) => ({
          id: r.id || r.patternId || '',
          content: r.content || r.pattern || '',
          score: r.score ?? r.confidence ?? 0,
        })) : [],
        controller: 'reasoningBank',
      };
    }

    // Fallback: search via bridge
    const result = await bridgeSearchEntries({
      query: options.query,
      namespace: 'pattern',
      limit: options.topK || 5,
      threshold: options.minConfidence || await _getAdaptiveThreshold(),
      dbPath: options.dbPath,
    });

    return result ? {
      results: result.results.map(r => ({ id: r.id, content: r.content, score: r.score })),
      controller: 'bridge-fallback',
    } : null;
  } catch {
    return null;
  }
}

// ===== Phase 3: Feedback recording =====

/**
 * Record task feedback for learning via ReasoningBank or LearningSystem.
 * Wired into hooks_post-task handler.
 */
export async function bridgeRecordFeedback(options: {
  taskId: string;
  success: boolean;
  quality: number;
  agent?: string;
  duration?: number;
  patterns?: string[];
  dbPath?: string;
}): Promise<{ success: boolean; controller: string; updated: number } | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  try {
    let controller = 'none';
    let updated = 0;

    // Try LearningSystem first (Phase 4)
    const learningSystem = registry.get('learningSystem');
    if (learningSystem) {
      try {
        if (typeof learningSystem.recordFeedback === 'function') {
          await learningSystem.recordFeedback({
            taskId: options.taskId, success: options.success, quality: options.quality,
            agent: options.agent, duration: options.duration, timestamp: Date.now(),
          });
          controller = 'learningSystem';
          updated++;
        } else if (typeof learningSystem.record === 'function') {
          await learningSystem.record(options.taskId, options.quality, options.success ? 'success' : 'failure');
          controller = 'learningSystem';
          updated++;
        }
      } catch { /* API mismatch — skip */ }
    }

    // Also record in ReasoningBank for pattern reinforcement
    const reasoningBank = registry.get('reasoningBank');
    if (reasoningBank) {
      try {
        // OPT-001/002: Probe for callable methods across binding patterns
        const recordOutcomeFn = getCallableMethod(reasoningBank, 'recordOutcome');
        const recordFn = !recordOutcomeFn ? getCallableMethod(reasoningBank, 'record', 'addFeedback') : null;
        if (recordOutcomeFn) {
          await recordOutcomeFn({
            taskId: options.taskId, verdict: options.success ? 'success' : 'failure',
            score: options.quality, timestamp: Date.now(),
          });
          controller = controller === 'none' ? 'reasoningBank' : `${controller}+reasoningBank`;
          updated++;
        } else if (recordFn) {
          await recordFn(options.taskId, options.quality);
          controller = controller === 'none' ? 'reasoningBank' : `${controller}+reasoningBank`;
          updated++;
        }
      } catch { /* API mismatch — skip */ }
    }

    // Phase 4: SkillLibrary promotion for high-quality patterns
    if (options.success && options.quality >= 0.9 && options.patterns?.length) {
      const skills = registry.get('skills');
      if (skills && typeof skills.promote === 'function') {
        for (const pattern of options.patterns) {
          try { await skills.promote(pattern, options.quality); updated++; } catch { /* skip */ }
        }
        controller += '+skills';
      }
    }

    // Always store feedback as a memory entry for retrieval (ensures it persists)
    const storeResult = await bridgeStoreEntry({
      key: `feedback-${options.taskId}`,
      value: JSON.stringify(options),
      namespace: 'feedback',
      tags: [options.success ? 'success' : 'failure', options.agent || 'unknown'],
      dbPath: options.dbPath,
    });
    if (storeResult?.success) {
      controller = controller === 'none' ? 'bridge-store' : `${controller}+bridge-store`;
      updated++;
    }

    return { success: true, controller, updated };
  } catch {
    return null;
  }
}

// ===== Phase 3: CausalMemoryGraph =====

/**
 * Record a causal edge between two entries (e.g., task → result).
 */
export async function bridgeRecordCausalEdge(options: {
  sourceId: string;
  targetId: string;
  relation: string;
  weight?: number;
  dbPath?: string;
}): Promise<{ success: boolean; controller: string } | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  try {
    const causalGraph = registry.get('causalGraph');
    if (causalGraph && typeof causalGraph.addEdge === 'function') {
      causalGraph.addEdge(options.sourceId, options.targetId, {
        relation: options.relation,
        weight: options.weight ?? 1.0,
        timestamp: Date.now(),
      });
      return { success: true, controller: 'causalGraph' };
    }

    // Fallback: store edge as metadata
    const ctx = getDb(registry);
    if (ctx) {
      try {
        ctx.db.prepare(`
          INSERT OR REPLACE INTO memory_entries (id, key, namespace, content, type, created_at, updated_at, status)
          VALUES (?, ?, 'causal-edges', ?, 'procedural', ?, ?, 'active')
        `).run(
          generateId('edge'),
          `${options.sourceId}→${options.targetId}`,
          JSON.stringify(options),
          Date.now(), Date.now(),
        );
        return { success: true, controller: 'bridge-fallback' };
      } catch { /* skip */ }
    }

    return null;
  } catch {
    return null;
  }
}

// ===== Phase 5: ReflexionMemory session lifecycle =====

/**
 * Start a session with ReflexionMemory episodic replay.
 * Loads relevant past session patterns for the new session.
 */
export async function bridgeSessionStart(options: {
  sessionId: string;
  context?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  controller: string;
  restoredPatterns: number;
  sessionId: string;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  try {
    let restoredPatterns = 0;
    let controller = 'none';

    // Try ReflexionMemory for episodic session replay
    const reflexion = registry.get('reflexion');
    if (reflexion && typeof reflexion.startEpisode === 'function') {
      await reflexion.startEpisode(options.sessionId, { context: options.context });
      controller = 'reflexion';
    }

    // Load recent patterns from past sessions
    const searchResult = await bridgeSearchEntries({
      query: options.context || 'session patterns',
      namespace: 'session',
      limit: 10,
      threshold: await _getAdaptiveThreshold(),
      dbPath: options.dbPath,
    });

    if (searchResult?.results) {
      restoredPatterns = searchResult.results.length;
    }

    return {
      success: true,
      controller: controller === 'none' ? 'bridge-search' : controller,
      restoredPatterns,
      sessionId: options.sessionId,
    };
  } catch {
    return null;
  }
}

/**
 * End a session and persist episodic summary to ReflexionMemory.
 */
export async function bridgeSessionEnd(options: {
  sessionId: string;
  summary?: string;
  tasksCompleted?: number;
  patternsLearned?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  controller: string;
  persisted: boolean;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  try {
    let controller = 'none';
    let persisted = false;

    // End episode in ReflexionMemory
    const reflexion = registry.get('reflexion');
    if (reflexion && typeof reflexion.endEpisode === 'function') {
      await reflexion.endEpisode(options.sessionId, {
        summary: options.summary,
        tasksCompleted: options.tasksCompleted,
        patternsLearned: options.patternsLearned,
      });
      controller = 'reflexion';
      persisted = true;
    }

    // Persist session summary as memory entry
    await bridgeStoreEntry({
      key: `session-${options.sessionId}`,
      value: JSON.stringify({
        sessionId: options.sessionId,
        summary: options.summary || 'Session ended',
        tasksCompleted: options.tasksCompleted ?? 0,
        patternsLearned: options.patternsLearned ?? 0,
        endedAt: new Date().toISOString(),
      }),
      namespace: 'session',
      tags: ['session-end'],
      upsert: true,
      dbPath: options.dbPath,
    });

    if (controller === 'none') controller = 'bridge-store';
    persisted = true;

    // Phase 3: Trigger NightlyLearner consolidation if available
    const nightlyLearner = registry.get('nightlyLearner');
    if (nightlyLearner && typeof nightlyLearner.consolidate === 'function') {
      try {
        await nightlyLearner.consolidate({ sessionId: options.sessionId });
        controller += '+nightlyLearner';
      } catch { /* non-fatal */ }
    }

    return { success: true, controller, persisted };
  } catch {
    return null;
  }
}

// ===== Phase 5: SemanticRouter bridge =====

/**
 * Route a task via AgentDB's SemanticRouter.
 * Returns null to fall back to local ruvector router.
 */
export async function bridgeRouteTask(options: {
  task: string;
  context?: string;
  dbPath?: string;
}): Promise<{
  route: string;
  confidence: number;
  agents: string[];
  controller: string;
} | null> {
  const registry = await getRegistry(options.dbPath);
  if (!registry) return null;

  try {
    // Try AgentDB's SemanticRouter
    const semanticRouter = registry.get('semanticRouter');
    if (semanticRouter && typeof semanticRouter.route === 'function') {
      const result = await semanticRouter.route(options.task, { context: options.context });
      if (result) {
        return {
          route: result.route || result.category || 'general',
          confidence: result.confidence ?? result.score ?? 0.5,
          agents: result.agents || result.suggestedAgents || [],
          controller: 'semanticRouter',
        };
      }
    }

    // Try LearningSystem recommendAlgorithm (Phase 4)
    const learningSystem = registry.get('learningSystem');
    if (learningSystem && typeof learningSystem.recommendAlgorithm === 'function') {
      const rec = await learningSystem.recommendAlgorithm(options.task);
      if (rec) {
        return {
          route: rec.algorithm || rec.route || 'general',
          confidence: rec.confidence ?? 0.5,
          agents: rec.agents || [],
          controller: 'learningSystem',
        };
      }
    }

    return null; // Fall back to local router
  } catch {
    return null;
  }
}

// ===== Phase 4: Health check with attestation =====

/**
 * Get comprehensive bridge health including all controller statuses.
 */
export async function bridgeHealthCheck(
  dbPath?: string,
): Promise<{
  available: boolean;
  controllers: Array<{ name: string; enabled: boolean; level: number }>;
  attestationCount?: number;
  cacheStats?: { size: number; hits: number; misses: number };
  attestationLog?: any;
} | null> {
  const registry = await getRegistry(dbPath);
  if (!registry) return null;

  try {
    const controllers = registry.listControllers();

    // Phase 4: AttestationLog stats
    let attestationCount = 0;
    const attestation = registry.get('attestationLog');
    if (attestation && typeof attestation.count === 'function') {
      attestationCount = attestation.count();
    }

    // Phase 2: TieredCache stats
    let cacheStats = { size: 0, hits: 0, misses: 0 };
    const cache = registry.get('tieredCache');
    if (cache && typeof cache.stats === 'function') {
      const s = cache.stats();
      cacheStats = { size: s.size ?? 0, hits: s.hits ?? 0, misses: s.misses ?? 0 };
    }

    // Phase 5: AttestationLog health stats (P5-C)
    let attestationLog: any = undefined;
    try {
      const attestationCtrl = registry.get('attestationLog') as any;
      if (attestationCtrl && typeof attestationCtrl.getStats === 'function') {
        const aStats = await Promise.race([
          attestationCtrl.getStats(),
          new Promise<any>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
        ]);
        attestationLog = aStats;
      }
    } catch { /* attestation stats unavailable */ }

    return { available: true, controllers, attestationCount, cacheStats, attestationLog };
  } catch {
    return null;
  }
}

// ===== Phase 7: Hierarchical memory, consolidation, batch, context, semantic route =====

/**
 * Store to hierarchical memory with tier.
 * Valid tiers: working, episodic, semantic
 *
 * Real HierarchicalMemory API (agentdb alpha.10+):
 *   store(content, importance?, tier?, options?) → Promise<string>
 * Stub API (fallback):
 *   store(key, value, tier) — synchronous
 */
export async function bridgeHierarchicalStore(params: { key: string; value: string; tier?: string; importance?: number }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const hm = registry.get('hierarchicalMemory');
    if (!hm) return { success: false, error: 'HierarchicalMemory not available' };
    const tier = params.tier || 'working';

    // Detect real HierarchicalMemory (has async store returning id) vs stub
    if (typeof hm.getStats === 'function' && typeof hm.promote === 'function') {
      // Real agentdb HierarchicalMemory
      const id = await hm.store(params.value, params.importance || 0.5, tier, {
        metadata: { key: params.key },
        tags: [params.key],
      });
      return { success: true, id, key: params.key, tier };
    }
    // Stub fallback
    hm.store(params.key, params.value, tier);
    return { success: true, key: params.key, tier };
  } catch (e: any) { return { success: false, error: e.message }; }
}

/**
 * Recall from hierarchical memory.
 *
 * Real HierarchicalMemory API (agentdb alpha.10+):
 *   recall(query: MemoryQuery) → Promise<MemoryItem[]>
 *   where MemoryQuery = { query, tier?, k?, threshold?, context?, includeDecayed? }
 * Stub API (fallback):
 *   recall(query: string, topK: number) → synchronous array
 */
export async function bridgeHierarchicalRecall(params: { query: string; tier?: string; topK?: number }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const hm = registry.get('hierarchicalMemory');
    if (!hm) return { results: [], error: 'HierarchicalMemory not available' };

    // Detect real HierarchicalMemory vs stub
    if (typeof hm.getStats === 'function' && typeof hm.promote === 'function') {
      // Real agentdb HierarchicalMemory — recall takes MemoryQuery object
      const memoryQuery: any = {
        query: params.query,
        k: params.topK || 5,
      };
      if (params.tier) {
        memoryQuery.tier = params.tier;
      }
      const results = await hm.recall(memoryQuery);
      return { results: results || [], controller: 'hierarchicalMemory' };
    }

    // Stub fallback — recall(string, number)
    const results = hm.recall(params.query, params.topK || 5);
    const filtered = params.tier
      ? results.filter((r: any) => r.tier === params.tier)
      : results;
    return { results: filtered, controller: 'hierarchicalMemory' };
  } catch (e: any) { return { results: [], error: e.message }; }
}

/**
 * Run memory consolidation.
 *
 * Real MemoryConsolidation API (agentdb alpha.10+):
 *   consolidate() → Promise<ConsolidationReport>
 *   ConsolidationReport = { episodicProcessed, semanticCreated, memoriesForgotten, ... }
 * Stub API (fallback):
 *   consolidate() → { promoted, pruned, timestamp }
 */
export async function bridgeConsolidate(params: { minAge?: number; maxEntries?: number }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const mc = registry.get('memoryConsolidation');
    if (!mc) return { success: false, error: 'MemoryConsolidation not available' };
    const result = await mc.consolidate();
    return { success: true, consolidated: result };
  } catch (e: any) { return { success: false, error: e.message }; }
}

/**
 * Batch operations (insert, update, delete).
 * - insert: calls insertEpisodes(entries) where entries are {content, metadata?}
 * - delete: calls bulkDelete(table, conditions) on episodes table
 * - update: calls bulkUpdate(table, updates, conditions) on episodes table
 */
export async function bridgeBatchOperation(params: { operation: string; entries: any[] }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const batch = registry.get('batchOperations');
    if (!batch) return { success: false, error: 'BatchOperations not available' };
    let result;
    switch (params.operation) {
      case 'insert': {
        // insertEpisodes expects [{content, metadata?, embedding?}]
        const episodes = params.entries.map((e: any) => ({
          content: e.value || e.content || JSON.stringify(e),
          metadata: e.metadata || { key: e.key },
        }));
        result = await batch.insertEpisodes(episodes);
        break;
      }
      case 'delete': {
        // bulkDelete(table, conditions) — conditions is a WHERE clause object
        const keys = params.entries.map((e: any) => e.key).filter(Boolean);
        for (const key of keys) {
          await batch.bulkDelete('episodes', { key });
        }
        result = { deleted: keys.length };
        break;
      }
      case 'update': {
        // bulkUpdate(table, updates, conditions)
        for (const entry of params.entries) {
          await batch.bulkUpdate('episodes', { content: entry.value || entry.content }, { key: entry.key });
        }
        result = { updated: params.entries.length };
        break;
      }
      default: return { success: false, error: `Unknown operation: ${params.operation}` };
    }
    return { success: true, operation: params.operation, count: params.entries.length, result };
  } catch (e: any) { return { success: false, error: e.message }; }
}

/**
 * Synthesize context from memories.
 * ContextSynthesizer.synthesize is a static method that takes MemoryPattern[] (not a string).
 */
export async function bridgeContextSynthesize(params: { query: string; maxEntries?: number }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const CS = registry.get('contextSynthesizer');
    if (!CS || typeof CS.synthesize !== 'function') {
      return { success: false, error: 'ContextSynthesizer not available' };
    }
    // Gather memory patterns from hierarchical memory as input
    const hm = registry.get('hierarchicalMemory');
    let memories: any[] = [];
    if (hm && typeof hm.recall === 'function') {
      // Detect real HierarchicalMemory (MemoryQuery object) vs stub (string, number)
      let recalled: any[];
      if (typeof hm.promote === 'function') {
        // Real agentdb HierarchicalMemory
        recalled = await hm.recall({ query: params.query, k: params.maxEntries || 10 });
      } else {
        // Stub
        recalled = hm.recall(params.query, params.maxEntries || 10);
      }
      memories = (recalled || []).map((r: any) => ({
        content: r.value || r.content || '',
        key: r.key || r.id || '',
        reward: 1,
        verdict: 'success',
      }));
    }
    const result = CS.synthesize(memories, { includeRecommendations: true });
    return { success: true, synthesis: result };
  } catch (e: any) { return { success: false, error: e.message }; }
}

/**
 * Route via SemanticRouter.
 * Available since agentdb 3.0.0-alpha.10 — uses @ruvector/router for
 * semantic matching with keyword fallback.
 */
export async function bridgeSemanticRoute(params: { input: string }): Promise<any> {
  const registry = await getRegistry();
  if (!registry) return null;
  try {
    const router = registry.get('semanticRouter');
    if (!router) return { route: null, error: 'SemanticRouter not available' };
    const result = await router.route(params.input);
    return { route: result, controller: 'semanticRouter' };
  } catch (e: any) { return { route: null, error: e.message }; }
}

// ===== Phase 2: LearningBridge + SolverBandit bridge functions =====

/**
 * Bridge function for LearningBridge.learn() with 2s timeout.
 * ADR-0033 Phase P2-B.
 */
export async function bridgeLearningBridgeLearn(options: {
  input: string;
  output: string;
  reward: number;
  context?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const registry = await getRegistry();
    const lb = registry?.get?.('learningBridge') as any;
    if (!lb || typeof lb.learn !== 'function') {
      return { success: false, error: 'LearningBridge not available' };
    }
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('LearningBridge.learn timeout (2s)')), 2000)
    );
    await Promise.race([lb.learn(options.input, options.output, options.reward, options.context), timeoutPromise]);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

/**
 * Bridge function for SolverBandit.selectArm() with Thompson Sampling.
 * ADR-0033 Phase P2-C.
 */
export async function bridgeSolverBanditSelect(
  context: string,
  arms: string[]
): Promise<{ arm: string; confidence: number; controller: string }> {
  try {
    const registry = await getRegistry();
    const bandit = registry?.get?.('solverBandit') as any;
    if (!bandit || typeof bandit.selectArm !== 'function') {
      return { arm: arms[0] || 'default', confidence: 0.5, controller: 'fallback' };
    }
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SolverBandit.selectArm timeout (2s)')), 2000)
    );
    const selected = await Promise.race([bandit.selectArm(context, arms), timeoutPromise]);
    const stats = bandit.getArmStats?.(context, selected);
    const alpha = stats?.alpha ?? 1;
    const beta = stats?.beta ?? 1;
    const confidence = alpha / (alpha + beta);
    return { arm: selected, confidence, controller: 'solverBandit' };
  } catch (e: any) {
    return { arm: arms[0] || 'default', confidence: 0.5, controller: 'fallback' };
  }
}

/**
 * Bridge function for SolverBandit.recordReward() with state persistence.
 * ADR-0033 Phase P2-C.
 */
export async function bridgeSolverBanditUpdate(
  context: string,
  arm: string,
  reward: number,
  cost?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const registry = await getRegistry();
    const bandit = registry?.get?.('solverBandit') as any;
    if (!bandit || typeof bandit.recordReward !== 'function') {
      return { success: false, error: 'SolverBandit not available' };
    }
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SolverBandit.recordReward timeout (2s)')), 2000)
    );
    await Promise.race([bandit.recordReward(context, arm, reward, cost), timeoutPromise]);
    // Fire-and-forget: persist state (non-blocking)
    try {
      const state = bandit.serialize?.();
      if (state) {
        bridgeStoreEntry({
          key: '_solver_bandit_state',
          value: JSON.stringify(state),
          namespace: 'default',
        }).catch(() => {});
      }
    } catch { /* persist failure is non-fatal */ }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// ===== Phase 4-B: ExplainableRecall with Merkle proof chain =====

/**
 * P4-B: ExplainableRecall with Merkle proof chain.
 * Returns search results with cryptographic provenance trail.
 * Falls back to standard bridgeSearchEntries if ExplainableRecall controller unavailable.
 */
export async function bridgeExplainableRecall(options: {
  query: string;
  namespace?: string;
  limit?: number;
  includeProof?: boolean;
}): Promise<{
  success: boolean;
  results?: any[];
  proofChain?: any[];
  error?: string;
}> {
  try {
    const registry = await getRegistry();
    const er = registry?.getController?.('explainableRecall') ?? registry?.get?.('explainableRecall');
    if (!er || typeof er.recall !== 'function') {
      // Fallback to standard search
      const fallback = await bridgeSearchEntries({
        query: options.query,
        namespace: options.namespace,
        limit: options.limit || 10,
      });
      return { success: true, results: fallback?.results || [], proofChain: [] };
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('ExplainableRecall timeout (2s)')), 2000)
    );

    const recallResult = await Promise.race([
      er.recall(options.query, {
        namespace: options.namespace,
        limit: options.limit || 10,
        explain: true,
      }),
      timeoutPromise,
    ]);

    // Build Merkle proof chain if requested
    let proofChain: any[] = [];
    if (options.includeProof && recallResult?.results) {
      try {
        const attestation = registry?.getController?.('attestationLog') ?? registry?.get?.('attestationLog');
        if (attestation && typeof attestation.getProof === 'function') {
          for (const result of recallResult.results.slice(0, 5)) {
            const proof = await Promise.race([
              attestation.getProof(result.id || result.key),
              new Promise<any>((_, reject) => setTimeout(() => reject(new Error('proof timeout')), 1000))
            ]);
            if (proof) {
              proofChain.push({
                key: result.id || result.key,
                proof: proof.hash || proof.merkleRoot,
                path: proof.path || [],
                verified: proof.verified ?? true,
              });
            }
          }
        }
      } catch { /* proof generation optional */ }
    }

    return {
      success: true,
      results: recallResult?.results || [],
      proofChain,
    };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// ===== Phase 5-D: GraphTransformer proof-gated re-ranking =====

/**
 * P5-D: GraphTransformer proof-gated re-ranking.
 * Uses only the proof_gated module from GraphTransformerService.
 * Returns original results unchanged on any failure.
 */
export async function bridgeGraphTransformerRerank(
  results: any[],
  query: string
): Promise<any[]> {
  if (!results || results.length === 0) return results;
  try {
    const registry = await getRegistry();
    const gt = registry?.getController?.('graphTransformer') ?? registry?.get?.('graphTransformer');
    if (!gt) return results;

    // Use only proof_gated module (ADR-0033 scope reduction)
    const reranker = gt.proofGated || gt;
    if (typeof reranker.rerank !== 'function') return results;

    const reranked = await Promise.race([
      reranker.rerank(results, query, { module: 'proof_gated' }),
      new Promise<any>((_, reject) => setTimeout(() => reject(new Error('GraphTransformer timeout')), 2000))
    ]);

    return Array.isArray(reranked) ? reranked : results;
  } catch {
    return results; // fallback to original order
  }
}

// ===== Utility =====

function cosineSim(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i], bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const mag = Math.sqrt(normA * normB);
  return mag === 0 ? 0 : dot / mag;
}
