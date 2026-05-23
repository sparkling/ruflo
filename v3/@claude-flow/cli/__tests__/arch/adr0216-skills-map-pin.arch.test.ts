/**
 * Arch-test: ADR-0216 — pin the SKILLS_MAP name-set.
 *
 * Per the ADR's 2026-05-22 re-validation block: SKILLS_MAP has 39
 * flattened entries; the `.claude/skills/` tree ships 38 `SKILL.md` files
 * because `dual-mode/` is a SKILL.md-less category (helper `dual-*.md` +
 * README.md only). The corpus-shape acceptance check (in ruflo-patch)
 * expresses the floor as a SKILL.md-file count (38) and whitelists
 * `dual-mode/` explicitly — NOT a blanket "skip dirs without SKILL.md"
 * (which would silently hide a real future missing-`SKILL.md`
 * regression).
 *
 * This arch test pins the canonical name-set so any addition or removal
 * to SKILLS_MAP trips a unit-test gate before the slower acceptance
 * gate. The dual-mode whitelist is also pinned here for symmetry with
 * the corpus-shape check.
 */

import { describe, it, expect } from 'vitest';
import { SKILLS_MAP } from '../../src/init/executor.js';

// Canonical 39-entry name-set as of ADR-0216 (2026-05-23).
const EXPECTED_SKILLS = [
  'agentdb-advanced',
  'agentdb-learning',
  'agentdb-memory-patterns',
  'agentdb-optimization',
  'agentdb-vector-search',
  'agentic-jujutsu',
  'browser',
  'dual-mode',
  'flow-nexus-neural',
  'flow-nexus-platform',
  'flow-nexus-swarm',
  'github-code-review',
  'github-multi-repo',
  'github-project-management',
  'github-release-management',
  'github-workflow-automation',
  'hive-mind-advanced',
  'hooks-automation',
  'pair-programming',
  'performance-analysis',
  'reasoningbank-agentdb',
  'reasoningbank-intelligence',
  'skill-builder',
  'sparc-methodology',
  'stream-chain',
  'swarm-advanced',
  'swarm-orchestration',
  'v3-cli-modernization',
  'v3-core-implementation',
  'v3-ddd-architecture',
  'v3-integration-deep',
  'v3-mcp-optimization',
  'v3-memory-unification',
  'v3-performance-optimization',
  'v3-security-overhaul',
  'v3-swarm-coordination',
  'verification-quality',
  'worker-benchmarks',
  'worker-integration',
];

// Categories that ship a SKILL.md-less dir today. Acceptance walks check
// every emitted dir has a SKILL.md UNLESS it appears in this whitelist.
const SKILL_MD_LESS_WHITELIST = ['dual-mode'];

describe('ADR-0216 — SKILLS_MAP name-set pin', () => {
  it('SKILLS_MAP flattens to exactly the canonical 39-entry name-set', () => {
    const actual = Object.values(SKILLS_MAP).flat().sort();
    expect(actual).toEqual([...EXPECTED_SKILLS].sort());
  });

  it('SKILLS_MAP has zero duplicate entries (each name unique across categories)', () => {
    const all = Object.values(SKILLS_MAP).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('every whitelisted SKILL.md-less category is present in SKILLS_MAP', () => {
    const all = Object.values(SKILLS_MAP).flat();
    for (const name of SKILL_MD_LESS_WHITELIST) {
      expect(all).toContain(name);
    }
  });

  it('the canonical name-set has 39 entries and 38 SKILL.md-bearing entries (1 whitelist)', () => {
    expect(EXPECTED_SKILLS.length).toBe(39);
    const skillMdBearing = EXPECTED_SKILLS.filter(
      (n) => !SKILL_MD_LESS_WHITELIST.includes(n),
    );
    expect(skillMdBearing.length).toBe(38);
  });
});
