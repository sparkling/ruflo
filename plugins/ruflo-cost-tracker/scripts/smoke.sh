#!/usr/bin/env bash
# Structural smoke test for ruflo-cost-tracker v0.2.2 (ADR-0001).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
step() { printf "→ %s ... " "$1"; }
ok()   { printf "PASS\n"; PASS=$((PASS+1)); }
bad()  { printf "FAIL: %s\n" "$1"; FAIL=$((FAIL+1)); }

step "1. plugin.json declares 0.2.2 with new keywords"
v=$(grep -E '"version"' "$ROOT/.claude-plugin/plugin.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [[ "$v" != "0.2.2" ]]; then
  bad "expected 0.2.2, got '$v'"
else
  miss=""
  for k in namespace-routing mcp; do
    grep -q "\"$k\"" "$ROOT/.claude-plugin/plugin.json" || miss="$miss $k"
  done
  [[ -z "$miss" ]] && ok || bad "missing keywords:$miss"
fi

step "2. both skills present with valid frontmatter"
miss=""
for s in cost-report cost-optimize; do
  f="$ROOT/skills/$s/SKILL.md"
  [[ -f "$f" ]] || { miss="$miss missing-$s"; continue; }
  for k in 'name:' 'description:' 'allowed-tools:'; do
    grep -q "^$k" "$f" || miss="$miss $s-no-$k"
  done
done
[[ -z "$miss" ]] && ok || bad "$miss"

step "3. skills use memory_* (namespace-routed), not agentdb_hierarchical-* with namespace"
miss=""
F="$ROOT/skills/cost-report/SKILL.md"
grep -q "memory_search\|memory_list\|memory_retrieve" "$F" || miss="$miss cost-report-no-memory"
grep -qE "agentdb_hierarchical-recall.+cost-tracking|cost-tracking.+agentdb_hierarchical-recall" "$F" && miss="$miss cost-report-still-uses-hierarchical"
F="$ROOT/skills/cost-optimize/SKILL.md"
grep -q "memory_search\|memory_list" "$F" || miss="$miss cost-optimize-no-memory"
[[ -z "$miss" ]] && ok || bad "$miss"

step "4. cost-optimize documents both pattern-store paths"
F="$ROOT/skills/cost-optimize/SKILL.md"
if grep -q "ReasoningBank" "$F" \
   && grep -q "memory_store --namespace cost-patterns" "$F"; then
  ok
else
  bad "missing dual-path documentation"
fi

step "5. README pins @claude-flow/cli to v3.6"
grep -qE "@claude-flow/cli.*v3\.6|v3\.6.*claude-flow/cli" "$ROOT/README.md" \
  && ok || bad "v3.6 pin missing"

step "6. README defers to ruflo-agentdb namespace convention"
grep -q "ruflo-agentdb" "$ROOT/README.md" \
  && grep -q "Namespace convention" "$ROOT/README.md" \
  && ok || bad "namespace coordination block incomplete"

step "7. README federation budget circuit breaker (ADR-097) block intact"
F="$ROOT/README.md"
miss=""
grep -q "ADR-097" "$F" || miss="$miss adr-ref"
grep -qE "maxHops|maxTokens|maxUsd" "$F" || miss="$miss budget-fields"
grep -q "BUDGET_EXCEEDED" "$F" || miss="$miss enforcement-string"
[[ -z "$miss" ]] && ok || bad "federation block missing:$miss"

step "8. ADR-0001 exists with status Proposed"
ADR="$ROOT/docs/adrs/0001-cost-tracker-contract.md"
[[ -f "$ADR" ]] && grep -qE "^status:[[:space:]]*Proposed" "$ADR" \
  && ok || bad "ADR missing or status != Proposed"

step "9. REFERENCE.md exists and is non-empty"
[[ -s "$ROOT/REFERENCE.md" ]] && ok || bad "REFERENCE.md missing or empty"

step "10. no wildcard tool grants in skills"
bad_skills=""
for f in "$ROOT"/skills/*/SKILL.md; do
  grep -q '^allowed-tools:[[:space:]]*\*' "$f" && bad_skills="$bad_skills $(basename $(dirname "$f"))"
done
[[ -z "$bad_skills" ]] && ok || bad "wildcard:$bad_skills"

printf "\n%s passed, %s failed\n" "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
