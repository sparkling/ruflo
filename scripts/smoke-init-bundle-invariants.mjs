#!/usr/bin/env node
/**
 * Init-bundle invariants smoke — ADR-128 Phase 5 (#2095).
 *
 * Statically asserts three properties of the @claude-flow/cli init bundle:
 *
 *   1. NO ORPHANED DIRECTORIES — every subdirectory under
 *      v3/@claude-flow/cli/.claude/{commands,agents}/ is reachable from
 *      COMMANDS_MAP or AGENTS_MAP in executor.ts. An "orphaned" directory is
 *      one that ships in the tarball but is never copied by any init path.
 *
 *   2. SKILLS_MAP COMPLETENESS — every skill name in SKILLS_MAP (all arrays)
 *      has a corresponding SKILL.md in either
 *      v3/@claude-flow/cli/.claude/skills/{name}/SKILL.md (bundled payload) or
 *      .claude/skills/{name}/SKILL.md (editorial source). Catches Phase 1
 *      regressions where a skill dir disappears from BOTH trees. Per ADR-0216,
 *      a known carve-out of editorial-only names lives in `.claude/skills/`
 *      only and is intentionally absent from the bundled payload; copySkills
 *      silently no-ops on those. The lockstep smoke
 *      (scripts/smoke-skills-lockstep.mjs) governs the byte-identical contract
 *      between the two trees.
 *
 *   3. NO INIT–PLUGIN AGENT BASENAME COLLISION — no .md file in
 *      v3/@claude-flow/cli/.claude/agents/(any path) shares a basename with any
 *      .md file in plugins/(any plugin)/agents/. Enforces the "plugin is canonical"
 *      dedup rule from ADR-128 Phase 2.
 *
 * Zero runtime dependencies — pure readFileSync + regex + readdirSync.
 * Exit 0: all assertions pass.
 * Exit 1: one or more assertions fail (file + details reported).
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const EXECUTOR_TS = join(REPO_ROOT, 'v3', '@claude-flow', 'cli', 'src', 'init', 'executor.ts');
const CLI_DOT_CLAUDE = join(REPO_ROOT, 'v3', '@claude-flow', 'cli', '.claude');
const TOP_DOT_CLAUDE = join(REPO_ROOT, '.claude');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listSubdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

function collectFiles(dir, ext) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(full);
    } else if (entry.isDirectory()) {
      results.push(...collectFiles(full, ext));
    }
  }
  return results;
}

// Parse all string values from a Record<string, string[]> literal in source.
// Handles multi-line blocks terminated by the closing '};'.
//
// Comment-stripping is mandatory: apostrophes inside `//` comments (e.g.
// "weren't", "AI-native") would otherwise open malformed regex captures that
// straddle category boundaries and produce garbled "skill names". Strip both
// full-line `// ...` comments and inline `... // tail` comments before matching.
function parseMapValues(src, mapName) {
  const start = src.indexOf(`const ${mapName}:`);
  if (start === -1) return new Set();
  const rawBlock = src.slice(start, src.indexOf('\n};', start) + 3);
  // Strip `//`-style line comments line-by-line. We don't need block-comment
  // (`/* ... */`) handling because the maps don't use them.
  const block = rawBlock
    .split('\n')
    .map(line => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
  const values = new Set();
  // Match single-quoted string literals (now safe — no comment apostrophes).
  for (const m of block.matchAll(/'([^']+)'/g)) {
    values.add(m[1]);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Load executor.ts
// ---------------------------------------------------------------------------

if (!existsSync(EXECUTOR_TS)) {
  console.error(`ERROR: executor.ts not found at ${EXECUTOR_TS}`);
  process.exit(1);
}
const executorSrc = readFileSync(EXECUTOR_TS, 'utf-8');

// ---------------------------------------------------------------------------
// Assertion 1: No orphaned command or agent subdirectories
// ---------------------------------------------------------------------------

const commandsValues = parseMapValues(executorSrc, 'COMMANDS_MAP');
const agentsValues = parseMapValues(executorSrc, 'AGENTS_MAP');

const commandsDirs = listSubdirs(join(CLI_DOT_CLAUDE, 'commands'));
const agentsDirs = listSubdirs(join(CLI_DOT_CLAUDE, 'agents'));

const orphanViolations = [];

for (const dir of commandsDirs) {
  if (!commandsValues.has(dir)) {
    orphanViolations.push({
      type: 'orphan-command-dir',
      path: `v3/@claude-flow/cli/.claude/commands/${dir}`,
      message: `commands/${dir}/ has no COMMANDS_MAP entry`,
    });
  }
}

for (const dir of agentsDirs) {
  if (!agentsValues.has(dir)) {
    orphanViolations.push({
      type: 'orphan-agent-dir',
      path: `v3/@claude-flow/cli/.claude/agents/${dir}`,
      message: `agents/${dir}/ has no AGENTS_MAP entry`,
    });
  }
}

// ---------------------------------------------------------------------------
// Assertion 2: Every SKILLS_MAP skill has a SKILL.md (or README.md) in EITHER
// the bundled v3/cli payload OR the top editorial source. Per ADR-0216, 5
// names are editorial-only — present in top, absent from the bundle by design.
// `copySkills` silently no-ops those at user-init time; the lockstep smoke
// (smoke-skills-lockstep.mjs) is the byte-equality gate between the two trees.
//
// This smoke fails only when a SKILLS_MAP entry has NO source at all (neither
// tree contains the dir). That is the regression Phase 1 was protecting
// against, and it still catches it.
// ---------------------------------------------------------------------------

const skillsMapValues = parseMapValues(executorSrc, 'SKILLS_MAP');
const bundleSkillsDir = join(CLI_DOT_CLAUDE, 'skills');
const topSkillsDir = join(TOP_DOT_CLAUDE, 'skills');
const missingSkills = [];

function skillExistsIn(dir, name) {
  return existsSync(join(dir, name, 'SKILL.md')) || existsSync(join(dir, name, 'README.md'));
}

for (const skillName of skillsMapValues) {
  const inBundle = skillExistsIn(bundleSkillsDir, skillName);
  const inTop = skillExistsIn(topSkillsDir, skillName);
  if (!inBundle && !inTop) {
    missingSkills.push({
      type: 'missing-skill',
      name: skillName,
      path: `v3/@claude-flow/cli/.claude/skills/${skillName}/SKILL.md (and .claude/skills/${skillName}/)`,
      message: `SKILLS_MAP references '${skillName}' but no SKILL.md or README.md found in either the bundle or the top editorial source`,
    });
  }
}

// ---------------------------------------------------------------------------
// Assertion 3: No init-template agent basename collides with a plugin agent
// ---------------------------------------------------------------------------

const initAgentFiles = collectFiles(join(CLI_DOT_CLAUDE, 'agents'), '.md');
const initBasenames = new Set(initAgentFiles.map(f => f.split('/').pop()));

const pluginAgentFiles = existsSync(PLUGINS_DIR)
  ? readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .flatMap(e => collectFiles(join(PLUGINS_DIR, e.name, 'agents'), '.md'))
  : [];

// ADR-128 wire-in carve-out: 2 consensus agents (gossip-coordinator and
// crdt-synchronizer) carry load-bearing ADR-0120/0121 wire-in (allowed-tools
// + Runtime Integration example) that makes mcp__ruflo__hive-mind_consensus
// reachable from the agent. The wire-in needs to be reachable at the
// user-facing .claude/agents/consensus/<file>.md path post-`ruflo init`.
//
// Init copies from the CLI init template — NOT from the plugin (plugin install
// is a separate user-driven `/plugin install` step, not part of `ruflo init`).
// So for these 2 wired files, the canonical surface MUST be the CLI init
// template, not the plugin. ADR-128's "plugin's version is canonical" policy
// is correct for purely-documentation duplicates but doesn't account for
// files whose wire-in is consumed at init time.
//
// These 2 files are allowlisted from the collision check. The plugin's thin
// copies of the same basenames remain (so `/plugin install ruflo-hive-mind`
// still installs a reasonable agent definition), but the CLI init template
// owns the wired version that reaches the user's project on init.
const ADR_128_WIRE_IN_CARVE_OUT = new Set([
  'gossip-coordinator.md',
  'crdt-synchronizer.md',
]);

const collisionViolations = [];

for (const pluginFile of pluginAgentFiles) {
  const basename = pluginFile.split('/').pop();
  if (ADR_128_WIRE_IN_CARVE_OUT.has(basename)) continue;
  if (initBasenames.has(basename)) {
    // Find the init copy for the error message
    const initCopy = initAgentFiles.find(f => f.split('/').pop() === basename);
    collisionViolations.push({
      type: 'agent-collision',
      init: initCopy.replace(REPO_ROOT + '/', ''),
      plugin: pluginFile.replace(REPO_ROOT + '/', ''),
      message: `'${basename}' exists in both init template and plugin (plugin must be canonical)`,
    });
  }
}

// ---------------------------------------------------------------------------
// Report results
// ---------------------------------------------------------------------------

const allViolations = [...orphanViolations, ...missingSkills, ...collisionViolations];

if (allViolations.length === 0) {
  console.log('ok: init-bundle invariants pass (no orphans, all skills present, no plugin-init overlap)');
  console.log(`  commands dirs checked: ${commandsDirs.length}`);
  console.log(`  agents dirs checked: ${agentsDirs.length}`);
  console.log(`  skills checked: ${skillsMapValues.size}`);
  console.log(`  plugin agent basenames checked: ${pluginAgentFiles.length}`);
  process.exit(0);
}

console.error(`\n${allViolations.length} init-bundle invariant violation(s):\n`);

for (const v of allViolations) {
  if (v.type === 'orphan-command-dir' || v.type === 'orphan-agent-dir') {
    console.error(`  [ORPHAN] ${v.path}`);
    console.error(`    ${v.message}`);
    console.error(`    Fix: add a COMMANDS_MAP or AGENTS_MAP entry for this directory,`);
    console.error(`         or delete the directory if it belongs to a plugin.`);
  } else if (v.type === 'missing-skill') {
    console.error(`  [MISSING-SKILL] ${v.path}`);
    console.error(`    ${v.message}`);
    console.error(`    Fix: add the skill source at .claude/skills/${v.name}/SKILL.md (editorial),`);
    console.error(`         or remove '${v.name}' from SKILLS_MAP in v3/@claude-flow/cli/src/init/executor.ts.`);
  } else if (v.type === 'agent-collision') {
    console.error(`  [COLLISION] ${v.message}`);
    console.error(`    init:   ${v.init}`);
    console.error(`    plugin: ${v.plugin}`);
    console.error(`    Fix: delete the init-template copy; the plugin version is canonical (ADR-128 §Phase 2).`);
  }
}

console.error('\nADR-128: https://github.com/ruvnet/ruflo/blob/main/v3/docs/adr/ADR-128-init-bundle-reduce-refactor.md\n');
process.exit(1);
