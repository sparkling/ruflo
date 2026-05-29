/**
 * ADR-0149 — Guidance MCP coverage drift test (Phase 3 durable fix).
 *
 * Contract: every tool name advertised by `guidance_*` (i.e. every entry in
 * `CAPABILITY_CATALOG[area].tools`) MUST resolve to a real, registered MCP tool.
 *
 * The catalog is the AI's primary self-discovery surface. When it advertises a
 * tool name that no handler backs, an AI that trusts the recommendation issues
 * `MCP tool not found` errors. ADR-0152 quantified ~39 such phantoms in the
 * frozen catalog (underscore-vs-dash name-format mismatches, wrong-name peers,
 * and whole-area fabrications like `security_*`).
 *
 * ── Authoritative source of truth ──────────────────────────────────────────
 * The registered surface is whatever `mcp-client.ts` loads into TOOL_REGISTRY:
 * the union of every `*-tools.ts` array it imports in its `registerTools([...])`
 * call. Ideally this test would `import { listMCPTools } from '../src/mcp-client'`
 * and read the live Map. That graph, however, transitively imports
 * `@claude-flow/shared` → `events/event-store` → an OPTIONAL `sql.js` native dep
 * that is not present in every dev tree, so a runtime import can fail to *load*
 * for reasons unrelated to guidance drift (a flaky, false-red signal).
 *
 * To keep the drift signal pure and deterministic, BOTH sides are derived by
 * statically scanning source:
 *   - the registered set: the `name` field of every MCPTool literal in the same
 *     `*-tools.ts` files `mcp-client.ts` registers (a `name:` line immediately
 *     followed by a `description:` line — the invariant MCPTool shape, which
 *     excludes JSON-schema `name:` properties);
 *   - the catalog set: the `tools:` arrays of `CAPABILITY_CATALOG` in
 *     `guidance-tools.ts`.
 *
 * Why source-scan instead of importing the live `CAPABILITY_CATALOG` symbol:
 * importing it transits `./types.js` → `@claude-flow/shared` →
 * `events/event-store` → an OPTIONAL `sql.js` native dep absent from some dev
 * trees, so a symbol import can fail to *load* for reasons unrelated to drift.
 * The source scan reads the exact same object literal with zero import risk and
 * is immune to unrelated churn in neighbouring modules. (DEVIATION from
 * ADR-0149's "import CAPABILITY_CATALOG" phrasing — same data, robust loader.)
 *
 * This test FAILS if any catalog tool name is not in the registered set —
 * exactly what would have caught all ~39 historical phantoms.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpToolsDir = join(__dirname, '..', 'src', 'mcp-tools');

/**
 * The `*-tools.ts` modules whose arrays `mcp-client.ts` spreads into
 * `registerTools([...])`. Kept in sync with that file; the
 * "registration list matches this list" test below guards the coupling.
 */
const REGISTERED_TOOL_MODULES = [
  'agent-tools',
  'swarm-tools',
  'memory-tools',
  'config-tools',
  'hooks-tools',
  'task-tools',
  'session-tools',
  'hive-mind-tools',
  'workflow-tools',
  'analyze-tools',
  'progress-tools',
  'embeddings-tools',
  'claims-tools',
  'security-tools',
  'transfer-tools',
  'system-tools',
  'terminal-tools',
  'neural-tools',
  'performance-tools',
  'github-tools',
  'daa-tools',
  'coordination-tools',
  'browser-tools',
  'browser-session-tools',
  'agentdb-tools',
  'ruvllm-tools',
  'wasm-agent-tools',
  'guidance-tools',
  'autopilot-tools',
];

/**
 * Extract MCP tool names from a `*-tools.ts` source file.
 *
 * An MCPTool object literal always has a `name:` field followed by a
 * `description:` field. JSON-schema property definitions also use `name:`, but
 * are never paired with a sibling `description:` — so the pair pattern isolates
 * real tool names. Intervening comment / blank lines are skipped (several tool
 * defs carry an ADR-rationale comment between `name:` and `description:`).
 */
function extractToolNames(source: string): string[] {
  const names: string[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*name:\s*['"]([a-z][a-z0-9_-]*)['"]\s*,\s*$/);
    if (!m) continue;
    // Look ahead for the `description:` sibling, skipping blank lines and
    // single-/multi-line comments.
    let j = i + 1;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
        j++;
        continue;
      }
      break;
    }
    if (j < lines.length && /^\s*description:\s*/.test(lines[j])) {
      names.push(m[1]);
    }
  }
  return names;
}

/** Live, registered MCP tool-name set (the authoritative surface). */
const registeredNames = new Set<string>();
for (const mod of REGISTERED_TOOL_MODULES) {
  const src = readFileSync(join(mcpToolsDir, `${mod}.ts`), 'utf-8');
  for (const name of extractToolNames(src)) registeredNames.add(name);
}

/**
 * Parse `CAPABILITY_CATALOG` from `guidance-tools.ts`: for each area, capture
 * its `tools: [...]` array. The catalog is a single hand-edited object literal,
 * so a scoped regex over the source is exact and stable.
 */
