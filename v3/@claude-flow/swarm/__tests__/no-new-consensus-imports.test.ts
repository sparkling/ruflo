/**
 * Arch-test for ADR-0238 Surface 4 (quarantine).
 *
 * The `@claude-flow/swarm/src/consensus/` subtree is QUARANTINED — its
 * 1,425 LOC implements three local-EventEmitter consensus simulations
 * unreachable from any user-facing CLI/MCP path (per F-09-001 / F-09-002).
 * The subtree is RETAINED (not deleted) because upstream is actively
 * extending it (see `ruvnet/ruflo` commit `22ca3b018` — ADR-095 G2 step 1
 * pluggable ConsensusTransport + Ed25519 signing, 2026-05-11).
 *
 * This arch-test forbids NEW `.ts` imports from the subtree beyond the
 * baseline allowlist. Real consensus dispatch goes through
 * `cli/src/mcp-tools/hive-mind-tools.ts` → archivist →
 * `agentdb/archivist/handlers/hive-mind/consensus/*`, not through this
 * subtree.
 *
 * Trip-wire: a new file importing from `./consensus/` (relative inside
 * `swarm/src/`) or from `@claude-flow/swarm/.../consensus/` (cross-package
 * inside this repo) sends this test RED.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SWARM_SRC = resolve(__dirname, '../src');
const REPO_ROOT = resolve(__dirname, '../../../../');

/**
 * Baseline allowlist — files that legitimately imported from `./consensus/`
 * before the ADR-0238 Surface 4 quarantine landed. Re-exports from
 * `index.ts` and the dead `unified-coordinator.ts` instantiation are the
 * only existing in-tree consumers; both are tracked-but-frozen per the
 * quarantine disposition.
 *
 * Repo-root-relative paths so failures point at the precise file.
 */
const BASELINE_ALLOWLIST = new Set<string>([
  'v3/@claude-flow/swarm/src/unified-coordinator.ts',
  'v3/@claude-flow/swarm/src/index.ts',
]);

/**
 * Recursively collect every `.ts` file under a directory (excluding
 * `.d.ts`, `__tests__`, `dist`).
 */
function collectTsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') {
        continue;
      }
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Importer detector — matches BOTH:
 *   - relative imports: `from '../consensus/...'`, `from './consensus/...'`
 *   - bare-specifier imports: `from '@claude-flow/swarm/.../consensus/...'`
 * Static `import ... from '...'` and dynamic `import('...')` both counted.
 */
const CONSENSUS_IMPORT_RE = /(?:from|import\s*\()\s*['"](?:[^'"]*\/)?consensus(?:\/[^'"]*)?['"]/g;

describe('ADR-0238 Surface 4: no new consensus imports', () => {
  it('only baseline allowlist files import from swarm consensus subtree', () => {
    const offenders: string[] = [];
    const tsFiles = collectTsFiles(resolve(REPO_ROOT, 'v3'));

    for (const file of tsFiles) {
      const rel = file.slice(REPO_ROOT.length + 1);
      // Skip files INSIDE the quarantined subtree — internal cross-imports
      // (e.g. raft.ts ↔ types.ts in the same dir) are allowed.
      if (rel.includes('v3/@claude-flow/swarm/src/consensus/')) {
        continue;
      }
      const src = readFileSync(file, 'utf8');
      // Cheap pre-check before regex
      if (!src.includes('consensus')) continue;
      // Reset stateful regex per file
      CONSENSUS_IMPORT_RE.lastIndex = 0;
      if (!CONSENSUS_IMPORT_RE.test(src)) continue;
      if (BASELINE_ALLOWLIST.has(rel)) continue;
      offenders.push(rel);
    }

    expect(
      offenders,
      `New importers of quarantined consensus subtree detected:\n  ${offenders.join('\n  ')}\n` +
        `Real consensus dispatch routes through cli/src/mcp-tools/hive-mind-tools.ts → ` +
        `agentdb/archivist/handlers/hive-mind/consensus/*. ` +
        `If this is intentional, update BASELINE_ALLOWLIST in this test ` +
        `AND document the new consumer in ADR-0238.`,
    ).toEqual([]);
  });

  it('quarantine headers present on all 4 subtree files', () => {
    const files = ['raft.ts', 'byzantine.ts', 'gossip.ts', 'index.ts'];
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(resolve(SWARM_SRC, 'consensus', f), 'utf8');
      if (!src.includes('ADR-0238 Surface 4 quarantine')) {
        missing.push(f);
      }
    }
    expect(
      missing,
      `Quarantine header missing on:\n  ${missing.join('\n  ')}\n` +
        `Re-run ruflo-patch/lib/adr0238-quarantine-header.mjs to restore (idempotent).`,
    ).toEqual([]);
  });
});
