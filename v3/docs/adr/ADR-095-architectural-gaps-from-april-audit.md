# ADR-095: Architectural Gaps From the April 2026 Audit

**Status**: Proposed (tracking only — no decisions yet on individual rows)
**Date**: 2026-05-03
**Version**: targets v3.7.x and beyond
**Supersedes**: nothing
**Related**: ADR-093 (May audit remediation), ADR-094 (transformers migration), [public audit gist](https://gist.github.com/roman-rr/ed603b676af019b8740423d2bb8e4bf6) by @roman-rr (2026-04-04)

## Context

The April 2026 audit by @roman-rr documented architectural gaps that ADR-093's "honesty patches" did not address. ADR-093 fixed the *contract* of the affected MCP tools (no more silent lies, no more bare hardcoded labels, schemas that round-trip what callers pass), but the *execution layer* underneath several of these tools is still missing.

This ADR is the canonical tracking record for those gaps. Each row below is a candidate for its own follow-up ADR with its own decision, scope, and validation plan. We are not deciding *how* to close any of them here — only naming them precisely so they cannot quietly fall off the backlog.

## The Gaps

### G1 — `agent_spawn` does not fork a subprocess

**Current state.** `agent_spawn` writes a JSON record into an in-memory `Map`: `{ agentId, status: 'idle', taskCount: 0, lastResult: null }`. No subprocess. No `fork()`. No LLM call. The status field never advances on its own. The schema-honesty work in ADR-093 made the lifecycle observable (the audit's `taskCount: 0 forever` is now reachable as the genuine state) but did not wire up an executor.

**Wire that exists, unused.** The `AnthropicProvider` class in `v3/@claude-flow/providers/` makes real `fetch` calls to `api.anthropic.com`. The `ProviderManager` does round-robin and latency-based routing. Neither is imported by the agent spawn / task / swarm code paths.

**What a real fix requires.**
- A worker pool that picks up `task_assign` events and runs them against `ProviderManager`.
- Result reporting back through `agent_status` and `task_status`.
- Process lifecycle for in-flight tasks (cancellation, timeout, OOM).
- Decision: in-process worker pool vs spawned subprocess vs E2B/sandboxes — each has a different security/perf profile.

**Why deferred.** This is not a 5-minute fix. It's the missing wire between the registry and the LLM layer the audit correctly identified.

---

### G2 — Hive-mind execution is single-process

**Current state.** ADR-093 F3 made `hive-mind_init` accept `consensus: 'raft' | 'byzantine' | 'gossip' | 'crdt' | 'quorum'`, persist `consensusStrategy` to state, and round-trip it through `hive-mind_status`. So the *parameter* is honest now.

The *handler* underneath is still EventEmitter-based and runs in a single Node process. `byzantine-coordinator.ts`'s `verifySignature()` returns `true` unconditionally. `RaftConsensus.requestVotes()` does `this.emit('vote_request')` against a local emitter. There are no sockets, no gRPC, no inter-node transport.

**What a real fix requires.**
- A multi-process (or multi-node) transport layer. Likely candidates: WebSockets, gRPC, or the agentdb sync coordinator.
- Real signature verification using the `@noble/ed25519` keypairs already in tree.
- Per-strategy correctness validation (BFT vote counting, Raft term/log replication, gossip propagation).
- Failure injection tests for f<n/3 (BFT) and f<n/2 (Raft).

**Why deferred.** Distributed consensus is its own ADR — the security and correctness implications cannot be slotted into a /loop iteration.

---

### G3 — Workflow execution lacks a runtime

**Current state.** `workflow_create` persists a workflow record to `.claude-flow/workflows/store.json`. `workflow_execute` returns `{error: "Workflow not found"}` even when called with a workflow ID that DOES exist in the store. The state machine definition (steps, conditions, deps) is present but no executor walks it.

**What a real fix requires.**
- A workflow runner that reads the persisted definition, walks the dependency graph, dispatches step actions to the agent layer (which itself needs G1 done first), and persists progress.
- Pause / resume / cancel semantics.
- Step retry policy.
- Output binding between steps (step N's output feeds step N+1's input).

**Why deferred.** Depends on G1.

---

### G4 — WASM agent prompt echoes input

**Current state.** `wasm_agent_prompt(input: "List 3 advantages of backtesting")` returns `"echo: List 3 advantages of backtesting"`. There is no WASM runtime, no LLM call, no sandbox. The MCP tool registers the agent definition and prints back what the user sent.

**What a real fix requires.**
- Integration with a real WASM runtime (`wasmtime`, `wasmer`, or browser WASM via Node's built-in support).
- A sandboxed execution context with disk/network policy.
- An LLM provider call (G1's wire) wrapped by the sandbox.

**Why deferred.** Depends on G1 plus a WASM runtime decision.

---

### G5 — `@xenova/transformers` → `protobufjs` critical RCE chain

**Current state.** `@xenova/transformers@2.17.x` is the deprecated predecessor of `@huggingface/transformers`. It pins `onnxruntime-web` versions that depend on `protobufjs <7.5.5`, which has a critical RCE CVE (`GHSA-h755-8qp9-cq85`). npm overrides cannot resolve this because the version range required by xenova's manifests forbids the safer protobufjs.

**Plan documented.** [ADR-094](./ADR-094-xenova-to-huggingface-transformers-migration.md) — try-prefer-fallback loader (`@huggingface/transformers` → `@xenova/transformers`).

**Status.** Implementation landed on branch in iteration #14; verification queued for next /loop publish.

---

### G6 — Auto-memory graph state bloat (100 MB / 20 unique entries)

**Current state.** The `auto-memory-hook.mjs` reads `MEMORY.md` files from `~/.claude/projects/*/memory/`, parses each section as a separate entry, and stores them in `auto-memory-store.json`. Then it builds a similarity graph using character-trigram Jaccard, runs PageRank for 30 iterations, and writes `graph-state.json` and `ranked-context.json`.

The audit measured: 5,706 entries, ~20 unique (5,686 are the same MEMORY.md sections duplicated across project directories). `graph-state.json` is 100 MB. `ranked-context.json` is 8.7 MB. The PageRank result is uniform (~0.02 across nodes) — meaningless because the graph is near-complete between near-identical duplicates. Trigram Jaccard isn't semantic — it scores character overlap, not meaning. The same entry is injected into Claude's context 5 times per message.

**What a real fix requires.**
- Dedup on content hash before graph construction.
- Replace trigram Jaccard with the existing 384-dim ONNX embedding similarity we already use elsewhere.
- Threshold edges (e.g. drop edges with similarity < 0.3) so the graph isn't near-complete.
- Cap injection at top-K *unique* entries per message, not top-K rows.
- Probably remove PageRank entirely for stores with < 100 unique entries — it's not useful at that scale.

**Why deferred.** This is its own cleanup track; touches the auto-memory hook, the trigram graph builder, and the runtime injection path. Worth its own ADR.

---

### G7 — Disabled AgentDB controllers (6 of 8 still off after ADR-093 F9)

**Current state.** ADR-093 F9 probed and wired `semanticRouter` (when present in agentdb), and improved the actionable error for `bridgeSemanticRoute`. The other 6 disabled controllers ship off because each constructor needs something the registry doesn't currently expose:

| Controller | Why disabled |
|---|---|
| `mutationGuard` | Needs write-policy config; turning on without config could break writes |
| `attestationLog` | Needs a sqlite db handle the registry doesn't expose; constructor throws otherwise |
| `gnnService` | Needs heavy deps (CUDA / WASM); not always available |
| `guardedVectorBackend` | Needs key material for at-rest encryption |
| `rvfOptimizer` | Needs RVF format storage configured |
| `graphAdapter` | Needs a graph DB connection |

**What a real fix requires.**
- One per-controller ADR with the activation gate (config schema, key material, security review for the encryption-related ones).
- A `controllers-config.json` schema or env-var convention so users can opt in deliberately.

**Why deferred.** Each controller activation is a security decision — turning them on in bulk would silently widen the attack surface.

---

## Decision

Track each gap as a candidate ADR rather than letting them dilute through the issue tracker:

- ADR-096 (when written): G1 agent_spawn worker wire
- ADR-097: G2 multi-process consensus
- ADR-098: G3 workflow runtime (depends on ADR-096)
- ADR-099: G4 WASM runtime
- ADR-100: G5 — superseded by ADR-094 (this slot left intentionally vacant)
- ADR-101: G6 auto-memory graph dedup + threshold
- ADR-102 through ADR-107: per-controller activation ADRs for G7

Numbers are reservations only; no decisions yet on any of them. The point of this ADR is to ensure the gaps are visible from the decisions log, not buried in PR comments.

## Validation

This ADR closes when each row above has either landed in its own ADR (proposed/accepted) or been explicitly de-scoped with a recorded reason. The April audit gist ([link](https://gist.github.com/roman-rr/ed603b676af019b8740423d2bb8e4bf6)) is the source of truth for what the audit named — re-read it before claiming any G# is done.

## Notes

- ADR-093 was never the right place to address these. It was a punch list of *honesty patches* — making the contract match the implementation. ADR-095 explicitly tracks gaps where the implementation needs to expand to match what the contract should be.
- @roman-rr's audit was rigorous; the gaps named here are real. This ADR exists so future maintainers don't re-discover them every audit cycle.
