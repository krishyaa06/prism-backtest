// Transaction cost and slippage models. Indian schedules are approximations of NSE equity charges;
// rates change, so check your broker's current contract note before relying on them.
const r2 = (x) => Math.round(x * 100) / 100;

export const COSTS = {
  "india-delivery": { label: "NSE equity delivery", brokerage: { pct: 0, max: 0 }, stt: { buy: 0.001, sell: 0.001 }, txn: 0.0000297, sebi: 1e-6, stamp: 0.00015, gst: 0.18, dp: 15.93 },
  "india-intraday": { label: "NSE equity intraday", brokerage: { pct: 0.0003, max: 20 }, stt: { buy: 0, sell: 0.00025 }, txn: 0.0000297, sebi: 1e-6, stamp: 0.00003, gst: 0.18, dp: 0 },
  "bps": { label: "Flat basis points", bps: 5 },
  "zero": { label: "No costs", bps: 0 },
};

/** Charges for one fill. Returns { total, parts } in rupees. `schedule` is a key of COSTS or a custom object. */
export function charges(side, qty, price, schedule = "india-delivery") {
  const s = typeof schedule === "string" ? COSTS[schedule] : schedule;
  if (!s) throw new Error(`unknown cost schedule ${schedule}`);
  const value = Math.abs(qty) * price;
  if (value === 0) return { total: 0, parts: {} };
  if (s.bps != null) { const t = r2((value * s.bps) / 1e4); return { total: t, parts: { commission: t } }; }
  const brokerage = r2(s.brokerage.max ? Math.min(s.brokerage.max, value * s.brokerage.pct) : value * s.brokerage.pct);
  const stt = Math.round(value * (side === "buy" ? s.stt.buy : s.stt.sell)); // STT is rounded to the rupee
  const txn = r2(value * s.txn), sebi = r2(value * s.sebi);
  const stamp = side === "buy" ? Math.round(value * s.stamp) : 0;
  const gst = r2((brokerage + txn + sebi) * s.gst);
  const dp = side === "sell" ? s.dp || 0 : 0;
  const parts = { brokerage, stt, txn, sebi, stamp, gst, dp };
  return { total: r2(brokerage + stt + txn + sebi + stamp + gst + dp), parts };
}

/**
 * Execution price after slippage. Models:
 *  { model: "bps", bps }                    fixed adverse move
 *  { model: "sqrt", k, spreadBps }          half-spread + k · σ_daily · √(qty / volume)  (square-root market impact)
 */
export function slip(side, qty, price, { model = "sqrt", bps = 5, k = 0.6, spreadBps = 2 } = {}, { vol = 0.02, volume = 1e6 } = {}) {
  let frac;
  if (model === "none") frac = 0;
  else if (model === "bps") frac = bps / 1e4;
  else if (model === "sqrt") frac = spreadBps / 2 / 1e4 + k * vol * Math.sqrt(Math.abs(qty) / Math.max(1, volume));
  else throw new Error(`unknown slippage model ${model}`);
  const px = side === "buy" ? price * (1 + frac) : price * (1 - frac);
  return { px: Math.round(px * 100) / 100, bps: frac * 1e4 };
}
