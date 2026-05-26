---
name: adr-create
description: Create a new Architecture Decision Record with sequential numbering and AgentDB registration
argument-hint: "<title>"
allowed-tools: mcp__ruflo__agentdb_hierarchical-store mcp__ruflo__agentdb_hierarchical-query mcp__ruflo__agentdb_causal-edge mcp__ruflo__memory_store mcp__ruflo__memory_search Bash Read Write Edit Grep Glob
---

# Create ADR

Create a new Architecture Decision Record with the next sequential number, register it in the AgentDB graph, and link it to related ADRs.

## When to use

When a significant architectural decision needs to be recorded -- new technology adoption, API design choices, data model changes, infrastructure decisions, or any cross-cutting concern that affects multiple components.

## Format

ADRs follow canonical MADR 4.x (https://adr.github.io/madr/) with one extension: a `tags:` frontmatter field for cross-cutting categorisation.

- **Filename**: `docs/adr/NNNN-<slug>.md` — 4-digit zero-padded number, lowercase kebab-case slug derived from the title. NO `ADR-` filename prefix.
- **H1**: `# <Title>` — title only, NO `ADR-NNNN:` prefix. The number lives in the filename.
- **Metadata**: YAML frontmatter (NOT bullet-list metadata under H1).
- **Status enum**: `proposed | accepted | rejected | deprecated | superseded`. Lowercase exactly as listed.
- **Completed flag**: `completed: false` for new ADRs (default). Set `completed: true` only when the ADR's scope is fully closed — nothing more to do under this ADR's name. Independent of `status`: an ADR can be `accepted` but still in-flight (`completed: false`). Per ADR-0262.
- **Required sections**: `## Context and Problem Statement`, `## Considered Options` (bullet list), `## Decision Outcome` containing `### Consequences` (flat bullets) and `### Confirmation`.
- **Optional sections**: `## Decision Drivers`, `## Pros and Cons of the Options` (with `### {Option}` per option), `## More Information`.

## Steps

1. **Find next number** -- `Glob` for `docs/adr/*.md` and parse the leading 4-digit prefix from each filename to determine the next sequential ID (e.g. `0042`). Filter out non-ADR files (`README.md`, `INDEX.md`, `_template.md`). Create `docs/adr/` if it does not exist.

2. **Slugify title** -- Convert the title argument to a lowercase, hyphen-separated slug (e.g., "Use PostgreSQL for persistence" becomes `use-postgresql-for-persistence`). Drop punctuation; collapse runs of hyphens.

3. **Create ADR file** -- `Write` the file at `docs/adr/NNNN-<slug>.md` using the canonical MADR template:

   ```markdown
   ---
   status: proposed
   completed: false
   date: <today's date YYYY-MM-DD>
   decision-makers:
     - <leave blank for author to fill>
   consulted: []
   informed: []
   tags: []
   ---

   # <Title>

   ## Context and Problem Statement

   <!-- What is the issue that motivates this decision? Describe the situation and the question. -->

   ## Decision Drivers

   <!-- Optional. Forces shaping the decision: constraints, qualities, stakeholder concerns. Bullet list. -->

   * <driver 1>
   * <driver 2>

   ## Considered Options

   <!-- Bullet list of alternatives evaluated. One option per line. -->

   * <Option A> — <brief description>
   * <Option B> — <brief description>

   ## Decision Outcome

   Chosen option: "<Option A>", because <justification — why this option meets the decision drivers, satisfies the K.O. criteria, or comes out best>.

   ### Consequences

   <!-- Flat bullet list. Use canonical phrasing: "* Good, because …" / "* Bad, because …" / "* Neutral, because …" -->

   * Good, because <positive consequence>
   * Bad, because <negative consequence>
   * Neutral, because <neutral consequence>

   ### Confirmation

   <!-- Optional. How compliance with this decision is verified (review, ArchUnit test, lint rule, etc.). -->

   ## Pros and Cons of the Options

   <!-- Optional. Per-option deliberation detail. H3 per option. -->

   ### <Option A>

   * Good, because <argument>
   * Bad, because <argument>

   ### <Option B>

   * Good, because <argument>
   * Bad, because <argument>

   ## More Information

   <!-- Optional. Links, related ADRs, supporting evidence. -->
   ```

4. **Store in AgentDB** -- Call `mcp__ruflo__agentdb_hierarchical-store` with:
   - path: `adr/ADR-NNNN`
   - value: `{ "id": "ADR-NNNN", "title": "<title>", "status": "proposed", "completed": false, "date": "<today>", "tags": [], "supersedes": [], "depends-on": [], "implements": [], "file": "docs/adr/NNNN-<slug>.md" }`

5. **Find related ADRs** -- Call `mcp__ruflo__memory_search` with the title as query in namespace `adr-patterns` to find related decisions. If matches found, add them to the `## More Information` section and create causal edges with relation `depends-on`.

6. **Store pattern** -- Call `mcp__ruflo__memory_store` in namespace `adr-patterns` with key `ADR-NNNN` and the title + context as value for future semantic search.

7. **Report** -- Output the created file path, ADR number, and any related ADRs found.

## Notes

- The `tags` frontmatter field is a project extension to canonical MADR for cross-cutting categorisation (e.g. `tags: [security, infrastructure]`). Optional — leave as `[]` if unused.
- For supersession, set `status: superseded` on the prior ADR. The successor ADR lists the prior in its `supersedes:` slot; the inverse (`superseded-by`) is derived at index time and must NOT be authored in frontmatter (ADR-0262, single source of truth). Reference the prior ADR in the successor's `## More Information`.
- The `### Confirmation` section is optional in canonical MADR but recommended — it answers "how do we know this decision is being followed?"
- If an ADR has only one viable option, list it alone in `## Considered Options` and explain in `## Decision Outcome` why no alternatives were considered.
