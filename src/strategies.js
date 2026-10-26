// Built-in strategies. Each is { name, label, desc, kind, params: {key: {v, min, max, step, label}}, risk?, create(p) -> { init?, onBar(ctx) } }.
// A strategy expresses intent with ctx.target(sym, weight, {stop}) / ctx.flat(sym); the engine sizes, risk-checks and fills it.
import { SMA, RSI, ATR, Bollinger, Donchian, ROC, RollingOLS } from "./indicators.js";

export class StrategyError extends Error {}
const each = (ctx, fn) => { const s = ctx.syms; for (const sym of s) if (ctx.bar(sym)?.d === ctx.d) fn(sym, 1 / s.length); };
const per = (map, sym, mk) => { let v = map.get(sym); if (!v) map.set(sym, (v = mk())); return v; };

export const STRATEGIES = {
  "sma-cross": {
    label: "Moving-average crossover", kind: "trend",
    desc: "Long while the fast SMA is above the slow SMA (short below it when shorting is allowed).",
    params: { fast: { v: 20, min: 3, max: 100, step: 1, label: "fast SMA" }, slow: { v: 50, min: 10, max: 250, step: 5, label: "slow SMA" } },
    check: (p) => { if (p.fast >= p.slow) throw new StrategyError("fast must be shorter than slow"); },
    create(p) {
      const st = new Map();
      return {
        onBar(ctx) {
          each(ctx, (sym, w) => {
            const s = per(st, sym, () => ({ f: new SMA(p.fast), s: new SMA(p.slow), side: 0 })), c = ctx.close(sym);
            const f = s.f.update(c), sl = s.s.update(c); s.v = { fast: f, slow: sl }; if (isNaN(sl)) return;
            const side = f > sl ? 1 : -1;
            if (ctx.stops(sym) !== (s.seen || 0)) { s.seen = ctx.stops(sym); s.stop = true; } // stopped out: sit out until the next cross
            if (side !== s.side) { s.side = side; s.stop = false; ctx.note(sym, side > 0 ? `golden cross ${f.toFixed(1)} > ${sl.toFixed(1)}` : `death cross ${f.toFixed(1)} < ${sl.toFixed(1)}`, side > 0 ? "buy" : "sell"); }
            // State-based: re-asserting the target every bar keeps the position right after warm-up, halts or partial fills.
            ctx.target(sym, s.stop ? 0 : side > 0 ? w : ctx.canShort ? -w : 0);
          });
        },
        overlay: (sym) => { const s = st.get(sym); return s ? [{ k: "fast", v: s.v?.fast }, { k: "slow", v: s.v?.slow }] : []; },
      };
    },
  },
  "rsi-revert": {
    label: "RSI mean reversion", kind: "mean-reversion",
    desc: "Buy oversold dips (RSI below the entry level) only above the long-term trend; sell when RSI recovers.",
    params: { period: { v: 3, min: 2, max: 30, step: 1, label: "RSI period" }, buy: { v: 15, min: 5, max: 45, step: 1, label: "buy below" }, exit: { v: 60, min: 40, max: 90, step: 1, label: "sell above" }, trend: { v: 200, min: 0, max: 300, step: 10, label: "trend SMA (0 = off)" } },
    risk: { stopLoss: 0.08 },
    check: (p) => { if (p.buy >= p.exit) throw new StrategyError("buy level must be below the exit level"); },
    create(p) {
      const st = new Map();
      return {
        onBar(ctx) {
          each(ctx, (sym, w) => {
            const s = per(st, sym, () => ({ r: new RSI(p.period), t: p.trend ? new SMA(p.trend) : null, in: false })), c = ctx.close(sym);
            const r = s.r.update(c), t = s.t ? s.t.update(c) : -Infinity; s.v = { rsi: r, trend: s.t ? t : NaN }; if (isNaN(r) || isNaN(t)) return;
            if (ctx.pos(sym) === 0) s.in = false;
            if (!s.in && r < p.buy && c > t) { s.in = true; ctx.note(sym, `RSI ${r.toFixed(1)} < ${p.buy}, above trend`, "buy"); ctx.target(sym, w); }
            else if (s.in && r > p.exit) { s.in = false; ctx.note(sym, `RSI ${r.toFixed(1)} > ${p.exit}`, "sell"); ctx.flat(sym); }
          });
        },
        overlay: (sym) => { const s = st.get(sym); return s?.t ? [{ k: "trend", v: s.v?.trend }] : []; },
        osc: (sym) => { const s = st.get(sym); return s ? { v: s.v?.rsi, lo: p.buy, hi: p.exit, max: 100, label: "RSI" } : null; },
      };
    },
  },
  "bollinger": {
    label: "Bollinger band reversion", kind: "mean-reversion",
    desc: "Buy a close below the lower band, exit at the middle band; short above the upper band when shorting is allowed.",
    params: { n: { v: 20, min: 5, max: 100, step: 1, label: "window" }, k: { v: 2, min: 0.5, max: 4, step: 0.1, label: "band width σ" } },
    risk: { stopLoss: 0.06 },
    create(p) {
      const st = new Map();
      return {
        onBar(ctx) {
          each(ctx, (sym, w) => {
            const s = per(st, sym, () => ({ b: new Bollinger(p.n, p.k) })), c = ctx.close(sym), b = (s.v = s.b.update(c)), pos = ctx.pos(sym);
            if (isNaN(b.mid)) return;
            if (pos === 0 && c < b.lo) { ctx.note(sym, `close ${c.toFixed(2)} below lower band`, "buy"); ctx.target(sym, w); }
            else if (pos === 0 && c > b.up && ctx.canShort) { ctx.note(sym, `close ${c.toFixed(2)} above upper band`, "sell"); ctx.target(sym, -w); }
            else if ((pos > 0 && c >= b.mid) || (pos < 0 && c <= b.mid)) ctx.flat(sym);
          });
        },
        overlay: (sym) => { const s = st.get(sym); return s?.v ? [{ k: "up", v: s.v.up }, { k: "mid", v: s.v.mid }, { k: "lo", v: s.v.lo }] : []; },
      };
    },
  },
  "donchian": {
    label: "Donchian breakout (turtle)", kind: "trend",
    desc: "Enter on a close beyond the N-day channel, exit on the shorter opposite channel. Size so a 2·ATR stop risks a fixed share of equity.",
    params: { entry: { v: 55, min: 10, max: 120, step: 5, label: "entry channel" }, exit: { v: 20, min: 5, max: 60, step: 5, label: "exit channel" }, atr: { v: 20, min: 5, max: 50, step: 1, label: "ATR period" }, riskPct: { v: 1, min: 0.25, max: 5, step: 0.25, label: "risk per trade %" } },
    check: (p) => { if (p.exit >= p.entry) throw new StrategyError("exit channel must be shorter than entry"); },
    create(p) {
      const st = new Map();
      return {
        onBar(ctx) {
          each(ctx, (sym, w) => {
            const s = per(st, sym, () => ({ e: new Donchian(p.entry), x: new Donchian(p.exit), a: new ATR(p.atr) })), b = ctx.bar(sym);
            const E = s.e.update(b), X = s.x.update(b), a = s.a.update(b), pos = ctx.pos(sym); s.v = { up: E.up, lo: E.lo, xu: X.up, xl: X.lo };
            if (isNaN(E.up) || isNaN(a) || isNaN(X.up)) return;
            const size = Math.min(w * 2, ((p.riskPct / 100) * b.c) / (2 * a));
            if (pos <= 0 && b.c > E.up) { ctx.note(sym, `${p.entry}-day breakout ${b.c.toFixed(2)} > ${E.up.toFixed(2)}`, "buy"); ctx.target(sym, size, { stop: b.c - 2 * a }); }
            else if (pos >= 0 && b.c < E.lo && ctx.canShort) { ctx.note(sym, `${p.entry}-day breakdown`, "sell"); ctx.target(sym, -size, { stop: b.c + 2 * a }); }
            else if ((pos > 0 && b.c < X.lo) || (pos < 0 && b.c > X.up)) { ctx.note(sym, `${p.exit}-day exit`, "exit"); ctx.flat(sym); }
          });
        },
        overlay: (sym) => { const s = st.get(sym); return s?.v ? [{ k: "up", v: s.v.up }, { k: "lo", v: s.v.lo }] : []; },
      };
    },
  },
  "momentum": {
    label: "Cross-sectional momentum", kind: "rotation",
    desc: "Every R days hold the top N symbols by trailing return, equal weight, but only those with positive momentum (absolute filter); the rest sits in cash.",
    params: { lookback: { v: 126, min: 20, max: 252, step: 1, label: "lookback days" }, top: { v: 3, min: 1, max: 8, step: 1, label: "hold top N" }, every: { v: 21, min: 1, max: 63, step: 1, label: "rebalance every" } },
    create(p) {
      const roc = new Map(); let k = 0;
      return {
        onBar(ctx) {
          const ranks = [];
          for (const sym of ctx.syms) { const r = per(roc, sym, () => new ROC(p.lookback)).update(ctx.close(sym)); if (!isNaN(r)) ranks.push([sym, r]); }
          if (ranks.length < ctx.syms.length || k++ % p.every) return;
          ranks.sort((a, b) => b[1] - a[1]);
          const keep = ranks.slice(0, p.top).filter(([, r]) => r > 0), w = 1 / p.top;
          for (const [sym] of ranks) ctx.target(sym, keep.some(([s]) => s === sym) ? w : 0);
          ctx.note(null, keep.length ? `rebalance → ${keep.map(([s, r]) => `${s} ${(r * 100).toFixed(0)}%`).join(", ")}` : "rebalance → all cash (no positive momentum)", "info");
        },
      };
    },
  },
  "pairs": {
    label: "Pairs trading (stat-arb)", kind: "market-neutral",
    desc: "Rolling OLS of log B on log A. When the residual's z-score is extreme, short the rich leg and buy the cheap one, hedge-ratio weighted; exit near zero, stop out if it keeps diverging.",
    params: { lookback: { v: 60, min: 20, max: 250, step: 5, label: "regression window" }, entry: { v: 2, min: 0.5, max: 4, step: 0.1, label: "entry |z|" }, exit: { v: 0.5, min: 0, max: 2, step: 0.1, label: "exit |z|" }, stopZ: { v: 4, min: 2, max: 8, step: 0.5, label: "stop |z|" } },
    pair: true, risk: { allowShort: true, maxGross: 2, maxPos: 1 },
    check: (p) => { if (p.exit >= p.entry) throw new StrategyError("exit z must be below entry z"); if (p.stopZ <= p.entry) throw new StrategyError("stop z must exceed entry z"); },
    create(p) {
      const ols = new RollingOLS(p.lookback); let side = 0, lastZ = NaN;
      return {
        init(ctx) { if (ctx.syms.length !== 2) throw new StrategyError("pairs needs exactly two symbols (A, B)"); },
        onBar(ctx) {
          const [A, B] = ctx.syms, a = ctx.close(A), b = ctx.close(B);
          const r = ols.update(Math.log(a), Math.log(b)); lastZ = r.z; if (isNaN(r.z)) return;
          const g = 0.5, beta = Math.max(0.2, Math.min(3, r.beta));
          if (side !== 0 && (ctx.pos(A) === 0 || ctx.pos(B) === 0)) side = 0;
          if (side === 0 && r.z > p.entry) { side = -1; ctx.note(B, `z ${r.z.toFixed(2)}: short ${B}, buy ${A} (β ${beta.toFixed(2)})`, "sell"); ctx.target(B, -g); ctx.target(A, g * beta); }
          else if (side === 0 && r.z < -p.entry) { side = 1; ctx.note(B, `z ${r.z.toFixed(2)}: buy ${B}, short ${A} (β ${beta.toFixed(2)})`, "buy"); ctx.target(B, g); ctx.target(A, -g * beta); }
          else if (side !== 0 && (Math.abs(r.z) < p.exit || Math.abs(r.z) > p.stopZ)) { ctx.note(B, Math.abs(r.z) > p.stopZ ? `z ${r.z.toFixed(2)} beyond stop: unwind` : `z ${r.z.toFixed(2)} converged: unwind`, Math.abs(r.z) > p.stopZ ? "stop" : "exit"); side = 0; ctx.flat(A, "unwind"); ctx.flat(B, "unwind"); }
        },
        osc: () => ({ v: lastZ, lo: -p.entry, hi: p.entry, min: -5, max: 5, label: "spread z" }),
      };
    },
  },
  "buy-hold": {
    label: "Buy and hold", kind: "benchmark", desc: "Equal weight on the first bar, never trades again.", params: {},
    create() { const done = new Set(); return { onBar(ctx) { for (const s of ctx.syms) { if (done.has(s)) continue; if (ctx.pos(s) > 0) done.add(s); else ctx.target(s, 1 / ctx.syms.length); } } }; },
  },
};

