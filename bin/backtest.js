#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { Backtest, backtest, sweep, walkForward, monteCarlo, GRIDS, STRATEGIES, strategyList, generate, parseCSV, toCSV, charges, COSTS, range, Market, UNIVERSE, SYMBOLS, timeline } from "../src/index.js";
import { c, table, header, fail, bar, spark, num } from "../src/lib/cli.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : d; };
const has = (n) => rest.includes("--" + n);
const HELP = `${c.bold("backtest")} — Prism Backtest: event-driven strategy backtesting with realistic Indian costs, risk controls and overfitting checks

  backtest demo                                   guided tour: costs, look-ahead bias, kill switch, sweep, walk-forward, Monte Carlo
  backtest run [--strategy sma-cross --fast 20 --slow 50] [--symbols NIFTYX] [--csv file.csv]
               [--seed 6 --years 6 --cash 1000000 --costs india-delivery --slippage sqrt|bps:5|none]
               [--fill next-open|close --stop 0.08 --trail 0.1 --ddhalt 0.2 --short] [--trades] [--json]
  backtest sweep [--strategy sma-cross] [--grid fast=5:50:5,slow=20:200:20]   grid search + deflated Sharpe
  backtest walkforward [--strategy sma-cross --train 504 --test 126]          rolling out-of-sample test
  backtest montecarlo [--strategy sma-cross --runs 1000 --block 10]           block bootstrap of daily returns
  backtest costs [--value 100000 --schedule india-delivery]                   charge breakdown for one round trip
  backtest strategies                                                         built-in strategies and parameters
  backtest data [--seed 6 --years 6 --out data/]                              write synthetic OHLCV CSVs
  backtest bench [--years 20 --symbols 8]                                     throughput
  backtest serve [--port 8789]                                                HTTP API
`;
const inr = (v) => (v < 0 ? "-" : "") + "₹" + Math.abs(Math.round(v)).toLocaleString("en-IN");
const pct = (x, d = 1) => (isFinite(x) ? (x * 100).toFixed(d) + "%" : "–");
const f2 = (x) => (isFinite(x) ? x.toFixed(2) : x === Infinity ? "∞" : "–");
const tone = (x, good = 0) => (x > good ? c.green : x < good ? c.red : (s) => s);

