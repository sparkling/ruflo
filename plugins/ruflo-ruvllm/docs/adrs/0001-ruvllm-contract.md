---
id: ADR-0001
title: ruflo-ruvllm plugin contract — pinning, namespace coordination, MicroLoRA + SONA cross-references, smoke as contract
status: Proposed
date: 2026-05-04
authors:
  - reviewer (Claude Code)
tags: [plugin, ruvllm, microlora, sona, llm, namespace, smoke-test]
---

## Context

`ruflo-ruvllm` (v0.1.0) — local LLM inference + MicroLoRA fine-tuning + chat formatting. 1 agent (`llm-specialist`), 2 skills (`llm-config`, `chat-format`), 1 command (`/ruvllm`).

Wraps `ruvllm_*` MCP family — same family that exposes the SONA + MicroLoRA tools `ruflo-intelligence` ADR-0001 already documents (`ruvllm_sona_create`, `ruvllm_sona_adapt`, `ruvllm_microlora_create`, `ruvllm_microlora_adapt` per `v3/@claude-flow/cli/src/mcp-tools/ruvllm-tools.ts:142, 169, 192, 222`). The HNSW WASM router (`ruvllm_hnsw_create/_add/_route`) is documented in `ruflo-agentdb` ADR-0001 §"Tool inventory".

This plugin is the canonical owner of the LLM-config + chat-format slice of the `ruvllm_*` surface; SONA + MicroLoRA + HNSW each have other canonical homes.

## Decision

1. Add this ADR (Proposed).
2. README augment: Compatibility (pin v3.6); Namespace coordination (claims `ruvllm-config`); Cross-reference table — SONA tools owned by ruflo-intelligence ADR-0001, MicroLoRA tools shared with ruflo-intelligence (DISTILL/CONSOLIDATE phase), HNSW WASM router owned by ruflo-agentdb ADR-0001; Verification + Architecture Decisions sections.
3. Bump `0.1.0 → 0.2.0`. Keywords add `mcp`, `local-inference`, `chat-templates`.
4. `scripts/smoke.sh` — 10 structural checks: version + keywords; both skills + agent + command with valid frontmatter; SONA cross-reference (ruflo-intelligence); MicroLoRA cross-reference (ruflo-intelligence DISTILL phase); HNSW cross-reference (ruflo-agentdb); v3.6 pin; namespace coordination; ADR Proposed; no wildcard tools.

## Consequences

**Positive:** plugin joins the cadence. Cross-plugin shared-tool ownership is now contractually documented (SONA → intelligence, MicroLoRA → intelligence DISTILL, HNSW WASM → agentdb).

**Negative:** none material.

## Verification

```bash
bash plugins/ruflo-ruvllm/scripts/smoke.sh
# Expected: "10 passed, 0 failed"
```

## Related

- `plugins/ruflo-intelligence/docs/adrs/0001-intelligence-surface-completeness.md` — owns SONA + MicroLoRA in the 4-step pipeline
- `plugins/ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md` — owns HNSW WASM router (`ruvllm_hnsw_*`) + namespace convention
- `plugins/ruflo-ruvector/docs/adrs/0001-pin-ruvector-0.2.25.md` — sibling substrate plugin
- `v3/@claude-flow/cli/src/mcp-tools/ruvllm-tools.ts` — 4 SONA + MicroLoRA tools at lines 142, 169, 192, 222
