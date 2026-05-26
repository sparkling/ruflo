---
name: adr-review
description: Review code changes against accepted ADRs and lint ADR frontmatter for cross-corpus and referential-integrity violations
argument-hint: "[--branch BRANCH] [--lint-only]"
allowed-tools: mcp__ruflo__agentdb_hierarchical-query mcp__ruflo__agentdb_causal-query mcp__ruflo__memory_search Bash Read Grep Glob
---

# ADR Review

Review code changes against accepted Architecture Decision Records to detect violations and drift, AND lint ADR frontmatter for cross-corpus modifying-relations violations and referential-integrity issues.

## When to use

Before committing or merging, after significant code changes, or as part of a periodic compliance check. Also runs as a frontmatter lint on changed `docs/adr/*.md` and `docs/ontology/odr/*.md` records to catch typed-relation errors before they hit the indexer.

`--lint-only` skips the code-vs-ADR compliance review and runs only the frontmatter lints (faster; useful as a pre-commit hook).

## Steps

### Phase A — Frontmatter lints (always run)

A1. **Identify changed records** -- Run `git diff --name-only main...HEAD` (or the specified branch) and filter for `docs/adr/*.md` and `docs/ontology/odr/*.md`. If no record changes, skip to Phase B.

A2. **Parse YAML frontmatter** -- For each changed record file, `Read` and parse YAML between the leading `---` fences. If frontmatter is malformed, fail loud (exit non-zero) with the file path and YAML parse error.

A3. **Cross-corpus modifying-relations lint** -- For each record:

   ```python
   # Pseudocode for the rule, ~6 lines.
   own_corpus = "ADR" if record.path.startswith("docs/adr/") else "ONT"
   for relation in ["supersedes", "implements"]:
       for ref in record.frontmatter.get(relation, []):
           if not ref.startswith(own_corpus):
               fail(f"{record.id}: {relation}: {ref} crosses corpora "
                    f"(modifying relations are intra-corpus only)")
   ```

   `depends-on:` is intentionally NOT in the loop — it may cross corpora.

   Note: this rule is symmetric — `odr-review` runs the same lint on the ODR side. ADRs cannot supersede ODRs and vice versa; ADRs cannot `implements` ODRs and vice versa.

A4. **Referential-integrity lint** -- For each typed reference (`supersedes`, `depends-on`, `implements`) in each changed record's frontmatter:

   - Resolve `ADR-NNNN` to a glob over `docs/adr/NNNN-*.md` (and the legacy companion patterns: `docs/adr/NNNN.*.md` and `docs/adr/NNNN-*-*.md`).
   - Resolve `ONT-NNNN` (or `ONT-NNNNa..m` for sub-records) to a glob over `docs/ontology/odr/ONT-NNNN*-*.md`.
   - If no file matches, fail loud with the source record ID, the relation slot, and the missing reference.

A5. **Inverse-authoring prohibition** -- Search the changed records' frontmatter for any of: `superseded-by:`, `depended-on-by:`, `implemented-by:`. If present, fail loud — these inverse properties are derived at index time, not authored. Authoring them creates a dual source of truth.

A6. **Status enum lint** -- If `status:` is present, it MUST be one of the 5 documented values: `proposed`, `accepted`, `rejected`, `deprecated`, `superseded`. Any other token (e.g., `implemented`, `draft`, `wip`, `partially-accepted`) is a fail-loud violation. The lifecycle/disposition signal that used to be conflated with `status: implemented` now lives in the separate `completed:` boolean (see A7).

A7. **`completed:` boolean lint** -- If `completed:` is present in frontmatter, it MUST be a YAML boolean (`true` or `false`). Pseudocode:

   ```python
   # Pseudocode for the rule, ~4 lines.
   for record in changed_records:
       if "completed" in record.frontmatter:
           if not isinstance(record.frontmatter["completed"], bool):
               fail(f"{record.id}: completed must be true/false, "
                    f"got {type(record.frontmatter['completed']).__name__}")
   ```

   Reject quoted strings (`completed: "true"`), numeric coercions (`completed: 1`), and free-text values (`completed: yes-mostly`). The field is optional; absence is treated as "not yet completed" by downstream tooling and is NOT a lint failure.

