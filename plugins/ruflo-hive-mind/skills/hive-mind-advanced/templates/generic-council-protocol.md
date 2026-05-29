# Generic Council Protocol (default dialectic methodology)

The protocol layer the queen reads in Pattern 1 Phase 2 when the project ships **no** methodology of its own (no ONT-0021-style file). It is persona-agnostic: it tells you how to run a real dialectic council, not which named experts to seat. If the project ships its own methodology, use that instead — this file is the fallback.

This protocol governs the **queen-composed default flow**: workers are one-shot independent returners; the queen reads N return values and composes the inter-expert discussion in the main thread. Composition is legitimate when every quotation traces to an actual worker return; fabrication is illegitimate. Runtime cross-talk (workers revising after seeing peers) is a separate Transports option in SKILL.md §Transports (b)/(c) — note below where it changes Phase 4.

For the per-expert spawn-prompt contract (frame, context-reading instructions, focus questions, file-vs-return deliverable, DA charge), see `worker-contract.md`. **Do not duplicate it here** — this file is the protocol; that file is the prompt.

## 1. When to convene a council

| Convene | Do NOT convene |
|---|---|
| Decision-bearing: a verdict, ratification, or go/no-go is the deliverable | Throughput work — use `swarm-advanced` (parallel execution, no consensus) |
| Multi-perspective: ≥2 defensible stances exist and must be reconciled | One obviously-correct answer; no genuine disagreement to surface |
| High-stakes: design/ADR, architecture choice, irreversible trade-off | Routine multi-agent fan-out where a single composer suffices |

Trigger phrases: the user says "council" / "panel" / "convene", OR the objective is a design decision / ADR question / multi-stakeholder trade-off. If none of these hold, this is probably a swarm, not a hive.

## 2. Frame the proposition

The panel votes on **one falsifiable, decidable statement** — not an open-ended topic. Sharpen before spawning:

- ✗ "Discuss memory persistence." → ✓ "Hive workers SHOULD persist final verdicts as retrievable memory entries (vs. epistemic isolation per hive)."
- Binary or small-n-ary. Byzantine deadlocks on vague n-ary propositions; if you cannot phrase it as a yes/no (or a short enumerated choice), restructure before Phase 1.
- One proposition per vote. Multi-question councils run §6 once per question (Q1..Qn), each with its own tally.

## 3. Seat the panel

| N | Topology | Consensus | Notes |
|---|---|---|---|
| 3 | `mesh` | `byzantine` | minimum viable council; `f=floor((N-1)/3)=0` — needs unanimity to "approve" under BFT, so prefer `weighted` if the queen should break ties |
| 4–6 | `mesh` | `byzantine` (or `weighted` if queen vote should dominate) | sweet spot; `f` tolerates 1 absent/faulty at N≥4 |
| 7+ | `hierarchical-mesh` | `byzantine` | sub-queens summarise per cluster (1-level cap) |

Recommended **N = 3–6**. Set `consensus: "byzantine"` for worker-unreliability tolerance; `consensus: "weighted"` when the queen is the authoritative voice and worker votes are advisory (queen counts ×3, denominator `(N-1)+3`).

Seating rules:

1. **Distinct named experts, real methodologies.** Each seat is a named practitioner (e.g. Fowler, Ousterhout, Evans, Hickey, Beck, Liskov for software architecture; Allemang, Hendler, Kendall, Cagle for ontology/data) arguing from a **real published methodology**, never "Worker A/B/C" or a generic role label. Pick a panel appropriate to the question's domain; the names are suggestive, not prescriptive.
2. **MANDATORY Devil's Advocate seat.** Exactly one panellist is the DA for this session. Their charge is to find flaws, over-engineering, and hidden complexity — *not* to steel-man a contrarian position. The DA must genuinely dissent (see §8). See `worker-contract.md` for the DA prompt variant.
3. **Distinct focus per seat.** Each expert gets a different angle on the proposition (the section-4 focus questions in `worker-contract.md` are the only part that varies meaningfully across panellists in the same session).

## 4. Expert rules (each panellist obeys)

1. Take a **clear stance** on the proposition — approve / reject (or pick an enumerated option), not a hedge.
2. Argue **from a named methodology** the expert is known for; reasoning must be attributable to that frame.
3. Engage **≥1 other expert by name** with a **specific claim** ("On the substitution risk, Liskov is right that … but …"). Vague "I agree with the panel" does not count.
4. **Never fabricate.** State only what the expert's methodology actually supports; the queen will trace every quote back to this return.

These rules live operationally in each spawn prompt — see `worker-contract.md`. This section is the contract the protocol *enforces*; that file is how it is *delivered*.

## 5. Round structure

**ONE spawn round.** The queen spawns all N panellists in a single message (parallel sync barrier — see SKILL.md Pattern 1 Phase 4), waits for **all** to return (no placeholders, no "good enough with what we have" — absence of any panellist is a HARD BLOCK on composition), then composes.

