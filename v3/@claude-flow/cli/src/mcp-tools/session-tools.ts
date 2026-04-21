/**
 * Session MCP Tools for CLI
 *
 * Tool definitions for session management with file persistence.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { writeFile as wfAsync, readFile as rfAsync, unlink as ulAsync, mkdir as mkAsync } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { type MCPTool, getProjectCwd } from './types.js';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const SESSION_DIR = 'sessions';

interface SessionRecord {
  sessionId: string;
  name: string;
  description?: string;
  value?: string;
  savedAt: string;
  stats: {
    tasks: number;
    agents: number;
    memoryEntries: number;
    totalSize: number;
  };
  data?: {
    memory?: Record<string, unknown>;
    tasks?: Record<string, unknown>;
    agents?: Record<string, unknown>;
  };
}

/**
 * PID-based advisory lock for session_save's read-modify-write sequence.
 * Mirrors the RVF backend lock pattern (ADR-0090 Tier B7) so concurrent
 * session_save writers see one-writer-at-a-time semantics and the P9-3
 * no-interleave invariant holds.
 */
async function acquireSessionLock(lockPath: string): Promise<void> {
  const lockDir = dirname(lockPath);
  try {
    await mkAsync(lockDir, { recursive: true });
  } catch (err: any) {
    if (err?.code && err.code !== 'EEXIST') throw err;
  }
  const maxWaitMs = 5000;
  const baseDelayMs = 20;
  const maxDelayMs = 500;
  const startTime = Date.now();
  let attempt = 0;
  while (Date.now() - startTime < maxWaitMs) {
    try {
      await wfAsync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
      return;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const content = await rfAsync(lockPath, 'utf-8');
        const parsed = JSON.parse(content) as { pid?: number; ts?: number };
        const pid = typeof parsed.pid === 'number' ? parsed.pid : -1;
        const ts = typeof parsed.ts === 'number' ? parsed.ts : 0;
        const staleMs = 5000;
        let pidAlive = true;
        try { process.kill(pid, 0); } catch { pidAlive = false; }
        if (!pidAlive || Date.now() - ts > staleMs) {
          try { await ulAsync(lockPath); } catch { /* concurrent reaper */ }
          continue;
        }
      } catch {
        try { await ulAsync(lockPath); } catch { /* concurrent reaper */ }
        continue;
      }
      const expDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter = expDelay * 0.5 * Math.random();
      await new Promise(r => setTimeout(r, expDelay + jitter));
      attempt++;
    }
  }
  throw new Error(
    `session_save: failed to acquire advisory lock after ${attempt} attempts over ${Date.now() - startTime}ms (budget=${maxWaitMs}ms)`,
  );
}

async function releaseSessionLock(lockPath: string): Promise<void> {
  try { await ulAsync(lockPath); } catch { /* lock may already be gone */ }
}

function getSessionDir(): string {
  return join(getProjectCwd(), STORAGE_DIR, SESSION_DIR);
}

function getSessionPath(sessionId: string): string {
  // Fail loud on missing/invalid IDs rather than reading .replace on undefined.
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(
      `getSessionPath: sessionId must be a non-empty string (got ${typeof sessionId})`,
    );
  }
  // Sanitize sessionId to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(getSessionDir(), `${safeId}.json`);
}

/**
 * Resolve a session handle (sessionId OR name) to a concrete SessionRecord.
 * Returns null if the handle cannot be resolved.
 */
function resolveSessionHandle(input: { sessionId?: unknown; name?: unknown }): SessionRecord | null {
  const sessionId = typeof input.sessionId === 'string' && input.sessionId.length > 0
    ? input.sessionId
    : undefined;
  const name = typeof input.name === 'string' && input.name.length > 0
    ? input.name
    : undefined;

  // Prefer sessionId if provided.
  if (sessionId) {
    const byId = loadSession(sessionId);
    if (byId) return byId;
  }

  // Fall back to name-based lookup.
  if (name) {
    const match = listSessions().find(s => s.name === name);
    if (match) return match;
  }

  return null;
}

