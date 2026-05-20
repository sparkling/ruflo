---
name: trader-backtest
description: Run a historical backtest using npx neural-trader with Rust/NAPI engine (8-19x faster) and walk-forward validation
allowed-tools: Bash Read mcp__ruflo__memory_store mcp__ruflo__memory_retrieve mcp__ruflo__memory_search mcp__ruflo__memory_delete mcp__ruflo__neural_train mcp__ruflo__agentdb_pattern-store
argument-hint: "<strategy-name> --symbol <TICKER> [--period 2020-2024]"
---
Run a historical backtest using the `neural-trader` Rust/NAPI engine.

Steps:
1. Ensure neural-trader is available:
   `npm ls neural-trader 2>/dev/null || npm install neural-trader`
2. Check for saved strategy config:
   `mcp__ruflo__memory_retrieve({ key: "strategy-STRATEGY_NAME", namespace: "trading-strategies" })`
   If not found, list available: `mcp__ruflo__memory_search({ query: "strategy", namespace: "trading-strategies", limit: 10 })`
3. Run backtest via neural-trader CLI:
   ```bash
   npx neural-trader --backtest --strategy <name> --symbol <TICKER> --period <range> --walk-forward
   ```
   For multi-indicator strategies:
   ```bash
   npx neural-trader --backtest --strategy multi-indicator --position-sizing kelly --symbol SPY --period 2020-2024
   ```
4. Capture performance metrics from output: total return, annualized return, Sharpe ratio, Sortino ratio, max drawdown, win rate, profit factor, number of trades
5. Dedup prior backtests for the same `(strategyId, paramsHash)` before storing the fresh one (ADR-125 lifecycle / ADR-126 Phase 2 — `keep-newest` semantics):
   - Search: `mcp__ruflo__memory_search({ query: "backtest STRATEGY paramsHash:PARAMS_HASH", namespace: "trading-backtests", limit: 10 })`
   - For each hit whose key matches `backtest-STRATEGY-*` AND whose stored `paramsHash` equals the current run's hash, delete it: `mcp__ruflo__memory_delete({ key: "OLD_KEY", namespace: "trading-backtests" })`
   - (Note: even without this proactive step, the `MemoryConsolidator.dedup('keep-newest')` background pass introduced in `@sparkleideas/memory@3.0.0-alpha.18` runs every 6h and will eventually converge. Doing it inline keeps `memory_search` results deterministic immediately after a re-run.)
6. Store backtest results (long-lived; no TTL — backtest history is the audit trail that ADR-126 Phase 4 will Ed25519-sign):
   `mcp__ruflo__memory_store({ key: "backtest-STRATEGY-TIMESTAMP", value: "RESULTS_JSON", namespace: "trading-backtests" })`
7. If Sharpe > 1.5, store as successful pattern:
   `mcp__ruflo__agentdb_pattern-store({ pattern: "profitable-STRATEGY_TYPE", data: "PARAMS_AND_RESULTS" })`
8. Train SONA on the outcome:
   `mcp__ruflo__neural_train({ patternType: "trading-strategy", epochs: 10 })`
