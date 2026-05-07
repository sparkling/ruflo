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

## Steps

1. **Scan directory** -- `Glob` for `docs/adr/*.md` to find ALL ADR files in
   the directory, regardless of naming convention. The previous
   `ADR-*.md` glob missed projects that use the unprefixed `NNNN-<slug>.md`
   convention (where every file silently went unindexed). Filter out
   obvious non-ADR files (`README.md`, `INDEX.md`, `_template.md`) by name
   only — never by frontmatter, since some ADR files lack frontmatter.

   If no files found, report that no ADRs exist yet.

2. **Parse each ADR** -- `Read` each file and extract:

   - **ID** (project-aware rules; apply in priority order; verify
     uniqueness in step 2.5):

     a. `ADR-NNNN-<slug>.md` (e.g. `ADR-042-use-postgres.md`) →
        ID = `ADR-NNNN` (canonical case).
     b. `ADR-NNNN.<descriptor>.md` (e.g. `ADR-0201.style-guide.md`) →
        ID = `ADR-NNNN-<slug-of-descriptor>` (NEVER bare `ADR-NNNN` —
        the bare slot might belong to a sibling canonical file).
     c. `NNNN-<slug>.md` without the `ADR-` prefix (e.g.
        `0159-two-schema-split-and-stage-2-5-transform.md`, common in
        projects that use unprefixed numeric-leading filenames) →
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

   - **Title**: from the `# ADR-NNN: <Title>` heading. Companion files
     may use a different H1 shape (`# 0159 wave35 cat6 — Generator
     Diff`); take whatever follows the first `# `.
   - **Status**: from the `**Status**:` line if present; otherwise
     `unknown` (companion files often lack frontmatter).
   - **Date**: from the `**Date**:` line if present; otherwise the
     file's `Glob` mtime as a fallback.
   - **Tags**: from the `**Tags**:` line if present; otherwise empty.
   - **Links**: from the `## Links` section (supersedes, amended-by,
     related, depends-on); otherwise empty.

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
   - value: `{ "id": "<id>", "title": "<title>", "status": "<status>", "date": "<date>", "tags": "<tags>", "file": "<filepath>" }`

4. **Build causal edges** -- For each ADR with links:
   - "Supersedes ADR-XXX" -> `mcp__ruflo__agentdb_causal-edge` with `from: ADR-XXX`, `to: <current>`, `relation: supersedes`
   - "Amended by ADR-YYY" -> `mcp__ruflo__agentdb_causal-edge` with `from: <current>`, `to: ADR-YYY`, `relation: amends`
   - "Related: ADR-ZZZ" -> `mcp__ruflo__agentdb_causal-edge` with `from: <current>`, `to: ADR-ZZZ`, `relation: related`
   - "Depends on ADR-WWW" -> `mcp__ruflo__agentdb_causal-edge` with `from: <current>`, `to: ADR-WWW`, `relation: depends-on`

5. **Store in memory** -- For each ADR, call `mcp__ruflo__memory_store` with:
   - namespace: `adr-patterns`
   - key: `<adr-id>`
   - value: `<title> — <body excerpt>`

   **Body excerpt rules** (in priority order, ADR-0147 Refinement 4):
   1. If the file has a `## Context` heading, use the first paragraph of that
      section.
   2. Else if the file has any other H2-section heading (e.g. `## Generator
      Status`, `## Matrix-Gap Findings`, `## Decision`, `## Status`), extract
      the first prose paragraph after the H1 title — skip frontmatter, the H1
      itself, blank lines, tables (lines starting with `|`), and lists (lines
      starting with `-` or `*`). Take the first 2-3 sentences (~500 chars max).
   3. Else, take the first 2-3 prose sentences from anywhere in the file body,
      capped at ~500 characters.

   This rule covers companion / wave / cat / amendment files (e.g.
   `0159-wave35-cat6-generator-diff.md`) which use category-specific section
   structures and don't have a `## Context` heading. Without the fallback,
   those entries store title-only and rank below canonical ADRs in semantic
   search even when the query matches their body content.

   This enables semantic search across ADRs.

6. **Verify graph** -- Call `mcp__ruflo__agentdb_causal-query` to retrieve all edges and verify:
   - No dangling references (edges pointing to non-existent ADRs)
   - No circular supersedes chains
   - All superseded ADRs have status "superseded"

7. **Report** -- Output a summary:
   ```
   ## ADR Index Summary

   Total ADRs: N
   - Proposed: X
   - Accepted: Y
   - Deprecated: Z
   - Superseded: W

   Relationships: M edges
   - Supersedes: A
   - Amends: B
   - Depends-on: C
   - Related: D

   Issues found: (list any dangling refs or status mismatches)
   ```
