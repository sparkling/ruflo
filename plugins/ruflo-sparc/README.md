# ruflo-sparc

SPARC methodology -- Specification, Pseudocode, Architecture, Refinement, Completion phases with quality gates between each phase.

## Overview

Drives features through a rigorous five-phase development lifecycle. Each phase has a quality gate that must pass before advancing. The orchestrator spawns specialized agents per phase (researcher, planner, system-architect, coder/tester, reviewer) and stores all artifacts and gate results in memory for traceability.

## Installation

```bash
claude --plugin-dir plugins/ruflo-sparc
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `sparc-orchestrator` | sonnet | Orchestrate 5-phase SPARC lifecycle, enforce gate checks, spawn phase-specific agents, track state in memory |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `sparc-spec` | `/sparc-spec <feature-description>` | Run the Specification phase -- gather requirements, define acceptance criteria, identify constraints |
| `sparc-implement` | `/sparc-implement` | Run the Architecture and Implementation phases -- design modules, write pseudocode, implement, test |
| `sparc-refine` | `/sparc-refine` | Run Refinement and Completion -- review code, improve coverage, validate against spec, generate docs |

## Commands (5 subcommands)

```bash
sparc init <feature>         # Initialize a new SPARC workflow
sparc status                 # Show current phase and gate history
sparc advance                # Attempt gate check, advance to next phase
sparc phase <phase-name>     # Jump to a specific phase (spec/pseudo/arch/refine/complete)
sparc report                 # Generate full SPARC methodology report with traceability matrix
```

## The 5 Phases

| Phase | Name | Gate Criteria | Spawned Agent |
|-------|------|--------------|---------------|
| 1 | Specification | >= 3 acceptance criteria, constraints, edge cases | `researcher` |
| 2 | Pseudocode | Covers all ACs, error paths explicit, complexity annotated | `planner` |
| 3 | Architecture | All constraints addressed, typed API contracts, no circular deps | `system-architect` |
| 4 | Refinement | All ACs have passing tests, review approved, coverage >= 80% | `coder` + `tester` |
| 5 | Completion | All tests green, docs complete, deployment checklist verified | `reviewer` |

## Memory Namespaces

| Namespace | Purpose |
|-----------|---------|
| `sparc-state` | Current phase tracking per feature |
| `sparc-phases` | Phase artifacts (specs, pseudocode, ADRs, reports) |
| `sparc-gates` | Gate check results and history |
| `patterns` | Learned SPARC execution patterns |

## Related Plugins

- `ruflo-ddd` -- Architecture phase uses DDD bounded context patterns
- `ruflo-adr` -- Architecture decisions recorded as ADRs in Phase 3

## License

MIT
