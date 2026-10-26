# Prism Backtest — Usage

## Install

```bash
npm install github:krishyaa06/prism-backtest
# or run the CLI directly
npx github:krishyaa06/prism-backtest --help
```

## JavaScript API

```js
import { backtest, sweep, walkForward, monteCarlo, generate, parseCSV, GRIDS } from "prism-backtest";

const data = { BANKX: generate({ seed: 6, years: 6 }).BANKX };        // or { RELIANCE: parseCSV(fs.readFileSync("RELIANCE.csv", "utf8")) }

const r = backtest(data, {
  strategy: "sma-cross", params: { fast: 20, slow: 50 },
  cash: 10_00_000, costs: "india-delivery",                          // STT, stamp duty, exchange + SEBI fees, GST, DP charge
  slippage: { model: "sqrt", k: 0.6, spreadBps: 2 },                 // half spread + square-root impact
  risk: { stopLoss: 0.08, maxPos: 1, ddHalt: 0.25 },                 // gap-aware stop, kill switch at -25%
});
r.metrics;   // { cagr, sharpe, sortino, maxDD, calmar, var95, winRate, profitFactor, psr, fees, slippage, ... }
r.trades;    // [{ sym, side, entryD, exitD, entry, exit, pnl, ret, mae, mfe, exitTag }]

const s = sweep(data, { strategy: "sma-cross", grid: GRIDS["sma-cross"] });
s.best; s.dsr;                                                       // deflated Sharpe after s.trials combinations

const wf = walkForward(data, { strategy: "sma-cross", grid: GRIDS["sma-cross"], train: 504, test: 126 });
wf.isSharpe; wf.oos.sharpe; wf.efficiency;                           // in-sample vs out-of-sample

const mc = monteCarlo(r, { runs: 1000, block: 10 });
mc.final[0.05]; mc.maxDD[0.95]; mc.pLoss;

// your own strategy: state target weights, the engine does the rest
const myStrategy = { onBar(ctx) { const c = ctx.close("BANKX"), c20 = ctx.close("BANKX", 20); if (c20) ctx.target("BANKX", c > c20 ? 1 : 0); } };
backtest(data, { strategy: myStrategy });
```

| Export | What it does |
|---|---|
| `backtest(data, opts)` | Run over `{ SYM: bar[] }` and return `{ dates, equity, bench, dd, gross, trades, fills, open, metrics, monthly }` |
| `new Backtest({ strategy, params, cash, costs, slippage, fill, maxVolPct, risk, benchmark, rf, cashRate, borrowBps, startAt, lot })` | Incremental engine: `.feed(date, bars)`, `.result()`, `.on(fn)`, `.resume()` |
| Events | `signal`, `fill`, `trade`, `stop`, `partial`, `reject`, `clamp`, `cancel`, `halt`, `resume` |
| Strategy `ctx` | `i`, `d`, `syms`, `equity`, `cash`, `canShort`, `bar(s)`, `close(s, k)`, `hist(s, n)`, `pos(s)`, `weight(s)`, `stops(s)`, `target(s, w, { stop, tag })`, `flat(s)`, `order(s, qty, { limit })`, `note(s, text, kind)` |
| `STRATEGIES` · `resolve(name, params)` · `StrategyError` | Built-ins with parameter specs and validation |
| `sweep(data, { strategy, grid, metric })` · `walkForward(data, { strategy, grid, train, test })` · `monteCarlo(result, { runs, block })` · `GRIDS` · `range` | Robustness |
| `stats(equity, { trades, bench, rf })` · `psr` · `dsr` · `expectedMaxSharpe` · `drawdowns` · `monthly` · `bootstrap` | Statistics |
| `charges(side, qty, price, schedule)` · `slip(side, qty, price, model, { vol, volume })` · `COSTS` | Costs and slippage |
| `SMA` `EMA` `RSI` `ATR` `Bollinger` `Donchian` `MACD` `ROC` `RollingOLS` `Stdev` | Streaming indicators (+ array versions) |
| `Market` · `generate` · `parseCSV` · `toCSV` · `UNIVERSE` · `REGIMES` | Data |
| `createServer()` from `src/node/server.js` | HTTP API |

## CLI

```bash
$ npx github:krishyaa06/prism-backtest demo
$ npx github:krishyaa06/prism-backtest run --strategy donchian --symbols BANKX --trades
$ npx github:krishyaa06/prism-backtest run --strategy rsi-revert --csv RELIANCE.csv --costs india-delivery
$ npx github:krishyaa06/prism-backtest sweep --strategy sma-cross
$ npx github:krishyaa06/prism-backtest walkforward --strategy sma-cross --train 504 --test 126
$ npx github:krishyaa06/prism-backtest montecarlo --runs 2000
$ npx github:krishyaa06/prism-backtest costs --value 100000
$ npx github:krishyaa06/prism-backtest serve --port 8789
```

| Command | Description |
|---|---|
| `backtest demo` | Eight steps: regimes, trend vs buy and hold, the cost of a round trip, capacity, kill switch, sweep + deflated Sharpe, walk-forward, Monte Carlo |
| `backtest run [--strategy --<param> N] [--symbols A,B \\| --csv file.csv[:SYM]] [--costs --slippage sqrt\\|bps:5\\|none --fill --stop --trail --ddhalt --short] [--trades] [--json]` | One backtest with a full report |
| `backtest sweep [--strategy] [--grid fast=5:50:5,slow=20:200:20]` | Grid search, heatmap, top results, PSR and deflated Sharpe |
| `backtest walkforward [--strategy --train 504 --test 126]` | Rolling out-of-sample test with chosen parameters per fold |
| `backtest montecarlo [--runs 1000 --block 10]` | Block bootstrap percentiles of final equity, CAGR and drawdown |
| `backtest costs [--value 100000 --schedule india-delivery]` | Breakdown of one round trip |
| `backtest strategies` · `backtest data [--out data/]` · `backtest bench` · `backtest serve [--port 8789]` | Reference, synthetic CSVs, throughput, HTTP API |

## Live simulator

Open [https://krishyaa06.github.io/prism-backtest/](https://krishyaa06.github.io/prism-backtest/) or serve the repo root locally (`npx serve .`). The simulator imports the same modules from `src/`.
