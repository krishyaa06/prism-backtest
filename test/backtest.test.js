import { test } from "node:test";
import assert from "node:assert/strict";
import { Backtest, backtest, sweep, walkForward, monteCarlo, GRIDS, generate, parseCSV, Market, charges, slip, stats, drawdowns, psr, dsr, ncdf, ninv, SMA, Stdev, RSI, Donchian, RollingOLS, ATR, sma, StrategyError, DataError, resolve, timeline } from "../src/index.js";
import { createServer } from "../src/node/server.js";

const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10);
const flat = (n, px = 100, v = 1e6) => Array.from({ length: n }, (_, i) => ({ d: day(i), o: px, h: px, l: px, c: px, v }));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const noCost = { costs: "zero", slippage: { model: "none" } };

test("streaming indicators match reference implementations", () => {
  const xs = Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / 7) + (i % 5));
  const s = new SMA(20), ref = sma(xs, 20); xs.forEach((x, i) => { const v = s.update(x); if (isNaN(ref[i])) assert.ok(isNaN(v)); else near(v, ref[i], 1e-9); });
  const sd = new Stdev(10); let last; for (const x of xs) last = sd.update(x); const w = xs.slice(-10), m = w.reduce((a, b) => a + b) / 10; near(last, Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 10), 1e-9);
  const r = new RSI(14); for (let i = 0; i < 30; i++) r.update(100 + i); assert.equal(r.v, 100, "only gains → RSI 100");
  const dc = new Donchian(3); const bars = [5, 7, 6, 9, 4].map((h) => ({ h, l: h - 1 }));
  const out = bars.map((b) => dc.update(b)); assert.ok(isNaN(out[2].up)); assert.equal(out[3].up, 7, "channel excludes the current bar"); assert.equal(out[4].up, 9);
  const ols = new RollingOLS(30); let v; for (let i = 0; i < 40; i++) v = ols.update(i, 2 * i + 1); near(v.beta, 2); near(v.alpha, 1); near(v.sd, 0);
  const a = new ATR(3); for (const b of [{ h: 10, l: 8, c: 9 }, { h: 11, l: 9, c: 10 }, { h: 12, l: 10, c: 11 }]) a.update(b); near(a.v, 2);
});

