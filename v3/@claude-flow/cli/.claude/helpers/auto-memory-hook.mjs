#!/usr/bin/env node
/**
 * Auto Memory Bridge Hook (ADR-048/049)
 *
 * Wires AutoMemoryBridge + LearningBridge + MemoryGraph into Claude Code
 * session lifecycle. Called by settings.json SessionStart/SessionEnd hooks.
 *
 * Usage:
 *   node auto-memory-hook.mjs import   # SessionStart: import auto memory files into backend
 *   node auto-memory-hook.mjs sync     # SessionEnd: sync insights back to MEMORY.md
 *   node auto-memory-hook.mjs status   # Show bridge status
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, '.claude-flow', 'data');
const STORE_PATH = join(DATA_DIR, 'auto-memory-store.json');

// Colors
const GREEN = '\x1b[0;32m';
const CYAN = '\x1b[0;36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const log = (msg) => console.log(`${CYAN}[AutoMemory] ${msg}${RESET}`);
const success = (msg) => console.log(`${GREEN}[AutoMemory] ✓ ${msg}${RESET}`);
const dim = (msg) => console.log(`  ${DIM}${msg}${RESET}`);

// Ensure data dir
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ============================================================================
// Simple JSON File Backend (implements IMemoryBackend interface)
// ============================================================================

class JsonFileBackend {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = new Map();
  }

  async initialize() {
    if (existsSync(this.filePath)) {
      try {
        const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const entry of data) this.entries.set(entry.id, entry);
        }
      } catch { /* start fresh */ }
    }
  }

  async shutdown() { this._persist(); }
  async store(entry) { this.entries.set(entry.id, entry); this._persist(); }
  async get(id) { return this.entries.get(id) ?? null; }
  async getByKey(key, ns) {
    for (const e of this.entries.values()) {
      if (e.key === key && (!ns || e.namespace === ns)) return e;
    }
    return null;
  }
  async update(id, updates) {
    const e = this.entries.get(id);
    if (!e) return null;
    if (updates.metadata) Object.assign(e.metadata, updates.metadata);
    if (updates.content !== undefined) e.content = updates.content;
    if (updates.tags) e.tags = updates.tags;
    e.updatedAt = Date.now();
    this._persist();
    return e;
  }
  async delete(id) { return this.entries.delete(id); }
  async query(opts) {
    let results = [...this.entries.values()];
    if (opts?.namespace) results = results.filter(e => e.namespace === opts.namespace);
    if (opts?.type) results = results.filter(e => e.type === opts.type);
    if (opts?.limit) results = results.slice(0, opts.limit);
    return results;
  }
  async search() { return []; } // No vector search in JSON backend
  async bulkInsert(entries) { for (const e of entries) this.entries.set(e.id, e); this._persist(); }
  async bulkDelete(ids) { let n = 0; for (const id of ids) { if (this.entries.delete(id)) n++; } this._persist(); return n; }
  async count() { return this.entries.size; }
  async listNamespaces() {
    const ns = new Set();
    for (const e of this.entries.values()) ns.add(e.namespace || 'default');
    return [...ns];
  }
  async clearNamespace(ns) {
    let n = 0;
    for (const [id, e] of this.entries) {
      if (e.namespace === ns) { this.entries.delete(id); n++; }
    }
    this._persist();
    return n;
  }
  async getStats() {
    return {
      totalEntries: this.entries.size,
      entriesByNamespace: {},
      entriesByType: { semantic: 0, episodic: 0, procedural: 0, working: 0, cache: 0 },
      memoryUsage: 0, avgQueryTime: 0, avgSearchTime: 0,
    };
  }
  async healthCheck() {
    return {
      status: 'healthy',
      components: {
        storage: { status: 'healthy', latency: 0 },
        index: { status: 'healthy', latency: 0 },
        cache: { status: 'healthy', latency: 0 },
      },
      timestamp: Date.now(), issues: [], recommendations: [],
    };
  }

  _persist() {
    try {
      const tmp = this.filePath + '.tmp';
      writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 2), 'utf-8');
      renameSync(tmp, this.filePath);
    } catch { /* best effort */ }
  }
}

