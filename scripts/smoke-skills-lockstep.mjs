#!/usr/bin/env node
/**
 * Lockstep smoke for SKILL.md drift detection — ADR-0257 item #3.
 *
 * The `.claude/skills/` tree at the repo root is the editorial source for
 * skills; `v3/@claude-flow/cli/.claude/skills/` is the npm-package payload
 * that `ruflo init` copies into user projects via SKILLS_MAP. The two trees
 * are NOT a strict bijection — top is a superset (editorial source) and
 * v3/cli is a subset (the shipped bundle). Per ADR-0216, the bundle pins a
 * specific name-set (currently 33 skills) and explicitly excludes 5 top-only
 * editorial skills: agentic-jujutsu, hive-mind-advanced, performance-
 * analysis, worker-benchmarks, worker-integration.
 *
 * What this smoke detects:
 *
 *   1. v3/cli SKILL.md missing from top — suspicious (where's the source?)
 *   2. v3/cli SKILL.md byte-differs from top for shared names — suspicious
 *
 * What this smoke deliberately DOES NOT flag:
 *
 *   - top SKILL.md without a v3/cli counterpart (editorial-only, intentional
 *     per ADR-0216)
 *
 * Exit 0: every name in v3/cli has a byte-identical counterpart in top.
 * Exit 1: one or more v3/cli SKILL.md files are missing from top or byte-differ.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const TOP_SKILLS = join(REPO_ROOT, '.claude', 'skills');
const V3_SKILLS = join(REPO_ROOT, 'v3', '@claude-flow', 'cli', '.claude', 'skills');

function listSkillNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
    .map(e => e.name);
}

if (!existsSync(TOP_SKILLS)) {
  console.error(`ERROR: top skills tree not found at ${TOP_SKILLS}`);
  process.exit(1);
}
if (!existsSync(V3_SKILLS)) {
  console.error(`ERROR: v3/cli skills tree not found at ${V3_SKILLS}`);
  process.exit(1);
}

const topNames = new Set(listSkillNames(TOP_SKILLS));
const v3Names = new Set(listSkillNames(V3_SKILLS));

const drifts = [];

// Every v3/cli name must exist in top (the editorial source) and be byte-identical.
// Top-only names are intentional (per ADR-0216 — editorial superset).
for (const name of v3Names) {
  if (!topNames.has(name)) {
    drifts.push({
      type: 'v3-only',
      name,
      message: `'${name}' has a SKILL.md in v3/@claude-flow/cli/.claude/skills/ but not in .claude/skills/`,
      fix: `top is the editorial source — copy v3/@claude-flow/cli/.claude/skills/${name}/SKILL.md → .claude/skills/${name}/SKILL.md, OR remove the v3/cli copy if it shouldn't be in the bundle.`,
    });
    continue;
  }
  const topBytes = readFileSync(join(TOP_SKILLS, name, 'SKILL.md'));
  const v3Bytes = readFileSync(join(V3_SKILLS, name, 'SKILL.md'));
  if (!topBytes.equals(v3Bytes)) {
    drifts.push({
      type: 'byte-differ',
      name,
      topSize: topBytes.length,
      v3Size: v3Bytes.length,
      message: `'${name}' SKILL.md content differs between top (${topBytes.length} bytes) and v3/cli (${v3Bytes.length} bytes)`,
      fix: `decide which copy is authoritative (top is usually the editorial source) and re-sync.`,
    });
  }
}

const topOnlyCount = [...topNames].filter(n => !v3Names.has(n)).length;
const intersectionCount = v3Names.size - drifts.filter(d => d.type === 'v3-only').length;

if (drifts.length === 0) {
  console.log(
    `ok: ${v3Names.size} bundled skill(s) aligned byte-identical with top; ` +
    `${topOnlyCount} top-only editorial skill(s) intentionally not bundled (per ADR-0216).`
  );
  process.exit(0);
}

console.error(`\n${drifts.length} SKILL.md lockstep drift(s) detected:\n`);
for (const d of drifts) {
  if (d.type === 'v3-only') {
    console.error(`  [V3-ONLY] ${d.name}`);
    console.error(`    ${d.message}`);
    console.error(`    Fix: ${d.fix}`);
  } else if (d.type === 'byte-differ') {
    console.error(`  [BYTE-DIFFER] ${d.name}`);
    console.error(`    top:   .claude/skills/${d.name}/SKILL.md (${d.topSize} bytes)`);
    console.error(`    v3/cli: v3/@claude-flow/cli/.claude/skills/${d.name}/SKILL.md (${d.v3Size} bytes)`);
    console.error(`    Fix: ${d.fix}`);
  }
}

console.error(`\nADR-0257 item #3 + ADR-0216 bundle pin.\n`);
process.exit(1);
