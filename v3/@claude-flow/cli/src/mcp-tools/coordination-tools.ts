/**
 * Coordination MCP Tools for CLI
 *
 * V2 Compatibility - Swarm coordination and orchestration tools
 *
 * ⚠️ IMPORTANT: These tools provide LOCAL STATE MANAGEMENT.
 * - Topology/consensus state is tracked locally
 * - No actual distributed coordination
 * - Useful for single-machine workflow orchestration
 *
 * ADR-0181 Phase 5 (W-coord) — call-site delegation. The six mutation
 * surfaces — `coordination_topology` (set), `coordination_load_balance`
 * (set / distribute), `coordination_sync` (trigger / resolve),
 * `coordination_node` (add / remove / heartbeat), `coordination_consensus`
 * (propose / vote), `coordination_orchestrate` — delegate to
 * `archivist.dispatch<'coordination_*'>(payload satisfies ToolPayloadMap[…])`.
 * The dispatch IS the write: it runs the guard chain, opens the audit
 * intent → applied transition, and performs the `withWrite` against
 * `.claude-flow/coordination/store.json` (all six storeIds route to the same
 * path via `fsJsonPathFor` overrides in `archivist/substrate-registry.ts`,
 * so the cli's existing `loadCoordStore()` sees archivist-applied state).
 * The cli no longer calls `saveCoordStore()`; it re-reads with
 * `loadCoordStore()` AFTER a successful dispatch to project the structured
 * response envelope. Pure-read actions (`get`/`status`/`info`/`list`/
 * `optimize`/`commit`) stay cli-side reads — no dispatch — per the
 * consolidated team-lead ruling: one dispatch per cli invocation, no
 * dispatch for non-mutating actions. `coordination_metrics` has no archivist
 * counterpart in `ToolPayloadMap` and remains cli-authoritative.
 *
 * Server-minted IDs (`orchestrationId`, `proposalId`) are recovered via a
 * before/after diff against the relevant array on the re-read store — the
 * archivist's `withWrite` lock + the cli's single-flight callsite make the
 * diff deterministic. See `coordination_orchestrate` and
 * `coordination_consensus propose` below.
 */

import { type MCPTool, findProjectRoot } from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProcessArchivist } from '../memory/archivist-init.js';
import type { ToolPayloadMap } from 'agentdb/archivist';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const COORD_DIR = 'coordination';
const COORD_FILE = 'store.json';

interface TopologyConfig {
  type: 'mesh' | 'hierarchical' | 'ring' | 'star' | 'hybrid' | 'hierarchical-mesh';
  maxNodes: number;
  redundancy: number;
  consensusAlgorithm: string;
}

interface LoadBalanceConfig {
  algorithm: 'round-robin' | 'least-connections' | 'weighted' | 'adaptive';
  weights: Record<string, number>;
  healthCheck: boolean;
}

interface SyncState {
  lastSync: string;
  syncCount: number;
  conflicts: number;
  pendingChanges: number;
}

interface CoordConsensusProposal {
  proposalId: string;
  type: string;
  proposal: unknown;
  proposedBy: string;
  proposedAt: string;
  votes: Record<string, boolean>;
  status: string;
  strategy: string;
  term?: number;
  quorumPreset?: string;
  byzantineVoters?: string[];
}

interface CoordConsensusResult {
  proposalId: string;
  result: string;
  votes: { for: number; against: number };
  decidedAt: string;
  strategy: string;
  term?: number;
  byzantineDetected?: string[];
}

interface CoordConsensusState {
  pending: CoordConsensusProposal[];
  history: CoordConsensusResult[];
}

interface CoordOrchestration {
  id: string;
  task: string;
  strategy: string;
  agents: ReadonlyArray<string>;
  status: 'scheduled';
  scheduledAt: string;
  topology: string;
}

interface CoordinationStore {
  topology: TopologyConfig;
  loadBalance: LoadBalanceConfig;
  sync: SyncState;
  nodes: Record<string, { id: string; status: string; load: number; lastHeartbeat: string }>;
  version: string;
  consensus?: CoordConsensusState;
  // Mirrors the archivist's canonical CoordinationStore shape (handlers/
  // coordination/shared.ts). The cli previously typed this via an inline
  // intersection cast (`store as CoordStoreShape`); the field is now part of
  // the cli's own interface so both `coordination_orchestrate` and any future
  // listing handler can read it without a cast.
  orchestrations?: CoordOrchestration[];
}

