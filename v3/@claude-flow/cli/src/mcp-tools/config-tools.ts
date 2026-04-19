/**
 * Config MCP Tools for CLI
 *
 * Tool definitions for configuration management with file persistence.
 *
 * Shape tolerance (ADR-0094 Phase 8 INV-6):
 *   • "mcp"     → flat top-level {values:{…}, scopes:{…}, version, updatedAt}
 *                 — historical shape written by these tools themselves.
 *   • "legacy"  → the whole parsed JSON IS the value tree (as emitted by
 *                 `init` / `config-template.ts` / `ConfigFileManager`:
 *                 {version, swarm:{…}, memory:{…}, …}).
 *
 * `loadConfigStore()` detects which shape is on disk and records it on the
 * returned store via the non-enumerable `__shape` property. `saveConfigStore()`
 * preserves whichever shape was loaded, so we never silently rewrite an
 * init-generated nested config as a flat MCP shape (which would break
 * `config set` CLI callers that read the nested tree).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type MCPTool, getProjectCwd } from './types.js';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const CONFIG_FILE = 'config.json';

type ConfigShape = 'mcp' | 'legacy';

interface ConfigStore {
  values: Record<string, unknown>;
  scopes: Record<string, Record<string, unknown>>;
  version: string;
  updatedAt: string;
  /** Original on-disk shape — preserved through save. Not persisted. */
  __shape?: ConfigShape;
}

const DEFAULT_CONFIG: Record<string, unknown> = {
  'swarm.topology': 'mesh',
  'swarm.maxAgents': 10,
  'swarm.autoScale': true,
  'memory.persistInterval': 60000,
  'memory.maxEntries': 100000,
  'session.autoSave': true,
  'session.saveInterval': 300000,
  'logging.level': 'info',
  'logging.format': 'json',
  'security.sandboxEnabled': true,
  'security.pathValidation': true,
};

function getConfigDir(): string {
  return join(getProjectCwd(), STORAGE_DIR);
}

function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE);
}

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Heuristic: an "MCP" shape has BOTH `values` and `scopes` as plain objects at
 * the top level. Anything else (e.g. init's nested `{version, swarm, memory}`)
 * is treated as legacy and exposed to the handlers as `store.values = parsed`.
 */
function detectShape(parsed: unknown): ConfigShape {
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed)
  ) {
    const obj = parsed as Record<string, unknown>;
    const hasValues =
      obj.values !== null &&
      typeof obj.values === 'object' &&
      !Array.isArray(obj.values);
    const hasScopes =
      obj.scopes !== null &&
      typeof obj.scopes === 'object' &&
      !Array.isArray(obj.scopes);
    if (hasValues && hasScopes) return 'mcp';
  }
  return 'legacy';
}

export function loadConfigStore(): ConfigStore {
  try {
    const path = getConfigPath();
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(data);
      const shape = detectShape(parsed);
      if (shape === 'mcp') {
        const mcp = parsed as Partial<ConfigStore>;
        return {
          values: (mcp.values as Record<string, unknown>) ?? { ...DEFAULT_CONFIG },
          scopes: (mcp.scopes as Record<string, Record<string, unknown>>) ?? {},
          version: (mcp.version as string) ?? '3.0.0',
          updatedAt: (mcp.updatedAt as string) ?? new Date().toISOString(),
          __shape: 'mcp',
        };
      }
      // legacy — the parsed tree IS the values. `scopes` is irrelevant
      // for init-generated configs; keep an empty map so handlers that
      // reference `store.scopes` don't NPE.
      const tree = parsed as Record<string, unknown>;
      return {
        values: tree,
        scopes: {},
        version: (tree.version as string) ?? '3.0.0',
        updatedAt:
          (tree.updatedAt as string) ??
          (tree.__updatedAt as string) ??
          new Date().toISOString(),
        __shape: 'legacy',
      };
    }
  } catch {
    // Fall through to defaults below.
  }
  return {
    values: { ...DEFAULT_CONFIG },
    scopes: {},
    version: '3.0.0',
    updatedAt: new Date().toISOString(),
    __shape: 'mcp',
  };
}

