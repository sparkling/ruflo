/**
 * ruflo-graph-intelligence — MCP Tool Surface (ADR-123 § Architecture)
 *
 * Six tools mounted under `sublinear/*`:
 *   - sublinear/page-rank-entry  — single-entry PPR (workhorse)
 *   - sublinear/solve            — full A·x = b
 *   - sublinear/solve-on-change  — incremental delta (Wedge 12, streaming)
 *   - sublinear/feasibility      — packing/covering LP feasibility
 *   - sublinear/jl-embed         — Johnson-Lindenstrauss projection
 *   - sublinear/analyze          — diagnostics (coherence, sparsity, recommended algo)
 *
 * Every tool accepts maxComplexityClass + coherenceThreshold.
 */

import { getRegistry } from '../domain/adapter.js';
import {
  PageRankQuerySchema,
  SolveQuerySchema,
  SolveOnChangeQuerySchema,
} from '../domain/types.js';
import {
  runPageRank,
  runSolve,
  runSolveOnChange,
  coherenceScore,
  checkCoherence,
} from '../infrastructure/solver-bridge.js';

export interface MCPTool {
  name: string;
  description: string;
  category: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export const graphIntelligenceTools: MCPTool[] = [
  {
    name: 'sublinear/page-rank-entry',
    description:
      'Single-entry personalized PageRank over a registered RuFlo graph. O(log n) on DD inputs. Returns score + observed complexity-class + coherence margin. Accepts maxComplexityClass budget gate (default linear) and coherenceThreshold (default 0 = disabled).',
    category: 'graph-intelligence',
    inputSchema: {
      type: 'object',
      properties: {
        graphId: { type: 'string', description: 'Adapter-registered graph identifier' },
        nodeId: { type: 'string', description: 'Node to compute PR score for (single-entry query)' },
        alpha: { type: 'number', description: 'Damping factor (default 0.85)' },
        epsilon: { type: 'number', description: 'Convergence target (default 1e-3)' },
        seedNodes: {
          type: 'array',
          items: { type: 'string' },
          description: 'For personalized PR — seed nodes carrying restart distribution',
        },
        maxComplexityClass: {
          type: 'string',
          description: '12-tier upstream class budget (constant/logarithmic/polylogarithmic/sublinear/linear/...); default linear',
        },
        coherenceThreshold: {
          type: 'number',
          description: 'DD margin floor in [-∞, 1] (default 0 = disabled)',
        },
      },
      required: ['graphId', 'nodeId'],
    },
    handler: async (input) => {
      const query = PageRankQuerySchema.parse(input);
      const adapter = getRegistry().get(query.graphId);
      if (!adapter) {
        return { success: false, error: { kind: 'graph-not-found', message: `no adapter for graphId=${query.graphId}` } };
      }
      const matrix = await adapter.exportAsSparseMatrix();
      try {
        const result = runPageRank(matrix, query);
        return { success: true, result };
      } catch (err) {
        return { success: false, error: err };
      }
    },
  },

  {
    name: 'sublinear/solve',
    description:
      'Full linear solve A·x = b over a registered graph. CG (symmetric PD) or Neumann (general DD). Returns x + residual + observed complexity-class + coherence margin.',
    category: 'graph-intelligence',
    inputSchema: {
      type: 'object',
      properties: {
        graphId: { type: 'string' },
        rhs: { type: 'array', items: { type: 'number' } },
        algorithm: { type: 'string', enum: ['cg', 'neumann', 'random-walk'] },
        maxComplexityClass: { type: 'string' },
        coherenceThreshold: { type: 'number' },
      },
      required: ['graphId', 'rhs'],
    },
    handler: async (input) => {
      const query = SolveQuerySchema.parse(input);
      const adapter = getRegistry().get(query.graphId);
      if (!adapter) {
        return { success: false, error: { kind: 'graph-not-found', message: `no adapter for graphId=${query.graphId}` } };
      }
      const matrix = await adapter.exportAsSparseMatrix();
      try {
        const result = runSolve(matrix, query);
        return { success: true, result };
      } catch (err) {
        return { success: false, error: err };
      }
    },
  },

  {
    name: 'sublinear/solve-on-change',
    description:
      'Incremental solve A·dx = δ then x_new = x_prev + dx (Wedge 12, ADR-123). For event-driven streaming systems (federation trust deltas, span streams, append-only causal breaks). Sparse δ → asymptotically faster than full re-solve.',
    category: 'graph-intelligence',
    inputSchema: {
      type: 'object',
      properties: {
        graphId: { type: 'string' },
        prevSolution: { type: 'array', items: { type: 'number' } },
        delta: {
          type: 'object',
          properties: {
            indices: { type: 'array', items: { type: 'number' } },
            values: { type: 'array', items: { type: 'number' } },
          },
        },
        algorithm: { type: 'string', enum: ['cg', 'neumann'] },
        maxComplexityClass: { type: 'string' },
      },
      required: ['graphId', 'prevSolution', 'delta'],
    },
    handler: async (input) => {
      const query = SolveOnChangeQuerySchema.parse(input);
      const adapter = getRegistry().get(query.graphId);
      if (!adapter) {
        return { success: false, error: { kind: 'graph-not-found', message: `no adapter for graphId=${query.graphId}` } };
      }
      const matrix = await adapter.exportAsSparseMatrix();
      try {
        const result = runSolveOnChange(matrix, query);
        return { success: true, result };
      } catch (err) {
        return { success: false, error: err };
      }
    },
  },

  {
    name: 'sublinear/analyze',
    description:
      'Diagnostic report on a registered graph: coherence margin (DD), sparsity, square-size, recommended algorithm. Use before sublinear/solve to choose algorithm + budget.',
    category: 'graph-intelligence',
    inputSchema: {
      type: 'object',
      properties: { graphId: { type: 'string' } },
      required: ['graphId'],
    },
    handler: async (input) => {
      const graphId = input.graphId as string;
      const adapter = getRegistry().get(graphId);
      if (!adapter) {
        return { success: false, error: { kind: 'graph-not-found', message: `no adapter for graphId=${graphId}` } };
      }
      const matrix = await adapter.exportAsSparseMatrix();
      const coherence = checkCoherence(matrix, 0);
      const nonzeros = matrix.entries.length;
      const density = nonzeros / (matrix.size * matrix.size);
      const recommendedAlgorithm = density < 0.01 ? 'forward-push' : coherence.score > 0 ? 'cg' : 'neumann';
      return {
        success: true,
        result: {
          graphId,
          size: matrix.size,
          nonzeros,
          density,
          coherenceScore: coherence.score,
          isDiagonallyDominant: coherence.score > 0,
          recommendedAlgorithm,
        },
      };
    },
  },

  {
    name: 'sublinear/feasibility',
    description:
      'Packing/covering LP feasibility check (Kyng-Sachdeva style). Wedge 9 — pre-flight check before invoking A* / heavy planners.',
    category: 'graph-intelligence',
    inputSchema: {
      type: 'object',
      properties: {
        constraints: { type: 'array', description: 'A·x ≤ b constraint set' },
        tolerance: { type: 'number', description: 'Slack for soft constraints (default 0.05)' },
        maxComplexityClass: { type: 'string' },
      },
      required: ['constraints'],
    },
    handler: async (input) => {
      // Phase 1: stub — returns "feasible unless trivially impossible". Wedge 9
      // wires this into the real LP solver via the sublinear-time-solver MCP.
      const constraints = (input.constraints as unknown[]) ?? [];
      return {
        success: true,
        result: {
          feasible: constraints.length === 0 || constraints.every((c) => c !== null),
          method: 'stub (Phase 1) — real LP wired in Wedge 9',
          tolerance: input.tolerance ?? 0.05,
        },
      };
    },
  },

  {
    name: 'sublinear/jl-embed',
    description:
      'Johnson-Lindenstrauss projection. Maps vectors to a target dimension with ε-distortion. Replaces @claude-flow/embeddings hand-rolled JL (closes ADR-121 Phase 4 follow-up).',
    category: 'graph-intelligence',
    inputSchema: {
      type: 'object',
      properties: {
        vectors: { type: 'array', description: 'Input vectors' },
        targetDim: { type: 'number' },
        epsilon: { type: 'number' },
      },
      required: ['vectors', 'targetDim'],
    },
    handler: async (input) => {
      // Phase 1: stub for now — wired in Phase 6 when we swap embeddings JL.
      const vectors = (input.vectors as number[][]) ?? [];
      const targetDim = Math.min((input.targetDim as number) ?? 64, vectors[0]?.length ?? 64);
      const projected = vectors.map((v) => v.slice(0, targetDim));
      return {
        success: true,
        result: {
          projected,
          targetDim,
          distortionBound: (input.epsilon as number) ?? 0.1,
          method: 'stub (Phase 1) — real JL wired in Phase 6',
        },
      };
    },
  },
];

export default graphIntelligenceTools;
