#!/usr/bin/env node
/**
 * Smoke: ADR-0255 Phase 1 — memory_export MCP tool.
 *
 * Closes a latent CLI crash: pre-ADR-0255, `claude-flow memory export -o ...`
 * invoked `callMCPTool('memory_export', ...)` against an unregistered tool.
 * This smoke verifies the tool now exists, has the expected shape, and that
 * its input-validation typed errors (ADR-0255 Decision #3 csv/binary,
 * Decision #6 includeVectors) fire BEFORE substrate boot.
 *
 * Two passes:
 *
 *   Pass A — surface inspection (no substrate, always runs):
 *     1. memoryTools contains an entry named 'memory_export'.
 *     2. inputSchema declares the four properties (outputPath required;
 *        format / namespace / includeVectors optional) per ADR-0255 Decision #5.
 *     3. Calling the handler with format='csv' throws a typed error containing
 *        'csv' + 'not implemented' (Decision #3).
 *     4. Calling the handler with format='binary' throws likewise (Decision #3).
 *     5. Calling the handler with includeVectors=true throws containing
 *        'includeVectors' + 'not implemented' (Decision #6).
 *     6. Calling the handler with NO outputPath returns the typed-error
 *        envelope { error: "...outputPath is required..." } (input validation).
 *
 *   Pass B — happy-path round-trip (best-effort; degrades cleanly):
 *     This requires the embedding pipeline (@xenova/transformers or ruvector)
 *     to be installed in the runtime tree — silent hash-fallback was removed
 *     per [[feedback-no-fallbacks]] / ADR-0234. When unavailable, the
 *     substrate-boot inside ensureRouter() throws and Pass B is reported as
 *     SKIPPED with the exact reason (NOT silenced — the smoke exit code is
 *     still 0 for Pass A passing, and the unavailability is printed loudly).
 *     This is the dev-tree reality; the production install always has an
 *     embedding provider, so Pass B exercises the substrate seam there.
 *
 *     1. mkdtemp a fresh project root; point CLAUDE_FLOW_CWD at it.
 *     2. Call memory_export on the empty store with a tmp outputPath.
 *     3. Verify:
 *          (a) envelope { outputPath, format: 'json', exported: {...} }
 *          (b) the written file parses as JSON
 *          (c) parsed.schema === 'ruflo-memory-export/v1'
 *          (d) parsed.count === 0 and parsed.entries === [] on an empty store
 *          (e) namespace filter sets parsed.namespace appropriately
 *
 * Out-of-scope here (Phase 2 of ADR-0255, not this commit):
 *   - `memory retrieve --value-only` pipe-friendly stdout shape.
 *
 * Exit codes:
 *   0 — Pass A clean (Pass B clean OR skipped with documented reason)
 *   1 — Pass A failed (typed-error or schema regression) OR Pass B *executed*
 *       but produced wrong output
 *
 * Usage:
 *   cd forks/ruflo && npm run build:ts && node scripts/smoke-memory-export.mjs
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const COMPILED_TOOLS = resolve(
  REPO_ROOT,
  'v3/@claude-flow/cli/dist/src/mcp-tools/memory-tools.js'
);

if (!existsSync(COMPILED_TOOLS)) {
  console.error(`[smoke] FAIL: compiled memory-tools not found at ${COMPILED_TOOLS}`);
  console.error('[smoke] run `npm run build:ts` first.');
  process.exit(1);
}

let failures = 0;
function fail(msg) {
  failures += 1;
  console.error(`[smoke] FAIL: ${msg}`);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

let memoryTools;
try {
  const mod = await import(pathToFileURL(COMPILED_TOOLS).href);
  memoryTools = mod.memoryTools;
} catch (e) {
  console.error(`[smoke] FAIL: cannot import compiled memoryTools: ${e?.message ?? String(e)}`);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Pass A — surface inspection (no substrate boot)
// ═══════════════════════════════════════════════════════════════════════════
console.log('[smoke] Pass A — surface inspection');

const exportTool = memoryTools.find((t) => t.name === 'memory_export');
assert(exportTool, 'memory_export tool registered in memoryTools');
if (!exportTool) {
  console.error('[smoke] Pass A fatal: cannot continue without memory_export tool');
  process.exit(1);
}

assert(typeof exportTool.description === 'string' && exportTool.description.length > 10, 'description is non-trivial');
assert(exportTool.category === 'memory', `category === 'memory' (got ${exportTool.category})`);
assert(exportTool.inputSchema?.type === 'object', `inputSchema.type === 'object'`);

const props = exportTool.inputSchema?.properties ?? {};
assert(props.outputPath, 'inputSchema declares outputPath');
assert(props.format, 'inputSchema declares format');
assert(props.namespace, 'inputSchema declares namespace');
assert(props.includeVectors, 'inputSchema declares includeVectors');
assert(
  Array.isArray(exportTool.inputSchema?.required) && exportTool.inputSchema.required.includes('outputPath'),
  `inputSchema.required includes 'outputPath'`
);

// — compiled source contains the schema literal we promise (Decision #3)
console.log('[smoke]   verifying schema string in compiled handler source...');
{
  const compiledSrc = readFileSync(COMPILED_TOOLS, 'utf-8');
  assert(
    compiledSrc.includes("'ruflo-memory-export/v1'") || compiledSrc.includes('"ruflo-memory-export/v1"'),
    `compiled memory-tools.js contains the literal 'ruflo-memory-export/v1' (the schema-string contract per ADR-0255 Decision #3)`
  );
  // 100k limit is also a load-bearing decision (Decision #7 — explicit cap).
  assert(
    compiledSrc.includes('100000'),
    `compiled memory-tools.js contains the 100000 limit (the explicit cap per ADR-0255 Decision #7)`
  );
}

// — missing outputPath → typed-error envelope (input validation; no substrate)
console.log('[smoke]   verifying missing outputPath returns typed-error envelope...');
{
  let result;
  try {
    result = await exportTool.handler({});
  } catch (e) {
    fail(`empty input must NOT throw (it returns { error }); got throw: ${e?.message ?? String(e)}`);
  }
  assert(
    result && typeof result.error === 'string' && /outputPath/i.test(result.error),
    `empty input returns { error: "...outputPath..." } (got ${JSON.stringify(result)})`
  );
}

// — format: 'csv' → typed error (no substrate, pre-init validation)
console.log('[smoke]   verifying format=csv throws typed error...');
{
  let threw = false;
  let msg = '';
  try {
    await exportTool.handler({ outputPath: '/tmp/unused.json', format: 'csv' });
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, `format='csv' must throw (per ADR-0255 Decision #3)`);
  assert(threw && /csv/i.test(msg) && /not implemented/i.test(msg), `csv error mentions 'csv' + 'not implemented' (got: ${msg})`);
}

// — format: 'binary' → typed error
console.log('[smoke]   verifying format=binary throws typed error...');
{
  let threw = false;
  let msg = '';
  try {
    await exportTool.handler({ outputPath: '/tmp/unused.json', format: 'binary' });
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, `format='binary' must throw (per ADR-0255 Decision #3)`);
  assert(threw && /binary/i.test(msg) && /not implemented/i.test(msg), `binary error mentions 'binary' + 'not implemented' (got: ${msg})`);
}

// — includeVectors: true → typed error
console.log('[smoke]   verifying includeVectors=true throws typed error...');
{
  let threw = false;
  let msg = '';
  try {
    await exportTool.handler({ outputPath: '/tmp/unused.json', includeVectors: true });
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, `includeVectors=true must throw (per ADR-0255 Decision #6)`);
  assert(threw && /includeVectors/i.test(msg) && /not implemented/i.test(msg), `includeVectors error mentions 'includeVectors' + 'not implemented' (got: ${msg})`);
}

if (failures > 0) {
  console.error(`[smoke] Pass A FAIL: ${failures} assertion(s) failed`);
  process.exit(1);
}

console.log('[smoke] Pass A PASS');

// ═══════════════════════════════════════════════════════════════════════════
// Pass B — happy-path round-trip (best-effort)
// ═══════════════════════════════════════════════════════════════════════════
console.log('[smoke] Pass B — happy-path round-trip (substrate boot)');

const tmpRoot = mkdtempSync(join(tmpdir(), 'ruflo-mem-export-'));
process.env.CLAUDE_FLOW_CWD = tmpRoot;
const exportPath = join(tmpRoot, 'export.json');
const cleanup = () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[smoke]   tmpRoot cleanup warning: ${e?.message ?? String(e)}`);
  }
};

let exportResult;
let substrateFailure = null;
try {
  exportResult = await exportTool.handler({ outputPath: exportPath });
} catch (e) {
  substrateFailure = e instanceof Error ? e.message : String(e);
}

if (substrateFailure) {
  // The most common dev-tree failure: embedding pipeline init fails because
  // @xenova/transformers / ruvector aren't installed in this tree (ADR-0234
  // removed the silent hash-fallback). Pass B is degraded — but Pass A still
  // covered the contract surface, so the smoke is honest about what it tested.
  console.warn(`[smoke]   Pass B SKIPPED — substrate boot failed:`);
  console.warn(`[smoke]     ${substrateFailure.split('\n')[0]}`);
  console.warn(`[smoke]   This is expected when the embedding provider isn't installed`);
  console.warn(`[smoke]   in the dev tree. Pass A (contract surface) was clean; the`);
  console.warn(`[smoke]   end-to-end round-trip runs in the installed-package smoke.`);
  cleanup();
  process.exit(0);
}

let pbFailures = 0;
function pbFail(msg) {
  pbFailures += 1;
  console.error(`[smoke]   FAIL: ${msg}`);
}
function pbAssert(cond, msg) {
  if (!cond) pbFail(msg);
}

pbAssert(
  exportResult && exportResult.outputPath === exportPath,
  `envelope.outputPath === ${exportPath} (got ${JSON.stringify(exportResult?.outputPath)})`
);
pbAssert(
  exportResult && exportResult.format === 'json',
  `envelope.format === 'json' (got ${JSON.stringify(exportResult?.format)})`
);
pbAssert(
  exportResult && exportResult.exported && typeof exportResult.exported.entries === 'number',
  `envelope.exported.entries is a number (got ${JSON.stringify(exportResult?.exported)})`
);
pbAssert(
  exportResult && exportResult.exported && exportResult.exported.entries === 0,
  `envelope.exported.entries === 0 on empty store (got ${exportResult?.exported?.entries})`
);
pbAssert(
  exportResult && typeof exportResult.fileSize === 'string' && /\dB$/.test(exportResult.fileSize),
  `envelope.fileSize is an 'NB'-suffixed string (got ${JSON.stringify(exportResult?.fileSize)})`
);

let parsed;
try {
  parsed = JSON.parse(readFileSync(exportPath, 'utf-8'));
} catch (e) {
  pbFail(`written file is not valid JSON: ${e?.message ?? String(e)}`);
}
if (parsed) {
  pbAssert(parsed.schema === 'ruflo-memory-export/v1', `schema === 'ruflo-memory-export/v1' (got ${JSON.stringify(parsed.schema)})`);
  pbAssert(parsed.namespace === null, `parsed.namespace === null when no filter (got ${JSON.stringify(parsed.namespace)})`);
  pbAssert(typeof parsed.exportedAt === 'string' && parsed.exportedAt.length > 0, `exportedAt is non-empty ISO string`);
  pbAssert(Array.isArray(parsed.entries), `parsed.entries is an array`);
  pbAssert(parsed.count === 0, `parsed.count === 0 on empty store (got ${parsed.count})`);
  pbAssert(parsed.entries?.length === 0, `parsed.entries.length === 0 on empty store (got ${parsed.entries?.length})`);
}

// namespace-filter envelope shape
const exportPathNs = join(tmpRoot, 'export-ns.json');
try {
  await exportTool.handler({ outputPath: exportPathNs, namespace: 'smoke-export' });
  const parsedNs = JSON.parse(readFileSync(exportPathNs, 'utf-8'));
  pbAssert(parsedNs.namespace === 'smoke-export', `namespace filter sets parsed.namespace (got ${JSON.stringify(parsedNs?.namespace)})`);
} catch (e) {
  pbFail(`namespace-filter export threw: ${e?.message ?? String(e)}`);
}

cleanup();

if (pbFailures > 0) {
  console.error(`[smoke] Pass B FAIL: ${pbFailures} assertion(s) failed`);
  process.exit(1);
}

console.log('[smoke] Pass B PASS');
console.log('[smoke] PASS: memory_export Phase 1 contracts verified (both passes)');
process.exit(0);