export function saveConfigStore(store: ConfigStore): void {
  ensureConfigDir();
  store.updatedAt = new Date().toISOString();
  const shape: ConfigShape = store.__shape ?? 'mcp';
  let payload: Record<string, unknown>;
  if (shape === 'legacy') {
    // Persist the nested tree exactly as handlers have mutated it.
    // Drop MCP-only bookkeeping fields that leaked in.
    payload = { ...store.values };
    // If the tree already carried a version key we keep it; otherwise
    // leave the tree unmodified (some init templates deliberately omit it).
  } else {
    payload = {
      values: store.values,
      scopes: store.scopes,
      version: store.version,
      updatedAt: store.updatedAt,
    };
  }
  writeFileSync(getConfigPath(), JSON.stringify(payload, null, 2), 'utf-8');
}

function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function filterDangerousKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!DANGEROUS_KEYS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
  const MAX_NESTING_DEPTH = 10;
  const parts = key.split('.');
  if (parts.length > MAX_NESTING_DEPTH) {
    throw new Error(`Key exceeds maximum nesting depth of ${MAX_NESTING_DEPTH}`);
  }
  for (const part of parts) {
    if (DANGEROUS_KEYS.has(part)) {
      throw new Error(`Dangerous key segment rejected: ${part}`);
    }
  }
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Resolve a key against a values tree tolerating both shapes:
 *   • MCP flat (`{"swarm.topology":"mesh"}`): direct key lookup first, then
 *     fall back to nested walk (handles operators who stored dotted keys
 *     both ways).
 *   • Legacy nested (`{swarm:{topology:"mesh"}}`): nested walk.
 *
 * @remarks Precedence: a literal dotted key (`values["swarm.topology"]`) ALWAYS
 * shadows a matching nested subtree (`values.swarm.topology`). This matches
 * existing MCP semantics — callers that stored dotted keys must read them back
 * verbatim. Do not "fix" this by inverting the order.
 */
function resolveValue(values: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(values, key)) {
    return values[key];
  }
  return getNestedValue(values, key);
}

