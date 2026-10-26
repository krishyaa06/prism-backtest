// Performance statistics, overfitting diagnostics (probabilistic / deflated Sharpe) and bootstrap.
import { rng } from "./lib/rng.js";

export const PPY = 252;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sdev = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
export { mean, sdev };

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf, |err| < 1.5e-7). */
export function ncdf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2); return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y); }
/** Inverse normal CDF (Acklam's rational approximation, rel. err < 1.2e-9). */
export function ninv(p) {
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239], b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572], c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425; let q, r;
  if (p < lo) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
const moments = (r) => { const m = mean(r), n = r.length; let m2 = 0, m3 = 0, m4 = 0; for (const x of r) { const d = x - m; m2 += d * d; m3 += d ** 3; m4 += d ** 4; } m2 /= n; m3 /= n; m4 /= n; return { skew: m2 > 0 ? m3 / m2 ** 1.5 : 0, kurt: m2 > 0 ? m4 / (m2 * m2) : 3 }; };

/**
 * Probabilistic Sharpe ratio (Bailey & López de Prado 2012): probability that the true per-period Sharpe exceeds `srStar`
 * given sample length, skew and kurtosis.
 */
export function psr(returns, srStar = 0) {
  const n = returns.length; if (n < 3) return NaN; const s = sdev(returns); if (s === 0) return NaN;
  const sr = mean(returns) / s, { skew, kurt } = moments(returns);
  const den = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return ncdf(((sr - srStar) * Math.sqrt(n - 1)) / den);
}
/** Expected maximum per-period Sharpe of `trials` independent strategies with zero true Sharpe and Sharpe variance `v`. */
export function expectedMaxSharpe(trials, v) { if (trials < 2) return 0; const g = 0.5772156649; return Math.sqrt(v) * ((1 - g) * ninv(1 - 1 / trials) + g * ninv(1 - 1 / (trials * Math.E))); }
/** Deflated Sharpe ratio: PSR against the Sharpe you would expect from the best of `trials` random strategies. */
export function dsr(returns, trials, sharpes) {
  const v = sharpes && sharpes.length > 1 ? sdev(sharpes) ** 2 : 1 / Math.max(1, returns.length - 1);
  return psr(returns, expectedMaxSharpe(trials, v));
}

export function drawdowns(eq) {
  let peak = -Infinity, max = 0, cur = 0, longest = 0, start = 0, maxAt = 0; const dd = new Array(eq.length);
  for (let i = 0; i < eq.length; i++) {
    if (eq[i] >= peak) { peak = eq[i]; start = i; cur = 0; } else cur = i - start;
    dd[i] = peak > 0 ? eq[i] / peak - 1 : 0; if (-dd[i] > max) { max = -dd[i]; maxAt = i; } longest = Math.max(longest, cur);
  }
  return { dd, max, longest, maxAt };
}
export const toReturns = (eq) => { const r = []; for (let i = 1; i < eq.length; i++) r.push(eq[i - 1] > 0 ? eq[i] / eq[i - 1] - 1 : 0); return r; };

