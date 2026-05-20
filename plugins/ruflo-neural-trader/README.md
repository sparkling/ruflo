# ruflo-neural-trader

Neural trading strategies powered by [`neural-trader`](https://www.npmjs.com/package/neural-trader) (v2.7+) — self-learning LSTM/Transformer/N-BEATS models, Rust/NAPI backtesting (8-19x faster), 112+ MCP tools, swarm coordination, and portfolio optimization.

## Overview

Wraps the `neural-trader` npm package as a Ruflo plugin with 4 specialized agents, 6 skills, and comprehensive CLI commands. Adds AgentDB memory persistence, SONA trajectory learning, and swarm-coordinated execution on top of neural-trader's Rust/NAPI engine.

## Prerequisites

```bash
npm install neural-trader
```

## Installation

```bash
claude --plugin-dir plugins/ruflo-neural-trader
```

## MCP Integration (112+ Tools)

neural-trader exposes 112+ MCP tools for direct Claude Desktop access:

```bash
claude mcp add neural-trader -- npx neural-trader mcp start
```

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `trading-strategist` | opus | Strategy design, LSTM/Transformer training, Z-score anomaly detection, backtest orchestration |
| `risk-analyst` | sonnet | VaR/CVaR assessment, Kelly criterion sizing, circuit breakers, correlation monitoring |
| `market-analyst` | sonnet | Regime detection, technical indicators (RSI/MACD/Bollinger), sector analysis, correlation |
| `backtest-engineer` | sonnet | Walk-forward validation, Monte Carlo simulation, parameter optimization, benchmark comparison |

## Skills

| Skill | Usage | Description |
|-------|-------|-------------|
| `trader-backtest` | `/trader-backtest <strategy> --symbol SPY` | Rust/NAPI backtest with walk-forward validation |
| `trader-signal` | `/trader-signal [--strategy NAME]` | Z-score anomaly detection signal generation |
| `trader-portfolio` | `/trader-portfolio [--risk-target 0.15]` | Mean-variance portfolio optimization |
| `trader-regime` | `/trader-regime [--symbol SPY]` | Market regime detection and classification |
| `trader-train` | `/trader-train lstm --symbol TSLA` | Train neural prediction models |
| `trader-risk` | `/trader-risk [--symbol AAPL]` | VaR, position sizing, circuit breaker status |
| `trader-portfolio-cg` | `/trader-portfolio-cg [--portfolio-id ID]` | Conjugate-Gradient mean-variance solve via `mcp__ruflo-sublinear__solve` — 40-60× faster than the legacy Neumann path ([ADR-126 Phase 3](../../v3/docs/adr/ADR-126-neural-trader-substrate-integration.md), [ADR-123 Wedge 8](../../v3/docs/adr/ADR-123-sublinear-integration.md)) |

## Commands

```bash
# Strategy management
trader strategy create <name> --type <momentum|mean-reversion|pairs|adaptive>
trader backtest <strategy> --symbol <TICKER> --period <range>

# Neural model training
trader train <lstm|transformer|nbeats> --symbol <TICKER>

# Signal generation
trader signal scan [--strategy <name>] [--symbols <TICKERS>]

# Market analysis
trader regime --symbol <TICKER>
trader indicators --symbol <TICKER> --indicators rsi,macd,bollinger
trader correlation --symbols <TICKERS> --window 30d

# Risk & portfolio
trader risk assess [--symbol <TICKER>]
trader portfolio optimize [--risk-target <number>]

# Live trading
trader live --broker <name> [--swarm enabled]

# History
trader history
```

## Neural Models (via neural-trader)

| Model | Type | Use Case |
|-------|------|----------|
| LSTM | Recurrent | Sequence prediction, price forecasting |
| Transformer | Attention | Multi-variate pattern recognition |
| N-BEATS | Decomposition | Trend/seasonality decomposition |

```bash
npx neural-trader --model lstm --symbol TSLA --confidence 0.95
npx neural-trader --model transformer --symbol BTC-USD --predict
npx neural-trader --model nbeats --symbol SPY --decompose
```

## Strategy Types

| Strategy | CLI Flag | Entry Logic |
|----------|----------|-------------|
| Momentum | `--strategy momentum` | RSI + MACD confirmation |
| Mean-reversion | `--strategy mean-reversion` | Z-score > 2.0, Bollinger extremes |
| Pairs trading | `--strategy pairs` | Cointegration spread divergence |
| Multi-indicator | `--strategy multi-indicator` | RSI + MACD + Bollinger combined |
| Adaptive | `--strategy adaptive` | Auto-switches by regime |

## Market Regime Detection

| Regime | Indicators | Recommended Strategy |
|--------|-----------|---------------------|
| Bull trending | ADX > 25, price > 200 SMA | Momentum, trend-following |
| Bear trending | ADX > 25, price < 200 SMA | Short momentum, hedging |
| Ranging | ADX < 20, Bollinger squeeze | Mean-reversion |
| High volatility | VIX > 25, ATR expanding | Reduce size, widen stops |
| Transitioning | Divergences forming | Wait for confirmation |

## Anomaly Detection

neural-trader Z-score composite scoring on OHLCV: `anomalyScore = min(1, meanZ / 3)`

| Type | Detection | Market Interpretation |
|------|-----------|----------------------|
| spike | maxZ > 5 | Breakout / gap |
| drift | 1-2 dims sustained | Sustained trend |
| flatline | all near zero | Consolidation |
| oscillation | alternating | Range-bound |
| pattern-break | moderate Z, multi-dim | Regime change |
| cluster-outlier | >50% dims high | Multi-factor dislocation |

## Circuit Breakers

| Breaker | Trigger | Action |
|---------|---------|--------|
| Daily loss | Drawdown > 3%/day | Halt new entries |
| Weekly loss | Drawdown > 5%/week | Reduce sizes 50% |
| Correlation spike | Portfolio corr > 0.85 | Reduce correlated positions |
| Volatility regime | VIX > 2x historical | Minimum position sizes |
| Max positions | Open > limit | Block new entries |
| Concentration | Any position > 10% | Force trim |

## Backtesting Features

| Feature | Command |
|---------|---------|
| Walk-forward | `--walk-forward --train-window 6M --test-window 1M` |
| Monte Carlo | `--monte-carlo --simulations 1000` |
| Parameter optimization | `--optimize --param "entry_z:1.5:3.0:0.25"` |
| Multi-symbol | `--symbols "AAPL,MSFT,GOOGL"` |
| Benchmark comparison | `--benchmark SPY` |

## Performance

neural-trader uses Rust/NAPI bindings for zero-overhead performance:
- **8-19x faster** than Python equivalents
- **Sub-200ms** order execution and risk checks
- **WASM/SIMD** acceleration available
- **52,000+ inserts/sec** for market data

## Compatibility

- **CLI:** pinned to `@sparkleideas/cli` v3.6 major+minor.
- **Runtime:** `npx neural-trader` (Rust/NAPI bindings — 112+ MCP tools).
- **Verification:** `bash plugins/ruflo-neural-trader/scripts/smoke.sh` is the contract.

## Namespace coordination

This plugin owns five AgentDB namespaces (kebab-case, follows the convention from [ruflo-agentdb ADR-0001 §"Namespace convention"](../ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md)). The canonical five-namespace set is defined by [ADR-126](../../v3/docs/adr/ADR-126-neural-trader-substrate-integration.md) Phase 1:

| Namespace | Purpose |
|-----------|---------|
| `trading-strategies` | Strategy definitions, parameters, regime-condition mappings (loaded by `trader-backtest`, `trader-signal`) |
| `trading-backtests` | Historical backtest results indexed by strategy + timestamp (long-lived; signed in ADR-126 Phase 4) |
| `trading-risk` | Risk model state, VaR/CVaR snapshots, circuit-breaker triggers |
| `trading-analysis` | Market-analyst output — regime classifications, technical-indicator summaries, model-training results |
| `trading-signals` | Short-lived signal events (intraday; TTL applied in ADR-126 Phase 2) |

Note: the namespace prefix is `trading-` (the actual intent) rather than `neural-trader-` (the plugin stem). This is a deliberate ergonomic choice — `trading` is the load-bearing concern downstream consumers reason about. Reserved namespaces (`pattern`, `claude-memories`, `default`) MUST NOT be shadowed.

All access via `memory_*` (namespace-routed). No `agentdb_hierarchical-*` or `agentdb_pattern-store` with namespace arguments — the plugin uses the correct routing throughout.

### Memory lifecycle (ADR-125 integration)

This plugin relies on `@claude-flow/memory@3.0.0-alpha.18` for the lifecycle guarantees defined in [ADR-125](../../v3/docs/adr/ADR-125-memory-consolidation.md) and wired by [ADR-126 Phase 2](../../v3/docs/adr/ADR-126-neural-trader-substrate-integration.md):

- **Warm HNSW restart** — `@claude-flow/memory@3.0.0-alpha.18` (ADR-125 Phase 3) snapshots the HNSW index to a `.hnsw` sidecar file, so neural-trader process restarts no longer rebuild the strategy / regime similarity index from scratch. No plugin-side change is required to benefit; routing is automatic through `MemoryService.search()`.
- **Hybrid retrieval (RRF + MMR)** — `market-analyst` regime-similarity queries automatically become hybrid (dense ANN + sparse FTS5 keyword, reciprocal-rank-fused and MMR-diversified) via the same `MemoryService.search()` path (ADR-125 Phase 5). When the embedding generator is unavailable, retrieval gracefully degrades to keyword-only rather than throwing.
- **Signal TTL (24h)** — `trader-signal` writes to `trading-signals` with `expiresAt: now + 24h`. The `MemoryConsolidator.sweepExpired()` pass (ADR-125 Phase 4) removes them from all indexes — including HNSW — when they expire. Long-running ruflo sessions no longer accumulate stale intraday signals.
- **Backtest dedup** — `trader-backtest` proactively deletes prior entries for the same `(strategyId, paramsHash)` before storing a fresh one. The same outcome is also produced asynchronously by the `MemoryConsolidator.dedup('keep-newest')` background pass that runs every 6 hours.
- **Consolidator schedule** — the consolidator runs every 6 hours by default (`sweepExpired` + `dedup` + `compactHnsw`), and also on `MemoryService.close()`. No plugin-side wiring is required.

### Portfolio CG path (ADR-126 Phase 3 / ADR-123 Wedge 8)

The new `trader-portfolio-cg` skill solves the mean-variance problem `Σ · x = μ` via Conjugate Gradient instead of the legacy Neumann series. CG is provably optimal for symmetric positive-definite inputs (covariance matrices are SPD by construction), and the upstream `sublinear-time-solver@1.7.0` benchmark shows **~816 ns CG vs ~50 µs Neumann at n=256 — a measured 40-60× speedup** ([ADR-123 §162 Row 8](../../v3/docs/adr/ADR-123-sublinear-integration.md)).

**When it's used**: any time the team wants optimal portfolio weights — call `/trader-portfolio-cg` instead of `/trader-portfolio`. The skill reads the current covariance and expected-return vector from `npx neural-trader --portfolio current --json`, dispatches to `mcp__ruflo-sublinear__solve` (when the `ruflo-sublinear` plugin is registered), and writes weights with provenance metadata (`method: 'cg-sublinear' | 'cg-local' | 'neumann-fallback'`) to the `trading-risk` namespace.

**How to disable**: set `RUFLO_NEURAL_TRADER_DISABLE_CG=1` to skip the CG path entirely and fall back to the legacy `npx neural-trader --portfolio optimize` route. Useful for A/B validation or when an upstream covariance regression breaks SPD.

**Parity guarantee**: `||cg_solution − neumann_solution||_∞ < 1e-4` on every benchmark seed — verified by `benchmarks/portfolio-cg.bench.mjs` and asserted by `scripts/smoke-neural-trader-portfolio-cg.mjs`.

**Local fallback**: the adapter (`src/sublinear-adapter.ts` + `.mjs` mirror) ships a self-contained ~50-LOC CG kernel so the skill works even before the `ruflo-sublinear` plugin lands on the IPFS registry. The same call site picks up the full native-WASM speedup automatically once `mcp__ruflo-sublinear__solve` is registered in the runtime.

```bash
# Run the bench yourself:
node plugins/ruflo-neural-trader/benchmarks/portfolio-cg.bench.mjs

# Run the contract smoke:
node scripts/smoke-neural-trader-portfolio-cg.mjs
```

## Verification

```bash
bash plugins/ruflo-neural-trader/scripts/smoke.sh
# Expected: "11 passed, 0 failed"
```

## Architecture Decisions

- [`ADR-0001` — ruflo-neural-trader plugin contract (already-compliant namespaces, 4-namespace claim, smoke as contract)](./docs/adrs/0001-neural-trader-contract.md)

## Related Plugins

- `ruflo-agentdb` — namespace convention owner; backing store
- `ruflo-market-data` — OHLCV data ingestion and candlestick pattern detection (feeds `trading-strategies`)
- `ruflo-ruvector` — HNSW indexing for strategy pattern similarity search
- `ruflo-cost-tracker` — PnL tracking and cost attribution
- `ruflo-observability` — Strategy performance dashboards

## License

MIT
