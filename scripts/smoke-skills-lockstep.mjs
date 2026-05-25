#!/usr/bin/env node
/**
 * Lockstep smoke for SKILL.md drift detection — ADR-0257 item #3.
 *
 * The `.claude/skills/` tree at the repo root is the editorial source for
 * skills; `v3/@claude-flow/cli/.claude/skills/` is the npm-package payload
 * that `ruflo init` copies into user projects via SKILLS_MAP in
 * `v3/@claude-flow/cli/src/init/executor.ts`. The two MUST stay byte-
 * identical or users get stale prose / regressed brand references (e.g.
 * `mcp__claude-flow__*` instead of `mcp__ruflo__*`).
 *
 * Earlier this session, agent `skill-resync` found drift in BOTH
 * directions:
 *   - 8 files where top was fresher (re-synced top → v3/cli in commit
 *     `02b6d7bcf`)
 *   - 1 file (`verification-quality`) where v3/cli was fresher (reverse-
 *     synced v3/cli → top in commit `34119ebcb`)
 *
 * This smoke prevents recurrence by bidirectionally byte-comparing the
 * two trees on every push / PR / direct edit:
 *
 *   1. Every `<name>` directory in `.claude/skills/` with a `SKILL.md`
 *      must have a name-matched `v3/@claude-flow/cli/.claude/skills/<name>/SKILL.md`
 *      that is byte-identical.
 *   2. Every `<name>` directory in `v3/@claude-flow/cli/.claude/skills/`
 *      with a `SKILL.md` must have a name-matched `.claude/skills/<name>/SKILL.md`
 *      that is byte-identical.
 *
 * Any missing-name OR any byte difference fails the smoke. No allowlist
 * — the whole point is that drift should never happen.
 *
 * Exit 0: all SKILL.md files aligned in both directions.
 * Exit 1: one or more files differ or are missing in one tree.
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

// Pass 1: every top name must exist in v3/cli; byte-compare matched pairs.
for (const name of topNames) {
  const topFile = join(TOP_SKILLS, name, 'SKILL.md');
  const v3File = join(V3_SKILLS, name, 'SKILL.md');
  if (!v3Names.has(name)) {
    drifts.push({
      type: 'top-only',
      name,
      message: `'${name}' has a SKILL.md in .claude/skills/ but not in v3/@claude-flow/cli/.claude/skills/`,
      fix: `copy .claude/skills/${name}/SKILL.md → v3/@claude-flow/cli/.claude/skills/${name}/SKILL.md, or remove the top copy if it is an unbundled editorial draft.`,
    });
    continue;
  }
  const topBytes = readFileSync(topFile);
  const v3Bytes = readFileSync(v3File);
  if (!topBytes.equals(v3Bytes)) {
    drifts.push({
      type: 'byte-differ',
      name,
      topPath: `.claude/skills/${name}/SKILL.md`,
      v3Path: `v3/@claude-flow/cli/.claude/skills/${name}/SKILL.md`,
      topSize: topBytes.length,
      v3Size: v3Bytes.length,
      message: `'${name}' SKILL.md content differs between top (${topBytes.length} bytes) and v3/cli (${v3Bytes.length} bytes)`,
      fix: `decide which copy is authoritative (top is usually the editorial source) and re-sync.`,
    });
  }
}

// Pass 2: every v3/cli name must exist in top (catches v3/cli-only drift).
for (const name of v3Names) {
  if (!topNames.has(name)) {
    drifts.push({
      type: 'v3-only',
      name,
      message: `'${name}' has a SKILL.md in v3/@claude-flow/cli/.claude/skills/ but not in .claude/skills/`,
      fix: `copy v3/@claude-flow/cli/.claude/skills/${name}/SKILL.md → .claude/skills/${name}/SKILL.md (top is the editorial source).`,
    });
  }
}

const aligned = topNames.size + v3Names.size - drifts.length;

if (drifts.length === 0) {
  console.log(`ok: all ${topNames.size} skills aligned byte-identical across .claude/skills/ and v3/@claude-flow/cli/.claude/skills/`);
  process.exit(0);
}

console.error(`\n${drifts.length} SKILL.md lockstep drift(s) detected:\n`);

for (const d of drifts) {
  if (d.type === 'top-only') {
    console.error(`  [TOP-ONLY] ${d.name}`);
    console.error(`    ${d.message}`);
    console.error(`    Fix: ${d.fix}`);
  } else if (d.type === 'v3-only') {
    console.error(`  [V3-ONLY] ${d.name}`);
    console.error(`    ${d.message}`);
    console.error(`    Fix: ${d.fix}`);
  } else if (d.type === 'byte-differ') {
    console.error(`  [BYTE-DIFFER] ${d.name}`);
    console.error(`    top:   ${d.topPath} (${d.topSize} bytes)`);
    console.error(`    v3/cli: ${d.v3Path} (${d.v3Size} bytes)`);
    console.error(`    Fix: ${d.fix}`);
  }
}

console.error(`\nADR-0257: docs/adr/ADR-0257-session-2026-05-25-backlog-execution-plan.md\n`);
process.exit(1);