function ensureSessionDir(): void {
  const dir = getSessionDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadSession(sessionId: string): SessionRecord | null {
  try {
    const path = getSessionPath(sessionId);
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return null on error
  }
  return null;
}

function saveSession(session: SessionRecord): void {
  ensureSessionDir();
  writeFileSync(getSessionPath(session.sessionId), JSON.stringify(session, null, 2), 'utf-8');
}

function listSessions(): SessionRecord[] {
  ensureSessionDir();
  const dir = getSessionDir();
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));

  const sessions: SessionRecord[] = [];
  for (const file of files) {
    try {
      const data = readFileSync(join(dir, file), 'utf-8');
      sessions.push(JSON.parse(data));
    } catch {
      // Skip invalid files
    }
  }

  return sessions;
}

// Load related stores for session data
async function loadRelatedStores(options: { includeMemory?: boolean; includeTasks?: boolean; includeAgents?: boolean }) {
  const data: SessionRecord['data'] = {};

  if (options.includeMemory) {
    // Route through memory-router so session_save sees the ACTIVE backend
    // (RVF primary per ADR-0086), not the legacy .claude-flow/memory/store.json
    // which may be empty or stale. Mirrors session_restore which already uses
    // routeMemoryOp on the re-populate side.
    try {
      const { routeMemoryOp } = await import('../memory/memory-router.js');
      const res = await routeMemoryOp({ type: 'list', limit: 100000 });
      if (res.success && Array.isArray(res.entries)) {
        const entriesMap: Record<string, unknown> = {};
        for (const entry of res.entries as Array<{ key?: string; id?: string; namespace?: string; content?: string; value?: string }>) {
          const k = entry.key ?? entry.id ?? '';
          if (k) entriesMap[k] = entry;
        }
        data.memory = { entries: entriesMap };
      }
    } catch { /* ignore — fall back to no memory in session */ }
  }

  if (options.includeTasks) {
    try {
      const taskPath = join(getProjectCwd(), STORAGE_DIR, 'tasks', 'store.json');
      if (existsSync(taskPath)) {
        data.tasks = JSON.parse(readFileSync(taskPath, 'utf-8'));
      }
    } catch { /* ignore */ }
  }

  if (options.includeAgents) {
    try {
      const agentPath = join(getProjectCwd(), STORAGE_DIR, 'agents', 'store.json');
      if (existsSync(agentPath)) {
        data.agents = JSON.parse(readFileSync(agentPath, 'utf-8'));
      }
    } catch { /* ignore */ }
  }

  return data;
}