- **Default (queen-composed cross-talk):** workers do **not** see each other at runtime. The §6 "Cross-Expert Discussion" section is written by the queen from the N independent returns. This is the canonical flow that produced 250+ pre-regression council sessions.
- **Where runtime cross-talk changes this:** if workers must *revise* their position after reading peers, switch to SKILL.md §Transports (b) `SendMessage`/Agent Teams or (c) `_memory`. Then Phase 4 becomes a multi-exchange round and §6's discussion is partly worker-authored rather than wholly queen-composed. The default below assumes queen-composed.

## 6. Vote protocol

After all panellists return, the queen runs the vote:

```javascript
// Propose
mcp__ruflo__hive-mind_consensus({
  action: "propose", type: "council-verdict",
  value: "<the proposition>",
  strategy: "byzantine",        // or "weighted"
  timeoutMs: 30000
})
// One ballot per expert, derived from that expert's return value
mcp__ruflo__hive-mind_consensus({
  action: "vote", proposalId, voterId: "<expert-name>", vote: <true|false>
})  // × N
// Tally
mcp__ruflo__hive-mind_consensus({ action: "status", proposalId })
```

| Strategy | Threshold | Ties / abstentions |
|---|---|---|
| `byzantine` | `requiredVotes = 2·floor((N-1)/3) + 1` | below threshold → `pending`, then auto-transitions to `failed-quorum-not-reached` at `timeoutMs`; treat as no-verdict, do not force one |
| `weighted` | queen vote ×3 dominates; `approved` once weighted majority crosses denominator `(N-1)+3` | queen breaks ties by weight; an abstaining worker simply does not contribute its vote |

Quorum: every roster member must have returned before tallying. Abstentions are recorded explicitly (an expert may decline on a sub-question outside their frame) and reduce the effective denominator — they are not silent. A tie under `byzantine` resolves to no-verdict (restructure the proposition or drop to `weighted`); never declare "all agreed" to escape a tie.

## 7. Transcript format (exactly 8 sections)

The queen composes one transcript per council, using **only** actual worker content.

| # | Section | Contents |
|---|---|---|
| 1 | **Agenda** | The proposition(s) Q1..Qn, the panel roster (N names + which seat is DA), date, scope. State the rule references being applied (this protocol, or the project methodology). |
| 2 | **Positions** | One block per expert: `**<Name>** (<frame>): "<stance + reasoning ~100 words, from their return value, citing their methodology>"`. One block per seat, including the DA. |
| 3 | **Cross-Expert Discussion** | Queen-composed sequenced turns, each naming a prior expert and engaging a specific claim: `**<Name>:** "Building on <Other>'s point about X, …"`. **Every turn traces to real return content** — composition over real material, never invented. ≥1 turn per non-DA expert engaging a peer by name. |
| 4 | **Vote Table** | `\| voterId \| vote \| one-line rationale \|` — one row per expert, rationale distilled from their return. Use `N-M-K` notation for split/abstain when summarising. |
| 5 | **Findings** | What the discussion established: agreed points, surviving disagreements, refinements adopted from the conversation (label each by source: "R1 (from <Name>): …"). |
| 6 | **Verdict** | Overall outcome + **confidence** (e.g. "approve, high confidence" / "approve, low — convergence is soft") + **recorded dissent** (the DA's surviving objection if not withdrawn, with its rationale). |
| 7 | **Signatures** | N lines, `<Name> — <their assessed verdict>` (approve / reject / abstain). The DA's line states withdraw-or-hold. |

(Sections 5–6 may be merged into "findings → verdict" for a single-question council; keep all 7 headings for multi-question or high-stakes sessions. The DA challenge + responses live inside §3 Cross-Expert Discussion as a named exchange, satisfying the 8th dialectic element.)

## 8. The trust bar

A council is only worth running if it clears all three:

1. **Traceability.** Every quotation in §2–§3 traces to a specific worker return value. If you cannot point to the return text behind a quote, delete the quote. Composition is legitimate; fabrication is not.
2. **Genuine DA dissent.** The Devil's Advocate must either (a) explicitly **withdraw** — naming the argument that moved them — or (b) **hold** principled dissent recorded in §6. A council where the DA "ends up agreeing with everyone" did not have a real DA; re-run with a sharper DA charge.
3. **Honest verdict.** §6 states both **confidence** AND **surviving dissent**. "Unanimous, high confidence" is suspect on a genuinely contested proposition — if convergence was forced rather than earned, say so and lower the confidence.

---

Drawn from: ADR-0138 §"What ships in the patched queen prompt template" + §"Full 12-stage flow" (stages 5/6/10), ADR-0140 §Piece 2 + §"Generic council-transcript shape", ADR-0145 §"Findings synthesis" (B1 consensus bounds, C1 failure transitions, D3 empirical patterns).
