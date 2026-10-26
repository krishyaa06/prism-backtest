// Event-driven backtester. Bars arrive one at a time (feed), so a strategy can only ever see the past.
// Orders decided on bar i fill at bar i+1's open (or, with fill:"close", at bar i's close, a deliberate look-ahead bias for comparison).
import { charges, slip } from "./costs.js";
import { stats, monthly, drawdowns } from "./metrics.js";
import { Stdev } from "./indicators.js";
import { resolve } from "./strategies.js";

export const DEFAULT_RISK = { maxPos: 1, maxGross: 1, allowShort: false, stopLoss: 0, trail: 0, ddHalt: 0, band: 0.1 };
export class BacktestError extends Error {}

export class Backtest {
  constructor({ strategy = "sma-cross", params = {}, cash = 1_000_000, costs = "india-delivery", slippage = { model: "sqrt", k: 0.6, spreadBps: 2 }, fill = "next-open", maxVolPct = 0.1, risk = {}, benchmark = null, rf = 0, cashRate = 0, startAt = null, borrowBps = 300, lot = 1 } = {}) {
    if (!(cash > 0)) throw new BacktestError("cash must be positive");
    if (!["next-open", "close"].includes(fill)) throw new BacktestError(`fill must be "next-open" or "close"`);
    this.strat = resolve(strategy, params); this.params = this.strat.params;
    Object.assign(this, { cash0: cash, cash, cashRate, costs, slippage, fill, maxVolPct, benchmark, rf, startAt, borrowBps, lot });
    this.risk = { ...DEFAULT_RISK, ...this.strat.risk, ...risk };
    this.S = new Map(); this.i = -1; this.d = null; this.pending = []; this.fills = []; this.trades = []; this.listeners = [];
    this.dates = []; this.eq = []; this.bench = []; this.gross = []; this.peak = cash; this.halted = false; this.started = !startAt;
    this.totalCosts = 0; this.slipCost = 0; this.turnover = 0; this.exposed = 0; this.benchUnits = 0; this.rejects = 0; this._inited = false;
    this.state = {}; this._targets = new Map(); this._orders = [];
    const E = this;
    this.ctx = {
      get i() { return E.i; }, get d() { return E.d; }, get equity() { return E.equity; }, get cash() { return E.cash; }, get syms() { return [...E.S.keys()]; }, get canShort() { return E.risk.allowShort; },
      params: this.params, state: this.state,
      bar: (s) => E._s(s).last, close: (s, k = 0) => { const b = E._s(s).bars; return b[b.length - 1 - k]?.c ?? NaN; },
      hist: (s, n = Infinity) => { const b = E._s(s).bars; return n >= b.length ? b.slice() : b.slice(b.length - n); },
      pos: (s) => E._s(s).pos, stops: (s) => E._s(s).stops || 0, weight: (s) => { const x = E._s(s); return E.equity > 0 && x.last ? (x.pos * x.last.c) / E.equity : 0; },
      target: (s, w, o = {}) => { if (!isFinite(w)) throw new BacktestError(`target weight for ${s} must be finite`); E._targets.set(s, { w, ...o }); },
      flat: (s, tag = "exit") => E._targets.set(s, { w: 0, tag }),
      order: (s, qty, o = {}) => { if (!Number.isInteger(qty) || qty === 0) throw new BacktestError("order qty must be a non-zero integer"); E._orders.push({ sym: s, qty, ...o }); },
      note: (s, text, kind = "info") => E.emit({ type: "signal", sym: s, text, kind }),
    };
  }
  on(fn) { this.listeners.push(fn); return () => (this.listeners = this.listeners.filter((f) => f !== fn)); }
  emit(ev) { ev.d ??= this.d; ev.i ??= this.i; for (const f of this.listeners) f(ev); }
  _s(sym) { const x = this.S.get(sym); if (!x) throw new BacktestError(`unknown symbol ${sym}`); return x; }
  _sym(sym) { let x = this.S.get(sym); if (!x) { x = { sym, bars: [], last: null, pos: 0, stop: null, ep: null, vol: new Stdev(20), volV: 0.02, pend: 0 }; this.S.set(sym, x); } return x; }
  get equity() { let e = this.cash; for (const x of this.S.values()) if (x.pos && x.last) e += x.pos * x.last.c; return e; }

