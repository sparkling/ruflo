/**
 * Swarm MCP Tools for CLI
 *
 * Tool definitions for swarm coordination with file-based state persistence.
 * Replaces previous stub implementations with real state tracking.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  statSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, getProjectCwd } from './types.js';

// Swarm state persistence
// ADR-0069 A4: standardized on .swarm (was .claude-flow/swarm)
const SWARM_DIR = '.swarm';
const SWARM_STATE_FILE = 'swarm-state.json';

interface SwarmState {
  swarmId: string;
  topology: string;
  maxAgents: number;
  status: 'initializing' | 'running' | 'paused' | 'shutting_down' | 'terminated';
  agents: string[];
  tasks: string[];
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface SwarmStore {
  swarms: Record<string, SwarmState>;
  version: string;
}

function getSwarmDir(): string {
  return join(getProjectCwd(), SWARM_DIR);
}

function getSwarmStatePath(): string {
  return join(getSwarmDir(), SWARM_STATE_FILE);
}

function ensureSwarmDir(): void {
  const dir = getSwarmDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function loadSwarmStore(): SwarmStore {
  try {
    const path = getSwarmStatePath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch { /* return default */ }
  return { swarms: {}, version: '3.0.0' };
}

function saveSwarmStore(store: SwarmStore): void {
  // ADR-0098: atomic write (temp + rename) — prevents partial writes under the lock
  ensureSwarmDir();
  const path = getSwarmStatePath();
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, path);
}