/** Full statistics from an equity curve (array of numbers, one per bar) and optional trades / benchmark curve. */
export function stats(eq, { trades = [], bench = null, rf = 0, costs = 0, turnover = 0, exposure = null, trials = 1, sharpes = null } = {}) {
  const r = toReturns(eq), n = r.length, years = n / PPY, rfd = Math.pow(1 + rf, 1 / PPY) - 1;
  const total = eq.length ? eq.at(-1) / eq[0] - 1 : 0, cagr = years > 0 && eq.at(-1) > 0 ? Math.pow(eq.at(-1) / eq[0], 1 / years) - 1 : (eq.at(-1) <= 0 ? -1 : 0);
  const ex = r.map((x) => x - rfd), s = sdev(r), vol = s * Math.sqrt(PPY);
  const sharpe = s > 0 ? (mean(ex) / s) * Math.sqrt(PPY) : 0;
  const dn = Math.sqrt(mean(ex.map((x) => Math.min(0, x) ** 2))), sortino = dn > 0 ? (mean(ex) / dn) * Math.sqrt(PPY) : 0;
  const { max: maxDD, longest } = drawdowns(eq), calmar = maxDD > 0 ? cagr / maxDD : 0;
  const sorted = r.slice().sort((a, b) => a - b), k = Math.max(1, Math.floor(n * 0.05));
  const var95 = n ? -sorted[k - 1] : 0, cvar95 = n ? -mean(sorted.slice(0, k)) : 0;
  let beta = NaN, alpha = NaN, corr = NaN, benchCagr = NaN;
  if (bench && bench.length === eq.length && n > 2) {
    const rb = toReturns(bench), mb = mean(rb), mr = mean(r); let cov = 0, vb = 0;
    for (let i = 0; i < n; i++) { cov += (r[i] - mr) * (rb[i] - mb); vb += (rb[i] - mb) ** 2; }
    beta = vb > 0 ? cov / vb : 0; alpha = ((mr - rfd) - beta * (mb - rfd)) * PPY; corr = vb > 0 && s > 0 ? cov / (n - 1) / (Math.sqrt(vb / (n - 1)) * s) : 0;
    benchCagr = years > 0 ? Math.pow(bench.at(-1) / bench[0], 1 / years) - 1 : 0;
  }
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  return {
    start: eq[0], end: eq.at(-1), total, cagr, vol, sharpe, sortino, calmar, maxDD, ddDays: longest, var95, cvar95,
    beta, alpha, corr, benchCagr, bars: eq.length, years,
    psr: psr(ex), dsr: trials > 1 ? dsr(ex, trials, sharpes) : psr(ex),
    trades: trades.length, winRate: trades.length ? wins.length / trades.length : 0, profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    expectancy: trades.length ? (gw - gl) / trades.length : 0, avgWin: wins.length ? gw / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0,
    avgBars: trades.length ? mean(trades.map((t) => t.bars)) : 0, costs, turnover, exposure,
  };
}

/** Calendar-month returns from dated equity: [{ ym: "2021-03", ret }]. */
export function monthly(dates, eq) {
  const out = []; let ym = null, open = eq[0];
  for (let i = 0; i < eq.length; i++) { const m = dates[i].slice(0, 7); if (ym !== m) { if (ym) { out.push({ ym, ret: eq[i - 1] / open - 1 }); open = eq[i - 1]; } ym = m; } }
  if (ym) out.push({ ym, ret: eq.at(-1) / open - 1 });
  return out;
}

/**
 * Stationary-style block bootstrap of daily returns: resample blocks of `block` consecutive days to keep volatility clustering.
 * Returns percentile bands of the equity path and distributions of final multiple, CAGR and max drawdown.
 */
export function bootstrap(returns, { runs = 1000, block = 10, seed = 1, horizon = returns.length, bands = [0.05, 0.25, 0.5, 0.75, 0.95] } = {}) {
  const R = rng(seed), n = returns.length; if (n < block) throw new Error("not enough returns to bootstrap");
  const finals = [], dds = [], paths = Array.from({ length: horizon + 1 }, () => new Float64Array(runs));
  for (let k = 0; k < runs; k++) {
    let e = 1, peak = 1, mdd = 0, t = 0; paths[0][k] = 1;
    while (t < horizon) { const s = R.int(0, n - block); for (let j = 0; j < block && t < horizon; j++, t++) { e *= 1 + returns[s + j]; peak = Math.max(peak, e); mdd = Math.max(mdd, 1 - e / peak); paths[t + 1][k] = e; } }
    finals.push(e); dds.push(mdd);
  }
  const q = (arr, p) => { const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))]; };
  const step = Math.max(1, Math.floor(horizon / 120));
  const fan = []; for (let t = 0; t <= horizon; t += step) fan.push(bands.map((p) => q(paths[t], p)));
  const yrs = horizon / PPY;
  return {
    runs, block, horizon, bands, fan, step,
    final: Object.fromEntries(bands.map((p) => [p, q(finals, p)])),
    cagr: Object.fromEntries(bands.map((p) => [p, Math.pow(q(finals, p), 1 / yrs) - 1])),
    maxDD: Object.fromEntries(bands.map((p) => [p, q(dds, p)])),
    pLoss: finals.filter((x) => x < 1).length / runs,
    pDD: (lim) => dds.filter((x) => x >= lim).length / runs,
  };
}