  /** Process one date. bars: { SYM: {o,h,l,c,v} }. Symbols missing on a date carry their last close. */
  feed(d, bars) {
    if (this.d && d <= this.d) throw new BacktestError(`dates must increase (${d} after ${this.d})`);
    this.i++; this.d = d;
    for (const [s, b] of Object.entries(bars)) {
      if (!(b.o > 0 && b.h >= b.l && b.c > 0)) throw new BacktestError(`bad bar for ${s} on ${d}`);
      const x = this._sym(s), bar = { d, ...b };
      if (x.last) { x.vol.update(Math.log(b.c / x.last.c)); if (!isNaN(x.vol.v)) x.volV = x.vol.v; }
      x.bars.push(bar); x.last = bar; x.today = bar;
    }
    for (const x of this.S.values()) if (x.last?.d !== d) x.today = null;
    if (!this._inited) { this._inited = true; this.strat.init?.(this.ctx); }
    if (!this.started && d >= this.startAt) { this.started = true; this.peak = this.equity; }

    // 1. pending orders at today's open
    if (this.pending.length) { const q = this.pending; this.pending = []; for (const o of q) this._execOpen(o); }
    // 2. protective stops (gap-aware)
    for (const x of this.S.values()) this._checkStop(x);
    // 3. mark to market, carry costs (cash interest, short borrow), trailing stops, excursions
    if (this.cashRate && this.cash > 0 && this.started) this.cash *= Math.pow(1 + this.cashRate, 1 / 252);
    for (const x of this.S.values()) {
      if (!x.pos || !x.today) continue; const b = x.today, ep = x.ep;
      if (x.pos < 0) { const fee = (Math.abs(x.pos) * b.c * this.borrowBps) / 1e4 / 252; this.cash -= fee; this.totalCosts += fee; if (ep) ep.cash -= fee; }
      if (ep) { const e = ep.entryN / ep.entryQ; if (x.pos > 0) { ep.mae = Math.min(ep.mae, b.l / e - 1); ep.mfe = Math.max(ep.mfe, b.h / e - 1); } else { ep.mae = Math.min(ep.mae, e / b.h - 1); ep.mfe = Math.max(ep.mfe, e / b.l - 1); } }
      if (this.risk.trail > 0 && x.stop != null) x.stop = x.pos > 0 ? Math.max(x.stop, b.c * (1 - this.risk.trail)) : Math.min(x.stop, b.c * (1 + this.risk.trail));
    }
    // 4. strategy decision on today's close
    this._targets.clear(); this._orders = [];
    this.strat.onBar(this.ctx);
    if (this.started && !this.halted) this._route();
    if (this.fill === "close" && this.pending.length) { const q = this.pending; this.pending = []; for (const o of q) this._exec(o, this._s(o.sym).today?.c ?? this._s(o.sym).last.c, this._s(o.sym).last); }
    // 5. record
    const eq = this.equity;
    if (this.started) {
      if (this.benchmark && !this.benchUnits && this.S.get(this.benchmark)?.last) this.benchUnits = this.cash0 / this.S.get(this.benchmark).last.c;
      this.dates.push(d); this.eq.push(eq); this.bench.push(this.benchUnits ? this.benchUnits * this.S.get(this.benchmark).last.c : this.cash0);
      let g = 0; for (const x of this.S.values()) if (x.pos && x.last) g += Math.abs(x.pos * x.last.c); this.gross.push(eq > 0 ? g / eq : 0); if (g > 0) this.exposed++;
      this.peak = Math.max(this.peak, eq);
      if (this.risk.ddHalt > 0 && !this.halted && eq / this.peak - 1 <= -this.risk.ddHalt) {
        this.halted = true; this.pending = [];
        for (const x of this.S.values()) { x.pend = 0; if (x.pos) this._queue({ sym: x.sym, qty: -x.pos, tag: "kill-switch" }); }
        this.emit({ type: "halt", dd: eq / this.peak - 1, equity: eq });
      }
    }
    return eq;
  }

