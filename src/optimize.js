// Parameter sweeps with a deflated Sharpe ratio, anchored-free rolling walk-forward analysis, and Monte Carlo.
import { backtest, timeline } from "./engine.js";
import { stats, toReturns, dsr, bootstrap, PPY } from "./metrics.js";
import { STRATEGIES, StrategyError } from "./strategies.js";

export const range = (lo, hi, step = 1) => { const out = []; for (let x = lo; x <= hi + 1e-9; x += step) out.push(Math.round(x * 1e6) / 1e6); return out; };
const combos = (grid) => Object.entries(grid).reduce((acc, [k, vs]) => acc.flatMap((c) => vs.map((v) => ({ ...c, [k]: v }))), [{}]);
export const sliceData = (data, d0, d1) => Object.fromEntries(Object.entries(data).map(([s, bars]) => [s, bars.filter((b) => b.d >= d0 && b.d <= d1)]));
const score = (m, metric) => (metric === "maxDD" ? -m.maxDD : m[metric] ?? m.sharpe);

/** Run every combination in `grid`. Returns rows, the best row and the deflated Sharpe ratio of the best given the number of trials. */
export function sweep(data, { strategy, grid, metric = "sharpe", ...opts }) {
  if (!grid || !Object.keys(grid).length) throw new StrategyError("grid needs at least one parameter");
  const rows = [];
  for (const p of combos(grid)) {
    try { const r = backtest(data, { ...opts, strategy, params: p }); rows.push({ params: p, ok: true, m: pick(r.metrics), ex: excess(r.equity, opts.rf) }); }
    catch (e) { if (e instanceof StrategyError) rows.push({ params: p, ok: false, error: e.message }); else throw e; }
  }
  const ok = rows.filter((r) => r.ok); if (!ok.length) throw new StrategyError("no valid parameter combination in the grid");
  const best = ok.reduce((a, b) => (score(b.m, metric) > score(a.m, metric) ? b : a));
  const sharpes = ok.map((r) => r.m.sharpe / Math.sqrt(PPY));
  const deflated = dsr(best.ex, ok.length, sharpes);
  for (const r of rows) delete r.ex;
  return { metric, rows, best: { params: best.params, m: best.m }, trials: ok.length, dsr: deflated, psr: best.m.psr };
}
const excess = (eq, rf = 0) => { const d = Math.pow(1 + rf, 1 / PPY) - 1; return toReturns(eq).map((x) => x - d); };
const pick = (m) => ({ sharpe: m.sharpe, cagr: m.cagr, maxDD: m.maxDD, trades: m.trades, winRate: m.winRate, sortino: m.sortino, calmar: m.calmar, psr: m.psr, total: m.total });

/**
 * Rolling walk-forward: optimise on `train` bars, trade the next `test` bars with the winning parameters (warmed up on prior data),
 * roll forward by `test`. The stitched out-of-sample equity is the honest estimate.
 */
export function walkForward(data, { strategy, grid, train = 504, test = 126, metric = "sharpe", warmup, cash = 1_000_000, ...opts }) {
  const days = timeline(data).map((x) => x.d), n = days.length;
  if (train + test > n) throw new StrategyError(`need at least ${train + test} bars (have ${n})`);
  const maxParam = Math.max(10, ...Object.values(grid).flat().filter((v) => typeof v === "number"));
  const wu = warmup ?? Math.ceil(maxParam * 1.1) + 5;
  const folds = []; let eq = [cash], dates = [], isSharpe = [];
  for (let s = 0; s + train + test <= n; s += test) {
    const trD = [days[s], days[s + train - 1]], teD = [days[s + train], days[Math.min(n - 1, s + train + test - 1)]];
    const sw = sweep(sliceData(data, ...trD), { ...opts, cash, strategy, grid, metric });
    const w0 = days[Math.max(0, s + train - wu)];
    const r = backtest(sliceData(data, w0, teD[1]), { ...opts, cash, strategy, params: sw.best.params, startAt: teD[0] });
    const ret = toReturns(r.equity); for (let i = 0; i < ret.length; i++) eq.push(eq.at(-1) * (1 + ret[i]));
    if (!dates.length) dates.push(r.dates[0]); dates.push(...r.dates.slice(1)); // fold boundaries share one bar
    isSharpe.push(sw.best.m.sharpe);
    folds.push({ train: trD, test: teD, params: sw.best.params, is: sw.best.m, oos: pick(r.metrics), trades: r.trades.length });
  }
  const oos = stats(eq, { rf: opts.rf ?? 0 }), isAvg = isSharpe.reduce((a, b) => a + b, 0) / isSharpe.length;
  return { folds, dates, equity: eq, oos, isSharpe: isAvg, efficiency: isAvg !== 0 ? oos.sharpe / isAvg : 0, stable: paramStability(folds) };
}
function paramStability(folds) { const out = {}; for (const k of Object.keys(folds[0]?.params || {})) { const vs = folds.map((f) => f.params[k]); out[k] = { values: vs, distinct: new Set(vs).size }; } return out; }

/** Monte Carlo of a finished backtest: block bootstrap of its daily returns. */
export function monteCarlo(result, opts = {}) { const r = toReturns(result.equity); const b = bootstrap(r, { horizon: r.length, ...opts }); return { ...b, pDD: undefined, pDD20: b.pDD(0.2), pDD30: b.pDD(0.3) }; }

/** Default search grids used by the CLI, API and simulator. */
export const GRIDS = {
  "sma-cross": { fast: range(5, 50, 5), slow: range(20, 200, 20) },
  "rsi-revert": { period: [2, 3, 5, 7, 10, 14], buy: [10, 15, 20, 25, 30, 35] },
  "bollinger": { n: range(10, 50, 5), k: [1.5, 1.75, 2, 2.25, 2.5, 3] },
  "donchian": { entry: range(20, 100, 10), exit: range(10, 40, 5) },
  "momentum": { lookback: [21, 42, 63, 126, 189, 252], top: [1, 2, 3, 4] },
  "pairs": { lookback: range(30, 120, 15), entry: [1.5, 1.75, 2, 2.25, 2.5, 3] },
  "buy-hold": {},
};
export const strategyList = () => Object.entries(STRATEGIES).map(([k, s]) => ({ name: k, label: s.label, kind: s.kind, desc: s.desc, params: s.params, risk: s.risk || {}, pair: !!s.pair }));
