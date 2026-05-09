#!/usr/bin/env node
/**
 * Regenerate the cryptographically-signed witness manifest at
 * `verification.md.json` for the current git HEAD.
 *
 * Used after publishing a release with new fix entries. Replaces the
 * inline regen described in `~/.claude/.../project_verification_process.md`.
 *
 * Behavior:
 *   1. Loads the existing manifest's `fixes[]` (so prior 78 entries persist).
 *   2. Appends entries from NEW_FIXES below.
 *   3. Refreshes each fix's sha256 against the current dist; sets
 *      `markerVerified` based on whether the marker substring is present.
 *   4. Updates `issuedAt`, `gitCommit`, `branch`, `releases`, and `summary`.
 *   5. Computes manifest hash, derives Ed25519 keypair from
 *      `sha256(gitCommit + ':ruflo-witness/v1')`, signs the manifest hash.
 *   6. Writes verification.md.json.
 *
 * Usage:
 *   node scripts/regen-witness.mjs            # regen using current HEAD
 *   node scripts/regen-witness.mjs --dry-run  # print what would change
 *
 * To register a new fix, append a `{ id, desc, file, marker }` entry to
 * NEW_FIXES. The script computes sha256 + markerVerified at write time.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// `@noble/ed25519` is installed in the `v3/` workspace, not at repo root.
// Use createRequire so the script runs without a top-level `npm install`.
const require = createRequire(join(process.cwd(), 'v3/node_modules/.placeholder'));
const ed = require('@noble/ed25519');

ed.etc.sha512Sync = (...m) => {
  const h = createHash('sha512');
  for (const x of m) h.update(x);
  return h.digest();
};

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = join(REPO_ROOT, 'verification.md.json');
const DRY_RUN = process.argv.includes('--dry-run');

// New fix entries to register on this regen. The script will compute
// sha256 + markerVerified for each. Append entries here when shipping
// a release with new documented fixes.
const NEW_FIXES = [
  {
    id: '#1867',
    desc: 'Node 26 install: better-sqlite3 dynamic import + optionalDependencies',
    file: 'v3/@claude-flow/memory/dist/sqlite-backend.js',
    marker: "(await import('better-sqlite3')).default",
  },
  {
    id: '#1859',
    desc: 'CLI flag/positional priority swap — named flags win over stray positionals (14 sites in hooks.ts)',
    file: 'v3/@claude-flow/cli/dist/src/commands/hooks.js',
    marker: 'ctx.flags.file || ctx.args[0]',
  },
  {
    id: '#1862',
    desc: 'ruflo-core PostToolUse hooks call documented CLI flags (-c/-s/-e, -f/-s) instead of bogus --format true',
    file: 'plugins/ruflo-core/hooks/hooks.json',
    marker: 'hooks post-edit -f \\"$FILE\\" -s true',
  },
];

// ─────────────────────────────────────────────────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fileSha256(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function fileContains(absPath, marker) {
  return readFileSync(absPath, 'utf8').includes(marker);
}

function refreshFix(fix) {
  const abs = join(REPO_ROOT, fix.file);
  if (!existsSync(abs)) {
    return { ...fix, sha256: fix.sha256 ?? '', markerVerified: false, _missing: true };
  }
  const sha256 = fileSha256(abs);
  const markerVerified = fileContains(abs, fix.marker);
  return { id: fix.id, desc: fix.desc, file: fix.file, sha256, marker: fix.marker, markerVerified };
}

// ─────────────────────────────────────────────────────────────────────

const witness = readJson(MANIFEST_PATH);
const oldFixes = witness.manifest?.fixes ?? [];
const oldIds = new Set(oldFixes.map(f => f.id));

const merged = [
  ...oldFixes.map(refreshFix),
  ...NEW_FIXES.filter(f => !oldIds.has(f.id)).map(refreshFix),
];

const gitCommit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim();
const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT }).toString().trim();
const issuedAt = new Date().toISOString();

// Read package versions for the releases block.
const releases = {};
for (const [key, pkgPath] of [
  ['ruflo', 'ruflo/package.json'],
  ['claude-flow', 'package.json'],
  ['@claude-flow/cli', 'v3/@claude-flow/cli/package.json'],
  ['@claude-flow/memory', 'v3/@claude-flow/memory/package.json'],
]) {
  const fullPath = join(REPO_ROOT, pkgPath);
  if (existsSync(fullPath)) {
    releases[key] = readJson(fullPath).version;
  }
}

const verifiedCount = merged.filter(f => f.markerVerified).length;
const missingCount = merged.filter(f => f._missing).length;

const manifest = {
  schema: witness.manifest?.schema ?? 'ruflo-witness/v1',
  issuedAt,
  gitCommit,
  branch,
  releases,
  summary: {
    totalFixes: merged.length,
    verified: verifiedCount,
    missing: missingCount,
  },
  fixes: merged.map(f => {
    // Strip internal-only fields before signing.
    const { _missing: _drop, ...clean } = f;
    return clean;
  }),
};

const manifestCanonical = JSON.stringify(manifest);
const manifestHash = createHash('sha256').update(manifestCanonical).digest('hex');
const seed = createHash('sha256').update(gitCommit + ':ruflo-witness/v1').digest();
// @noble/ed25519 v2 exposes both sync and async APIs; sync is fine here
// because we configured sha512Sync above.
const publicKey = ed.getPublicKey(seed);
const signature = ed.sign(Buffer.from(manifestHash, 'hex'), seed);

const fullWitness = {
  manifest,
  integrity: {
    manifestHashAlgo: 'sha256',
    manifestHash,
    signatureAlgo: 'ed25519',
    publicKey: Buffer.from(publicKey).toString('hex'),
    signature: Buffer.from(signature).toString('hex'),
    seedDerivation: "sha256(gitCommit + ':ruflo-witness/v1')",
  },
};

const summary = `
witness regen summary
─────────────────────
  gitCommit:    ${gitCommit.slice(0, 12)}…
  branch:       ${branch}
  issuedAt:     ${issuedAt}
  total fixes:  ${manifest.summary.totalFixes}  (was ${oldFixes.length})
  verified:     ${verifiedCount}
  missing:      ${missingCount}
  new entries:  ${NEW_FIXES.filter(f => !oldIds.has(f.id)).map(f => f.id).join(', ') || '(none)'}
  releases:     ${JSON.stringify(releases)}
`;

if (DRY_RUN) {
  console.log(summary);
  console.log('(dry-run — manifest NOT written)');
  process.exit(0);
}

writeFileSync(MANIFEST_PATH, JSON.stringify(fullWitness, null, 2));
console.log(summary);
console.log(`written: ${MANIFEST_PATH}`);