/** Merge and validate params; returns a ready strategy instance. Accepts a name or a custom { name, params, create } / { onBar } object. */
export function resolve(strategy, params = {}) {
  let def = strategy;
  if (typeof strategy === "string") { def = STRATEGIES[strategy]; if (!def) throw new StrategyError(`unknown strategy "${strategy}" (try: ${Object.keys(STRATEGIES).join(", ")})`); def = { name: strategy, ...def }; }
  else if (typeof strategy?.onBar === "function") def = { name: strategy.name || "custom", params: {}, create: () => strategy };
  else if (!strategy || typeof strategy.create !== "function") throw new StrategyError("strategy must be a name, an object with create(params), or an object with onBar(ctx)");
  const p = {};
  for (const [k, spec] of Object.entries(def.params || {})) {
    const v = params[k] ?? spec.v;
    if (typeof v !== "number" || !isFinite(v)) throw new StrategyError(`${k} must be a number`);
    if (v < spec.min || v > spec.max) throw new StrategyError(`${k} must be between ${spec.min} and ${spec.max} (got ${v})`);
    p[k] = spec.step >= 1 ? Math.round(v) : v;
  }
  for (const k of Object.keys(params)) if (!(k in (def.params || {})) && typeof strategy === "string") throw new StrategyError(`unknown parameter "${k}" for ${def.name} (known: ${Object.keys(def.params).join(", ") || "none"})`);
  def.check?.(p);
  const inst = def.create(p);
  return { name: def.name, label: def.label, params: p, risk: def.risk || {}, ...inst };
}
