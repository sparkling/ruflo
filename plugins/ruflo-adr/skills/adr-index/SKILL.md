---
name: adr-index
description: Build or rebuild the ADR index and dependency graph in AgentDB
argument-hint: ""
allowed-tools: mcp__ruflo__agentdb_hierarchical-store mcp__ruflo__agentdb_hierarchical-query mcp__ruflo__agentdb_causal-edge mcp__ruflo__agentdb_causal-query mcp__ruflo__memory_store mcp__ruflo__memory_search Bash Read Grep Glob
---

# ADR Index

Build or rebuild the full ADR index and dependency graph in AgentDB from the `docs/adr/` directory.

## When to use

After importing ADRs from another project, when the AgentDB graph is out of sync, or when bootstrapping ADR tracking on an existing codebase that already has ADR files.

## Format ADRs follow (canonical MADR 4.x + project extensions)

ADRs follow canonical MADR 4.x with optional `tags:` extension. The skill extracts metadata from YAML frontmatter, NOT from bullet-list headers.

Expected file shape:

```markdown
---
status: proposed | accepted | rejected | deprecated | superseded by ADR-NNNN
date: YYYY-MM-DD
decision-makers:
  - <name>
consulted: []
informed: []
tags: [tag1, tag2]
---

# <Title>

## Context and Problem Statement

...

## Considered Options

...

## Decision Outcome

...

### Consequences

...

## More Information

- Supersedes: ADR-XXX
- Related: ADR-YYY
- Depends on: ADR-WWW
```

Legacy ADRs may still use bullet-list metadata (`- **Status**:`, `- **Date**:`, etc.) and `## Links` section names. Extraction MUST handle both formats; YAML frontmatter takes precedence when both are present.

## Steps

1. **Scan directory** -- `Glob` for `docs/adr/*.md` to find ALL ADR files in
   the directory, regardless of naming convention. Filter out obvious
   non-ADR files (`README.md`, `INDEX.md`, `_template.md`) by name only —
   never by frontmatter, since some legacy ADR files lack frontmatter.

   If no files found, report that no ADRs exist yet.

