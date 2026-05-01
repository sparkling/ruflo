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

## Related Plugins

- `ruflo-market-data` — OHLCV data ingestion and candlestick pattern detection
- `ruflo-ruvector` — HNSW indexing for strategy pattern similarity search
- `ruflo-cost-tracker` — PnL tracking and cost attribution
- `ruflo-observability` — Strategy performance dashboards

## License

MIT