// ============================================================================
// Resolve memory package path (local dev or npm installed)
// ============================================================================

async function loadMemoryPackage() {
  // Strategy 1: Local dev (built dist)
  const localDist = join(PROJECT_ROOT, 'v3/@claude-flow/memory/dist/index.js');
  if (existsSync(localDist)) {
    try {
      return await import(`file://${localDist}`);
    } catch { /* fall through */ }
  }

  // Strategy 2: Use createRequire for CJS-style resolution (handles nested node_modules
  // when installed as a transitive dependency via npx ruflo / npx claude-flow)
  try {
    const { createRequire } = await import('module');
    const require = createRequire(join(PROJECT_ROOT, 'package.json'));
    return require('@claude-flow/memory');
  } catch { /* fall through */ }

  // Strategy 3: ESM import (works when @claude-flow/memory is a direct dependency)
  try {
    return await import('@claude-flow/memory');
  } catch { /* fall through */ }

  // Strategy 4: Walk up from PROJECT_ROOT looking for memory package in any node_modules
  // ADR-0074 Phase 1a: check @sparkleideas/memory (published scope) AND @claude-flow/memory (dev scope)
  let searchDir = PROJECT_ROOT;
  const { parse } = await import('path');
  while (searchDir !== parse(searchDir).root) {
    for (const pkg of ['@sparkleideas/memory', '@claude-flow/memory']) {
      const candidate = join(searchDir, 'node_modules', ...pkg.split('/'), 'dist', 'index.js');
      if (existsSync(candidate)) {
        try {
          return await import(`file://${candidate}`);
        } catch { /* fall through */ }
      }
    }
    searchDir = dirname(searchDir);
  }

  return null;
}

// ============================================================================
// Read config from .claude-flow/config.json (YAML fallback for migration)
// ============================================================================

function readConfig() {
  const defaults = {
    backend: 'agentdb',
    learningBridge: { enabled: true, sonaMode: 'balanced', confidenceDecayRate: 0.005, accessBoostAmount: 0.03, consolidationThreshold: 10 },
    memoryGraph: { enabled: true, pageRankDamping: 0.85, maxNodes: 5000, similarityThreshold: 0.8 },
    agentScopes: { enabled: true, defaultScope: 'project' },
    agentdb: { enableLearning: true },
    syncMode: 'on-session-end',
  };

  // Primary: read .claude-flow/config.json
  const jsonPath = join(PROJECT_ROOT, '.claude-flow', 'config.json');
  if (existsSync(jsonPath)) {
    try {
      const cfg = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      const mem = cfg.memory || {};
      if (['hybrid', 'json', 'sqlite', 'agentdb'].includes(mem.backend)) defaults.backend = mem.backend;
      if (mem.learningBridge) Object.assign(defaults.learningBridge, mem.learningBridge);
      if (mem.memoryGraph) Object.assign(defaults.memoryGraph, mem.memoryGraph);
      if (mem.agentScopes) Object.assign(defaults.agentScopes, mem.agentScopes);
      if (mem.agentdb) Object.assign(defaults.agentdb, mem.agentdb);
      if (mem.syncMode) defaults.syncMode = mem.syncMode;
      return defaults;
    } catch (err) {
      console.error(`[FAIL] auto-memory.readConfig: ${err.message}`);
    }
  }

  // Fallback: read config.yaml for backward compat
  const yamlPath = join(PROJECT_ROOT, '.claude-flow', 'config.yaml');
  if (existsSync(yamlPath)) {
    try {
      const yaml = readFileSync(yamlPath, 'utf-8');
      const getBool = (key) => {
        const match = yaml.match(new RegExp(`${key}:\\s*(true|false)`, 'i'));
        return match ? match[1] === 'true' : undefined;
      };
      const getStr = (key) => {
        const match = yaml.match(new RegExp(`${key}:\\s*([\\w-]+)`, 'i'));
        return match ? match[1] : undefined;
      };
      const parsedBackend = getStr('backend');
      if (parsedBackend && ['hybrid', 'json', 'sqlite', 'agentdb'].includes(parsedBackend)) defaults.backend = parsedBackend;
      const lbEnabled = getBool('learningBridge[\\s\\S]*?enabled');
      if (lbEnabled !== undefined) defaults.learningBridge.enabled = lbEnabled;
      const mgEnabled = getBool('memoryGraph[\\s\\S]*?enabled');
      if (mgEnabled !== undefined) defaults.memoryGraph.enabled = mgEnabled;
      const asEnabled = getBool('agentScopes[\\s\\S]*?enabled');
      if (asEnabled !== undefined) defaults.agentScopes.enabled = asEnabled;
      defaults.syncMode = getStr('syncMode') || defaults.syncMode;
      dim('[config] Read from config.yaml (legacy).');
      return defaults;
    } catch { /* WM-003: legacy YAML parse failure, return defaults */
      return defaults;
    }
  }

  return defaults;
}

