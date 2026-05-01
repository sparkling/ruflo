# ruflo-observability

Structured logging, distributed tracing, and metrics -- correlate agent swarm activity with application telemetry.

## Overview

Implements OpenTelemetry-compatible structured logging with correlation IDs, distributed tracing with parent-child span hierarchies, and metrics collection (counters, gauges, histograms). Correlates swarm agent activity with application-level telemetry and detects anomalies in latency, error rates, and resource usage.

## Installation

```bash
claude --plugin-dir plugins/ruflo-observability
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `observability-engineer` | sonnet | Structured logging, distributed tracing, metrics collection, agent-application telemetry correlation |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `observe-trace` | `/observe-trace <task-id>` | Trace agent execution by collecting spans and building a trace tree |
| `observe-metrics` | `/observe-metrics [--period 1h]` | Aggregate and display system metrics with anomaly detection |

## Commands (5 subcommands)

```bash
observe trace <task-id>              # Trace agent execution with span tree
observe metrics [--period 1h]        # View aggregated metrics (p50, p95, p99)
observe logs [--level error]         # Filter structured logs by level
observe dashboard                    # Combined health dashboard
observe correlate <agent-id>         # Correlate all telemetry for an agent
```

## Key Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `agent_task_duration_seconds` | Histogram | Time to complete agent tasks |
| `agent_token_usage` | Counter | Tokens consumed per agent/model |
| `agent_active_count` | Gauge | Currently active agents |
| `agent_error_rate` | Counter | Errors per agent |
| `swarm_span_duration_ms` | Histogram | Span durations for tracing |
| `memory_operations_total` | Counter | AgentDB read/write counts |

## Trace Hierarchy

```
[root] swarm-task
  [child] agent-spawn (agent=architect)
  [child] agent-spawn (agent=coder)
    [child] file-read (path=src/auth.ts)
    [child] file-write (path=src/auth.ts)
  [child] agent-spawn (agent=tester)
    [child] test-run (suite=auth)
```

## Log Format

JSON structured logs with `timestamp`, `level`, `message`, `correlationId`, `agentId`, `taskId`, `spanId`, `traceId`, `duration_ms`, and `metadata`.

## Related Plugins

- `ruflo-cost-tracker` -- Token usage metrics feed into cost attribution
- `ruflo-iot-cognitum` -- Reuses Z-score anomaly detection for telemetry patterns
- `ruflo-market-data` -- Data feed health and ingestion latency monitoring

## License

MIT