function getCoordPath(): string {
  return join(findProjectRoot(), STORAGE_DIR, COORD_DIR, COORD_FILE);
}

function loadCoordStore(): CoordinationStore {
  try {
    const path = getCoordPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return default store
  }
  return {
    topology: {
      type: 'hierarchical',
      maxNodes: 15,
      redundancy: 2,
      consensusAlgorithm: 'raft',
    },
    loadBalance: {
      algorithm: 'adaptive',
      weights: {},
      healthCheck: true,
    },
    sync: {
      lastSync: new Date().toISOString(),
      syncCount: 0,
      conflicts: 0,
      pendingChanges: 0,
    },
    nodes: {},
    version: '3.0.0',
  };
}

export const coordinationTools: MCPTool[] = [
  {
    name: 'coordination_topology',
    description: 'Configure swarm topology',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'optimize'], description: 'Action to perform' },
        type: { type: 'string', enum: ['mesh', 'hierarchical', 'ring', 'star', 'hybrid', 'hierarchical-mesh'], description: 'Topology type' },
        maxNodes: { type: 'number', description: 'Maximum nodes' },
        redundancy: { type: 'number', description: 'Redundancy level' },
        consensusAlgorithm: { type: 'string', enum: ['raft', 'byzantine', 'gossip', 'crdt'], description: 'Consensus algorithm' },
      },
    },
    handler: async (input) => {
      const action = (input.action as string) || 'get';

      if (action === 'get') {
        const store = loadCoordStore();
        return {
          success: true,
          topology: store.topology,
          nodes: Object.keys(store.nodes).length,
          status: 'active',
        };
      }

      if (action === 'set') {
        const payload = {
          action: 'set',
          type: input.type as ToolPayloadMap['coordination_topology']['type'],
          maxNodes: input.maxNodes as number | undefined,
          redundancy: input.redundancy as number | undefined,
          consensusAlgorithm: input.consensusAlgorithm as
            | ToolPayloadMap['coordination_topology']['consensusAlgorithm']
            | undefined,
        } satisfies ToolPayloadMap['coordination_topology'];
        await (await getProcessArchivist()).dispatch('coordination_topology', payload);
        const store = loadCoordStore();
        return {
          success: true,
          action: 'updated',
          topology: store.topology,
        };
      }

      if (action === 'optimize') {
        const store = loadCoordStore();
        // Analyze current state and suggest optimal topology
        const nodeCount = Object.keys(store.nodes).length;
        let recommended: TopologyConfig['type'] = 'hierarchical';

        if (nodeCount <= 5) {
          recommended = 'mesh';
        } else if (nodeCount <= 15) {
          recommended = 'hierarchical';
        } else {
          recommended = 'hybrid';
        }

        return {
          success: true,
          action: 'optimize',
          current: store.topology.type,
          recommended,
          reason: nodeCount <= 5
            ? 'Small cluster benefits from full mesh connectivity'
            : nodeCount <= 15
              ? 'Medium cluster works well with hierarchical coordination'
              : 'Large cluster needs hybrid approach for scalability',
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_load_balance',
    description: 'Configure load balancing',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'distribute'], description: 'Action to perform' },
        algorithm: { type: 'string', enum: ['round-robin', 'least-connections', 'weighted', 'adaptive'], description: 'Algorithm' },
        weights: { type: 'object', description: 'Node weights' },
        task: { type: 'string', description: 'Task to distribute' },
      },
    },
    handler: async (input) => {
      const action = (input.action as string) || 'get';

      if (action === 'get') {
        const store = loadCoordStore();
        const nodes = Object.values(store.nodes);
        const avgLoad = nodes.length > 0
          ? nodes.reduce((sum, n) => sum + n.load, 0) / nodes.length
          : 0;

        return {
          success: true,
          loadBalance: store.loadBalance,
          metrics: {
            nodeCount: nodes.length,
            avgLoad,
            maxLoad: nodes.length > 0 ? Math.max(...nodes.map(n => n.load)) : 0,
            minLoad: nodes.length > 0 ? Math.min(...nodes.map(n => n.load)) : 0,
          },
        };
      }

      if (action === 'set') {
        const payload = {
          action: 'set',
          algorithm: input.algorithm as
            | ToolPayloadMap['coordination_load_balance']['algorithm']
            | undefined,
          weights: input.weights as Record<string, number> | undefined,
        } satisfies ToolPayloadMap['coordination_load_balance'];
        await (await getProcessArchivist()).dispatch('coordination_load_balance', payload);
        const store = loadCoordStore();
        return {
          success: true,
          action: 'updated',
          loadBalance: store.loadBalance,
        };
      }

      if (action === 'distribute') {
        const task = input.task as string;
        // Pre-dispatch read: archivist `distribute` mints the picked node + load
        // counter internally; mirroring the pick here would diverge from the
        // handler's algorithm. Instead we dispatch and recover the result via a
        // before/after diff on `nodes[id].load` against the re-read store.
        const before = loadCoordStore();
        const beforeActive = Object.values(before.nodes).filter(n => n.status === 'active');
        if (beforeActive.length === 0) {
          return { success: false, error: 'No active nodes available' };
        }
        const beforeLoads = new Map(beforeActive.map(n => [n.id, n.load] as const));

        const payload = {
          action: 'distribute',
          task,
        } satisfies ToolPayloadMap['coordination_load_balance'];
        await (await getProcessArchivist()).dispatch('coordination_load_balance', payload);

        const after = loadCoordStore();
        const incremented = Object.values(after.nodes).find(
          n => n.status === 'active' && (beforeLoads.get(n.id) ?? n.load) < n.load,
        );
        if (!incremented) {
          throw new Error(
            'coordination_load_balance distribute: post-dispatch store shows no node-load increment; ' +
              'archivist dispatch returned without mutating store.nodes (no concurrent writer expected).',
          );
        }
        return {
          success: true,
          action: 'distributed',
          task,
          assignedTo: incremented.id,
          algorithm: after.loadBalance.algorithm,
          nodeLoad: incremented.load,
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_sync',
    description: 'Synchronize state across nodes',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'trigger', 'resolve'], description: 'Action to perform' },
        force: { type: 'boolean', description: 'Force synchronization' },
        conflictResolution: { type: 'string', enum: ['latest', 'merge', 'manual'], description: 'Conflict resolution strategy' },
      },
    },
    handler: async (input) => {
      const action = (input.action as string) || 'status';

      if (action === 'status') {
        const store = loadCoordStore();
        const timeSinceSync = Date.now() - new Date(store.sync.lastSync).getTime();

        return {
          success: true,
          sync: store.sync,
          timeSinceSync: `${Math.floor(timeSinceSync / 1000)}s`,
          status: store.sync.conflicts > 0 ? 'conflicts' : store.sync.pendingChanges > 0 ? 'pending' : 'synced',
        };
      }

      if (action === 'trigger') {
        const payload = {
          action: 'trigger',
          force: input.force as boolean | undefined,
        } satisfies ToolPayloadMap['coordination_sync'];
        await (await getProcessArchivist()).dispatch('coordination_sync', payload);
        const store = loadCoordStore();
        return {
          success: true,
          action: 'synchronized',
          syncCount: store.sync.syncCount,
          syncedAt: store.sync.lastSync,
          nodesSync: Object.keys(store.nodes).length,
        };
      }

      if (action === 'resolve') {
        const strategy = (input.conflictResolution as string) || 'latest';
        const before = loadCoordStore();
        const conflictsBefore = before.sync.conflicts;

        const payload = {
          action: 'resolve',
          conflictResolution: input.conflictResolution as
            | ToolPayloadMap['coordination_sync']['conflictResolution']
            | undefined,
        } satisfies ToolPayloadMap['coordination_sync'];
        await (await getProcessArchivist()).dispatch('coordination_sync', payload);

        if (conflictsBefore > 0) {
          return {
            success: true,
            action: 'resolved',
            strategy,
            conflictsResolved: conflictsBefore,
          };
        }
        return {
          success: true,
          action: 'resolve',
          message: 'No conflicts to resolve',
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_node',
    description: 'Manage coordination nodes',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'heartbeat', 'status', 'info'], description: 'Action to perform' },
        nodeId: { type: 'string', description: 'Node ID' },
        status: { type: 'string', description: 'Node status' },
      },
    },
    handler: async (input) => {
      const action = (input.action as string) || 'list';

      // `status` / `info` — return aggregate coordination-node health.
      // Accepts optional `nodeId` to return a single node's state.
      if (action === 'status' || action === 'info') {
        const store = loadCoordStore();
        const nodes = Object.values(store.nodes);
        const nodeId = input.nodeId as string | undefined;

        if (nodeId) {
          const node = store.nodes[nodeId];
          if (!node) {
            return { success: false, error: 'Node not found', nodeId };
          }
          return {
            success: true,
            status: node.status,
            node: {
              id: node.id,
              status: node.status,
              load: node.load,
              lastHeartbeat: node.lastHeartbeat,
            },
            ready: node.status === 'active',
          };
        }

        const activeCount = nodes.filter(n => n.status === 'active').length;
        return {
          success: true,
          status: activeCount > 0 || nodes.length === 0 ? 'healthy' : 'degraded',
          ready: true,
          online: activeCount,
          total: nodes.length,
          active: activeCount,
          nodes: nodes.map(n => ({
            id: n.id,
            status: n.status,
            load: n.load,
            lastHeartbeat: n.lastHeartbeat,
          })),
        };
      }

      if (action === 'list') {
        const store = loadCoordStore();
        const nodes = Object.values(store.nodes);

        return {
          success: true,
          nodes: nodes.map(n => ({
            id: n.id,
            status: n.status,
            load: n.load,
            lastHeartbeat: n.lastHeartbeat,
          })),
          total: nodes.length,
          active: nodes.filter(n => n.status === 'active').length,
        };
      }

      if (action === 'add') {
        // Mirror the archivist handler's nodeId default (`node-${Date.now()}`)
        // so we know which key to surface back; passing it explicitly also
        // makes the audit entry payload-hash deterministic for the same call.
        const nodeId = (input.nodeId as string) || `node-${Date.now()}`;
        const payload = {
          action: 'add',
          nodeId,
        } satisfies ToolPayloadMap['coordination_node'];
        await (await getProcessArchivist()).dispatch('coordination_node', payload);
        const store = loadCoordStore();
        return {
          success: true,
          action: 'added',
          nodeId,
          totalNodes: Object.keys(store.nodes).length,
        };
      }

      if (action === 'remove') {
        const nodeId = input.nodeId as string;
        // Archivist handler throws on unknown nodeId (`feedback-no-fallbacks`
        // divergence from cli's prior `success: false` short-circuit). Catch
        // the throw and surface as the same `success: false` envelope so
        // existing callers' branching is preserved.
        const payload = {
          action: 'remove',
          nodeId,
        } satisfies ToolPayloadMap['coordination_node'];
        try {
          await (await getProcessArchivist()).dispatch('coordination_node', payload);
        } catch (err) {
          return { success: false, error: (err as Error).message };
        }
        const store = loadCoordStore();
        return {
          success: true,
          action: 'removed',
          nodeId,
          totalNodes: Object.keys(store.nodes).length,
        };
      }

      if (action === 'heartbeat') {
        const nodeId = input.nodeId as string;
        // Archivist handler throws on unknown nodeId (the cli's prior silent
        // no-op masked caller bugs — `feedback-no-fallbacks` divergence). Catch
        // + surface as `success: false` envelope so the wire response shape
        // stays `{success, action, nodeId, timestamp}` for the known-node case.
        const payload = {
          action: 'heartbeat',
          nodeId,
        } satisfies ToolPayloadMap['coordination_node'];
        try {
          await (await getProcessArchivist()).dispatch('coordination_node', payload);
        } catch (err) {
          return { success: false, error: (err as Error).message, nodeId };
        }
        return {
          success: true,
          action: 'heartbeat',
          nodeId,
          timestamp: new Date().toISOString(),
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_consensus',
    description: 'Manage consensus protocol with BFT, Raft, or Quorum strategies',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'propose', 'vote', 'commit'], description: 'Action to perform' },
        proposal: { type: 'object', description: 'Proposal data (for propose)' },
        proposalId: { type: 'string', description: 'Proposal ID (for vote/commit/status)' },
        vote: { type: 'string', enum: ['accept', 'reject'], description: 'Vote' },
        voterId: { type: 'string', description: 'Voter node ID' },
        strategy: { type: 'string', enum: ['bft', 'raft', 'quorum'], description: 'Consensus strategy (default: raft)' },
        quorumPreset: { type: 'string', enum: ['unanimous', 'majority', 'supermajority'], description: 'Quorum threshold preset (default: majority)' },
        term: { type: 'number', description: 'Term number (for raft strategy)' },
      },
    },
    handler: async (input) => {
      const action = (input.action as string) || 'status';
      const strategy = (input.strategy as string) || 'raft';

      function calcRequired(strat: string, total: number, preset?: string): number {
        if (total <= 0) return 1;
        if (strat === 'bft') return Math.floor((total * 2) / 3) + 1;
        if (strat === 'quorum') {
          if (preset === 'unanimous') return total;
          if (preset === 'supermajority') return Math.floor((total * 2) / 3) + 1;
        }
        return Math.floor(total / 2) + 1;
      }

      function readConsensus(): {
        store: CoordinationStore;
        consensus: CoordConsensusState;
        nodeCount: number;
      } {
        const store = loadCoordStore();
        if (!store.consensus) {
          store.consensus = { pending: [], history: [] };
        }
        return {
          store,
          consensus: store.consensus,
          nodeCount: Object.keys(store.nodes).length || 1,
        };
      }

      if (action === 'status') {
        const { store, consensus, nodeCount } = readConsensus();
        if (input.proposalId) {
          // Status for specific proposal
          const p = consensus.pending.find(x => x.proposalId === input.proposalId);
          if (p) {
            const votesFor = Object.values(p.votes).filter(v => v).length;
            const votesAgainst = Object.values(p.votes).filter(v => !v).length;
            return {
              success: true,
              proposalId: p.proposalId,
              strategy: p.strategy,
              status: p.status,
              votesFor,
              votesAgainst,
              required: calcRequired(p.strategy, nodeCount, p.quorumPreset),
              totalNodes: nodeCount,
              resolved: false,
            };
          }
          const h = consensus.history.find(x => x.proposalId === input.proposalId);
          if (h) return { success: true, ...h, resolved: true, historical: true };
          return { success: false, error: 'Proposal not found' };
        }

        const quorum = calcRequired(strategy, nodeCount);
        return {
          success: true,
          algorithm: store.topology.consensusAlgorithm,
          strategy,
          nodes: nodeCount,
          quorum,
          pendingProposals: consensus.pending.length,
          resolvedProposals: consensus.history.length,
          status: nodeCount >= quorum ? 'operational' : 'degraded',
        };
      }

      if (action === 'propose') {
        // Pre-dispatch snapshot — the archivist mints the proposalId
        // server-side (`proposal-${Date.now()}-${random}`); we recover it via
        // before/after diff on `consensus.pending`.
        const before = readConsensus();
        const beforeIds = new Set(before.consensus.pending.map(p => p.proposalId));
        const quorumPreset = (input.quorumPreset as string) || 'majority';
        const term = (input.term as number) || 1;
        const required = calcRequired(strategy, before.nodeCount, quorumPreset);

        // Raft one-pending-per-term: the archivist handler throws on conflict
        // (`feedback-no-fallbacks`); catch + map to the cli's `success: false`
        // envelope so existing callers (CLI scripts, tests) see the
        // pre-flip wire shape (`existingProposalId` field preserved).
        if (strategy === 'raft') {
          const existing = before.consensus.pending.find(
            p => p.strategy === 'raft' && p.term === term,
          );
          if (existing) {
            return {
              success: false,
              error: `Raft term ${term} already has pending proposal: ${existing.proposalId}`,
              existingProposalId: existing.proposalId,
            };
          }
        }

        const payload = {
          action: 'propose',
          proposal: input.proposal,
          voterId: input.voterId as string | undefined,
          strategy: strategy as ToolPayloadMap['coordination_consensus']['strategy'],
          quorumPreset: quorumPreset as ToolPayloadMap['coordination_consensus']['quorumPreset'],
          term,
        } satisfies ToolPayloadMap['coordination_consensus'];
        await (await getProcessArchivist()).dispatch('coordination_consensus', payload);

        const after = readConsensus();
        const newProposal = after.consensus.pending.find(p => !beforeIds.has(p.proposalId));
        if (!newProposal) {
          throw new Error(
            'coordination_consensus propose: post-dispatch store shows no new pending proposal; ' +
              'archivist dispatch returned without appending to consensus.pending (no concurrent writer expected).',
          );
        }
        return {
          success: true,
          action: 'proposed',
          proposalId: newProposal.proposalId,
          proposal: input.proposal,
          strategy,
          status: 'pending',
          required,
          totalNodes: after.nodeCount,
          term: strategy === 'raft' ? term : undefined,
        };
      }

      if (action === 'vote') {
        // Pre-dispatch snapshot — needed both to fail-fast on missing
        // proposal/voterId (the archivist throws — we catch and translate to
        // the pre-flip `success: false` wire shape) AND to compute `required`
        // / detect byzantine outcomes from the post-dispatch state diff.
        const before = readConsensus();
        const pBefore = before.consensus.pending.find(x => x.proposalId === input.proposalId);
        if (!pBefore) return { success: false, error: 'Proposal not found or already resolved' };
        const voterId = input.voterId as string;
        if (!voterId) return { success: false, error: 'voterId is required' };

        const pStrategy = pBefore.strategy || 'raft';
        const required = calcRequired(pStrategy, before.nodeCount, pBefore.quorumPreset);

        const payload = {
          action: 'vote',
          proposalId: input.proposalId as string,
          vote: input.vote as ToolPayloadMap['coordination_consensus']['vote'],
          voterId,
          strategy: pStrategy as ToolPayloadMap['coordination_consensus']['strategy'],
        } satisfies ToolPayloadMap['coordination_consensus'];
        try {
          await (await getProcessArchivist()).dispatch('coordination_consensus', payload);
        } catch (err) {
          // The archivist handler signals four refusal modes via thrown
          // errors (the pre-flip cli used `success: false` envelopes):
          //   1. "Byzantine behaviour — voter ... attempted a conflicting
          //      vote on the same proposal" — same-proposal conflict; record
          //      persisted before the throw.
          //   2. "Byzantine behaviour — voter ... cast conflicting votes
          //      across proposals" — cross-proposal conflict; same.
          //   3. "voter '...' has already voted on this proposal" —
          //      non-byzantine double vote; no write.
          //   4. catch-all for proposal/voter input validation.
          // Translate (1) and (2) back to the byzantineDetected envelope by
          // re-reading the persisted byzantineVoters list; everything else
          // surfaces as the generic error envelope.
          const msg = (err as Error).message;
          if (msg.includes('Byzantine behaviour')) {
            const after = readConsensus();
            const pAfter = after.consensus.pending.find(x => x.proposalId === input.proposalId);
            const byzantineVoters = pAfter?.byzantineVoters ?? [];
            return {
              success: false,
              byzantineDetected: true,
              message: msg,
              byzantineVoters,
            };
          }
          return { success: false, error: msg };
        }

        // Successful vote: re-read to compute the response envelope. The
        // archivist may have moved the proposal to history (resolution); the
        // `status` field comes from whichever list it lands on.
        const after = readConsensus();
        const pAfterPending = after.consensus.pending.find(x => x.proposalId === input.proposalId);
        const pAfterHistory = after.consensus.history.find(
          x => x.proposalId === input.proposalId,
        );
        const resolved = pAfterHistory !== undefined;
        const result = resolved ? pAfterHistory.result : undefined;
        const votesFor = pAfterPending
          ? Object.values(pAfterPending.votes).filter(v => v).length
          : pAfterHistory?.votes.for ?? 0;
        const votesAgainst = pAfterPending
          ? Object.values(pAfterPending.votes).filter(v => !v).length
          : pAfterHistory?.votes.against ?? 0;
        const status = pAfterPending?.status ?? pAfterHistory?.result ?? 'pending';

        return {
          success: true,
          action: 'voted',
          proposalId: input.proposalId,
          voterId,
          vote: input.vote,
          strategy: pStrategy,
          votesFor,
          votesAgainst,
          required,
          totalNodes: after.nodeCount,
          resolved,
          result,
          status,
        };
      }

      if (action === 'commit') {
        // Commit is a no-op confirmation for already-resolved proposals —
        // pure read (no dispatch needed). The archivist's commit action is
        // also a read shape; aligning behaviour without re-dispatching keeps
        // ONE-dispatch-per-cli-invocation hygiene (no audit entries for
        // pure-read confirmation calls).
        if (input.proposalId) {
          const { consensus } = readConsensus();
          const h = consensus.history.find(x => x.proposalId === input.proposalId);
          if (h) {
            return {
              success: true,
              action: 'committed',
              proposalId: input.proposalId,
              result: h.result,
              committedAt: new Date().toISOString(),
            };
          }
          return { success: false, error: 'Proposal not found in resolved history. Vote must reach quorum first.' };
        }
        return { success: false, error: 'proposalId is required for commit' };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'coordination_orchestrate',
    description: 'Orchestrate multi-agent coordination',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task to orchestrate' },
        agents: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to coordinate' },
        strategy: { type: 'string', enum: ['parallel', 'sequential', 'pipeline', 'broadcast'], description: 'Orchestration strategy' },
        timeout: { type: 'number', description: 'Timeout in ms' },
      },
      required: ['task'],
    },
    handler: async (input) => {
      // ADR-093 F7: this tool only schedules an orchestration record — it
      // does not actually execute. The archivist handler mints the
      // orchestrationId server-side (`orch-${Date.now()}`); we recover it via
      // before/after diff on `store.orchestrations[]`.
      const task = input.task as string;
      const before = loadCoordStore();
      const agents = (input.agents as string[]) || Object.keys(before.nodes);
      const strategy = (input.strategy as string) || 'parallel';
      const beforeIds = new Set((before.orchestrations ?? []).map(o => o.id));

      const payload = {
        task,
        agents,
        strategy: strategy as ToolPayloadMap['coordination_orchestrate']['strategy'],
        timeout: input.timeout as number | undefined,
      } satisfies ToolPayloadMap['coordination_orchestrate'];
      await (await getProcessArchivist()).dispatch('coordination_orchestrate', payload);

      const after = loadCoordStore();
      const newOrch = (after.orchestrations ?? []).find(o => !beforeIds.has(o.id));
      if (!newOrch) {
        throw new Error(
          'coordination_orchestrate: post-dispatch store shows no new orchestration record; ' +
            'archivist dispatch returned without appending to store.orchestrations (no concurrent writer expected).',
        );
      }

      return {
        success: true,
        orchestrationId: newOrch.id,
        task,
        strategy,
        agents: newOrch.agents,
        status: 'scheduled',
        topology: after.topology.type,
        // Honest stub: no executor wired up yet. Don't lie about completion time.
        executor: 'none',
        _note: 'coordination_orchestrate currently records the orchestration request but does not execute it. For real multi-agent execution use agent_spawn + the Task tool, or hive-mind_spawn for queen-led coordination.',
      };
    },
  },
  {
    name: 'coordination_metrics',
    description: 'Get coordination metrics',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['all', 'latency', 'throughput', 'availability'], description: 'Metric type' },
        timeRange: { type: 'string', description: 'Time range' },
      },
    },
    handler: async (input) => {
      const store = loadCoordStore();
      const metric = (input.metric as string) || 'all';

      const nodes = Object.values(store.nodes);
      const activeNodes = nodes.filter(n => n.status === 'active');

      const metrics = {
        latency: {
          avg: null,
          p50: null,
          p95: null,
          p99: null,
          unit: 'ms',
          _note: 'Real-time latency metrics not available — coordination is state-tracking only',
        },
        throughput: {
          current: null,
          peak: null,
          avg: null,
          unit: 'ops/s',
          _note: 'Real-time throughput metrics not available — coordination is state-tracking only',
        },
        availability: {
          uptime: null,
          _note: 'Uptime not tracked — coordination store has no persistent start time',
          activeNodes: activeNodes.length,
          totalNodes: nodes.length,
          syncCount: store.sync.syncCount,
          lastSync: store.sync.lastSync,
          conflicts: store.sync.conflicts,
          pendingChanges: store.sync.pendingChanges,
          syncStatus: store.sync.conflicts === 0 ? 'healthy' : 'conflicts',
        },
      };

      if (metric === 'all') {
        return { success: true, metrics };
      }

      return {
        success: true,
        metric,
        data: metrics[metric as keyof typeof metrics],
      };
    },
  },
];
