#!/usr/bin/env node
// cost-compact — wraps getTokenOptimizer().getCompactContext() so the
// cost-compact-context skill can invoke a single command instead of an
// inlined Node one-liner. A proper MCP tool wrapping getTokenOptimizer is
// still deferred (would require modifying @claude-flow/cli source); this
// is the plugin-local equivalent.
//
// Resolution: must run from a directory where `@claude-flow/integration`
// resolves (typically anywhere under `v3/`). The script resolves from
// process.cwd() rather than from its own location so the user's `cd v3`
// works without npm-installing the bridge into the plugin tree.
//
// Usage:
//   node scripts/compact.mjs "<query>"
//
// Optional env:
//   COMPACT_QUIET=1   emit JSON only (no markdown banner)

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

async function main() {
  const query = process.argv[2] || '';
  if (!query) {
    console.error('usage: compact.mjs "<query>"');
    process.exit(2);
  }

  let mod;
  try {
    const requireFromCwd = createRequire(join(process.cwd(), 'package.json'));
    const resolved = requireFromCwd.resolve('@claude-flow/integration/token-optimizer');
    mod = await import(pathToFileURL(resolved).href);
  } catch (err) {
    const out = {
      bridgeUnavailable: true,
      reason: String(err.message || err).slice(0, 300),
      memoriesRetrieved: 0,
      tokensSaved: 0,
      agenticFlowAvailable: false,
    };
    if (process.env.COMPACT_QUIET === '1') return console.log(JSON.stringify(out));
    console.log(`# cost-compact-context\n\nbridge unavailable: ${out.reason}`);
    console.log('Run from a directory where `@claude-flow/integration` resolves, e.g. `cd v3 && ...`.');
    return;
  }

  const { getTokenOptimizer } = mod;
  const opt = await getTokenOptimizer();
  const ctx = await opt.getCompactContext(query);
  const stats = opt.getStats();

  const out = {
    query,
    memoriesRetrieved: ctx.memories?.length ?? 0,
    tokensSaved: ctx.tokensSaved ?? 0,
    agenticFlowAvailable: !!stats?.agenticFlowAvailable,
    cacheHitRate: stats?.cacheHitRate || '0%',
    upstreamReported: 'tokensSaved is bridge-reported (heuristic), not measured against a no-RAG baseline',
  };

  if (process.env.COMPACT_QUIET === '1') return console.log(JSON.stringify(out));
  console.log(`# cost-compact-context — query: "${query}"`);
  console.log('');
  console.log('| Metric | Value |');
  console.log('|---|---:|');
  console.log(`| Memories retrieved | ${out.memoriesRetrieved} |`);
  console.log(`| Tokens saved (bridge-reported) | ${out.tokensSaved} |`);
  console.log(`| agentic-flow bridge available | ${out.agenticFlowAvailable} |`);
  console.log(`| Cache hit rate | ${out.cacheHitRate} |`);
  console.log('');
  console.log(`> ${out.upstreamReported}`);
  if (!out.agenticFlowAvailable) {
    console.log('');
    console.log('agentic-flow not installed — bridge returns inert results. No compact-context savings.');
  }
}

main().catch((e) => { console.error('compact.mjs failed:', e.message || e); process.exit(1); });