  _route() {
    const eq = this.equity; if (eq <= 0) return;
    const R = this.risk, want = new Map();
    for (const [s, t] of this._targets) {
      let w = t.w; const x = this._s(s);
      if (!x.last) continue;
      if (w < 0 && !R.allowShort) { if (x.pos >= 0) { this.rejects++; this.emit({ type: "reject", sym: s, reason: "short selling disabled", w }); } w = 0; }
      if (Math.abs(w) > R.maxPos) { this.emit({ type: "clamp", sym: s, reason: `position limit ${Math.round(R.maxPos * 100)}%`, w }); w = Math.sign(w) * R.maxPos; }
      want.set(s, { ...t, w });
    }
    // gross exposure cap: scale requested weights down together
    let g = 0; for (const x of this.S.values()) { if (want.has(x.sym)) g += Math.abs(want.get(x.sym).w); else if (x.pos && x.last) g += Math.abs((x.pos * x.last.c) / eq); }
    if (g > R.maxGross + 1e-9) { let fixed = g; for (const t of want.values()) fixed -= Math.abs(t.w); const k = Math.max(0, R.maxGross - fixed) / Math.max(1e-12, g - fixed); for (const t of want.values()) t.w *= k; this.emit({ type: "clamp", reason: `gross limit ${R.maxGross}×`, scale: k }); }
    for (const [s, t] of want) {
      const x = this._s(s), px = x.last.c, lot = this.lot;
      // Budget for buying costs so a 100% target does not overdraw cash.
      const desired = Math.trunc((t.w * eq * 0.995) / px / lot) * lot;
      const delta = desired - x.pos - x.pend;
      if (delta === 0) continue;
      if (desired !== 0 && x.pos !== 0 && Math.sign(desired) === Math.sign(x.pos) && Math.abs(delta) < Math.abs(desired) * R.band) continue; // rebalance band
      this._queue({ sym: s, qty: delta, tag: t.tag || (desired === 0 ? "exit" : x.pos === 0 ? "entry" : "rebalance"), stop: t.stop });
    }
    for (const o of this._orders) { if (o.qty < 0 && this._s(o.sym).pos + o.qty < 0 && !R.allowShort) { this.rejects++; this.emit({ type: "reject", sym: o.sym, reason: "short selling disabled" }); continue; } this._queue(o); }
  }
  _queue(o) { this.pending.push(o); this._s(o.sym).pend += o.qty; }

  _execOpen(o) {
    const x = this._s(o.sym); x.pend -= o.qty; const b = x.today;
    if (!b) { this.emit({ type: "cancel", sym: o.sym, reason: "no bar (holiday or halt)" }); return; }
    let px = b.o;
    if (o.limit != null) { if (o.qty > 0 ? b.l > o.limit : b.h < o.limit) { this.emit({ type: "cancel", sym: o.sym, reason: `limit ${o.limit} not reached` }); return; } px = o.qty > 0 ? Math.min(b.o, o.limit) : Math.max(b.o, o.limit); }
    this._exec(o, px, b);
  }
  _exec(o, base, b) {
    const x = this._s(o.sym); let qty = o.qty;
    if (this.fill === "close") x.pend -= o.qty;
    const cap = Math.floor(this.maxVolPct * (b.v || Infinity));
    if (o.tag !== "kill-switch" && o.tag !== "stop" && Math.abs(qty) > cap) { this.emit({ type: "partial", sym: o.sym, want: qty, got: Math.sign(qty) * cap, reason: `${Math.round(this.maxVolPct * 100)}% of volume` }); qty = Math.sign(qty) * cap; if (!qty) return; }
    if (x.pos !== 0 && Math.sign(x.pos + qty) === -Math.sign(x.pos)) { const close = -x.pos; this._fill(x, { ...o, qty: close }, base, b); this._fill(x, { ...o, qty: qty - close }, base, b); }
    else this._fill(x, { ...o, qty }, base, b);
  }
  _fill(x, o, base, b) {
    const side = o.qty > 0 ? "buy" : "sell", q = Math.abs(o.qty);
    const { px, bps } = slip(side, q, base, this.slippage, { vol: x.volV, volume: b.v || 1e9 });
    const fee = charges(side, q, px, this.costs).total, flow = -o.qty * px - fee;
    this.cash += flow; this.totalCosts += fee; this.slipCost += q * Math.abs(px - base); this.turnover += q * px;
    const prev = x.pos; x.pos += o.qty;
    if (prev === 0) { x.ep = { side: o.qty > 0 ? "long" : "short", entryD: this.d, entryI: this.i, entryN: q * px, entryQ: q, exitN: 0, exitQ: 0, cash: flow, fees: fee, mae: 0, mfe: 0, tag: o.tag }; this._setStop(x, px, o); }
    else if (Math.sign(o.qty) === Math.sign(prev)) { x.ep.entryN += q * px; x.ep.entryQ += q; x.ep.cash += flow; x.ep.fees += fee; if (o.stop != null) x.stop = o.stop; }
    else { x.ep.exitN += q * px; x.ep.exitQ += q; x.ep.cash += flow; x.ep.fees += fee; }
    const f = { d: this.d, i: this.i, sym: x.sym, side, qty: q, px, base, fee, slipBps: bps, tag: o.tag || "" };
    this.fills.push(f); this.emit({ type: "fill", ...f, pos: x.pos });
    if (x.pos === 0) {
      const ep = x.ep, t = { sym: x.sym, side: ep.side, entryD: ep.entryD, exitD: this.d, bars: this.i - ep.entryI, qty: ep.entryQ, entry: ep.entryN / ep.entryQ, exit: ep.exitN / ep.exitQ, pnl: Math.round(ep.cash * 100) / 100, ret: ep.cash / ep.entryN, fees: ep.fees, mae: ep.mae, mfe: ep.mfe, exitTag: o.tag || "" };
      this.trades.push(t); x.ep = null; x.stop = null; this.emit({ type: "trade", ...t });
    }
  }
  _setStop(x, px, o) {
    if (o.stop != null) x.stop = o.stop;
    else if (this.risk.stopLoss > 0) x.stop = x.pos > 0 ? px * (1 - this.risk.stopLoss) : px * (1 + this.risk.stopLoss);
    else if (this.risk.trail > 0) x.stop = x.pos > 0 ? px * (1 - this.risk.trail) : px * (1 + this.risk.trail);
    else x.stop = null;
  }
  _checkStop(x) {
    const b = x.today; if (!x.pos || x.stop == null || !b) return;
    const long = x.pos > 0, hit = long ? b.l <= x.stop : b.h >= x.stop; if (!hit) return;
    const gap = long ? b.o <= x.stop : b.o >= x.stop, px = gap ? b.o : x.stop, stop = x.stop;
    this.pending = this.pending.filter((o) => { if (o.sym === x.sym) { x.pend -= o.qty; return false; } return true; });
    x.stops = (x.stops || 0) + 1; this.emit({ type: "stop", sym: x.sym, stop, px, gap });
    this._fill(x, { sym: x.sym, qty: -x.pos, tag: gap ? "stop (gap)" : "stop" }, px, b);
  }

