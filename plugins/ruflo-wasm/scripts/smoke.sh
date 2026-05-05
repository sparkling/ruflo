#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
step() { printf "→ %s ... " "$1"; }
ok()   { printf "PASS\n"; PASS=$((PASS+1)); }
bad()  { printf "FAIL: %s\n" "$1"; FAIL=$((FAIL+1)); }

step "1. plugin.json declares 0.2.0 with new keywords"
v=$(grep -E '"version"' "$ROOT/.claude-plugin/plugin.json" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [[ "$v" != "0.2.0" ]]; then bad "expected 0.2.0, got '$v'"; else
  miss=""
  for k in mcp rvagent-wasm ruvllm-wasm; do
    grep -q "\"$k\"" "$ROOT/.claude-plugin/plugin.json" || miss="$miss $k"
  done
  [[ -z "$miss" ]] && ok || bad "missing keywords:$miss"
fi

step "2. both skills + agent + command present with valid frontmatter"
miss=""
for s in wasm-agent wasm-gallery; do
  f="$ROOT/skills/$s/SKILL.md"
  [[ -f "$f" ]] || { miss="$miss missing-$s"; continue; }
  for k in 'name:' 'description:'; do
    grep -q "^$k" "$f" || miss="$miss $s-no-$k"
  done
done
[[ -f "$ROOT/agents/wasm-specialist.md" ]] || miss="$miss missing-agent"
[[ -f "$ROOT/commands/wasm.md" ]] || miss="$miss missing-command"
[[ -z "$miss" ]] && ok || bad "$miss"

step "3. all 10 wasm_* MCP tools referenced"
miss=""
for t in wasm_agent_create wasm_agent_prompt wasm_agent_tool wasm_agent_list wasm_agent_terminate wasm_agent_files wasm_agent_export wasm_gallery_list wasm_gallery_search wasm_gallery_create; do
  grep -rq "$t" "$ROOT" --include='*.md' || miss="$miss $t"
done
[[ -z "$miss" ]] && ok || bad "undocumented:$miss"

step "4. README pins @claude-flow/cli to v3.6"
grep -qE "@claude-flow/cli.*v3\.6|v3\.6.*claude-flow/cli" "$ROOT/README.md" \
  && ok || bad "v3.6 pin missing"

step "5. README defers to ruflo-agentdb namespace convention"
grep -q "ruflo-agentdb" "$ROOT/README.md" \
  && grep -q "Namespace convention" "$ROOT/README.md" \
  && ok || bad "namespace coordination block incomplete"

step "6. wasm-gallery namespace claimed"
grep -q "wasm-gallery" "$ROOT/README.md" \
  && ok || bad "wasm-gallery namespace not claimed"

step "7. ADR-070 cross-reference present (rvagent-wasm + ruvllm-wasm integration)"
F="$ROOT/README.md"
miss=""
grep -q "ADR-070" "$F" || miss="$miss adr-ref"
grep -q "rvagent-wasm" "$F" || miss="$miss rvagent-wasm"
grep -q "ruvllm-wasm" "$F" || miss="$miss ruvllm-wasm"
grep -qE "optionalDependencies|graceful-degradation" "$F" || miss="$miss integration-detail"
[[ -z "$miss" ]] && ok || bad "$miss"

step "8. sandbox isolation documented"
F="$ROOT/README.md"
grep -q "Sandbox isolation\|sandbox isolation" "$F" \
  && grep -qE "no host filesystem|virtual filesystem" "$F" \
  && ok || bad "sandbox isolation guarantee not documented"

step "9. AIDefence 3-gate cross-reference (sandbox → host LLM defense)"
F="$ROOT/README.md"
grep -q "ruflo-aidefence" "$F" \
  && grep -qE "3-gate|3 gates" "$F" \
  && ok || bad "AIDefence 3-gate cross-reference missing"

step "10. ADR-0001 exists with status Proposed"
ADR="$ROOT/docs/adrs/0001-wasm-contract.md"
[[ -f "$ADR" ]] && grep -qE "^status:[[:space:]]*Proposed" "$ADR" \
  && ok || bad "ADR missing or status != Proposed"

step "11. no wildcard tool grants in skills"
bad_skills=""
for f in "$ROOT"/skills/*/SKILL.md; do
  grep -q '^allowed-tools:[[:space:]]*\*' "$f" && bad_skills="$bad_skills $(basename $(dirname "$f"))"
done
[[ -z "$bad_skills" ]] && ok || bad "wildcard:$bad_skills"

printf "\n%s passed, %s failed\n" "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
