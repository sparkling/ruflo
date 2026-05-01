---
name: vector
description: RuVector operations via npx ruvector — embedding, search, clustering, indexing, hyperbolic, hooks, brain AGI
---

$ARGUMENTS
Vector operations via the `ruvector` npm package. Parse subcommand from $ARGUMENTS.

Usage: /vector <subcommand> [options]

Subcommands:

1. For **embed `<text>`**:
   Run: `npx ruvector embed "TEXT"`
   For files: `npx ruvector embed --file src/module.ts`
   Return the 384-dim vector and confirm storage.

2. For **batch `<glob-pattern>`**:
   Run: `npx ruvector embed --batch --glob "PATTERN"`
   Report count of vectors inserted and index size.

3. For **search `<query>` [--limit N]**:
   Run: `npx ruvector search "QUERY" --limit N`
   Present results ranked by similarity score.
   For hybrid search: `npx ruvector search "QUERY" --hybrid`
   For Graph RAG: `npx ruvector search "QUERY" --graph-rag`

4. For **compare `<text1>` `<text2>`**:
   Run: `npx ruvector compare "TEXT1" "TEXT2"`
   Report cosine similarity as decimal and percentage.

5. For **cluster `<namespace>` [--k N]**:
   Run: `npx ruvector cluster --namespace NAMESPACE --k N`
   Without --k, uses density clustering: `npx ruvector cluster --namespace NAMESPACE --density`
   Present cluster summaries with labels, counts, and cohesion.

6. For **index create `<name>`**:
   Run: `npx ruvector index create NAME --M 16 --efConstruction 200`
   Confirm creation with parameters.

7. For **index stats `<name>`**:
   Run: `npx ruvector index stats NAME`
   Report vector count, dimension, M, efConstruction, memory usage.

8. For **hyperbolic embed `<text>`**:
   Run: `npx ruvector embed --model poincare "TEXT"`
   Return Poincare ball coordinates.

9. For **hooks init**:
   Run: `npx ruvector hooks init --pretrain --build-agents quality`
   Initialize self-learning with 9-phase pretrain pipeline.

10. For **hooks route `<task>`**:
    Run: `npx ruvector hooks route --task "DESCRIPTION"`
    Return smart agent routing recommendation.

11. For **ast `<file>`**:
    Run: `npx ruvector hooks ast-analyze --file FILE`
    Return AST analysis with symbols, complexity, imports.

12. For **brain status**:
    Run: `npx ruvector brain agi status`
    Show AGI subsystem diagnostics.

13. For **midstream status**:
    Run: `npx ruvector midstream status`
    Show streaming analysis platform overview.