function loadData() {
  const csv = flag("csv");
  if (csv) {
    const [file, sym0] = csv.split(":"), sym = sym0 || basename(file).replace(/\.csv$/i, "").toUpperCase();
    try { return { [sym]: parseCSV(readFileSync(file, "utf8")) }; } catch (e) { fail(`${file}: ${e.message}`); }
  }
  const strat = flag("strategy", "sma-cross");
  const def = strat === "pairs" ? "BANKX,FINX" : strat === "momentum" ? "KLPR,BANKX,PHRMA,AUTOX,INFRA,GOLDB" : "NIFTYX";
  const syms = flag("symbols", def).split(",").map((s) => s.trim().toUpperCase());
  for (const s of syms) if (!SYMBOLS.includes(s)) fail(`unknown symbol ${s} (synthetic universe: ${SYMBOLS.join(", ")})`);
  const need = [...new Set([...syms, ...syms.map((s) => UNIVERSE.find((u) => u.sym === s).pairOf).filter(Boolean), "NIFTYX"])];
  const all = generate({ seed: +flag("seed", 6), years: +flag("years", 6), symbols: need });
  return Object.fromEntries(syms.map((s) => [s, all[s]]).concat([["__bench", all.NIFTYX]]));
}
const split = (data) => { const bench = data.__bench; const d = { ...data }; delete d.__bench; return { d, bench }; };
function options() {
  const strategy = flag("strategy", "sma-cross"), def = STRATEGIES[strategy]; if (!def) fail(`unknown strategy ${strategy} (try: ${Object.keys(STRATEGIES).join(", ")})`);
  const params = {}; for (const k of Object.keys(def.params)) if (flag(k) != null) params[k] = +flag(k);
  const sl = flag("slippage", "sqrt"); const slippage = sl === "none" ? { model: "none" } : sl.startsWith("bps") ? { model: "bps", bps: +(sl.split(":")[1] || 5) } : { model: "sqrt", k: 0.6, spreadBps: 2 };
  const risk = {}; if (flag("stop")) risk.stopLoss = +flag("stop"); if (flag("trail")) risk.trail = +flag("trail"); if (flag("ddhalt")) risk.ddHalt = +flag("ddhalt"); if (has("short")) risk.allowShort = true; if (flag("maxpos")) risk.maxPos = +flag("maxpos");
  return { strategy, params, cash: +flag("cash", 1_000_000), costs: flag("costs", "india-delivery"), slippage, fill: flag("fill", "next-open"), risk, rf: +flag("rf", 0) };
}
function withBench(d, bench, opts) { if (!bench || d.NIFTYX) return { data: d, benchmark: d.NIFTYX ? "NIFTYX" : null }; return { data: d, benchmark: null, benchBars: bench }; }
function runOne(extra = {}) {
  const { d, bench } = split(loadData()), o = { ...options(), ...extra };
  let r; try { r = backtest(d, { ...o, benchmark: d.NIFTYX ? "NIFTYX" : null }); } catch (e) { fail(e.message); }
  if (!r.bench && bench) { const b = bench.filter((x) => x.d >= r.dates[0]); r.bench = r.dates.map((dt, i) => (o.cash * (b.find((x) => x.d === dt) || b[i] || b.at(-1)).c) / b[0].c); }
  return { r, o, d };
}
function report(r, o, title) {
  const m = r.metrics;
  console.log(header("Prism Backtest", title || `${r.strategy} ${JSON.stringify(r.params)}`));
  console.log(c.dim(`  ${r.dates[0]} → ${r.dates.at(-1)} · ${m.bars} bars · costs ${o.costs} · slippage ${o.slippage.model} · fill ${o.fill}`));
  console.log("  equity  " + c.accent(spark(r.equity.filter((_, i) => i % Math.ceil(r.equity.length / 60) === 0))) + "  " + inr(m.start) + " → " + c.bold(inr(m.end)));
  if (r.bench) console.log("  bench   " + c.dim(spark(r.bench.filter((_, i) => i % Math.ceil(r.bench.length / 60) === 0))) + "  " + c.dim("buy & hold NIFTYX"));
  const bm = r.bench ? (r.bench.at(-1) / r.bench[0]) ** (1 / m.years) - 1 : NaN;
  console.log(table([
    ["CAGR", tone(m.cagr)(pct(m.cagr)), "benchmark", pct(bm)],
    ["Sharpe", tone(m.sharpe)(f2(m.sharpe)), "Sortino", f2(m.sortino)],
    ["Max drawdown", c.red(pct(m.maxDD)), "longest underwater", m.ddDays + " bars"],
    ["Calmar", f2(m.calmar), "volatility", pct(m.vol)],
    ["Trades", String(m.trades), "win rate", pct(m.winRate, 0)],
    ["Profit factor", f2(m.profitFactor), "expectancy / trade", inr(m.expectancy)],
    ["Exposure", pct(m.exposure, 0), "turnover / yr", f2(m.turnover) + "×"],
    ["Fees + taxes", inr(m.fees), "slippage", inr(m.slippage)],
    ["VaR 95% (1d)", pct(m.var95, 2), "CVaR 95%", pct(m.cvar95, 2)],
    ["P(Sharpe > 0)", pct(m.psr, 0), m.halted ? c.red("kill switch") : "kill switch", m.halted ? c.red("TRIGGERED") : "not triggered"],
  ].map((r) => ["  " + r[0], r[1], c.dim(r[2]), r[3]]), { align: [, "right", , "right"] }));
}