2. **Parse each ADR** -- `Read` each file and extract:

   - **ID** (project-aware rules; apply in priority order; verify
     uniqueness in step 2.5):

     a. `ADR-NNNN-<slug>.md` (e.g. `ADR-042-use-postgres.md`) →
        ID = `ADR-NNNN` (canonical case for legacy `ADR-` prefixed files).
     b. `ADR-NNNN.<descriptor>.md` (e.g. `ADR-0201.style-guide.md`) →
        ID = `ADR-NNNN-<slug-of-descriptor>` (NEVER bare `ADR-NNNN` —
        the bare slot might belong to a sibling canonical file).
     c. `NNNN-<slug>.md` without the `ADR-` prefix (e.g.
        `0159-two-schema-split-and-stage-2-5-transform.md`, the canonical
        MADR 4.x convention) →
        ID = `ADR-NNNN` (treat as canonical for that number).
     d. **Companion / wave / cat / amendment files** matching
        `NNNN-<extra-disambiguator>-<slug>.md` (e.g.
        `0159-wave35-cat6-generator-diff.md` — companion to
        `0159-two-schema-split-and-stage-2-5-transform.md`):
        ID = `ADR-NNNN-<full-rest-of-filename-stem-slugified>`. So
        `0159-wave35-cat6-generator-diff.md` →
        `ADR-0159-wave35-cat6-generator-diff`.
     e. Fallback (no recognised pattern) → ID = full filename stem
        (without `.md`), slug-normalised.

   - **Frontmatter** (YAML between leading `---` fences). Parse as YAML.
     If no frontmatter, fall back to legacy bullet-list metadata
     extraction (rules below).

   - **Title**: from the first H1 heading (`# Title`).
     - Canonical MADR 4.x form: `# Title` (no `ADR-NNNN:` self-prefix).
     - Legacy form: `# ADR-NNN: <Title>` — strip the `ADR-NNN:` prefix
       to get the title.
     - Companion files may use other H1 shapes — take whatever follows
       the first `# `.

   - **Status**:
     1. Frontmatter `status:` field if present (canonical).
     2. Otherwise from a `**Status**:` line in body (legacy).
     3. Otherwise `unknown`.
     - Canonical MADR enum: `proposed | accepted | rejected | deprecated | superseded by ADR-NNNN`. Lowercase.
     - Other values pass through verbatim but flag in the report.
     - **Supersession parsing** — if the status value matches the regex
       `^superseded by (ADR-\d{4})\b`, capture the target ADR ID. The
       captured ID is used to emit a `superseded-by` causal edge in
       step 4. If `superseded by` appears without a matching ADR-NNNN,
       record a `status_warning` for the report.

   - **Date**:
     1. Frontmatter `date:` field if present (canonical).
     2. Otherwise from a `**Date**:` line in body (legacy).
     3. Otherwise the file's `Glob` mtime as a fallback.
     - Format: ISO `YYYY-MM-DD`.

   - **Decision-makers**:
     1. Frontmatter `decision-makers:` list if present (canonical).
     2. Otherwise from a `**Deciders**:` line in body (legacy).
     3. Otherwise empty list.

   - **Consulted** / **Informed**:
     1. Frontmatter `consulted:` / `informed:` lists if present.
     2. Otherwise empty lists. (Legacy ADRs typically don't have these.)

   - **Tags**:
     1. Frontmatter `tags:` list if present (canonical extension).
     2. Otherwise from a `**Tags**:` line in body (legacy).
     3. Otherwise empty list.
     - Tag values are project-defined; the skill stores whatever it finds.
     - YAML inline form (`tags: [a, b]`) and block form (`tags:\n  - a\n  - b`)
       both supported via standard YAML parsing.

   - **Decision summary** (`## Decision Outcome` first paragraph):
     1. Locate `## Decision Outcome` H2.
     2. Take the first prose paragraph (skip blank lines, list items,
        tables, code blocks, and any H3+ subheadings like `### Consequences`).
     3. The paragraph typically begins `Chosen option: "X", because Y.` —
        this canonical sentence is the core decision.
     4. Cap at ~500 characters. If absent, store empty string.

   - **Considered options** (`## Considered Options` bullet list):
     1. Locate `## Considered Options` H2.
     2. Extract all top-level bullet items (lines starting with `* ` or
        `- ` at zero indent within the section, before the next H2).
     3. For each bullet, capture the full text (including any em-dash
        description). Result is a list of strings.
     4. If absent or non-bullet form (prose / H3-only), store empty list
        and record a `format_warning` for the report.

   - **Consequences** (`### Consequences` flat bullets under
     `## Decision Outcome`):
     1. Locate `### Consequences` H3.
     2. Parse each bullet line. Classify by leading prefix:
        - `* Good, because …` → `consequences.good[]`
        - `* Bad, because …` → `consequences.bad[]`
        - `* Neutral, because …` → `consequences.neutral[]`
        - Other forms → `consequences.other[]` (record a `format_warning`).
     3. Result: `{ good: [], bad: [], neutral: [], other: [] }`.

   - **Confirmation** (`### Confirmation` H3 under `## Decision Outcome`):
     1. Locate `### Confirmation` H3 (optional).
     2. Capture the full text up to the next H3/H2 (~500 chars cap).
     3. If absent, store empty string.

   - **Links / cross-references**: from the `## More Information` section
     (canonical) or `## Links` / `## References` section (legacy).
     Two-pass extraction:

     **Pass 1 — explicit relation prefixes** (most precise; preferred):
     - `Supersedes: ADR-XXX` → relation `supersedes`
     - `Superseded by: ADR-XXX` → relation `superseded-by`
     - `Amended by: ADR-XXX` → relation `amended-by`
     - `Amends: ADR-XXX` → relation `amends`
     - `Related: ADR-XXX` → relation `related`
     - `Depends on: ADR-XXX` → relation `depends-on`
     - `Builds on ADR-XXX` / `Built on ADR-XXX` → relation `depends-on`
     - `Closes: ADR-XXX` / `Closes: S\d+-\w+` (Council ticket) → relation `closes`
     - `Opens: ADR-XXX` / `Opens: S\d+-\w+` → relation `opens`
     - `See also: ADR-XXX` → relation `related`

     **Pass 2 — bare ADR references** (fallback for prose-style links):
     - Any remaining `\bADR-\d{4}\b` reference within the section that
       wasn't captured by Pass 1 → relation `related` (default). Avoid
       double-counting Pass 1 matches.

     **Frontmatter status** — if `status:` matched the supersession regex
     above, additionally emit a `superseded-by` edge from the current ADR
     to the captured target ADR.

2.5. **Uniqueness check** -- After extracting IDs for ALL files, verify
   no two files mapped to the same ID. If a collision exists, abort
   the index build and report the colliding files. Never silently
   overwrite — that's the data-loss shape this rule is designed to
   prevent. The user can then either rename the offending files or
   adjust their project-specific extraction convention before retrying.

   Common collision shapes that this check catches:
   - Two canonical files for the same number (legitimate bug — rename
     one of them).
   - Companion file falling through to rule (a) instead of rule (d) —
     usually means the disambiguator pattern needs tuning for this
     project. Document the project's convention in
     `docs/adr/README.md` and report the fix back.

3. **Store in AgentDB** -- For each ADR, call `mcp__ruflo__agentdb_hierarchical-store` with:
   - path: `adr/<adr-id>`
   - value:
     ```json
     {
       "id": "<id>",
       "title": "<title>",
       "status": "<status>",
       "date": "<date>",
       "decision-makers": [...],
       "consulted": [...],
       "informed": [...],
       "tags": [...],
       "decision_summary": "<first paragraph of Decision Outcome, ~500 chars>",
       "considered_options": ["<option A>", "<option B>", ...],
       "consequences": { "good": [...], "bad": [...], "neutral": [...], "other": [...] },
       "confirmation": "<Confirmation section text, ~500 chars>",
       "file": "<filepath>"
     }
     ```

4. **Build causal edges** -- For each cross-reference captured in the
   two-pass extraction (step 2's "Links / cross-references" rule), call
   `mcp__ruflo__agentdb_causal-edge`:

   - `supersedes` → `from: <referenced>`, `to: <current>`
   - `superseded-by` → `from: <current>`, `to: <referenced>`
   - `amends` / `amended-by` → analogous direction
   - `depends-on` → `from: <current>`, `to: <referenced>`
   - `closes` / `opens` → `from: <current>`, `to: <referenced>`
   - `related` (default) → `from: <current>`, `to: <referenced>`

   Plus: if the frontmatter `status:` value matched the supersession
   regex (`^superseded by (ADR-\d{4})\b`), emit a `superseded-by` edge
   from the current ADR to the captured target.

   Deduplicate edges — if the same `(from, to, relation)` triple is
   produced by both Pass 1 and Pass 2 of cross-reference extraction,
   emit it only once.

5. **Store in memory** -- For each ADR, call `mcp__ruflo__memory_store` with:
   - namespace: `adr-patterns`
   - key: `<adr-id>`
   - value: `<title> — <body excerpt>`

   **Body excerpt rules** (in priority order):
   1. If the file has a `## Context and Problem Statement` heading
      (canonical MADR 4.x), use the first paragraph of that section.
   2. Else if the file has a `## Context` heading (legacy MADR / pre-4.x),
      use the first paragraph of that section.
   3. Else if the file has any other H2-section heading (e.g. `## Generator
      Status`, `## Matrix-Gap Findings`, `## Decision`, `## Status`),
      extract the first prose paragraph after the H1 title — skip
      frontmatter, the H1 itself, blank lines, tables (lines starting
      with `|`), and lists (lines starting with `-` or `*`). Take the
      first 2-3 sentences (~500 chars max).
   4. Else, take the first 2-3 prose sentences from anywhere in the file
      body, capped at ~500 characters.

   This rule covers companion / wave / cat / amendment files (e.g.
   `0159-wave35-cat6-generator-diff.md`) which use category-specific section
   structures and don't have a `## Context` heading. Without the fallback,
   those entries store title-only and rank below canonical ADRs in semantic
   search even when the query matches their body content.

   This enables semantic search across ADRs.

6. **Verify graph** -- Call `mcp__ruflo__agentdb_causal-query` to retrieve all edges and verify:
   - No dangling references (edges pointing to non-existent ADRs)
   - No circular supersedes chains
   - All superseded ADRs have status `superseded` or
     `superseded by ADR-NNNN`

7. **Report** -- Output a summary:
   ```
   ## ADR Index Summary

   Total ADRs: N
   - Proposed: X
   - Accepted: Y
   - Deprecated: Z
   - Superseded: W
   - Rejected: R
   - Unknown: U

   Tag distribution (top 10):
   - <tag>: <count>
   ...

   Relationships: M edges
   - Supersedes / Superseded-by: A
   - Amends / Amended-by: B
   - Depends-on: C
   - Related: D

   Issues found: (list any dangling refs, status mismatches, or
   non-canonical status values)
   ```
