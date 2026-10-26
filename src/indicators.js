// Streaming indicators: O(1) per update, NaN until warm. Each has a matching array function for tests and charts.
class Ring {
  constructor(n) { this.n = n; this.a = new Float64Array(n); this.i = 0; this.len = 0; }
  push(x) { const old = this.len === this.n ? this.a[this.i] : undefined; this.a[this.i] = x; this.i = (this.i + 1) % this.n; if (this.len < this.n) this.len++; return old; }
  get full() { return this.len === this.n; }
  ago(k) { return this.a[(this.i - 1 - k + this.n * 2) % this.n]; } // k = 0 is the latest
}

export class SMA { constructor(n) { this.n = n; this.r = new Ring(n); this.s = 0; this.v = NaN; } update(x) { const o = this.r.push(x); this.s += x - (o ?? 0); return (this.v = this.r.full ? this.s / this.n : NaN); } }
export class EMA {
  constructor(n) { this.n = n; this.k = 2 / (n + 1); this.c = 0; this.s = 0; this.v = NaN; }
  update(x) { this.c++; if (this.c < this.n) { this.s += x; return (this.v = NaN); } if (this.c === this.n) return (this.v = (this.s + x) / this.n); return (this.v = this.v + this.k * (x - this.v)); }
}
/** Rolling mean and population standard deviation (Bollinger convention). */
export class Stdev {
  constructor(n) { this.n = n; this.r = new Ring(n); this.s = 0; this.q = 0; this.mean = NaN; this.v = NaN; }
  update(x) { const o = this.r.push(x); if (o !== undefined) { this.s -= o; this.q -= o * o; } this.s += x; this.q += x * x; if (!this.r.full) return (this.v = NaN); this.mean = this.s / this.n; return (this.v = Math.sqrt(Math.max(0, this.q / this.n - this.mean * this.mean))); }
}
export class Bollinger { constructor(n = 20, k = 2) { this.k = k; this.sd = new Stdev(n); this.v = { mid: NaN, up: NaN, lo: NaN }; } update(x) { const s = this.sd.update(x); const m = this.sd.mean; return (this.v = isNaN(s) ? { mid: NaN, up: NaN, lo: NaN } : { mid: m, up: m + this.k * s, lo: m - this.k * s }); } }
/** Wilder RSI. */
export class RSI {
  constructor(n = 14) { this.n = n; this.prev = NaN; this.c = 0; this.g = 0; this.l = 0; this.v = NaN; }
  update(x) {
    if (isNaN(this.prev)) { this.prev = x; return (this.v = NaN); }
    const ch = x - this.prev; this.prev = x; const up = Math.max(0, ch), dn = Math.max(0, -ch); this.c++;
    if (this.c <= this.n) { this.g += up; this.l += dn; if (this.c < this.n) return (this.v = NaN); this.g /= this.n; this.l /= this.n; }
    else { this.g = (this.g * (this.n - 1) + up) / this.n; this.l = (this.l * (this.n - 1) + dn) / this.n; }
    return (this.v = this.l === 0 ? (this.g === 0 ? 50 : 100) : 100 - 100 / (1 + this.g / this.l));
  }
}
/** Wilder ATR on bars {h,l,c}. */
export class ATR {
  constructor(n = 14) { this.n = n; this.pc = NaN; this.c = 0; this.s = 0; this.v = NaN; }
  update(b) { const tr = isNaN(this.pc) ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - this.pc), Math.abs(b.l - this.pc)); this.pc = b.c; this.c++; if (this.c < this.n) { this.s += tr; return (this.v = NaN); } if (this.c === this.n) return (this.v = (this.s + tr) / this.n); return (this.v = (this.v * (this.n - 1) + tr) / this.n); }
}
/** Donchian channel of the previous n bars (the current bar is excluded so a breakout can be detected). Monotonic deques: O(1) amortised. */
export class Donchian {
  constructor(n = 20) { this.n = n; this.i = 0; this.hi = []; this.lo = []; this.v = { up: NaN, lo: NaN }; }
  update(b) {
    const w0 = this.i - this.n; while (this.hi.length && this.hi[0][0] < w0) this.hi.shift(); while (this.lo.length && this.lo[0][0] < w0) this.lo.shift();
    this.v = this.i >= this.n ? { up: this.hi[0][1], lo: this.lo[0][1] } : { up: NaN, lo: NaN };
    while (this.hi.length && this.hi.at(-1)[1] <= b.h) this.hi.pop(); this.hi.push([this.i, b.h]);
    while (this.lo.length && this.lo.at(-1)[1] >= b.l) this.lo.pop(); this.lo.push([this.i, b.l]);
    this.i++; return this.v;
  }
}
export class MACD { constructor(f = 12, s = 26, sig = 9) { this.f = new EMA(f); this.s = new EMA(s); this.sig = new EMA(sig); this.v = { macd: NaN, signal: NaN, hist: NaN }; } update(x) { const a = this.f.update(x), b = this.s.update(x); if (isNaN(a) || isNaN(b)) return this.v; const m = a - b, s = this.sig.update(m); return (this.v = { macd: m, signal: s, hist: m - s }); } }
/** Rate of change over n bars: x / x[n ago] - 1. */
export class ROC { constructor(n) { this.r = new Ring(n + 1); this.v = NaN; } update(x) { this.r.push(x); return (this.v = this.r.full ? x / this.r.ago(this.r.n - 1) - 1 : NaN); } }
/** Rolling OLS of y on x: y = alpha + beta x. Also the residual standard deviation and the latest residual's z-score. */
export class RollingOLS {
  constructor(n) { this.n = n; this.rx = new Ring(n); this.ry = new Ring(n); this.sx = 0; this.sy = 0; this.sxx = 0; this.sxy = 0; this.syy = 0; this.v = { beta: NaN, alpha: NaN, sd: NaN, z: NaN, resid: NaN }; }
  update(x, y) {
    const ox = this.rx.push(x), oy = this.ry.push(y);
    if (ox !== undefined) { this.sx -= ox; this.sy -= oy; this.sxx -= ox * ox; this.sxy -= ox * oy; this.syy -= oy * oy; }
    this.sx += x; this.sy += y; this.sxx += x * x; this.sxy += x * y; this.syy += y * y;
    if (!this.rx.full) return this.v;
    const n = this.n, vx = this.sxx - this.sx * this.sx / n, cxy = this.sxy - this.sx * this.sy / n, vy = this.syy - this.sy * this.sy / n;
    const beta = vx > 0 ? cxy / vx : 0, alpha = (this.sy - beta * this.sx) / n;
    const sse = Math.max(0, vy - beta * cxy), sd = Math.sqrt(sse / Math.max(1, n - 2)), resid = y - (alpha + beta * x);
    return (this.v = { beta, alpha, sd, resid, z: sd > 0 ? resid / sd : 0 });
  }
}

// ----- array versions (reference implementations) -----
export const sma = (xs, n) => xs.map((_, i) => (i + 1 < n ? NaN : xs.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n));
export const ema = (xs, n) => { const e = new EMA(n); return xs.map((x) => e.update(x)); };
export const rsi = (xs, n = 14) => { const e = new RSI(n); return xs.map((x) => e.update(x)); };
export const atr = (bars, n = 14) => { const e = new ATR(n); return bars.map((b) => e.update(b)); };
export const bollinger = (xs, n = 20, k = 2) => { const e = new Bollinger(n, k); return xs.map((x) => e.update(x)); };
export const donchian = (bars, n = 20) => { const e = new Donchian(n); return bars.map((b) => e.update(b)); };