function parseCatalogToolsByArea(source: string): Record<string, string[]> {
  // Isolate the catalog object literal to avoid matching `tools:` elsewhere.
  const start = source.indexOf('CAPABILITY_CATALOG: Record<string, CapabilityArea> = {');
  if (start < 0) throw new Error('CAPABILITY_CATALOG declaration not found in guidance-tools.ts');
  const body = source.slice(start);
  const result: Record<string, string[]> = {};
  // Match: `<area-key>: {` ... `tools: [ ... ],`
  const areaRe = /(?:^|\n)\s*'([a-z][a-z0-9-]*)':\s*\{/g;
  let areaMatch: RegExpExecArray | null;
  while ((areaMatch = areaRe.exec(body)) !== null) {
    const areaKey = areaMatch[1];
    const after = body.slice(areaMatch.index);
    const toolsMatch = after.match(/tools:\s*\[([^\]]*)\]/);
    if (!toolsMatch) continue;
    const tools = [...toolsMatch[1].matchAll(/['"]([a-z][a-z0-9_-]*)['"]/g)].map((m) => m[1]);
    result[areaKey] = tools;
  }
  return result;
}

const guidanceSrc = readFileSync(join(mcpToolsDir, 'guidance-tools.ts'), 'utf-8');
const catalogToolsByArea = parseCatalogToolsByArea(guidanceSrc);

describe('ADR-0149 — guidance CAPABILITY_CATALOG ⊆ registered MCP tools', () => {
  it('the registered set is non-empty and substantial (guards the extractor)', () => {
    // The fork registers well over 200 MCP tools; a tiny number means the
    // extractor regressed (e.g. a refactor changed the object shape).
    expect(registeredNames.size).toBeGreaterThan(150);
  });

  it('the module list matches mcp-client.ts registerTools(...)', () => {
    // Coupling guard: if mcp-client.ts adds/removes a registered tool module,
    // this list must follow. Drift here would silently shrink the surface the
    // catalog is checked against.
    const clientSrc = readFileSync(join(__dirname, '..', 'src', 'mcp-client.ts'), 'utf-8');
    const registerBlock = clientSrc.slice(
      clientSrc.indexOf('registerTools(['),
      clientSrc.indexOf('])', clientSrc.indexOf('registerTools([')),
    );
    // Every module we scan must be spread into the register block.
    const importLine = (mod: string) => `from './mcp-tools/${mod}.js'`;
    const missingFromImports = REGISTERED_TOOL_MODULES.filter(
      (mod) => !clientSrc.includes(importLine(mod)),
    );
    expect(missingFromImports, `modules scanned but not imported by mcp-client.ts: ${missingFromImports.join(', ')}`).toEqual([]);
    // Spot-check the register block actually spreads the array variables.
    expect(registerBlock).toContain('...agentdbTools');
    expect(registerBlock).toContain('...guidanceTools');
    expect(registerBlock).toContain('...taskTools');
  });

  it('the catalog parsed to a sane shape (guards the parser)', () => {
    const areas = Object.keys(catalogToolsByArea);
    expect(areas.length).toBeGreaterThan(15);
    // The new ADR-0149 areas must be present.
    for (const newArea of ['agentdb', 'task-management', 'aidefence', 'workflows', 'observability', 'federation', 'knowledge-graph', 'rvf']) {
      expect(areas, `missing area "${newArea}"`).toContain(newArea);
    }
  });

  it('every catalog tool name resolves to a registered MCP tool (no phantoms)', () => {
    const phantoms: Array<{ area: string; tool: string }> = [];
    for (const [area, tools] of Object.entries(catalogToolsByArea)) {
      for (const tool of tools) {
        if (!registeredNames.has(tool)) phantoms.push({ area, tool });
      }
    }
    expect(
      phantoms,
      `Guidance catalog advertises ${phantoms.length} phantom tool(s) not in the MCP registry:\n` +
        phantoms.map((p) => `  - [${p.area}] ${p.tool}`).join('\n'),
    ).toEqual([]);
  });

  // Per-area parametrised checks: pinpoints which area drifted on failure.
  for (const [area, tools] of Object.entries(catalogToolsByArea)) {
    it(`area "${area}" advertises only real tools`, () => {
      const bad = tools.filter((t) => !registeredNames.has(t));
      expect(bad, `area "${area}" phantom tools: ${bad.join(', ')}`).toEqual([]);
    });
  }

  it('regression guards: historically-phantom names are NOT advertised', () => {
    // The specific phantoms ADR-0152 catalogued. They must never reappear.
    const forbidden = [
      // wrong-name peers
      'agent_stop', 'swarm_terminate', 'embeddings_embed', 'session_start', 'session_end',
      // name-format mismatches (underscore where dash is real)
      'hooks_pre_task', 'hooks_post_task', 'hooks_pre_edit', 'hooks_post_edit',
      'hive_mind_init', 'hive_mind_status', 'hive_mind_consensus',
      // whole-area / pure fabrications
      'agent_metrics', 'agent_logs', 'swarm_spawn', 'swarm_topology', 'swarm_metrics',
      'memory_init', 'memory_import', 'memory_compact', 'memory_namespace',
      'analyze_coverage', 'analyze_graph', 'github_code_review', 'github_sync_coord',
      'config_provider', 'hive_mind_propose', 'hive_mind_vote', 'hive_mind_metrics',
      'ruvllm_kvcache_create',
      'security_scan', 'security_audit', 'security_cve', 'security_threats',
      'security_validate', 'security_report',
      'claims_check', 'claims_grant', 'claims_revoke',
    ];
    const allCatalogTools = new Set(
      Object.values(catalogToolsByArea).flat(),
    );
    const reappeared = forbidden.filter((f) => allCatalogTools.has(f));
    expect(reappeared, `historically-phantom names reappeared: ${reappeared.join(', ')}`).toEqual([]);
  });
});
