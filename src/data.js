// Synthetic market data with regimes, jumps, factor correlation and a cointegrated pair,
// plus a strict OHLCV CSV loader for real data. All prices are rupees on a ₹0.05 tick.
import { rng } from "./lib/rng.js";

export const TICK = 0.05;
export const roundTick = (p, tick = TICK) => Math.max(tick, Math.round(Math.round(p / tick) * tick * 100) / 100);
const r2 = (x) => Math.round(x * 100) / 100;

/** Annualised drift / volatility of the market factor in each regime, and daily transition odds. */
export const REGIMES = {
  bull: { mu: 0.22, vol: 0.13, stay: 0.995, next: ["chop", "bear"] },
  chop: { mu: 0.0, vol: 0.11, stay: 0.99, next: ["bull", "bear"] },
  bear: { mu: -0.3, vol: 0.26, stay: 0.975, next: ["chop", "bull"] },
  crisis: { mu: -1.4, vol: 0.6, stay: 0.86, next: ["bear"] },
  rally: { mu: 0.9, vol: 0.2, stay: 0.93, next: ["bull"] },
};

/** Fictional tickers (no real-company data). beta to the market factor, idiosyncratic vol, alpha. */
export const UNIVERSE = [
  { sym: "NIFTYX", name: "Prism 50 index (synthetic)", s0: 22000, beta: 1, idio: 0.02, alpha: 0, adv: 2.2e6 },
  { sym: "KLPR", name: "Kolhapur Power", s0: 412, beta: 0.85, idio: 0.2, alpha: 0.03, adv: 1.8e6 },
  { sym: "BANKX", name: "Bharat Bank", s0: 1520, beta: 1.25, idio: 0.16, alpha: 0.01, adv: 3.1e6 },
  { sym: "FINX", name: "Deccan Finance", pairOf: "BANKX", ratio: 0.42, theta: 0.06, sd: 0.012, adv: 1.1e6 },
  { sym: "PHRMA", name: "Sahyadri Pharma", s0: 1180, beta: 0.55, idio: 0.22, alpha: 0.02, adv: 0.9e6 },
  { sym: "AUTOX", name: "Western Motors", s0: 865, beta: 1.15, idio: 0.24, alpha: 0, adv: 1.4e6 },
  { sym: "INFRA", name: "Konkan Infra", s0: 236, beta: 1.35, idio: 0.3, alpha: -0.02, adv: 2.6e6 },
  { sym: "GOLDB", name: "Gold BeES (synthetic)", s0: 62, beta: -0.15, idio: 0.12, alpha: 0.04, adv: 4e6 },
];
export const SYMBOLS = UNIVERSE.map((u) => u.sym);

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** Next NSE-style trading day (skips Saturday and Sunday). */
export function nextDay(d) { let ms = Date.parse(d + "T00:00:00Z") + 864e5; while ([0, 6].includes(new Date(ms).getUTCDay())) ms += 864e5; return isoDay(ms); }

