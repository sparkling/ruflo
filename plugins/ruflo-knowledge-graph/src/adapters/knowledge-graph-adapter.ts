/**
 * Knowledge Graph Adapter — ADR-0261 Phase 4 (fork-native ADR-130)
 *
 * Fork-side port of upstream's `plugins/ruflo-graph-intelligence/src/adapters/
 * knowledge-graph-adapter.ts` (73 LOC of the ADR-130 P4 deliverable).
 *
 * Per ADR-0261 §R2.9 resolution: the fork has NO `ruflo-graph-intelligence`
 * plugin — only `ruflo-knowledge-graph`. The adapter is retargeted here. The
 * read path is adapted: instead of upstream's direct `sql.js` access via
 * `getBridgeDb()` (which doesn't exist in the fork), the adapter routes
 * through `archivist.dispatchRead('agentdb_graph_edge_query', ...)` per
 * ADR-0181 (audit-traceability) + ADR-0246 (per-op substrate acquisition).
 *
 * The catch-and-return-empty pattern from upstream is replaced with
 * throw-on-fatal per `feedback-best-effort-must-rethrow-fatals`.
 *
 * Bootstrap status (per ADR-0261 §R2.9 footnote): the plugin currently has
 * NO src/ runtime — it is a Claude Code skill/agent/command-only plugin
 * (markdown thought-templates). This adapter file lands as a structural
 * port; activation requires either:
 *   - A future ADR adding a typescript bootstrap to this plugin that
 *     reads `plugin.json.graph_adapter` and calls `createAutoGraphAdapter()`.
 *   - A consumer plugin (`ruflo-graph-intelligence`-equivalent) that
 *     imports this file directly.
 * Until then the file is shelfware-by-design, consistent with the ADR's
 * "subject to verification" carve-out.
 */

import { createHash } from 'node:crypto';

// ============================================================================
// Minimal types (inlined — the upstream `domain/types.ts` and
// `domain/adapter.ts` modules belong to `ruflo-graph-intelligence` which is
// NOT ported to the fork). Inlining keeps this file self-contained.
// ============================================================================

/** Sparse-matrix entry (row, col, value) — same shape as upstream. */
export interface SparseEntry {
  readonly row: number;
  readonly col: number;
  readonly value: number;
}

/** Sparse-matrix snapshot of the knowledge graph. */
export interface SparseMatrix {
  readonly graphId: string;
  readonly size: number;
  readonly entries: readonly SparseEntry[];
  readonly nodeIndex: Readonly<Record<string, number>>;
  readonly indexNode: readonly string[];
  readonly capturedAt: string;
  readonly contentHash: string;
}

/** Adapter contract — same shape as upstream's `SublinearAdapter`. */
export interface SublinearAdapter {
  readonly graphId: string;
  readonly ownerPlugin: string;
  readonly requiresPreprocessing: boolean;
  exportAsSparseMatrix(options?: {
    nodeFilter?: ReadonlySet<string>;
  }): Promise<SparseMatrix>;
}

/** Adapter registry contract — bare minimum to satisfy registration calls. */
export interface AdapterRegistry {
  register(adapter: SublinearAdapter): void;
}

/** Returns the process-wide adapter registry. */
let _registry: AdapterRegistry | null = null;
export function getRegistry(): AdapterRegistry {
  if (!_registry) {
    const adapters: SublinearAdapter[] = [];
    _registry = {
      register(a) {
        adapters.push(a);
      },
    };
  }
  return _registry;
}

// ============================================================================
// KGEdge / source-of-edges contract
// ============================================================================

export interface KGEdge {
  fromEntity: string;
  toEntity: string;
  relation: string;
  /** Edge confidence in [0,1]. Default 1.0. */
  confidence?: number;
}

export interface KnowledgeGraphSource {
  listEdges(): Promise<readonly KGEdge[]>;
}

