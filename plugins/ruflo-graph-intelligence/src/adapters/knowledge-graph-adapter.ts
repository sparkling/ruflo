/**
 * Knowledge Graph Adapter (Wedge 4, ADR-123 Phase 4)
 *
 * `ruflo-knowledge-graph` builds an entity-relation graph via kg-extract.
 * This adapter exports it as a SparseMatrix so kg-importance(entity) becomes
 * a single-entry PR query — answering "which entity is most central" in
 * sub-millisecond on a 10k-node graph.
 */

import { createHash } from 'node:crypto';
import type { SparseEntry, SparseMatrix } from '../domain/types.js';
import type { SublinearAdapter, AdapterRegistry } from '../domain/adapter.js';
import { getRegistry } from '../domain/adapter.js';

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

  async exportAsSparseMatrix(options?: { nodeFilter?: ReadonlySet<string> }): Promise<SparseMatrix> {
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

export function registerKnowledgeGraphAdapter(
  options: KnowledgeGraphAdapterOptions & { registry?: AdapterRegistry },
): KnowledgeGraphAdapter {
  const adapter = new KnowledgeGraphAdapter(options);
  (options.registry ?? getRegistry()).register(adapter);
  return adapter;
}

function hashContent(graphId: string, entries: readonly SparseEntry[]): string {
  const h = createHash('sha256');
  h.update(graphId);
  for (const e of entries) h.update(`|${e.row},${e.col},${e.value.toFixed(8)}`);
  return h.digest('hex');
}