export const sessionTools: MCPTool[] = [
  {
    name: 'session_save',
    description: 'Save current session state',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name' },
        description: { type: 'string', description: 'Session description' },
        value: { type: 'string', description: 'Opaque session value payload' },
        includeMemory: { type: 'boolean', description: 'Include memory in session' },
        includeTasks: { type: 'boolean', description: 'Include tasks in session' },
        includeAgents: { type: 'boolean', description: 'Include agents in session' },
      },
      required: ['name'],
    },
    handler: async (input) => {
      // RC-3b: input validation — fail fast BEFORE acquiring any lock so bad
      // input never competes for the advisory lock (ADR-0094 P11/P12).
      if (input.name === undefined || input.name === null) {
        return {
          success: false,
          error: "session_save: 'name' is required and must be a non-empty string (missing)",
        };
      }
      if (typeof input.name !== 'string') {
        return {
          success: false,
          error: `session_save: 'name' must be a string (got type ${typeof input.name}) — expected string`,
        };
      }
      if (input.name.length === 0) {
        return {
          success: false,
          error: "session_save: 'name' must be a non-empty string (invalid empty value)",
        };
      }
      if (input.name.length > 255) {
        return {
          success: false,
          error: "session_save: 'name' must be 1..255 chars (invalid length) — expected safe identifier",
        };
      }
      // Path traversal / control-char guard. Allowed: word chars, dot, dash,
      // space. Reject path separators, NUL, and parent traversal explicitly.
      if (input.name.includes('..') || /[\/\\\x00]/.test(input.name) || !/^[\w .-]+$/.test(input.name)) {
        return {
          success: false,
          error: "session_save: 'name' must match /^[\\w .-]{1,255}$/ — path traversal and separators are forbidden (invalid name)",
        };
      }

      // Optional `value` field — if present, must be a string. Silently
      // ignoring a wrong-type value would be ADR-0082 silent-pass.
      if (input.value !== undefined && input.value !== null && typeof input.value !== 'string') {
        return {
          success: false,
          error: `session_save: 'value' must be a string when provided (got type ${typeof input.value}) — expected string`,
        };
      }
      if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
        return {
          success: false,
          error: `session_save: 'description' must be a string when provided (got type ${typeof input.description}) — expected string`,
        };
      }

      const name = input.name;
      const lockPath = join(getSessionDir(), '.session.lock');

      // Load related data based on options (outside the lock — this is a
      // read of other stores and doesn't race with session file writes).
      const data = await loadRelatedStores({
        includeMemory: input.includeMemory as boolean,
        includeTasks: input.includeTasks as boolean,
        includeAgents: input.includeAgents as boolean,
      });

      const stats = {
        tasks: data.tasks ? Object.keys((data.tasks as { tasks?: object }).tasks || {}).length : 0,
        agents: data.agents ? Object.keys((data.agents as { agents?: object }).agents || {}).length : 0,
        memoryEntries: data.memory ? Object.keys((data.memory as { entries?: object }).entries || {}).length : 0,
        totalSize: 0,
      };

      // Ensure the session dir exists before taking the lock (acquireSessionLock
      // does mkdir on the lock's parent, which is the same dir — redundant but
      // harmless).
      ensureSessionDir();
      await acquireSessionLock(lockPath);
      try {
        // RC-2: name-reuse lookup under the lock. If a session with the same
        // name exists, overwrite at its sessionId instead of creating a new
        // file (idempotent: same name → same sessionId, updated fields).
        const existing = listSessions().find(s => s.name === name) ?? null;
        const sessionId = existing?.sessionId
          ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const session: SessionRecord = {
          sessionId,
          name,
          description: typeof input.description === 'string' ? input.description : undefined,
          value: typeof input.value === 'string' ? input.value : undefined,
          savedAt: new Date().toISOString(),
          stats,
          data: Object.keys(data).length > 0 ? data : undefined,
        };

        const sessionJson = JSON.stringify(session);
        session.stats.totalSize = Buffer.byteLength(sessionJson, 'utf-8');

        saveSession(session);

        return {
          success: true,
          sessionId,
          name: session.name,
          value: session.value,
          savedAt: session.savedAt,
          stats: session.stats,
          path: getSessionPath(sessionId),
          reused: existing !== null,
        };
      } finally {
        await releaseSessionLock(lockPath);
      }
    },
  },
  {
    name: 'session_restore',
    description: 'Restore a saved session',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to restore' },
        name: { type: 'string', description: 'Session name to restore' },
      },
    },
    handler: async (input) => {
      let session: SessionRecord | null = null;

      // Try to find by sessionId first
      if (input.sessionId) {
        session = loadSession(input.sessionId as string);
      }

      // Try to find by name if sessionId not found
      if (!session && input.name) {
        const sessions = listSessions();
        session = sessions.find(s => s.name === input.name) || null;
      }

      // Try to find latest if no params
      if (!session && !input.sessionId && !input.name) {
        const sessions = listSessions();
        if (sessions.length > 0) {
          sessions.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
          session = sessions[0];
        }
      }

      if (session) {
        // Restore data to respective stores (legacy JSON for backward compat)
        if (session.data?.memory) {
          const memoryDir = join(getProjectCwd(), STORAGE_DIR, 'memory');
          if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
          writeFileSync(join(memoryDir, 'store.json'), JSON.stringify(session.data.memory, null, 2), 'utf-8');

          // Also populate active SQLite database so memory-tools can find entries
          try {
            const { routeMemoryOp } = await import('../memory/memory-router.js');
            const memoryData = session.data.memory as { entries?: Record<string, { key?: string; id?: string; value?: string; content?: string; namespace?: string }> };
            if (memoryData.entries) {
              for (const entry of Object.values(memoryData.entries)) {
                const key = entry.key || entry.id || '';
                const value = entry.value || entry.content || '';
                if (key && value) {
                  await routeMemoryOp({
                    type: 'store',
                    key,
                    value,
                    namespace: entry.namespace || 'restored',
                    upsert: true,
                  });
                }
              }
            }
          } catch {
            // Legacy JSON restore is the fallback -- SQLite import may not be available
          }
        }
        if (session.data?.tasks) {
          const taskDir = join(getProjectCwd(), STORAGE_DIR, 'tasks');
          if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
          writeFileSync(join(taskDir, 'store.json'), JSON.stringify(session.data.tasks, null, 2), 'utf-8');
        }
        if (session.data?.agents) {
          const agentDir = join(getProjectCwd(), STORAGE_DIR, 'agents');
          if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
          writeFileSync(join(agentDir, 'store.json'), JSON.stringify(session.data.agents, null, 2), 'utf-8');
        }

        return {
          sessionId: session.sessionId,
          name: session.name,
          restored: true,
          restoredAt: new Date().toISOString(),
          stats: session.stats,
        };
      }

      return {
        sessionId: input.sessionId || input.name || 'latest',
        restored: false,
        error: 'Session not found',
      };
    },
  },
  {
    name: 'session_list',
    description: 'List saved sessions',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum sessions to return' },
        sortBy: { type: 'string', description: 'Sort field (date, name, size)' },
      },
    },
    handler: async (input) => {
      let sessions = listSessions();

      // Sort
      const sortBy = (input.sortBy as string) || 'date';
      if (sortBy === 'date') {
        sessions.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
      } else if (sortBy === 'name') {
        sessions.sort((a, b) => a.name.localeCompare(b.name));
      } else if (sortBy === 'size') {
        sessions.sort((a, b) => b.stats.totalSize - a.stats.totalSize);
      }

      // Apply limit
      const limit = (input.limit as number) || 10;
      sessions = sessions.slice(0, limit);

      return {
        sessions: sessions.map(s => ({
          sessionId: s.sessionId,
          name: s.name,
          description: s.description,
          savedAt: s.savedAt,
          stats: s.stats,
        })),
        total: sessions.length,
        limit,
      };
    },
  },
  {
    name: 'session_delete',
    description: 'Delete a saved session (by sessionId or name)',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to delete' },
        name: { type: 'string', description: 'Session name to delete (alternative to sessionId)' },
      },
      // Neither field is strictly required at the schema level because either is accepted;
      // the handler fails loud if both are missing.
    },
    handler: async (input) => {
      const sessionIdInput = typeof input.sessionId === 'string' ? input.sessionId : undefined;
      const nameInput = typeof input.name === 'string' ? input.name : undefined;

      if (!sessionIdInput && !nameInput) {
        throw new Error(
          "session_delete: must provide either 'sessionId' or 'name' (both were missing or empty)",
        );
      }

      const session = resolveSessionHandle({ sessionId: sessionIdInput, name: nameInput });
      if (!session) {
        return {
          sessionId: sessionIdInput,
          name: nameInput,
          deleted: false,
          error: 'Session not found',
        };
      }

      const path = getSessionPath(session.sessionId);
      if (existsSync(path)) {
        unlinkSync(path);
        return {
          sessionId: session.sessionId,
          name: session.name,
          deleted: true,
          deletedAt: new Date().toISOString(),
        };
      }

      // Record exists in listing but file is gone — still a "not found" from caller's POV.
      return {
        sessionId: session.sessionId,
        name: session.name,
        deleted: false,
        error: 'Session not found',
      };
    },
  },
  {
    name: 'session_info',
    description: 'Get detailed session information (by sessionId or name)',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        name: { type: 'string', description: 'Session name (alternative to sessionId)' },
      },
    },
    handler: async (input) => {
      const sessionIdInput = typeof input.sessionId === 'string' ? input.sessionId : undefined;
      const nameInput = typeof input.name === 'string' ? input.name : undefined;

      if (!sessionIdInput && !nameInput) {
        throw new Error(
          "session_info: must provide either 'sessionId' or 'name' (both were missing or empty)",
        );
      }

      const session = resolveSessionHandle({ sessionId: sessionIdInput, name: nameInput });

      if (session) {
        const path = getSessionPath(session.sessionId);
        const stat = statSync(path);

        return {
          sessionId: session.sessionId,
          name: session.name,
          description: session.description,
          savedAt: session.savedAt,
          stats: session.stats,
          fileSize: stat.size,
          path,
          hasData: {
            memory: !!session.data?.memory,
            tasks: !!session.data?.tasks,
            agents: !!session.data?.agents,
          },
        };
      }

      return {
        sessionId: sessionIdInput,
        name: nameInput,
        error: 'Session not found',
      };
    },
  },
];