// ============================================================================
// Wedge 4 — KnowledgeGraphAdapter (the upstream-ported "kg-importance"
// surface; verbatim from ADR-123 P4).
// ============================================================================

export interface KnowledgeGraphAdapterOptions {
  source: KnowledgeGraphSource;
  /** DD safety margin. Default 0.25. */
  ddSafetyMargin?: number;
}

export const KNOWLEDGE_GRAPH_ID = 'ruflo-knowledge-graph:entities';

export class KnowledgeGraphAdapter implements SublinearAdapter {
  readonly graphId = KNOWLEDGE_GRAPH_ID;
  readonly ownerPlugin = 'ruflo-knowledge-graph';
  readonly requiresPreprocessing = false;

  private readonly source: KnowledgeGraphSource;
  private readonly ddSafetyMargin: number;

  constructor(options: KnowledgeGraphAdapterOptions) {
    this.source = options.source;
    this.ddSafetyMargin = options.ddSafetyMargin ?? 0.25;
  }

  async exportAsSparseMatrix(options?: {
    nodeFilter?: ReadonlySet<string>;
  }): Promise<SparseMatrix> {
    const edges = await this.source.listEdges();
    const entitySet = new Set<string>();
    for (const e of edges) {
      entitySet.add(e.fromEntity);
      entitySet.add(e.toEntity);
    }
    if (options?.nodeFilter) {
      for (const n of [...entitySet]) if (!options.nodeFilter.has(n)) entitySet.delete(n);
    }

    const entities = [...entitySet].sort();
    const nodeIndex: Record<string, number> = {};
    entities.forEach((n, i) => (nodeIndex[n] = i));

    // Weight edges by confidence; if multiple relations exist between two
    // entities, sum confidences (cap at 1).
    const weights = new Map<string, number>();
    for (const e of edges) {
      const r = nodeIndex[e.fromEntity];
      const c = nodeIndex[e.toEntity];
      if (r === undefined || c === undefined || r === c) continue;
      const key = `${r},${c}`;
      weights.set(key, Math.min(1, (weights.get(key) ?? 0) + (e.confidence ?? 1)));
    }
    const entries: SparseEntry[] = [];
    const rowSums = new Array<number>(entities.length).fill(0);
    for (const [key, w] of weights) {
      const [rStr, cStr] = key.split(',');
      const r = Number(rStr);
      const c = Number(cStr);
      entries.push({ row: r, col: c, value: w });
      rowSums[r] += w;
    }
    for (let i = 0; i < entities.length; i++) {
      entries.push({ row: i, col: i, value: rowSums[i]! + this.ddSafetyMargin });
    }
    return {
      graphId: this.graphId,
      size: entities.length,
      entries,
      nodeIndex,
      indexNode: entities,
      capturedAt: new Date().toISOString(),
      contentHash: hashContent(this.graphId, entries),
    };
  }
}

function hashContent(graphId: string, entries: readonly SparseEntry[]): string {
  const h = createHash('sha256');
  h.update(graphId);
  for (const e of entries) h.update(`|${e.row},${e.col},${e.value.toFixed(8)}`);
  return h.digest('hex');
}

export function registerKnowledgeGraphAdapter(
  options: KnowledgeGraphAdapterOptions & { registry?: AdapterRegistry },
): KnowledgeGraphAdapter {
  const adapter = new KnowledgeGraphAdapter(options);
  (options.registry ?? getRegistry()).register(adapter);
  return adapter;
}

// ============================================================================
// ADR-0261 P4 — GraphEdgesSource: live edges read from graph_edges via the
// agentdb archivist (NOT upstream's `getBridgeDb()` sql.js path).
// ============================================================================

