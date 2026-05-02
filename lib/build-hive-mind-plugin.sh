#!/usr/bin/env bash
# build-hive-mind-plugin.sh — materialise the ruflo-hive-mind marketplace plugin
# from upstream paths. Implements ADR-0116 (Hive-mind marketplace plugin).
#
# Determinism: zero diff on consecutive runs (no timestamps, no random, sorted
# iteration, LC_ALL=C). Hand-editing the shipped tree is forbidden — fix at
# upstream and re-run this script.
#
# Coupling with ADR-0118: the §Status table for T1-T10 is hardcoded in the
# T_STATUS array below. When ADR-0118 §Status changes, update the array and
# re-run. The script consults the array to drop "complete" rows from the
# README gaps table and to flip per-command implementation-status frontmatter.
#
# Usage:
#   bash lib/build-hive-mind-plugin.sh
#   UPSTREAM_DIR=/path/to/ruvnet/ruflo bash lib/build-hive-mind-plugin.sh
#
set -euo pipefail
export LC_ALL=C

UPSTREAM_DIR="${UPSTREAM_DIR:-/Users/henrik/source/ruvnet/ruflo}"
FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${FORK_DIR}/plugins/ruflo-hive-mind"

if [[ ! -d "$UPSTREAM_DIR" ]]; then
  echo "FATAL: upstream not found: $UPSTREAM_DIR" >&2
  exit 1
fi

# --- ADR-0118 §Status (T1-T10) ----------------------------------------------
# Format: T<n>=<status>:<title>:<file>
# Values: open | in-progress | escalated-to-adr | complete
T_STATUS=(
  "T1:open:Weighted consensus (Queen 3x voting power):mcp-tools/hive-mind-tools.ts:35"
  "T2:open:Gossip consensus protocol:mcp-tools/hive-mind-tools.ts:35,518"
  "T3:open:CRDT consensus protocol:mcp-tools/hive-mind-tools.ts:35,518"
  "T4:open:8 Memory types + TTLs:mcp-tools/hive-mind-tools.ts:937-1010"
  "T5:open:LRU + SQLite WAL backend:loadHiveState/saveHiveState"
  "T6:open:Session checkpoint/resume/export/import:commands/hive-mind/{sessions,resume}.md"
  "T7:open:Queen-type behaviour:commands/hive-mind.ts:75,88"
  "T8:open:Worker-type behaviour:swarm/src/queen-coordinator.ts:1248-1251"
  "T9:open:Adaptive topology (auto-scaling):swarm/src/unified-coordinator.ts:585"
  "T10:open:5 swarm topologies:commands/hive-mind.ts:77,92"
)

t_status_for() {
  local t="$1"
  for row in "${T_STATUS[@]}"; do
    [[ "${row%%:*}" == "$t" ]] && { echo "${row#*:}" | cut -d: -f1; return; }
  done
  echo "unknown"
}

# --- Inline codemod (per ADR-0116 §Source-of-truth strategy + plugin
# README's user-facing examples) -----------------------------------
# Operates on a single file in place. Patterns:
#   1. @claude-flow/cli@latest -> @sparkleideas/cli@latest
#   2. claude-flow@alpha       -> @sparkleideas/cli@latest
#   3. mcp__claude-flow__X     -> mcp__ruflo__X
#   4. npx claude-flow <space> -> npx @sparkleideas/cli@latest <space>
#      (rewrites all upstream user-facing examples like
#       `npx claude-flow hive-mind spawn ...`)
codemod_file() {
  local f="$1"
  perl -i -pe '
    s|\@claude-flow/cli\@latest|\@sparkleideas/cli\@latest|g;
    s|claude-flow\@alpha|\@sparkleideas/cli\@latest|g;
    s|mcp__claude-flow__|mcp__ruflo__|g;
    s|\bnpx\s+claude-flow\s|npx \@sparkleideas/cli\@latest |g;
  ' "$f"
}

# --- Frontmatter manipulation ------------------------------------------------
# Inject a key:value line before the closing `---` of the file's leading
# YAML frontmatter. Idempotent: if the key already exists, do nothing.
inject_frontmatter_field() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}:" "$file"; then
    return
  fi
  awk -v k="$key" -v v="$value" '
    BEGIN { in_fm=0; fm_started=0 }
    NR==1 && $0=="---" { fm_started=1; in_fm=1; print; next }
    in_fm && $0=="---" { print k ": " v; print; in_fm=0; next }
    { print }
    END {
      if (fm_started==0) {
        # No frontmatter — refuse, this is a programming error.
        exit 2
      }
    }
  ' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