A8. **Report frontmatter lint results** -- If any A3/A4/A5/A6/A7 violation was found, exit non-zero with the structured report:

   ```
   ## ADR/ODR Frontmatter Lint Failures

   ### Cross-corpus modifying-relations violations
   - <record-id>: <relation>: <crossing-ref>

   ### Missing reference targets
   - <record-id>: <relation>: <missing-ref> — no file matches

   ### Inverse-authoring violations
   - <record-id>: authored <inverse-relation> — derived at index time only

   ### Status enum violations
   - <record-id>: status: <bad-value> — not one of proposed|accepted|rejected|deprecated|superseded

   ### `completed:` boolean violations
   - <record-id>: completed: <bad-value> — must be true/false
   ```

### Phase B — Compliance review (skip if `--lint-only`)

B1. **Get diff** -- Run `git diff main...HEAD --name-only` to list changed files. Then run `git diff main...HEAD` to get the full diff content.

B2. **Find relevant ADRs** -- For each changed file:
   - `Grep` the file for ADR references (`ADR-\d+`)
   - `Grep` `docs/adr/` for ADRs that mention the changed file paths or modules
   - Call `mcp__ruflo__memory_search` with the file path and change summary to find semantically related ADRs

B3. **Load ADR content** -- `Read` each relevant ADR file. Focus on:
   - The **`## Decision Outcome`** section (what was decided — first paragraph is the canonical chosen-option statement)
   - The **`status:`** frontmatter (only enforce `accepted` ADRs)
   - The **`### Consequences`** flat bullets (expected constraints)

   The `completed:` flag does NOT change Phase B enforcement scope. An `accepted` ADR is authoritative for compliance regardless of whether `completed: true` (work done) or `completed: false` / absent (work pending). Specifically: decision-only ADRs (defer / close / disposition / findings records) with `status: accepted, completed: true` ARE still enforced — they encode a ratified decision and any code change that contradicts them is a violation. There is no carve-out by `completed` and no carve-out by decision-only sub-type.

B4. **Check for violations** -- Analyze each changed file against its relevant ADRs:
   - Does the code change contradict an accepted decision?
   - Does it use a technology/pattern that an ADR explicitly rejected?
   - Does it modify a module in a way the ADR's consequences warned against?
   - Is the code referencing a deprecated or superseded ADR?

B5. **Query relationship graph** -- Call `mcp__ruflo__agentdb_causal-query` to check if any referenced ADRs have been superseded. If so, flag that the code references an outdated decision.

B6. **Report** -- Present findings as a compliance report:

   ```
   ## ADR Compliance Report

   ### Violations
   - [ ] <file>:<line> — violates ADR-NNN: <reason>

   ### Warnings
   - [!] <file> references superseded ADR-NNN (replaced by ADR-MMM)

   ### Compliant
   - [x] <file> — consistent with ADR-NNN

   ### Unlinked Changes
   - [?] <file> — no ADR coverage (consider creating one)
   ```

B7. **Suggest actions** -- For each violation, suggest whether to update the code or propose a new ADR to supersede the violated one.

## Notes

- The frontmatter lint (Phase A) is fast and runs on every changed record — suitable as a pre-commit hook (`--lint-only`).
- The compliance review (Phase B) is heavier — runs against the full code diff and uses the AgentDB graph; better suited to PR review or periodic audit.
- Cross-corpus rule rationale: schema-design decisions (ADR side) shouldn't reach into the ontology to modify it; ontology decisions (ODR side) shouldn't reach into the architecture to modify it. `depends-on:` is the only modifying-free relation, so it's the only one allowed to cross.
- Tolerate legacy DACI fields (`decision-makers`, `consulted`, `informed`) silently if encountered during the rollout window — they are removed by Phase 3.0d of ADR-0211 (the mechanical migration commit).