  /** Clear the kill switch and reset the drawdown peak. */
  resume() { this.halted = false; this.peak = this.equity; this.emit({ type: "resume" }); }
  /** Summary of everything so far. */
  result() {
    const open = [...this.S.values()].filter((x) => x.pos).map((x) => ({ sym: x.sym, qty: x.pos, side: x.pos > 0 ? "long" : "short", entry: x.ep ? x.ep.entryN / x.ep.entryQ : NaN, mark: x.last.c, upnl: x.ep ? x.ep.cash + x.pos * x.last.c : 0, stop: x.stop }));
    const avgEq = this.eq.length ? this.eq.reduce((a, b) => a + b, 0) / this.eq.length : this.cash0;
    const m = stats(this.eq, { trades: this.trades, bench: this.benchmark ? this.bench : null, rf: this.rf, costs: this.totalCosts + this.slipCost, turnover: this.eq.length > 1 ? (this.turnover / avgEq) * (252 / this.eq.length) : 0, exposure: this.eq.length ? this.exposed / this.eq.length : 0 });
    m.fees = this.totalCosts; m.slippage = this.slipCost; m.rejects = this.rejects; m.halted = this.halted;
    return { strategy: this.strat.name, params: this.params, dates: this.dates, equity: this.eq, bench: this.benchmark ? this.bench : null, gross: this.gross, dd: drawdowns(this.eq).dd, trades: this.trades, fills: this.fills, open, metrics: m, monthly: monthly(this.dates, this.eq) };
  }
}

/** Align { SYM: bar[] } by date into [{ d, bars }] */
export function timeline(data) {
  const by = new Map();
  for (const [s, bars] of Object.entries(data)) for (const b of bars) { let m = by.get(b.d); if (!m) by.set(b.d, (m = {})); m[s] = b; }
  return [...by.keys()].sort().map((d) => ({ d, bars: by.get(d) }));
}
/** Run a whole backtest over static data. */
export function backtest(data, opts = {}) {
  const bt = new Backtest(opts); if (opts.on) bt.on(opts.on);
  for (const { d, bars } of timeline(data)) { if (opts.endAt && d > opts.endAt) break; bt.feed(d, bars); }
  return bt.result();
}