// ADR-0098: cross-process file lock for swarm-state.json read-modify-write.
// Uses O_EXCL sentinel with stale-lock recovery (no external dep).
async function withSwarmStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${getSwarmStatePath()}.lock`;
  const MAX_WAIT_MS = 5000;
  const POLL_MS = 50;
  const STALE_LOCK_MS = 30_000;
  const deadline = Date.now() + MAX_WAIT_MS;

  ensureSwarmDir();

  // Acquire
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      writeSync(fd, `${process.pid}\n${Date.now()}\n`);
      closeSync(fd);
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'EEXIST') {
        try {
          const stat = statSync(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            continue;
          }
        } catch { /* lockfile vanished between check and stat — retry */ }
        if (Date.now() > deadline) {
          throw new Error(`Timeout waiting for swarm-state lock after ${MAX_WAIT_MS}ms`);
        }
        await new Promise(r => setTimeout(r, POLL_MS));
        continue;
      }
      throw err;
    }
  }

  try {
    return await fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

// Input validation
const VALID_TOPOLOGIES = new Set([
  'hierarchical', 'mesh', 'hierarchical-mesh', 'ring', 'star', 'hybrid', 'adaptive',
]);

// ADR-0098: dedupe TTL — only reuse running swarms updated within this window
const SWARM_REUSE_TTL_MS = 7 * 24 * 3600 * 1000;

export const swarmTools: MCPTool[] = [
  {
    name: 'swarm_init',
    description: 'Initialize a swarm with persistent state tracking. ADR-0098: reuses an existing running swarm with matching {topology, maxAgents, strategy} within 7-day TTL unless force=true.',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        topology: { type: 'string', description: 'Swarm topology type (hierarchical, mesh, hierarchical-mesh, ring, star, hybrid, adaptive)' },
        maxAgents: { type: 'number', description: 'Maximum number of agents (1-50)' },
        strategy: { type: 'string', description: 'Agent strategy (specialized, balanced, adaptive)' },
        config: { type: 'object', description: 'Additional swarm configuration' },
        force: { type: 'boolean', description: 'Force create a new swarm even if a matching running one exists within TTL (default: false)' },
        reason: { type: 'string', description: 'Optional rationale when force=true — advisory, logged for audit' },
      },
    },
    handler: async (input) => {
      const topology = (input.topology as string) || 'hierarchical-mesh';
      const maxAgents = Math.min(Math.max((input.maxAgents as number) || 15, 1), 50);
      const strategy = (input.strategy as string) || 'specialized';
      const config = (input.config || {}) as Record<string, unknown>;
      const force = input.force === true;
      const reason = input.reason as string | undefined;

      if (!VALID_TOPOLOGIES.has(topology)) {
        return {
          success: false,
          error: `Invalid topology: ${topology}. Valid: ${[...VALID_TOPOLOGIES].join(', ')}`,
        };
      }

      if (force && !reason) {
        // Advisory warning — ADR-0098 Flaw 4 mitigation: force=true without reason is a drift smell
        process.stderr.write(
          '[WARN] swarm_init called with force=true but no reason — ' +
          'prefer passing reason="..." to document why a fresh swarm is required\n',
        );
      }

      return withSwarmStoreLock(async () => {
        const store = loadSwarmStore();
        const now = new Date().toISOString();
        const nowMs = Date.now();

        // ADR-0098: config-fingerprint dedupe.
        // Find the most-recently-updated running swarm matching {topology, maxAgents, strategy}
        // within the TTL window. Skipped entirely when force=true.
        if (!force) {
          const candidates = Object.values(store.swarms)
            .filter(s =>
              s.status === 'running' &&
              s.topology === topology &&
              s.maxAgents === maxAgents &&
              (s.config as { strategy?: string }).strategy === strategy &&
              (nowMs - new Date(s.updatedAt).getTime()) < SWARM_REUSE_TTL_MS,
            )
            .sort(
              (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
            );

          if (candidates.length > 0) {
            const existing = candidates[0];
            existing.updatedAt = now;
            store.swarms[existing.swarmId] = existing;
            saveSwarmStore(store);
            return {
              success: true,
              swarmId: existing.swarmId,
              topology: existing.topology,
              strategy: (existing.config as { strategy?: string }).strategy ?? strategy,
              maxAgents: existing.maxAgents,
              initializedAt: existing.createdAt,
              config: existing.config,
              persisted: true,
              reused: true,
            };
          }
        }

        // No reuse candidate (or force=true): mint a new swarm.
        const swarmId = `swarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const swarmState: SwarmState = {
          swarmId,
          topology,
          maxAgents,
          status: 'running',
          agents: [],
          tasks: [],
          config: {
            topology,
            maxAgents,
            strategy,
            communicationProtocol: (config.communicationProtocol as string) || 'message-bus',
            autoScaling: (config.autoScaling as boolean) ?? true,
            consensusMechanism: (config.consensusMechanism as string) || 'majority',
          },
          createdAt: now,
          updatedAt: now,
        };

        store.swarms[swarmId] = swarmState;
        saveSwarmStore(store);

        return {
          success: true,
          swarmId,
          topology,
          strategy,
          maxAgents,
          initializedAt: now,
          config: swarmState.config,
          persisted: true,
          reused: false,
        };
      });
    },
  },
  {
    name: 'swarm_status',
    description: 'Get swarm status from persistent state',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID (omit for most recent)' },
      },
    },
    handler: async (input) => {
      const store = loadSwarmStore();
      const swarmId = input.swarmId as string;

      if (swarmId && store.swarms[swarmId]) {
        const swarm = store.swarms[swarmId];
        return {
          swarmId: swarm.swarmId,
          status: swarm.status,
          topology: swarm.topology,
          maxAgents: swarm.maxAgents,
          agentCount: swarm.agents.length,
          taskCount: swarm.tasks.length,
          config: swarm.config,
          createdAt: swarm.createdAt,
          updatedAt: swarm.updatedAt,
        };
      }

      // Return most recent swarm if no ID specified
      const swarmIds = Object.keys(store.swarms);
      if (swarmIds.length === 0) {
        return {
          status: 'no_swarm',
          message: 'No active swarms. Use swarm_init to create one.',
          totalSwarms: 0,
        };
      }

      const latest = swarmIds
        .map(id => store.swarms[id])
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];

      return {
        swarmId: latest.swarmId,
        status: latest.status,
        topology: latest.topology,
        maxAgents: latest.maxAgents,
        agentCount: latest.agents.length,
        taskCount: latest.tasks.length,
        config: latest.config,
        createdAt: latest.createdAt,
        updatedAt: latest.updatedAt,
        totalSwarms: swarmIds.length,
      };
    },
  },
  {
    name: 'swarm_shutdown',
    description: 'Shutdown a swarm and update persistent state',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID to shutdown' },
        graceful: { type: 'boolean', description: 'Graceful shutdown (default: true)' },
      },
    },
    handler: async (input) => {
      const store = loadSwarmStore();
      const swarmId = input.swarmId as string;

      // Find the swarm
      let target: SwarmState | undefined;
      if (swarmId && store.swarms[swarmId]) {
        target = store.swarms[swarmId];
      } else {
        // Shutdown most recent running swarm
        const running = Object.values(store.swarms)
          .filter(s => s.status === 'running')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        target = running[0];
      }

      if (!target) {
        return {
          success: false,
          error: swarmId ? `Swarm ${swarmId} not found` : 'No running swarms to shutdown',
        };
      }

      if (target.status === 'terminated') {
        return {
          success: false,
          swarmId: target.swarmId,
          error: 'Swarm already terminated',
        };
      }

      target.status = 'terminated';
      target.updatedAt = new Date().toISOString();
      saveSwarmStore(store);

      return {
        success: true,
        swarmId: target.swarmId,
        terminated: true,
        graceful: (input.graceful as boolean) ?? true,
        agentsTerminated: target.agents.length,
        terminatedAt: target.updatedAt,
      };
    },
  },
  {
    name: 'swarm_health',
    description: 'Check swarm health status with real state inspection',
    category: 'swarm',
    inputSchema: {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID to check' },
      },
    },
    handler: async (input) => {
      const store = loadSwarmStore();
      const swarmId = input.swarmId as string;

      // Find the swarm
      let target: SwarmState | undefined;
      if (swarmId) {
        target = store.swarms[swarmId];
        if (!target) {
          return {
            status: 'not_found',
            healthy: false,
            checks: [
              { name: 'swarm_exists', status: 'fail', message: `Swarm ${swarmId} not found` },
            ],
            checkedAt: new Date().toISOString(),
          };
        }
      } else {
        const running = Object.values(store.swarms)
          .filter(s => s.status === 'running')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        target = running[0];
      }

      if (!target) {
        return {
          status: 'no_swarm',
          healthy: false,
          checks: [
            { name: 'swarm_exists', status: 'fail', message: 'No active swarm found' },
          ],
          checkedAt: new Date().toISOString(),
        };
      }

      const isRunning = target.status === 'running';
      const stateFileExists = existsSync(getSwarmStatePath());

      const checks = [
        {
          name: 'coordinator',
          status: isRunning ? 'ok' : 'warn',
          message: isRunning ? 'Coordinator active' : `Swarm status: ${target.status}`,
        },
        {
          name: 'agents',
          status: target.agents.length > 0 ? 'ok' : 'info',
          message: `${target.agents.length} agents registered (max: ${target.maxAgents})`,
        },
        {
          name: 'persistence',
          status: stateFileExists ? 'ok' : 'warn',
          message: stateFileExists ? 'State file persisted' : 'State file missing',
        },
        {
          name: 'topology',
          status: 'ok',
          message: `Topology: ${target.topology}`,
        },
      ];

      const healthy = isRunning && stateFileExists;

      return {
        status: healthy ? 'healthy' : 'degraded',
        healthy,
        swarmId: target.swarmId,
        topology: target.topology,
        agentCount: target.agents.length,
        checks,
        checkedAt: new Date().toISOString(),
      };
    },
  },
];