// ADR-0059 Phase 4: Daemon IPC helpers
async function tryDaemonIPC() {
  const socketPath = join(PROJECT_ROOT, '.claude-flow', 'daemon.sock');
  if (!existsSync(socketPath)) return null;
  try {
    const net = await import('node:net');
    return new Promise((resolve) => {
      const socket = net.createConnection(socketPath, () => {
        socket.destroy();
        resolve(socketPath);
      });
      socket.on('error', () => resolve(null));
      const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 50);
      socket.on('connect', () => clearTimeout(timer));
      socket.on('error', () => clearTimeout(timer));
    });
  } catch {
    return null;
  }
}

async function ipcCall(socketPath, method, params) {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; socket.destroy(); reject(new Error('IPC timeout')); }
    }, 500);
    const req = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }) + '\n';
    const socket = net.createConnection(socketPath, () => { socket.write(req); });
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const line = data.split('\n').find(l => l.trim());
        if (!line) return reject(new Error('empty IPC response'));
        const resp = JSON.parse(line);
        if (resp.error) reject(new Error(resp.error.message));
        else resolve(resp.result);
      } catch (e) { reject(e); }
    });
    socket.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
  });
}

// ADR-0059: Backend factory — RvfBackend preferred (same package, atomic persist)
function createBackend(config, memPkg) {
  if (config.backend === 'json') {
    return { backend: new JsonFileBackend(STORE_PATH) };
  }
  const swarmDir = join(PROJECT_ROOT, '.swarm');
  if (!existsSync(swarmDir)) mkdirSync(swarmDir, { recursive: true });
  const rvfPath = join(swarmDir, 'agentdb-memory.rvf');

  // Prefer RvfBackend — same package, no cross-package import, atomic persist
  if (memPkg.RvfBackend) {
    const backend = new memPkg.RvfBackend({ databasePath: rvfPath });
    return { backend };
  }
  // Fallback: AgentDBBackend (heavier but functional if agentdb is installed)
  if (memPkg.AgentDBBackend) {
    try {
      const backend = new memPkg.AgentDBBackend({ dbPath: rvfPath });
      return { backend };
    } catch (err) {
      dim(`AgentDBBackend init failed: ${err.message} — falling back to JSON`);
    }
  }
  // Last resort: JsonFileBackend
  dim('RvfBackend and AgentDBBackend unavailable — using JSON file backend');
  return { backend: new JsonFileBackend(STORE_PATH) };
}

// ============================================================================
// Commands
// ============================================================================