const cmds = {
  help() { console.log(HELP); },
  run() {
    const { r, o } = runOne(); if (has("json")) return console.log(JSON.stringify({ strategy: r.strategy, params: r.params, metrics: r.metrics, trades: r.trades, open: r.open, monthly: r.monthly }, null, 2));
    report(r, o);
    if (has("trades")) console.log("\n" + table(r.trades.map((t) => [t.sym, t.side, t.entryD, t.exitD, String(t.bars), f2(t.entry), f2(t.exit), tone(t.pnl)(inr(t.pnl)), pct(t.ret), pct(t.mae), t.exitTag]), { head: ["sym", "side", "entry", "exit", "bars", "in", "out", "P&L", "ret", "MAE", "exit"], align: [, , , , "right", "right", "right", "right", "right", "right"] }));
    if (r.open.length) console.log(c.dim("\n  open: ") + r.open.map((p) => `${p.sym} ${p.qty} @ ${f2(p.entry)} (${inr(p.upnl)})`).join(", "));
  },
  sweep() {
    const { d } = split(loadData()), o = options(); let grid = GRIDS[o.strategy];
    if (flag("grid")) grid = Object.fromEntries(flag("grid").split(",").map((kv) => { const [k, spec] = kv.split("="); const [a, b, s] = spec.split(":").map(Number); return [k, b != null ? range(a, b, s || 1) : spec.split("|").map(Number)]; }));
    const t0 = performance.now(); let sw; try { sw = sweep(d, { ...o, grid }); } catch (e) { fail(e.message); }
    const keys = Object.keys(grid);
    console.log(header("Prism Backtest", `sweep ${o.strategy} · ${sw.trials} combinations · ${Math.round(performance.now() - t0)} ms`));
    if (keys.length === 2) {
      const [a, b] = keys, va = grid[a], vb = grid[b], ch = "░▒▓█";
      const ok = sw.rows.filter((r) => r.ok), lo = Math.min(...ok.map((r) => r.m.sharpe)), hi = Math.max(...ok.map((r) => r.m.sharpe));
      console.log(c.dim(`  Sharpe heatmap: rows ${a}, columns ${b} (darker = higher)`));
      console.log("        " + vb.map((v) => String(v).padStart(4)).join(""));
      for (const x of va) console.log("  " + String(x).padStart(5) + " " + vb.map((y) => { const r = sw.rows.find((q) => q.params[a] === x && q.params[b] === y); if (!r?.ok) return c.dim("   ·"); const k = Math.round(((r.m.sharpe - lo) / (hi - lo || 1)) * 3); const s = "  " + ch[k].repeat(2); return r === sw.rows.find((q) => JSON.stringify(q.params) === JSON.stringify(sw.best.params)) ? c.yellow(s) : c.accent(s); }).join(""));
    }
    const top = sw.rows.filter((r) => r.ok).sort((x, y) => y.m.sharpe - x.m.sharpe).slice(0, 8);
    console.log("\n" + table(top.map((r) => [JSON.stringify(r.params), f2(r.m.sharpe), pct(r.m.cagr), pct(r.m.maxDD), String(r.m.trades)]), { head: ["params", "Sharpe", "CAGR", "max DD", "trades"], align: [, "right", "right", "right", "right"] }));
    console.log(`\n  best ${c.bold(JSON.stringify(sw.best.params))}: P(Sharpe>0) ${pct(sw.psr, 0)} → ${c.bold("deflated " + pct(sw.dsr, 0))} after ${sw.trials} trials`);
    console.log(c.dim("  The deflated Sharpe ratio asks whether the best result beats what the luckiest of N random strategies would show."));
  },
  walkforward() {
    const { d } = split(loadData()), o = options(), t0 = performance.now(); let wf;
    try { wf = walkForward(d, { ...o, grid: GRIDS[o.strategy], train: +flag("train", 504), test: +flag("test", 126) }); } catch (e) { fail(e.message); }
    console.log(header("Prism Backtest", `walk-forward ${o.strategy} · ${wf.folds.length} folds · ${Math.round(performance.now() - t0)} ms`));
    console.log(table(wf.folds.map((f, i) => [String(i + 1), f.train.join("→"), f.test.join("→"), JSON.stringify(f.params), f2(f.is.sharpe), tone(f.oos.sharpe)(f2(f.oos.sharpe)), pct(f.oos.total)]), { head: ["fold", "train", "test", "chosen", "IS Sharpe", "OOS Sharpe", "OOS ret"], align: [, , , , "right", "right", "right"] }));
    console.log(`\n  in-sample Sharpe ${f2(wf.isSharpe)} → out-of-sample ${c.bold(f2(wf.oos.sharpe))} · efficiency ${c.bold(pct(wf.efficiency, 0))} · OOS CAGR ${pct(wf.oos.cagr)} · max DD ${pct(wf.oos.maxDD)}`);
    console.log(c.dim("  Efficiency well below ~50% means the in-sample optimum was mostly fitting noise."));
  },
  montecarlo() {
    const { r, o } = runOne(), mc = monteCarlo(r, { runs: +flag("runs", 1000), block: +flag("block", 10), seed: +flag("seed", 6) });
    report(r, o);
    console.log("\n" + header("Monte Carlo", `${mc.runs} block-bootstrap paths · block ${mc.block} days`));
    console.log(table([["final multiple", ...mc.bands.map((p) => f2(mc.final[p]) + "×")], ["CAGR", ...mc.bands.map((p) => pct(mc.cagr[p]))], ["max drawdown", ...mc.bands.map((p) => pct(mc.maxDD[p]))]], { head: ["", ...mc.bands.map((p) => `p${Math.round(p * 100)}`)], align: [, "right", "right", "right", "right", "right"] }));
    console.log(`\n  P(loss) ${c.bold(pct(mc.pLoss))} · P(drawdown ≥ 20%) ${c.bold(pct(mc.pDD20))} · P(drawdown ≥ 30%) ${pct(mc.pDD30)}`);
  },
  costs() {
    const v = +flag("value", 100000), sch = flag("schedule", "india-delivery"), px = 1000, q = Math.round(v / px);
    if (!COSTS[sch]) fail(`unknown schedule (try: ${Object.keys(COSTS).join(", ")})`);
    const b = charges("buy", q, px, sch), s = charges("sell", q, px, sch);
    console.log(header("Prism Backtest", `${COSTS[sch].label}: round trip on ${inr(q * px)}`));
    const keys = [...new Set([...Object.keys(b.parts), ...Object.keys(s.parts)])];
    console.log(table([...keys.map((k) => [k, inr(b.parts[k] || 0), inr(s.parts[k] || 0)]), [c.bold("total"), c.bold(inr(b.total)), c.bold(inr(s.total))]], { head: ["charge", "buy", "sell"], align: [, "right", "right"] }));
    console.log(`\n  round trip ${c.bold(inr(b.total + s.total))} = ${c.bold(((b.total + s.total) / (q * px) * 1e4).toFixed(1) + " bps")} before slippage. A strategy needs to beat this on every trade.`);
    console.log(c.dim("  Rates approximate NSE schedules and change over time; check your broker's contract note."));
  },
  strategies() {
    console.log(header("Prism Backtest", "built-in strategies"));
    for (const s of strategyList()) { console.log(`\n  ${c.bold(s.name)} ${c.dim("· " + s.kind)}  ${s.label}\n  ${c.dim(s.desc)}`); for (const [k, p] of Object.entries(s.params)) console.log(`    --${k.padEnd(9)} ${String(p.v).padStart(5)}  ${c.dim(`${p.label} [${p.min}–${p.max}]`)}`); if (Object.keys(s.risk).length) console.log(c.dim(`    default risk: ${JSON.stringify(s.risk)}`)); }
  },
  data() {
    const out = flag("out", "data"), all = generate({ seed: +flag("seed", 6), years: +flag("years", 6) }); mkdirSync(out, { recursive: true });
    for (const [s, bars] of Object.entries(all)) writeFileSync(join(out, s + ".csv"), toCSV(bars));
    console.log(header("Prism Backtest", `wrote ${Object.keys(all).length} files × ${all.NIFTYX.length} bars to ${out}/`));
    console.log(c.dim("  Fictional tickers generated by a regime-switching factor model with jumps and one cointegrated pair (BANKX / FINX)."));
  },
  bench() {
    const years = +flag("years", 20), n = +flag("symbols", 8), syms = SYMBOLS.slice(0, n);
    const data = generate({ seed: 1, years, symbols: syms }), bars = Object.values(data).reduce((a, b) => a + b.length, 0);
    console.log(header("Prism Backtest", `bench · ${syms.length} symbols × ${data.NIFTYX.length} days = ${num(bars)} bars`));
    const rows = [];
    for (const s of ["buy-hold", "sma-cross", "rsi-revert", "bollinger", "donchian", "momentum"]) { const t0 = performance.now(); const r = backtest(data, { strategy: s }); const ms = performance.now() - t0; rows.push([s, num(ms, 0) + " ms", num(bars / ms * 1000, 0), String(r.trades.length), String(r.fills.length)]); }
    const pd = { BANKX: data.BANKX, FINX: data.FINX }, t0 = performance.now(), r = backtest(pd, { strategy: "pairs" }), ms = performance.now() - t0; rows.push(["pairs", num(ms, 0) + " ms", num(pd.BANKX.length * 2 / ms * 1000, 0), String(r.trades.length), String(r.fills.length)]);
    console.log(table(rows, { head: ["strategy", "time", "bars/s", "trades", "fills"], align: [, "right", "right", "right", "right"] }));
    const t1 = performance.now(), sw = sweep({ NIFTYX: data.NIFTYX }, { strategy: "sma-cross", grid: GRIDS["sma-cross"] });
    console.log(`\n  sweep: ${sw.trials} backtests over ${data.NIFTYX.length} bars in ${num(performance.now() - t1, 0)} ms`);
  },
  async serve() {
    const { createServer } = await import("../src/node/server.js"); const port = +flag("port", 8789);
    createServer().listen(port, () => console.log(header("Prism Backtest", `API on http://localhost:${port}`) + c.dim("\n  GET /v1/strategies · POST /v1/backtest · /v1/sweep · /v1/walkforward · /v1/montecarlo · GET /healthz")));
  },
  demo() {
    const step = (n, t) => console.log("\n" + c.accent(`[${n}/8] `) + c.bold(t));
    console.log(header("Prism Backtest", "demo · synthetic NSE-like market, seed 6, six years"));
    const all = generate({ seed: 6, years: 6 }), nx = { NIFTYX: all.NIFTYX }, base = { cash: 1_000_000, benchmark: "NIFTYX" };
    step(1, "A market with regimes");
    const m = new Market({ seed: 6 }), reg = {}; for (let i = 0; i < 1512; i++) { const x = m.next(); reg[x.regime] = (reg[x.regime] || 0) + 1; }
    console.log("  NIFTYX " + c.accent(spark(all.NIFTYX.filter((_, i) => i % 25 === 0).map((b) => b.c))) + `  ${f2(all.NIFTYX[0].c)} → ${f2(all.NIFTYX.at(-1).c)}`);
    console.log(c.dim("  days per regime: ") + Object.entries(reg).map(([k, v]) => `${k} ${v}`).join(" · "));
    step(2, "Trend following vs buy and hold");
    const rows = []; for (const s of ["buy-hold", "sma-cross", "donchian", "rsi-revert"]) { const r = backtest(nx, { ...base, strategy: s }), q = r.metrics; rows.push([s, pct(q.cagr), f2(q.sharpe), pct(q.maxDD), String(q.trades), inr(q.fees + q.slippage)]); }
    console.log(table(rows, { head: ["strategy", "CAGR", "Sharpe", "max DD", "trades", "costs"], align: [, "right", "right", "right", "right", "right"] }));
    step(3, "What a round trip really costs (NSE delivery, ₹1,00,000)");
    const b = charges("buy", 100, 1000), s = charges("sell", 100, 1000);
    console.log(`  buy ${inr(b.total)} (STT ${inr(b.parts.stt)}, stamp ${inr(b.parts.stamp)}) + sell ${inr(s.total)} (STT ${inr(s.parts.stt)}, DP ${inr(s.parts.dp)}) = ${c.bold(((b.total + s.total) / 10).toFixed(1) + " bps")}`);
    const fast = { strategy: "sma-cross", params: { fast: 3, slow: 10 } }, z = backtest(nx, { ...base, ...fast, costs: "zero", slippage: { model: "none" } }).metrics, w = backtest(nx, { ...base, ...fast }).metrics;
    console.log(`  a fast 3/10 crossover: Sharpe ${f2(z.sharpe)} without costs → ${c.bold(f2(w.sharpe))} with costs and slippage (${w.trades} trades)`);
    step(4, "Capacity: the same crossover on BANKX with ₹10 lakh vs ₹500 crore");
    const bk = { BANKX: all.BANKX }; let parts = 0;
    const cap = (cash, on) => { const r = backtest(bk, { strategy: "sma-cross", cash, on }), tv = r.fills.reduce((a, f) => a + f.qty * f.px, 0); return { m: r.metrics, bps: (r.metrics.slippage / tv) * 1e4 }; };
    const small = cap(1e6), big = cap(5e9, (e) => { if (e.type === "partial") parts++; });
    console.log(`  ₹10 L:   CAGR ${pct(small.m.cagr)}, Sharpe ${f2(small.m.sharpe)}, slippage ${small.bps.toFixed(1)} bps of traded value`);
    console.log(`  ₹500 Cr: CAGR ${c.bold(pct(big.m.cagr))}, Sharpe ${c.bold(f2(big.m.sharpe))}, slippage ${c.bold(big.bps.toFixed(1) + " bps")}, ${parts} fills capped at 10% of daily volume`);
    step(5, "Risk: a 15% drawdown kill switch");
    let halt = null; const k = backtest(nx, { ...base, strategy: "buy-hold", risk: { ddHalt: 0.15 }, on: (e) => { if (e.type === "halt") halt = e; } }), kb = backtest(nx, { ...base, strategy: "buy-hold" });
    console.log(halt ? `  halted on ${halt.d} at ${pct(halt.dd)}; max drawdown ${c.bold(pct(k.metrics.maxDD))} instead of ${pct(kb.metrics.maxDD)}` : "  not triggered");
    step(6, "Parameter sweep and the deflated Sharpe ratio");
    const sw = sweep(nx, { ...base, strategy: "sma-cross", grid: GRIDS["sma-cross"] });
    console.log(`  best of ${sw.trials}: ${JSON.stringify(sw.best.params)} Sharpe ${f2(sw.best.m.sharpe)} · P(Sharpe>0) ${pct(sw.psr, 0)} → deflated ${c.bold(pct(sw.dsr, 0))}`);
    step(7, "Walk-forward: optimise on 2 years, trade the next 6 months, roll");
    const wf = walkForward(nx, { ...base, strategy: "sma-cross", grid: GRIDS["sma-cross"] });
    console.log(`  ${wf.folds.length} folds · in-sample Sharpe ${f2(wf.isSharpe)} → out-of-sample ${c.bold(f2(wf.oos.sharpe))} (efficiency ${pct(wf.efficiency, 0)})`);
    console.log(c.dim("  chosen per fold: ") + wf.folds.map((f) => `${f.params.fast}/${f.params.slow}`).join(" "));
    step(8, "Monte Carlo: 1,000 bootstrap paths of the crossover");
    const mc = monteCarlo(backtest(nx, { ...base, strategy: "sma-cross" }), { runs: 1000 });
    console.log(`  final multiple p5 ${f2(mc.final[0.05])}× · p50 ${f2(mc.final[0.5])}× · p95 ${f2(mc.final[0.95])}× · max DD p95 ${pct(mc.maxDD[0.95])} · P(loss) ${pct(mc.pLoss)}`);
    console.log(c.dim("\n  Next: backtest run --strategy donchian --trades · backtest sweep · backtest serve"));
  },
};
const fn = cmds[cmd || "help"] || (cmd === "--help" || cmd === "-h" ? cmds.help : null);
if (!fn) fail(`unknown command ${cmd}\n\n${HELP}`);
await fn();