export class Market {
  constructor({ seed = 7, symbols = SYMBOLS, start = "2019-01-01", regime = "bull" } = {}) {
    this.r = rng(seed); this.d = start; this.day = 0; this.regime = regime; this.regimeDays = 0; this._forced = null;
    this.specs = symbols.map((s) => { const u = UNIVERSE.find((x) => x.sym === s); if (!u) throw new Error(`unknown symbol ${s}`); return u; });
    for (const u of this.specs) if (u.pairOf && !symbols.includes(u.pairOf)) throw new Error(`${u.sym} needs ${u.pairOf} in the universe`);
    // One random stream per symbol, so a symbol's path does not depend on which other symbols are in the universe.
    const h = (str) => [...str].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) >>> 0, 2166136261);
    this.px = {}; this.spread = {}; this.rs = {}; for (const u of this.specs) { this.px[u.sym] = u.s0 ?? 0; this.spread[u.sym] = 0; this.rs[u.sym] = rng((seed * 2654435761) ^ h(u.sym)); }
    this.syms = symbols.slice();
  }
  /** Force a scenario: "crash" (gap down then crisis), "rally", "chop" or "bear". */
  shock(kind) {
    if (kind === "crash") { this._gap = -0.075; this.regime = "crisis"; }
    else if (kind === "rally") this.regime = "rally";
    else if (REGIMES[kind]) this.regime = kind;
    else throw new Error(`unknown shock ${kind}`);
    this.regimeDays = 0;
  }
  _regimeStep() {
    const g = REGIMES[this.regime]; this.regimeDays++;
    if (!this.r.chance(g.stay)) { this.regime = this.r.pick(g.next); this.regimeDays = 0; }
  }
  /** Advance one trading day. Returns { d, regime, bars: { SYM: {d,o,h,l,c,v} } } */
  next() {
    const r = this.r, g = REGIMES[this.regime], dt = 1 / 252;
    const fz = r.normal(), jump = r.chance(0.006) ? r.normal(-0.035, 0.02) : 0;
    let f = (g.mu - 0.5 * g.vol * g.vol) * dt + g.vol * Math.sqrt(dt) * fz + jump;
    const gap = this._gap || 0; this._gap = 0; f += gap;
    const bars = {}, rets = {};
    if (this.day > 0) this.d = nextDay(this.d);
    for (const u of this.specs) {
      if (u.pairOf) continue;
      const prev = this.px[u.sym], sig = u.idio;
      const R = this.rs[u.sym];
      const ret = u.beta * f + (u.alpha - 0.5 * sig * sig) * dt + sig * Math.sqrt(dt) * R.normal() + (R.chance(0.003) ? R.normal(0, 0.04) : 0);
      rets[u.sym] = ret;
      bars[u.sym] = this._bar(R, prev, ret, Math.abs(u.beta) * g.vol + sig, u.adv, gap * u.beta);
      this.px[u.sym] = bars[u.sym].c;
    }
    for (const u of this.specs) {
      if (!u.pairOf) continue;
      const base = bars[u.pairOf], s0 = this.spread[u.sym], r = this.rs[u.sym];
      const s1 = s0 - u.theta * s0 + u.sd * r.normal();
      this.spread[u.sym] = s1;
      const k0 = u.ratio * Math.exp(s0), k1 = u.ratio * Math.exp(s1);
      const o = roundTick(base.o * k0), c = roundTick(base.c * k1);
      const h = roundTick(Math.max(o, c, base.h * Math.max(k0, k1) * (1 + Math.abs(r.normal(0, 0.002)))));
      const l = roundTick(Math.min(o, c, base.l * Math.min(k0, k1) * (1 - Math.abs(r.normal(0, 0.002)))));
      bars[u.sym] = { d: this.d, o, h, l, c, v: Math.round(u.adv * Math.exp(r.normal(0, 0.3)) * (1 + 15 * Math.abs(Math.log(c / o)))) };
      this.px[u.sym] = c;
    }
    this.day++; const regime = this.regime; this._regimeStep();
    return { d: this.d, regime, bars };
  }
  _bar(r, prev, ret, vol, adv, gapPart) {
    // Split the day into an overnight gap and an intraday Brownian path (8 steps) for realistic highs and lows.
    const on = gapPart + ret * 0.25 + r.normal(0, 0.002), id = ret - on;
    const o = roundTick(prev * Math.exp(on)); let p = o, hi = o, lo = o; const sd = (vol / Math.sqrt(252)) * 0.55 / Math.sqrt(8);
    for (let k = 1; k <= 8; k++) { const left = 8 - k + 1; const drift = (Math.log(prev * Math.exp(ret) / p)) / left; p *= Math.exp(drift + (k < 8 ? r.normal(0, sd) : 0)); hi = Math.max(hi, p); lo = Math.min(lo, p); }
    const c = roundTick(prev * Math.exp(ret));
    return { d: this.d, o, h: roundTick(Math.max(hi, o, c)), l: roundTick(Math.min(lo, o, c)), c, v: Math.round(adv * Math.exp(r.normal(0, 0.3)) * (1 + 18 * Math.abs(ret))) };
  }
  /** Generate n days and return { SYM: bar[] } */
  take(n) { const out = Object.fromEntries(this.syms.map((s) => [s, []])); for (let i = 0; i < n; i++) { const { bars } = this.next(); for (const s of this.syms) out[s].push(bars[s]); } return out; }
}

/** Convenience: deterministic multi-year dataset. */
export function generate({ seed = 7, years = 5, symbols = SYMBOLS, start = "2019-01-01" } = {}) {
  return new Market({ seed, symbols, start }).take(Math.round(years * 252));
}

export class DataError extends Error { constructor(msg, line) { super(line ? `line ${line}: ${msg}` : msg); this.line = line; } }

/** Strict OHLCV CSV: date,open,high,low,close[,adj close],volume (any order, case-insensitive). Adjusts for splits/dividends when "adj close" is present. */
export function parseCSV(text) {
  const lines = String(text).replace(/\r/g, "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) throw new DataError("need a header and at least one row");
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/[_-]/g, " "));
  const idx = (names) => head.findIndex((h) => names.includes(h));
  const col = { d: idx(["date", "day", "timestamp", "time"]), o: idx(["open", "o"]), h: idx(["high", "h"]), l: idx(["low", "l"]), c: idx(["close", "c"]), a: idx(["adj close", "adjclose", "adjusted close"]), v: idx(["volume", "vol", "v"]) };
  for (const k of ["d", "o", "h", "l", "c"]) if (col[k] < 0) throw new DataError(`missing column ${({ d: "date", o: "open", h: "high", l: "low", c: "close" })[k]}`, 1);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",").map((x) => x.trim()), n = i + 1;
    const d = f[col.d]; if (!/^\d{4}-\d{2}-\d{2}/.test(d || "")) throw new DataError(`bad date "${d}" (use YYYY-MM-DD)`, n);
    const num = (k) => { const x = Number(f[col[k]]); if (!isFinite(x) || x <= 0) throw new DataError(`bad ${k === "v" ? "volume" : "price"} "${f[col[k]]}"`, n); return x; };
    let o = num("o"), h = num("h"), l = num("l"), c = num("c"); const v = col.v >= 0 && f[col.v] !== "" ? Number(f[col.v]) : 0;
    if (!isFinite(v) || v < 0) throw new DataError(`bad volume "${f[col.v]}"`, n);
    if (h < Math.max(o, c) - 1e-9 || l > Math.min(o, c) + 1e-9 || l > h) throw new DataError(`inconsistent bar (high ${h}, low ${l}, open ${o}, close ${c})`, n);
    if (col.a >= 0) { const a = num("a"), k = a / c; o *= k; h *= k; l *= k; c = a; }
    const bar = { d: d.slice(0, 10), o: r2(o), h: r2(h), l: r2(l), c: r2(c), v };
    if (out.length && bar.d <= out.at(-1).d) throw new DataError(`dates must be strictly increasing (${bar.d} after ${out.at(-1).d})`, n);
    out.push(bar);
  }
  return out;
}
export function toCSV(bars) { return "date,open,high,low,close,volume\n" + bars.map((b) => [b.d, b.o, b.h, b.l, b.c, b.v].join(",")).join("\n") + "\n"; }