async function doImport() {
  log('Importing auto memory files into bridge...');

  // ADR-0059 Phase 4: Check daemon IPC availability
  const ipcSocket = await tryDaemonIPC();
  if (ipcSocket) {
    dim('[Phase 4] Daemon IPC available — daemon will handle memory operations');
  }

  const memPkg = await loadMemoryPackage();
  if (!memPkg || !memPkg.AutoMemoryBridge) {
    dim('Memory package not available — skipping auto memory import');
    return;
  }

  const config = readConfig();
  const { backend } = createBackend(config, memPkg);
  await backend.initialize();

  const bridgeConfig = {
    workingDir: PROJECT_ROOT,
    syncMode: config.syncMode || 'on-session-end',
  };

  // Wire learning if enabled and available
  if (config.learningBridge.enabled && memPkg.LearningBridge) {
    bridgeConfig.learning = {
      sonaMode: config.learningBridge.sonaMode,
      confidenceDecayRate: config.learningBridge.confidenceDecayRate,
      accessBoostAmount: config.learningBridge.accessBoostAmount,
      consolidationThreshold: config.learningBridge.consolidationThreshold,
    };
  }

  // Wire graph if enabled and available
  if (config.memoryGraph.enabled && memPkg.MemoryGraph) {
    bridgeConfig.graph = {
      pageRankDamping: config.memoryGraph.pageRankDamping,
      maxNodes: config.memoryGraph.maxNodes,
      similarityThreshold: config.memoryGraph.similarityThreshold,
    };
  }

  const bridge = new memPkg.AutoMemoryBridge(backend, bridgeConfig);

  try {
    const result = await bridge.importFromAutoMemory();
    success(`Imported ${result.imported} entries (${result.skipped} skipped)`);
    dim(`├─ Backend entries: ${await backend.count()}`);
    dim(`├─ Learning: ${config.learningBridge.enabled ? 'active' : 'disabled'}`);
    dim(`├─ Graph: ${config.memoryGraph.enabled ? 'active' : 'disabled'}`);
    dim(`└─ Agent scopes: ${config.agentScopes.enabled ? 'active' : 'disabled'}`);
  } catch (err) {
    dim(`Import failed (non-critical): ${err.message}`);
  }

  await backend.shutdown();
}