# Prepend a frontmatter block to a file that has none.
# Args: file, then key=value pairs.
prepend_frontmatter() {
  local file="$1"; shift
  local body
  body="$(cat "$file")"
  {
    echo "---"
    while [[ $# -gt 0 ]]; do
      echo "$1"
      shift
    done
    echo "---"
    echo
    echo "$body"
  } > "$file.tmp"
  mv "$file.tmp" "$file"
}

# --- Reset output ------------------------------------------------------------
rm -rf "$PLUGIN_DIR"
mkdir -p \
  "$PLUGIN_DIR/.claude-plugin" \
  "$PLUGIN_DIR/skills/hive-mind" \
  "$PLUGIN_DIR/skills/hive-mind-advanced" \
  "$PLUGIN_DIR/agents" \
  "$PLUGIN_DIR/commands"

# --- Skills (2) -------------------------------------------------------------
cp "$UPSTREAM_DIR/.agents/skills/hive-mind/SKILL.md" \
   "$PLUGIN_DIR/skills/hive-mind/SKILL.md"
cp "$UPSTREAM_DIR/v3/@claude-flow/cli/.claude/skills/hive-mind-advanced/SKILL.md" \
   "$PLUGIN_DIR/skills/hive-mind-advanced/SKILL.md"

# --- Agents (16) ------------------------------------------------------------
HIVE_MIND_AGENTS=(
  queen-coordinator
  collective-intelligence-coordinator
  scout-explorer
  swarm-memory-manager
  worker-specialist
)
for f in "${HIVE_MIND_AGENTS[@]}"; do
  cp "$UPSTREAM_DIR/.claude/agents/hive-mind/${f}.md" "$PLUGIN_DIR/agents/${f}.md"
done

cp "$UPSTREAM_DIR/.claude/agents/v3/v3-queen-coordinator.md" \
   "$PLUGIN_DIR/agents/v3-queen-coordinator.md"

CONSENSUS_AGENTS=(
  byzantine-coordinator
  raft-manager
  gossip-coordinator
  crdt-synchronizer
  quorum-manager
  performance-benchmarker
  security-manager
)
for f in "${CONSENSUS_AGENTS[@]}"; do
  cp "$UPSTREAM_DIR/.claude/agents/consensus/${f}.md" "$PLUGIN_DIR/agents/${f}.md"
done

TOPOLOGY_AGENTS=(
  adaptive-coordinator
  hierarchical-coordinator
  mesh-coordinator
)
for f in "${TOPOLOGY_AGENTS[@]}"; do
  cp "$UPSTREAM_DIR/.claude/agents/swarm/${f}.md" "$PLUGIN_DIR/agents/${f}.md"
done

# --- Commands (11; README excluded) -----------------------------------------
COMMANDS=(
  hive-mind
  hive-mind-init
  hive-mind-spawn
  hive-mind-status
  hive-mind-stop
  hive-mind-resume
  hive-mind-memory
  hive-mind-metrics
  hive-mind-consensus
  hive-mind-sessions
  hive-mind-wizard
)
for f in "${COMMANDS[@]}"; do
  cp "$UPSTREAM_DIR/.claude/commands/hive-mind/${f}.md" "$PLUGIN_DIR/commands/${f}.md"
done

# --- Apply inline codemod to every shipped .md ------------------------------
find "$PLUGIN_DIR" -type f -name '*.md' | LC_ALL=C sort | while read -r f; do
  codemod_file "$f"
done

# --- Skill frontmatter: inject `allowed-tools` ------------------------------
inject_frontmatter_field \
  "$PLUGIN_DIR/skills/hive-mind/SKILL.md" \
  "allowed-tools" \
  "Bash(npx *) Read mcp__ruflo__hive-mind_init mcp__ruflo__hive-mind_spawn mcp__ruflo__hive-mind_status mcp__ruflo__hive-mind_consensus"

inject_frontmatter_field \
  "$PLUGIN_DIR/skills/hive-mind-advanced/SKILL.md" \
  "allowed-tools" \
  "Bash(npx *) Read Write Edit Grep Glob mcp__ruflo__hive-mind_init mcp__ruflo__hive-mind_spawn mcp__ruflo__hive-mind_status mcp__ruflo__hive-mind_join mcp__ruflo__hive-mind_leave mcp__ruflo__hive-mind_consensus mcp__ruflo__hive-mind_broadcast mcp__ruflo__hive-mind_shutdown mcp__ruflo__hive-mind_memory mcp__ruflo__memory_store mcp__ruflo__memory_search Agent Task"

# --- Agent frontmatter: inject `model: sonnet` ------------------------------
for f in "$PLUGIN_DIR"/agents/*.md; do
  inject_frontmatter_field "$f" "model" "sonnet"
done

# --- Command frontmatter: prepend (none upstream) ---------------------------
declare -A COMMAND_DESC=(
  [hive-mind]="Hive Mind overview and dispatch entry point"
  [hive-mind-init]="Initialize a hive-mind swarm with queen-led coordination"
  [hive-mind-spawn]="Spawn a Hive Mind swarm — supports --queen-type (Strategic|Tactical|Adaptive) and --consensus (majority|weighted|byzantine|raft|gossip|crdt|quorum)"
  [hive-mind-status]="Show hive-mind swarm status and worker health"
  [hive-mind-stop]="Stop a running hive-mind swarm"
  [hive-mind-resume]="Resume a checkpointed hive-mind session"
  [hive-mind-memory]="Query and manage collective hive memory across 8 memory types with TTL"
  [hive-mind-metrics]="Show hive-mind performance and consensus metrics"
  [hive-mind-consensus]="Run a consensus vote across hive workers (Majority|Weighted|Byzantine|Raft|Gossip|CRDT|Quorum)"
  [hive-mind-sessions]="Manage hive-mind sessions: list, checkpoint, export, import"
  [hive-mind-wizard]="Interactive wizard for hive-mind setup and tuning"
)

for f in "$PLUGIN_DIR"/commands/*.md; do
  name="$(basename "$f" .md)"
  desc="${COMMAND_DESC[$name]}"
  prepend_frontmatter "$f" \
    "name: ${name}" \
    "description: ${desc}"
done

# --- Per-command implementation-status (AC #16) -----------------------------
# 4 commands need implementation-status + gap-tracker frontmatter, derived
# from ADR-0118 §Status. If all referenced Tns are `complete`, status flips
# to `implemented`; else inherit the worse of `partial` vs `missing` per the
# matrix.
add_impl_status() {
  local file="$1" status="$2" trackers="$3"
  inject_frontmatter_field "$file" "implementation-status" "$status"
  inject_frontmatter_field "$file" "gap-tracker" "[${trackers}]"
}

# Determine status per file based on T-state.
status_for_tns() {
  local default_status="$1"; shift
  local all_complete=1
  for t in "$@"; do
    local s; s="$(t_status_for "$t")"
    if [[ "$s" != "complete" ]]; then
      all_complete=0
      break
    fi
  done
  if [[ "$all_complete" -eq 1 ]]; then
    echo "implemented"
  else
    echo "$default_status"
  fi
}

CONSENSUS_STATUS="$(status_for_tns partial T1 T2 T3)"
add_impl_status \
  "$PLUGIN_DIR/commands/hive-mind-consensus.md" \
  "$CONSENSUS_STATUS" \
  "ADR-0118-T1, ADR-0118-T2, ADR-0118-T3"

MEMORY_STATUS="$(status_for_tns partial T4 T5)"
add_impl_status \
  "$PLUGIN_DIR/commands/hive-mind-memory.md" \
  "$MEMORY_STATUS" \
  "ADR-0118-T4, ADR-0118-T5"

SESSIONS_STATUS="$(status_for_tns missing T6)"
add_impl_status \
  "$PLUGIN_DIR/commands/hive-mind-sessions.md" \
  "$SESSIONS_STATUS" \
  "ADR-0118-T6"

RESUME_STATUS="$(status_for_tns missing T6)"
add_impl_status \
  "$PLUGIN_DIR/commands/hive-mind-resume.md" \
  "$RESUME_STATUS" \
  "ADR-0118-T6"

# --- Append canonical invocation to hive-mind-stop.md (AC #11) --------------
# Upstream stub renders `npx claude-flow hive-mind hive-mind-stop` (file-name
# form, not the USERGUIDE-canonical `hive-mind stop` form). Append a one-line
# note with the canonical invocation so AC #11's substring check passes and
# users see the right command.
cat >> "$PLUGIN_DIR/commands/hive-mind-stop.md" <<'EOF'

Canonical invocation: `npx @sparkleideas/cli@latest hive-mind stop`
EOF

# --- Inject AC #9 content into hive-mind-memory.md --------------------------
# Upstream stub doesn't enumerate the 8 memory types + TTLs that the
# USERGUIDE advertises. Append to body so it lands after the existing H1.
MEMORY_FILE="$PLUGIN_DIR/commands/hive-mind-memory.md"
cat >> "$MEMORY_FILE" <<'EOF'

## Collective Memory Types (USERGUIDE contract)

| Type | TTL | Purpose |
|---|---|---|
| `knowledge` | permanent | Long-term shared facts and learned patterns |
| `context` | 1h | Short-lived working context |
| `task` | 30min | Active task state |
| `result` | permanent | Task outcomes |
| `error` | 24h | Failure traces |
| `metric` | 1h | Performance metrics |
| `consensus` | permanent | Decisions reached via voting |
| `system` | permanent | Hive infrastructure state |

> **Implementation status**: `partial` — see ADR-0118 T4 (memory types + TTLs) and T5 (LRU + SQLite WAL backend). The current MCP backend exposes a flat key/value dict with no type discriminator or TTL.
EOF

# --- plugin.json ------------------------------------------------------------
cat > "$PLUGIN_DIR/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "ruflo-hive-mind",
  "description": "Queen-led hive-mind collective intelligence — skills, agents, and commands for Byzantine/Raft/Gossip consensus, collective memory, and worker specialization",
  "version": "0.1.0",
  "author": {
    "name": "Henrik Pettersen",
    "url": "https://github.com/sparkling"
  },
  "homepage": "https://github.com/sparkling/ruflo",
  "license": "MIT",
  "keywords": [
    "ruflo",
    "hive-mind",
    "queen-worker",
    "consensus",
    "collective-intelligence",
    "byzantine"
  ]
}
EOF

# --- README.md --------------------------------------------------------------
# Only emit gap rows whose ADR-0118 status is open | in-progress | escalated-to-adr.
emit_gap_row() {
  local t="$1" feat="$2" verdict="$3" evidence="$4"
  local s; s="$(t_status_for "$t")"
  case "$s" in
    open|in-progress|escalated-to-adr)
      echo "| $feat | $verdict | $evidence | ADR-0118 $t |"
      ;;
  esac
}

GAP_ROWS="$(
  emit_gap_row T1  "Weighted consensus (Queen 3x)"             "✗ missing from \`ConsensusStrategy\` enum" "\`mcp-tools/hive-mind-tools.ts:35\`"
  emit_gap_row T2  "Gossip consensus"                          "✗ missing from \`ConsensusStrategy\` enum" "\`mcp-tools/hive-mind-tools.ts:35,518\`"
  emit_gap_row T3  "CRDT consensus"                            "✗ missing from \`ConsensusStrategy\` enum" "\`mcp-tools/hive-mind-tools.ts:35,518\`"
  emit_gap_row T4  "8 Memory types + TTLs"                     "✗ flat dict, no TTL"                       "\`mcp-tools/hive-mind-tools.ts:937-1010\`"
  emit_gap_row T5  "LRU + SQLite WAL backend"                  "✗ JSON file persistence"                   "\`loadHiveState\`/\`saveHiveState\`"
  emit_gap_row T6  "Session checkpoint/resume/export/import"   "✗ command surfaces only"                   "\`commands/hive-mind/{sessions,resume}.md\`"
  emit_gap_row T7  "Queen-type behaviour"                      "⚠ prompt-string substitution only"        "\`commands/hive-mind.ts:75,88\`"
  emit_gap_row T8  "Worker-type behaviour"                     "⚠ display grouping + 4 scoring nudges"    "\`swarm/src/queen-coordinator.ts:1248-1251\`"
  emit_gap_row T9  "Adaptive topology (auto-scaling)"          "⚠ config flag only"                        "\`swarm/src/unified-coordinator.ts:585\`"
  emit_gap_row T10 "5 swarm topologies"                        "⚠ prompt-string substitution only"        "\`commands/hive-mind.ts:77,92\`"
)"

cat > "$PLUGIN_DIR/README.md" <<EOF
# ruflo-hive-mind

Queen-led collective intelligence with consensus mechanisms for sparkling/ruflo.

## Install

    /plugin marketplace add sparkling/ruflo
    /plugin install ruflo-hive-mind@ruflo

## What's in the box

- 2 skills: \`hive-mind\`, \`hive-mind-advanced\`
- 16 agents (hive coordination, consensus, topology)
- 11 slash commands

## USERGUIDE contract

This plugin materialises everything the upstream USERGUIDE advertises for hive-mind. See \`docs/USERGUIDE.md\` (upstream) §Hive Mind for the full surface.

## Known gaps vs. USERGUIDE

The following USERGUIDE-advertised features ship as documentation only — runtime support is partial or missing. Tracked in ADR-0118.

| Feature | Status | Evidence | Tracker |
|---|---|---|---|
${GAP_ROWS}

When ADR-0118 closes a row, the materialise script removes the row from this README and the corresponding annotation from the relevant command file.
EOF

# --- Summary ----------------------------------------------------------------
file_count="$(find "$PLUGIN_DIR" -type f | wc -l | tr -d ' ')"
echo "Materialised ${file_count} files into ${PLUGIN_DIR}"