test("no look-ahead: a decision on bar i fills at bar i+1's open", () => {
  const bars = flat(10).map((b, i) => ({ ...b, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  const seen = [];
  const strat = { onBar(ctx) { seen.push(ctx.hist("X").length); if (ctx.i === 3) ctx.target("X", 1); } };
  const r = backtest({ X: bars }, { strategy: strat, ...noCost });
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "the strategy only ever sees bars up to today");
  assert.equal(r.fills[0].d, day(4)); assert.equal(r.fills[0].px, 104, "filled at the next open");
  const peek = backtest({ X: bars }, { strategy: { onBar(ctx) { if (ctx.i === 3) ctx.target("X", 1); } }, ...noCost, fill: "close" });
  assert.equal(peek.fills[0].d, day(3)); assert.equal(peek.fills[0].px, 103.5, "fill: close uses the same bar (look-ahead, opt-in)");
});

test("NSE delivery charges for a ₹1,00,000 round trip", () => {
  const b = charges("buy", 100, 1000), s = charges("sell", 100, 1000);
  assert.equal(b.parts.stt, 100); assert.equal(b.parts.stamp, 15); assert.equal(b.parts.txn, 2.97); assert.equal(b.parts.sebi, 0.1); assert.equal(b.parts.gst, 0.55);
  assert.equal(b.total, 118.62); assert.equal(s.parts.stamp, 0); assert.equal(s.parts.dp, 15.93); assert.equal(s.total, 119.55);
  const intr = charges("buy", 1000, 500, "india-intraday"); assert.equal(intr.parts.brokerage, 20, "intraday brokerage capped at ₹20");
  assert.equal(slip("buy", 100, 100, { model: "bps", bps: 10 }).px, 100.1); assert.ok(slip("buy", 1e5, 100, { model: "sqrt", k: 1, spreadBps: 0 }, { vol: 0.02, volume: 1e6 }).bps > 60, "square-root impact grows with size");
});

test("accounting identity: equity = cash₀ + closed P&L + open P&L, with shorts, costs and slippage", () => {
  const data = generate({ seed: 3, years: 3, symbols: ["BANKX", "FINX"] });
  const r = backtest(data, { strategy: "pairs" });
  assert.ok(r.trades.length > 10); assert.ok(r.trades.some((t) => t.side === "short"));
  const closed = r.trades.reduce((a, t) => a + t.pnl, 0), open = r.open.reduce((a, p) => a + p.upnl, 0);
  near(r.equity.at(-1), 1_000_000 + closed + open, 0.01 * r.trades.length + 1);
  assert.ok(r.metrics.fees > 0 && r.metrics.slippage > 0);
});

test("stops: intrabar at the stop price, gaps at the open, then sit out until the next signal", () => {
  const bars = flat(9).map((b, i) => (i === 4 ? { ...b, o: 99, h: 99.5, l: 94, c: 95 } : i === 7 ? { ...b, o: 90, h: 91, l: 89, c: 90 } : b));
  const evs = [];
  const r = backtest({ X: bars }, { strategy: { onBar(ctx) { if (ctx.i === 1 || ctx.i === 5) ctx.target("X", 1); } }, ...noCost, risk: { stopLoss: 0.03 }, on: (e) => evs.push(e) });
  const stops = evs.filter((e) => e.type === "stop");
  assert.equal(stops.length, 2); assert.equal(stops[0].px, 97, "intrabar stop fills at the stop"); assert.equal(stops[0].gap, false);
  assert.equal(stops[1].px, 90, "gap through the stop fills at the open"); assert.equal(stops[1].gap, true);
  assert.equal(r.trades[1].exitTag, "stop (gap)");
});

test("participation cap creates partial fills; state-based strategies finish over following days", () => {
  const bars = flat(10, 100, 1000), evs = [];
  const r = backtest({ X: bars }, { strategy: { onBar(ctx) { ctx.target("X", 1); } }, ...noCost, maxVolPct: 0.1, on: (e) => evs.push(e) });
  assert.ok(evs.filter((e) => e.type === "partial").length >= 5);
  assert.ok(r.fills.every((f) => f.qty <= 100), "never more than 10% of the bar's volume");
});

test("risk: short selling disabled, position limit and the drawdown kill switch", () => {
  const evs = [], bars = flat(5);
  backtest({ X: bars }, { strategy: { onBar(ctx) { if (ctx.i === 1) ctx.target("X", -0.5); if (ctx.i === 2) ctx.target("X", 3); } }, ...noCost, risk: { maxPos: 0.4 }, on: (e) => evs.push(e) });
  assert.ok(evs.some((e) => e.type === "reject" && /short/.test(e.reason)));
  assert.ok(evs.some((e) => e.type === "clamp" && /position limit/.test(e.reason)));
  const crash = flat(20).map((b, i) => { const p = i < 5 ? 100 : 100 - (i - 4) * 4; return { ...b, o: p, h: p, l: p, c: p }; });
  let halt = null; const r = backtest({ X: crash }, { strategy: "buy-hold", ...noCost, risk: { ddHalt: 0.2 }, on: (e) => { if (e.type === "halt") halt = e; } });
  assert.ok(halt && halt.dd <= -0.2); assert.equal(r.metrics.halted, true); assert.equal(r.open.length, 0, "liquidated");
  assert.equal(r.trades.at(-1).exitTag, "kill-switch");
});

test("metrics on known curves", () => {
  const dd = drawdowns([100, 120, 90, 95, 130]); near(dd.max, 0.25);
  const eq = [100]; for (let i = 0; i < 252; i++) eq.push(eq.at(-1) * Math.pow(2, 1 / 252));
  const m = stats(eq); near(m.cagr, 1, 1e-6); assert.equal(m.maxDD, 0); assert.equal(m.sharpe, 0, "zero volatility → Sharpe reported as 0");
  for (const p of [0.01, 0.2, 0.5, 0.9, 0.999]) near(ncdf(ninv(p)), p, 2e-7);
  const rets = Array.from({ length: 500 }, (_, i) => 0.0005 + 0.01 * Math.sin(i * 1.7));
  assert.ok(psr(rets) > 0.5); assert.ok(dsr(rets, 200) < psr(rets), "deflating for 200 trials lowers confidence");
});

test("sweep flags invalid combinations; walk-forward never tests on training data", () => {
  const data = { NIFTYX: generate({ seed: 6, years: 4, symbols: ["NIFTYX"] }).NIFTYX };
  const sw = sweep(data, { strategy: "sma-cross", grid: { fast: [10, 50], slow: [20, 50] } });
  assert.equal(sw.rows.filter((r) => !r.ok).length, 2, "fast >= slow is rejected, not silently run"); assert.equal(sw.trials, 2);
  const wf = walkForward(data, { strategy: "sma-cross", grid: GRIDS["sma-cross"], train: 252, test: 126 });
  assert.ok(wf.folds.length >= 5);
  for (const f of wf.folds) assert.ok(f.test[0] > f.train[1], "test starts after training ends");
  for (let i = 1; i < wf.folds.length; i++) assert.ok(wf.folds[i].test[0] > wf.folds[i - 1].test[1], "test windows do not overlap");
  for (let i = 1; i < wf.dates.length; i++) assert.ok(wf.dates[i] > wf.dates[i - 1]);
  assert.equal(wf.equity.length, wf.dates.length);
  const mc = monteCarlo(backtest(data, { strategy: "sma-cross" }), { runs: 200 }); assert.ok(mc.final[0.05] <= mc.final[0.5] && mc.final[0.5] <= mc.final[0.95]);
});

test("strategy validation", () => {
  assert.throws(() => resolve("nope"), StrategyError);
  assert.throws(() => resolve("sma-cross", { fast: 60, slow: 50 }), /shorter/);
  assert.throws(() => resolve("sma-cross", { fats: 5 }), /unknown parameter/);
  assert.throws(() => resolve("rsi-revert", { period: 99 }), /between/);
  assert.equal(resolve("donchian").params.entry, 55);
});

test("CSV loader: strict validation with line numbers, split adjustment", () => {
  const ok = parseCSV("Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-01,100,110,95,105,52.5,1000\n2024-01-02,105,108,100,106,53,900\n");
  assert.equal(ok.length, 2); assert.equal(ok[0].c, 52.5); assert.equal(ok[0].h, 55, "OHLC scaled by adj close / close");
  assert.throws(() => parseCSV("date,open,high,low,close\n2024-01-01,100,99,95,105\n"), (e) => e instanceof DataError && e.line === 2 && /inconsistent/.test(e.message));
  assert.throws(() => parseCSV("date,open,high,low,close\n2024-01-02,1,1,1,1\n2024-01-01,1,1,1,1\n"), /increasing/);
  assert.throws(() => parseCSV("date,open,high,low\n2024-01-01,1,1,1\n"), /missing column close/);
});

test("synthetic market: deterministic, symbol paths independent of the universe, a mean-reverting pair", () => {
  const a = generate({ seed: 9, years: 1 }), b = generate({ seed: 9, years: 1 }), c = generate({ seed: 9, years: 1, symbols: ["NIFTYX", "KLPR"] });
  assert.deepEqual(a.KLPR, b.KLPR); assert.deepEqual(a.KLPR, c.KLPR, "same seed, same KLPR path, whatever else is generated");
  for (const bar of a.AUTOX) { assert.ok(bar.h >= Math.max(bar.o, bar.c) && bar.l <= Math.min(bar.o, bar.c) && bar.v > 0); assert.equal(Math.round(bar.c * 20), bar.c * 20, "₹0.05 tick"); }
  const ols = new RollingOLS(200); let v; for (let i = 0; i < a.BANKX.length; i++) v = ols.update(Math.log(a.BANKX[i].c), Math.log(a.FINX[i].c));
  assert.ok(v.sd < 0.06 && Math.abs(v.beta - 1) < 0.3, "FINX tracks BANKX with a stationary spread");
  const m = new Market({ seed: 1 }); m.shock("crash"); const x = m.next(); assert.equal(x.regime, "crisis"); assert.ok(x.bars.NIFTYX.o < 22000 * 0.95, "crash gaps down at the open");
  assert.ok(timeline(a).length === a.NIFTYX.length);
});

test("HTTP API", async () => {
  const srv = createServer().listen(0); const port = srv.address().port, u = (p) => `http://127.0.0.1:${port}${p}`;
  const post = (p, b) => fetch(u(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    const s = await (await fetch(u("/v1/strategies"))).json(); assert.ok(s.strategies.length >= 7);
    const r = await post("/v1/backtest", { strategy: "donchian", years: 3, seed: 2 }); assert.equal(r.status, 200); const j = await r.json(); assert.ok(j.metrics.trades >= 1 && j.equity.length > 10);
    const csv = "date,open,high,low,close,volume\n" + flat(80).map((b, i) => `${b.d},${100 + i},${101 + i},${99 + i},${100 + i},1000000`).join("\n");
    const c = await (await post("/v1/backtest", { strategy: "buy-hold", csv: { ABC: csv }, costs: "zero" })).json(); assert.ok(c.metrics.total > 0.5);
    assert.equal((await post("/v1/backtest", { strategy: "sma-cross", params: { fast: 90, slow: 20 } })).status, 400);
    assert.equal((await post("/v1/backtest", { csv: { X: "date,open\n" } })).status, 400);
    const mc = await (await post("/v1/montecarlo", { runs: 100, years: 2 })).json(); assert.ok(mc.final["0.5"] > 0);
  } finally { srv.close(); }
});
