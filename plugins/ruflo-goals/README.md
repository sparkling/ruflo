# ruflo-goals

Long-horizon goal planning, deep research orchestration, and adaptive replanning.

## Install

```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-goals@ruflo
```

## Features

- **Goal planning**: GOAP-based action planning with precondition analysis and cost optimization
- **Deep research**: Multi-source research orchestration (web, memory, codebase, patterns)
- **Horizon tracking**: Persistent objectives across sessions with milestone checkpoints
- **Research synthesis**: Evidence-graded reports with contradiction resolution
- **Dossier investigation**: Recursive parallel fan-out across all ruflo sources for seed-driven investigation (ADR-099)

## Commands

- `/goals` -- List active horizons, check progress, view research

## Skills

- `deep-research` -- Orchestrate multi-phase research campaigns
- `goal-plan` -- Create and execute GOAP action plans
- `horizon-track` -- Track objectives across sessions with drift detection
- `research-synthesize` -- Synthesize findings into structured reports
- `dossier-collect` -- Recursive parallel investigation building a graph-structured dossier on a seed entity

## Agents

- `goal-planner` -- GOAP specialist with A* planning and trajectory learning
- `deep-researcher` -- Multi-source research with evidence grading (linear, question-driven)
- `horizon-tracker` -- Cross-session objective tracking with drift detection
- `dossier-investigator` -- Recursive parallel multi-source investigator (seed-driven, graph output)

## Selection guide

| You have | Use |
|---|---|
| A question | `deep-researcher` / `deep-research` |
| A seed entity to expand outward | `dossier-investigator` / `dossier-collect` |
| A multi-step objective | `goal-planner` / `goal-plan` |
| A long-running objective | `horizon-tracker` / `horizon-track` |