/**
 * KnowledgeGraphSource backed by graph_edges. Used when `autoRegister: true`
 * in a plugin's `plugin.json.graph_adapter` declaration.
 *
 * Read routing (fork-native, per ADR-0261 §R2):
 *   - Per-query substrate acquisition through
 *     `archivist.dispatchRead('agentdb_graph_edge_query', {action:'list', ...})`
 *   - NO module-scope cache (ADR-0202)
 *   - NO catch-and-return-empty (replaces upstream's
 *     `try { ... } catch { return []; }` — surfaces errors loudly per
 *     `feedback-best-effort-must-rethrow-fatals`)
 *
 * The cross-package dependency on `forks/agentdb`:
 *   - The archivist exposes a read handler under tool name
 *     `agentdb_graph_edge_query` returning `ReadonlyArray<GraphEdgeRow>`.
 *   - Agent A registers that handler at
 *     `forks/agentdb/src/archivist/handlers/agentdb/graph-edge.ts`.
 */
export interface GraphEdgesSourceOptions {
  /** Restrict the edge feed to specific relation types. */
  relationsFilter?: readonly string[];
  /** Page-size for the underlying read; defaults to 100000. */
  limit?: number;
}

/** Row shape returned by the archivist (mirrors graph_edges columns). */
interface GraphEdgeRow {
  readonly source_id: string;
  readonly target_id: string;
  readonly relation: string;
  readonly weight: number;
  readonly confidence: number;
}

export class GraphEdgesSource implements KnowledgeGraphSource {
  private readonly relationsFilter: readonly string[] | undefined;
  private readonly limit: number;

  constructor(options?: GraphEdgesSourceOptions) {
    this.relationsFilter = options?.relationsFilter;
    this.limit = options?.limit ?? 100000;
  }

  async listEdges(): Promise<readonly KGEdge[]> {
    // Lazy import of the cli's archivist accessor. The plugin has no
    // direct compile-time dependency on the cli's package; runtime
    // resolution against the installed `@sparkleideas/cli` or the local
    // dev mono-repo is provided by the consumer's module loader.
    //
    // We do NOT swallow import failures — if the cli isn't available,
    // the plugin author wired this in the wrong context, and the loud
    // error is the right surface (per feedback-best-effort-must-rethrow-
    // fatals + ADR-0261 §Risks criterion C6).
    type ArchivistAccessor = {
      getProcessArchivist(): Promise<{
        dispatchRead(
          tool: string,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          payload: any,
        ): Promise<unknown>;
      }>;
      ensureSqliteWired(): Promise<void>;
    };
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — dynamic cross-package import resolved at runtime
    const mod: ArchivistAccessor = await import('@sparkleideas/cli/dist/src/memory/archivist-init.js');

    await mod.ensureSqliteWired();
    const archivist = await mod.getProcessArchivist();
    const rows = (await archivist.dispatchRead('agentdb_graph_edge_query', {
      action: 'list',
      relation: undefined, // null = no relation filter at the SQL layer
      withEmbedding: false,
      limit: this.limit,
    })) as ReadonlyArray<GraphEdgeRow>;

    const filterSet = this.relationsFilter
      ? new Set(this.relationsFilter)
      : undefined;

    const out: KGEdge[] = [];
    for (const r of rows ?? []) {
      if (filterSet && !filterSet.has(r.relation)) continue;
      out.push({
        fromEntity: r.source_id,
        toEntity: r.target_id,
        relation: r.relation,
        confidence: typeof r.weight === 'number' ? r.weight : 1.0,
      });
    }
    return out;
  }
}

/**
 * Create a KnowledgeGraphAdapter backed by graph_edges (ADR-0261 §Phase 4).
 * This is the "autoRegister" path: no manual SublinearAdapter implementation
 * needed. Pair this with `plugin.json.graph_adapter.autoRegister = true`.
 */
export function createAutoGraphAdapter(options?: {
  relationsFilter?: string[];
  ddSafetyMargin?: number;
  registry?: AdapterRegistry;
}): KnowledgeGraphAdapter {
  const source = new GraphEdgesSource({ relationsFilter: options?.relationsFilter });
  return registerKnowledgeGraphAdapter({
    source,
    ddSafetyMargin: options?.ddSafetyMargin,
    registry: options?.registry,
  });
}