export const configTools: MCPTool[] = [
  {
    name: 'config_get',
    description: 'Get configuration value',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Configuration key (dot notation supported)' },
        scope: { type: 'string', description: 'Configuration scope (project, user, system)' },
      },
      required: ['key'],
    },
    handler: async (input) => {
      const store = loadConfigStore();
      const key = input.key as string;
      const scope = (input.scope as string) || 'default';

      let value: unknown;
      let source: 'scope' | 'stored' | 'default' | 'none' = 'none';

      // Check scope first (only meaningful for MCP shape), then values, then defaults.
      if (scope !== 'default' && store.scopes[scope]) {
        const scoped = store.scopes[scope];
        if (Object.prototype.hasOwnProperty.call(scoped, key)) {
          value = scoped[key];
          source = 'scope';
        } else {
          const nested = getNestedValue(scoped, key);
          if (nested !== undefined) {
            value = nested;
            source = 'scope';
          }
        }
      }
      if (value === undefined) {
        value = resolveValue(store.values, key);
        if (value !== undefined) source = 'stored';
      }
      if (value === undefined) {
        value = DEFAULT_CONFIG[key];
        if (value !== undefined) source = 'default';
      }

      return {
        key,
        value,
        scope,
        exists: value !== undefined,
        source,
      };
    },
  },
  {
    name: 'config_set',
    description: 'Set configuration value',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Configuration key (dot notation supported)' },
        value: { description: 'Configuration value' },
        scope: { type: 'string', description: 'Configuration scope (project, user, system)' },
      },
      required: ['key', 'value'],
    },
    handler: async (input) => {
      const store = loadConfigStore();
      const key = input.key as string;
      const value = input.value;
      const scope = (input.scope as string) || 'default';

      // ADR-0082 / ADR-0094 Phase 8 nit BUG-A: a legacy config.json (init-generated
      // nested tree) has no scope concept at all, and `saveConfigStore`'s legacy
      // branch only persists `store.values`, not `store.scopes`. Silently
      // "succeeding" on a scoped write against a legacy file would therefore
      // drop the value on the next reload. Fail loudly instead so the caller
      // knows to either init with an MCP shape or drop the scope arg.
      if (scope !== 'default' && store.__shape === 'legacy') {
        return {
          success: false,
          key,
          value,
          scope,
          path: getConfigPath(),
          shape: 'legacy',
          error:
            'scope writes require MCP shape — legacy (init-generated) config.json cannot persist scoped values',
        };
      }

      const previousValue = resolveValue(store.values, key);

      if (scope === 'default') {
        if (store.__shape === 'legacy') {
          // Write into the nested tree so `claude-flow config get swarm.topology`
          // and subsequent MCP reads agree.
          setNestedValue(store.values, key, value);
        } else {
          store.values[key] = value;
        }
      } else {
        if (!store.scopes[scope]) {
          store.scopes[scope] = {};
        }
        // Scopes are primarily an MCP-shape concept; set by flat key. If the
        // caller is using dotted paths (scope + nested), setNestedValue keeps
        // the nesting consistent with config_get's resolution.
        if (key.includes('.')) {
          setNestedValue(store.scopes[scope], key, value);
        } else {
          store.scopes[scope][key] = value;
        }
      }

      saveConfigStore(store);

      return {
        success: true,
        key,
        value,
        previousValue,
        scope,
        path: getConfigPath(),
        shape: store.__shape ?? 'mcp',
      };
    },
  },
  {
    name: 'config_list',
    description: 'List configuration values',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Configuration scope' },
        prefix: { type: 'string', description: 'Key prefix filter' },
        includeDefaults: { type: 'boolean', description: 'Include default values' },
      },
    },
    handler: async (input) => {
      const store = loadConfigStore();
      const scope = (input.scope as string) || 'default';
      const prefix = input.prefix as string;
      const includeDefaults = input.includeDefaults !== false;

      // Flatten both legacy nested trees and MCP flat values into a single
      // key-set so callers get consistent dotted keys regardless of shape.
      const flatten = (
        src: Record<string, unknown>,
        out: Record<string, unknown>,
        parent = '',
      ): void => {
        for (const [k, v] of Object.entries(src)) {
          const full = parent ? `${parent}.${k}` : k;
          if (
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v)
          ) {
            // If the key itself is already dotted (flat-mcp shape) keep it
            // as-is at this level; otherwise recurse.
            flatten(v as Record<string, unknown>, out, full);
          } else {
            out[full] = v;
          }
        }
      };

      const configs: Record<string, unknown> = {};
      if (includeDefaults) {
        Object.assign(configs, DEFAULT_CONFIG);
      }
      flatten(store.values, configs);
      if (scope !== 'default' && store.scopes[scope]) {
        flatten(store.scopes[scope], configs);
      }

      // Filter by prefix
      let entries = Object.entries(configs);
      if (prefix) {
        entries = entries.filter(([key]) => key.startsWith(prefix));
      }

      // Sort by key
      entries.sort(([a], [b]) => a.localeCompare(b));

      return {
        configs: entries.map(([key, value]) => ({
          key,
          value,
          source:
            resolveValue(store.values, key) !== undefined ? 'stored' : 'default',
        })),
        total: entries.length,
        scope,
        shape: store.__shape ?? 'mcp',
        updatedAt: store.updatedAt,
      };
    },
  },
  {
    name: 'config_reset',
    description: 'Reset configuration to defaults',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Configuration scope' },
        key: { type: 'string', description: 'Specific key to reset (omit to reset all)' },
      },
    },
    handler: async (input) => {
      const store = loadConfigStore();
      const scope = (input.scope as string) || 'default';
      const key = input.key as string;

      let resetKeys: string[] = [];

      if (key) {
        // Reset specific key
        if (scope === 'default') {
          if (key in store.values) {
            delete store.values[key];
            resetKeys.push(key);
          } else if (store.__shape === 'legacy' && getNestedValue(store.values, key) !== undefined) {
            // Delete via nested walk
            const parts = key.split('.');
            let cur: Record<string, unknown> = store.values;
            for (let i = 0; i < parts.length - 1; i++) {
              cur = cur[parts[i]] as Record<string, unknown>;
              if (!cur) break;
            }
            if (cur) {
              delete cur[parts[parts.length - 1]];
              resetKeys.push(key);
            }
          }
        } else if (store.scopes[scope] && key in store.scopes[scope]) {
          delete store.scopes[scope][key];
          resetKeys.push(key);
        }
      } else {
        // Reset all keys in scope
        if (scope === 'default') {
          if (store.__shape === 'legacy') {
            // BUG-B (ADR-0094 Phase 8 nit): DEFAULT_CONFIG is a FLAT map of
            // dotted keys. Assigning it directly to a legacy (nested) tree
            // would produce a hybrid file where top-level keys are
            // dotted strings ("swarm.topology") instead of the nested
            // subtrees init emits. Rebuild via setNestedValue so the file
            // stays nested and `config_get("swarm.topology")` resolves
            // through the nested walk as expected.
            resetKeys = Object.keys(store.values);
            for (const k of resetKeys) delete store.values[k];
            for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
              setNestedValue(store.values, k, v);
            }
          } else {
            resetKeys = Object.keys(store.values);
            store.values = { ...DEFAULT_CONFIG };
          }
        } else if (store.scopes[scope]) {
          resetKeys = Object.keys(store.scopes[scope]);
          delete store.scopes[scope];
        }
      }

      saveConfigStore(store);

      return {
        success: true,
        scope,
        reset: key || 'all',
        resetKeys,
        count: resetKeys.length,
      };
    },
  },
  {
    name: 'config_export',
    description: 'Export configuration to JSON',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Configuration scope' },
        includeDefaults: { type: 'boolean', description: 'Include default values' },
      },
    },
    handler: async (input) => {
      const store = loadConfigStore();
      const scope = (input.scope as string) || 'default';
      const includeDefaults = input.includeDefaults !== false;

      let exportData: Record<string, unknown> = {};

      if (includeDefaults) {
        exportData = { ...DEFAULT_CONFIG };
      }

      Object.assign(exportData, store.values);

      if (scope !== 'default' && store.scopes[scope]) {
        Object.assign(exportData, store.scopes[scope]);
      }

      return {
        config: exportData,
        scope,
        version: store.version,
        shape: store.__shape ?? 'mcp',
        exportedAt: new Date().toISOString(),
        count: Object.keys(exportData).length,
      };
    },
  },
  {
    name: 'config_import',
    description: 'Import configuration from JSON',
    category: 'config',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object', description: 'Configuration object to import' },
        scope: { type: 'string', description: 'Configuration scope' },
        merge: { type: 'boolean', description: 'Merge with existing (true) or replace (false)' },
      },
      required: ['config'],
    },
    handler: async (input) => {
      const store = loadConfigStore();
      const config = filterDangerousKeys(input.config as Record<string, unknown>);
      const scope = (input.scope as string) || 'default';
      const merge = input.merge !== false;

      // ADR-0082 / ADR-0094 Phase 8 follow-up (config_import mirror of BUG-A):
      // saveConfigStore's legacy branch persists ONLY `store.values`, so both
      // (a) scoped imports (scope !== 'default') and
      // (b) default-scope imports carrying a nested `scopes` key in the payload
      // would either silently drop data on reload or corrupt the nested tree.
      // Refuse loudly with success:false — same pattern as config_set BUG-A.
      if (scope !== 'default' && store.__shape === 'legacy') {
        return {
          success: false,
          scope,
          shape: 'legacy',
          path: getConfigPath(),
          error:
            'scope imports require MCP shape — legacy (init-generated) config.json cannot persist scoped values',
        };
      }
      if (
        store.__shape === 'legacy' &&
        Object.prototype.hasOwnProperty.call(config, 'scopes')
      ) {
        return {
          success: false,
          scope,
          shape: 'legacy',
          path: getConfigPath(),
          error:
            'legacy config.json rejects import payloads carrying a top-level `scopes` key — would corrupt the nested tree',
        };
      }

      const importedKeys: string[] = Object.keys(config);

      if (scope === 'default') {
        if (merge) {
          Object.assign(store.values, config);
        } else {
          store.values = { ...DEFAULT_CONFIG, ...config };
        }
      } else {
        if (!store.scopes[scope] || !merge) {
          store.scopes[scope] = {};
        }
        Object.assign(store.scopes[scope], config);
      }

      saveConfigStore(store);

      return {
        success: true,
        scope,
        imported: importedKeys.length,
        keys: importedKeys,
        merge,
      };
    },
  },
];