async function doSync() {
  log('Syncing insights to auto memory files...');

  // ADR-0059 Phase 4: Check daemon IPC availability
  const ipcSocket = await tryDaemonIPC();
  if (ipcSocket) {
    dim('[Phase 4] Daemon IPC available for sync');
  }

  const memPkg = await loadMemoryPackage();
  if (!memPkg || !memPkg.AutoMemoryBridge) {
    dim('Memory package not available — skipping sync');
    return;
  }

  const config = readConfig();
  const { backend } = createBackend(config, memPkg);
  await backend.initialize();

  const entryCount = await backend.count();
  if (entryCount === 0) {
    dim('No entries to sync');
    await backend.shutdown();
    return;
  }

  const bridgeConfig = {
    workingDir: PROJECT_ROOT,
    syncMode: config.syncMode || 'on-session-end',
  };

  if (config.learningBridge.enabled && memPkg.LearningBridge) {
    bridgeConfig.learning = {
      sonaMode: config.learningBridge.sonaMode,
      confidenceDecayRate: config.learningBridge.confidenceDecayRate,
      consolidationThreshold: config.learningBridge.consolidationThreshold,
    };
  }

  if (config.memoryGraph.enabled && memPkg.MemoryGraph) {
    bridgeConfig.graph = {
      pageRankDamping: config.memoryGraph.pageRankDamping,
      maxNodes: config.memoryGraph.maxNodes,
    };
  }

  const bridge = new memPkg.AutoMemoryBridge(backend, bridgeConfig);

  try {
    const syncResult = await bridge.syncToAutoMemory();
    success(`Synced ${syncResult.synced} entries to auto memory`);
    dim(`├─ Categories updated: ${syncResult.categories?.join(', ') || 'none'}`);
    dim(`└─ Backend entries: ${entryCount}`);

    // Curate MEMORY.md index with graph-aware ordering
    await bridge.curateIndex();
    success('Curated MEMORY.md index');
  } catch (err) {
    dim(`Sync failed (non-critical): ${err.message}`);
  }

  // ADR-0074 Phase 2: Drain CJS intelligence data into RvfBackend
  // The CJS intelligence.cjs writes ranked-context.json with PageRank + confidence scores.
  // This bridges the CJS/ESM silo by reading that JSON artifact and upserting into the
  // persistent backend, so memory_search and agentdb_pattern_store can see intelligence data.
  try {
    const rankedPath = join(PROJECT_ROOT, '.claude-flow', 'data', 'ranked-context.json');
    if (existsSync(rankedPath)) {
      const ranked = JSON.parse(readFileSync(rankedPath, 'utf-8'));
      const entries = ranked.entries || [];
      if (entries.length > 0) {
        const MAX_DRAIN = 500;
        const toDrain = entries.slice(0, MAX_DRAIN);
        let drained = 0;
        for (const entry of toDrain) {
          if (!entry.content && !entry.summary) continue;
          try {
            await backend.store({
              key: entry.id || `intel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              value: entry.content || entry.summary,
              namespace: entry.category || 'intelligence',
              metadata: {
                source: 'cjs-intelligence-drain',
                confidence: entry.confidence,
                pageRank: entry.pageRank,
                accessCount: entry.accessCount,
                drainedAt: Date.now(),
              },
            });
            drained++;
          } catch { /* skip individual entry failures */ }
        }
        if (drained > 0) {
          success(`Drained ${drained}/${entries.length} intelligence entries to backend (ADR-0074)`);
        }
      }
    }
  } catch (err) {
    dim(`Intelligence drain skipped: ${err.message}`);
  }

  if (bridge.destroy) bridge.destroy();
  await backend.shutdown();
}

async function doStatus() {
  const memPkg = await loadMemoryPackage();
  const config = readConfig();

  console.log('\n=== Auto Memory Bridge Status ===\n');
  console.log(`  Package:        ${memPkg?.AutoMemoryBridge ? 'Active (AutoMemoryBridge)' : memPkg ? '✅ Available' : '❌ Not found'}`);
  console.log(`  Store:          ${existsSync(STORE_PATH) ? '✅ ' + STORE_PATH : '⏸ Not initialized'}`);
  console.log(`  LearningBridge: ${config.learningBridge.enabled ? '✅ Enabled' : '⏸ Disabled'}`);
  console.log(`  MemoryGraph:    ${config.memoryGraph.enabled ? '✅ Enabled' : '⏸ Disabled'}`);
  console.log(`  AgentScopes:    ${config.agentScopes.enabled ? '✅ Enabled' : '⏸ Disabled'}`);

  if (existsSync(STORE_PATH)) {
    try {
      const data = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      console.log(`  Entries:        ${Array.isArray(data) ? data.length : 0}`);
    } catch { /* ignore */ }
  }

  const sockExists = existsSync(join(PROJECT_ROOT, '.claude-flow', 'daemon.sock'));
  console.log(`  Daemon IPC:     ${sockExists ? '\x1b[32mActive\x1b[0m (daemon.sock)' : '\x1b[2mUnavailable (fallback: direct RVF)\x1b[0m'}`);

  console.log('');
}

// ============================================================================
// Main
// ============================================================================

const command = process.argv[2] || 'status';

// Suppress unhandled rejection warnings from dynamic import() failures
process.on('unhandledRejection', () => {});

try {
  switch (command) {
    case 'import': await doImport(); break;
    case 'sync': await doSync(); break;
    case 'status': await doStatus(); break;
    default:
      console.log('Usage: auto-memory-hook.mjs <import|sync|status>');
      break;
  }
} catch (err) {
  // Hooks must never crash Claude Code - fail silently
  try { dim(`Error (non-critical): ${err.message}`); } catch (_) {}
}
// Force clean exit — process.exitCode alone isn't enough if async errors override it
process.exit(0);
