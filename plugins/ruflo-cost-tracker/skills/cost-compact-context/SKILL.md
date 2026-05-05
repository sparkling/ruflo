---
name: cost-compact-context
description: Wrap getTokenOptimizer().getCompactContext() to retrieve compacted ReasoningBank context for cost-analysis queries; report bridge-reported tokensSaved
argument-hint: "<query>"
allowed-tools: Bash
---

# Cost Compact Context

Wraps `getTokenOptimizer().getCompactContext()` from `@claude-flow/integration` for cost-analysis queries. The bridge dynamically imports `agentic-flow` with graceful fallback: when the package isn't installed, `tokensSaved` is `0` and the skill exits cleanly. No MCP tool wraps `getTokenOptimizer` today (ADR-0002 §"Riskiest assumption"); we shell a Node one-liner instead.

## Steps

1. **Take the query** — the single argument.
2. **Invoke** — run from anywhere under `v3/` so `@claude-flow/integration` resolves:

   ```bash
   node --input-type=module -e '
     import("@claude-flow/integration/token-optimizer")
       .then(async ({ getTokenOptimizer }) => {
         const opt = await getTokenOptimizer();
         const out = await opt.getCompactContext(process.argv[1] || "");
         const stats = opt.getStats();
         console.log(JSON.stringify({
           memoriesRetrieved: out.memories?.length ?? 0,
           tokensSaved: out.tokensSaved ?? 0,
           agenticFlowAvailable: !!stats?.agenticFlowAvailable,
           cacheHitRate: stats?.cacheHitRate,
         }));
       })
       .catch((err) => console.log(JSON.stringify({
         memoriesRetrieved: 0, tokensSaved: 0, agenticFlowAvailable: false,
         bridgeUnavailable: true, reason: String(err?.message ?? err),
       })));
   ' -- "<QUERY>"
   ```

   Use the canonical export `@claude-flow/integration/token-optimizer`. **Not** `dist/token-optimizer.js` — Node's `./*` exports rule will double the `.js` extension and the import will fail.

3. **Report** — `Context compacted: <N> memories, <K> tokens saved (bridge-reported, not measured against a no-RAG baseline). agentic-flow available: <bool>. Cache hit rate: <X%>`. On bridge-unavailable: `agentic-flow not available, no compact-context savings`.

## Caveats — claimed upstream, not yet verified

CLAUDE.md root claims `ReasoningBank retrieval: -32%` tokens. The bridge's `tokensSaved` is `query_tokens − compact_prompt_tokens` (token-optimizer.ts:141–143) — a heuristic, **not** a baseline-measured saving. token-optimizer.ts:9–10 itself says: *"No fabricated metrics are reported — all stats reflect real measurements"*. This skill carries that disclaimer forward.

Booster-specific availability is **not** exposed as a getter — observable only through `optimizedEdit()` returning `method: 'agent-booster'`. The canonical Tier 1 signal is `[AGENT_BOOSTER_AVAILABLE]` (see `cost-booster-route`).

## Fallback

`agentic-flow` not installed → `getCompactContext` returns `{tokensSaved: 0, memories: []}` (line 116–124), `optimizedEdit` returns `{method: 'traditional'}`, `getOptimalConfig` falls back to anti-drift defaults. Skill exits cleanly with the "not available" message.

## Cross-references

ADR-0002 Decision #2 + §"Riskiest assumption" · `token-optimizer.ts:308` (singleton export) · `docs/benchmarks/0002-baseline.md` (verification findings).
