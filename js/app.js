import { Backtest, Market, STRATEGIES, UNIVERSE, SYMBOLS, sweep, GRIDS, monteCarlo, drawdowns } from "../src/index.js";
import { $, esc, toast, Loop, bindLoop, LogView, Kpis, Chart, fit, hexA } from "./pro.js";

const OK = "#34f5c5", BAD = "#ff5c8a", WARN = "#ffb547", ACC = "#f5c542", ACC2 = "#7c5cff", CYAN = "#5cc8ff", MUTED = "#5f6884", TEXT = "#e6ebf5", mono = "JetBrains Mono, monospace";
const REG_COL = { bull: OK, chop: MUTED, bear: BAD, crisis: "#ff2e6e", rally: CYAN };
const LINE_COL = [ACC, CYAN, ACC2, OK, "#c084fc", WARN, BAD, TEXT];
const MOMO = ["KLPR", "BANKX", "PHRMA", "AUTOX", "INFRA", "GOLDB"], PAIR = ["BANKX", "FINX"];
const BPS = 6; // bars per second at 1×
const inr = (v) => (v < 0 ? "-₹" : "₹") + Math.abs(Math.round(v)).toLocaleString("en-IN");
const inrS = (v) => { const a = Math.abs(v), s = v < 0 ? "-₹" : "₹"; return a >= 1e7 ? s + (a / 1e7).toFixed(2) + " Cr" : a >= 1e5 ? s + (a / 1e5).toFixed(2) + " L" : s + Math.round(a).toLocaleString("en-IN"); };
const pct = (x, d = 1) => (isFinite(x) ? (x >= 0 ? "+" : "") + (x * 100).toFixed(d) + "%" : "–");
const f2 = (x) => (isFinite(x) ? x.toFixed(2) : "–");
const log = new LogView($("#log"), 220);
let H, M, seed = 6, bt, view, quiet = false, acc = 0, lastShock = null, sw = null, mc = null, pop = [];
const cfg = { strategy: "sma-cross", sym: "BANKX", params: {}, risk: { stopLoss: 0, trail: 0, ddHalt: 0 }, short: false, costs: "india-delivery", slip: "sqrt", peek: false };
const L = (h) => { if (!quiet) log.html(h, H?.dates.at(-1) || ""); };
const universe = () => (cfg.strategy === "pairs" ? PAIR : cfg.strategy === "momentum" ? MOMO : [cfg.sym]);
const multi = () => universe().length > 1;

// ---------- market history (shared by every replay) ----------
function newMarket() { M = new Market({ seed, symbols: SYMBOLS, start: "2019-01-01" }); H = { dates: [], regimes: [], bars: Object.fromEntries(SYMBOLS.map((s) => [s, []])) }; }
function nextBar() { const x = M.next(); H.dates.push(x.d); H.regimes.push(x.regime); for (const s of SYMBOLS) H.bars[s].push(x.bars[s]); if (H.regimes.at(-2) && H.regimes.at(-2) !== x.regime && !quiet) L(`<span class="${x.regime === "bull" || x.regime === "rally" ? "ok" : x.regime === "chop" ? "dim" : "bad"}">REGIME</span> ${H.regimes.at(-2)} → <b>${x.regime}</b>`); return H.dates.length - 1; }

// ---------- backtest wiring ----------
function riskObj() { const r = { allowShort: cfg.short || cfg.strategy === "pairs" }; if (cfg.risk.stopLoss) r.stopLoss = cfg.risk.stopLoss / 100; if (cfg.risk.trail) r.trail = cfg.risk.trail / 100; if (cfg.risk.ddHalt) r.ddHalt = cfg.risk.ddHalt / 100; return r; }
function make() {
  const slip = cfg.slip === "none" ? { model: "none" } : cfg.slip === "bps" ? { model: "bps", bps: 5 } : { model: "sqrt", k: 0.6, spreadBps: 2 };
  const b = new Backtest({ strategy: cfg.strategy, params: cfg.params, cash: 1_000_000, costs: cfg.costs, slippage: slip, fill: cfg.peek ? "close" : "next-open", risk: riskObj() });
  b.on(onEvent); return b;
}
function feed(i) {
  const bars = {}; for (const s of universe()) bars[s] = H.bars[s][i];
  bt.feed(H.dates[i], bars);
  const s0 = multi() ? null : cfg.sym, ovl = bt.strat.overlay && s0 ? bt.strat.overlay(s0) : [], osc = bt.strat.osc ? bt.strat.osc(s0) : null;
  view.ov.push(Object.fromEntries(ovl.map((o) => [o.k, o.v]))); view.osc.push(osc ? osc.v : NaN); view.oscDef = osc || view.oscDef;
  view.pos.push(multi() ? (universe().some((s) => bt.ctx.pos(s) !== 0) ? (cfg.strategy === "pairs" ? Math.sign(bt.ctx.pos("FINX")) : 1) : 0) : Math.sign(bt.ctx.pos(cfg.sym)));
  view.held.push(multi() ? universe().filter((s) => bt.ctx.pos(s) !== 0) : []);
}
function replay() {
  const t0 = performance.now(); quiet = true; mAt = -1; bt = make(); view = { ov: [], osc: [], pos: [], held: [], oscDef: null };
  for (let i = 0; i < H.dates.length; i++) feed(i);
  quiet = false; sw = null; mc = null; drawHeat(); drawFan();
  const m = bt.result().metrics, ms = performance.now() - t0;
  $("#rstat").className = "rstat ok"; $("#rstat").textContent = `${H.dates.length} bars replayed in ${ms.toFixed(0)} ms`;
  $("#resume").style.display = bt.halted ? "" : "none";
  return m;
}
let lastPartial = -99;
function onEvent(e) {
  if (e.type === "fill") pop.push({ i: e.i, t: 1 });
  if (quiet) return;
  if (e.type === "signal") { const cls = e.kind === "buy" ? "ok" : e.kind === "sell" || e.kind === "stop" ? "bad" : e.kind === "exit" ? "warn" : "acc"; L(`<span class="${cls}">${e.kind.toUpperCase()}</span> ${e.sym ? "<b>" + e.sym + "</b> " : ""}${esc(e.text)}`); }
  else if (e.type === "trade") L(`<span class="${e.pnl > 0 ? "ok" : "bad"}">CLOSED</span> ${e.side} <b>${e.sym}</b> ${inr(e.pnl)} (${pct(e.ret)}) <span class="dim">${e.bars} bars · ${esc(e.exitTag)}</span>`);
  else if (e.type === "stop") L(`<span class="warn">STOP</span> <b>${e.sym}</b> ${e.gap ? "gapped through" : "hit"} ${f2(e.stop)} → filled ${f2(e.px)}`);
  else if (e.type === "halt") { L(`<span class="bad">KILL SWITCH</span> drawdown ${pct(e.dd)}: liquidating and halting <span class="dim">press Resume to trade again</span>`); $("#resume").style.display = ""; }
  else if (e.type === "reject") L(`<span class="bad">REJECT</span> ${e.sym || ""} ${esc(e.reason)}`);
  else if (e.type === "partial" && e.i - lastPartial > 15) { lastPartial = e.i; L(`<span class="warn">PARTIAL</span> ${e.sym} ${Math.abs(e.got)} of ${Math.abs(e.want)} <span class="dim">${esc(e.reason)}</span>`); }
}

// ---------- KPIs + charts ----------
const kp = new Kpis($("#kpis"), [
  { key: "eq", label: "Equity", fmt: inrS }, { key: "ret", label: "Return", fmt: (x) => pct(x) }, { key: "sh", label: "Sharpe", fmt: f2 },
  { key: "dd", label: "Max DD", fmt: (x) => (x * 100).toFixed(1) + "%", tone: "bad" }, { key: "tr", label: "Trades", fmt: (x) => Math.round(x).toString() }, { key: "wr", label: "Win rate", fmt: (x) => Math.round(x * 100) + "%" },
]);
const eqChart = new Chart($("#eqc"), { series: [{ label: "strategy", color: ACC }, { label: "buy & hold", color: MUTED }], points: 300, min: null, fmtY: (v) => (v >= 1e7 ? (v / 1e7).toFixed(1) + "Cr" : (v / 1e5).toFixed(1) + "L"), area: false });
function benchCurve() { const s = multi() ? "NIFTYX" : cfg.sym, b = H.bars[s]; if (!b.length) return []; const k = 1_000_000 / b[0].c; return b.map((x) => x.c * k); }
const thin = (a, n = 300) => { const k = Math.max(1, Math.ceil(a.length / n)); const out = []; for (let i = 0; i < a.length; i += k) out.push(a[i]); if (a.length && (a.length - 1) % k) out.push(a.at(-1)); return out; };
let mCache = null, mAt = -1;
function metricsNow() { if (mAt === H.dates.length) return mCache; mAt = H.dates.length; mCache = bt.result(); return mCache; }
function refreshStats() {
  const r = metricsNow(), m = r.metrics, b = benchCurve();
  kp.set({ eq: m.end || 1e6, ret: m.total || 0, sh: m.sharpe || 0, dd: m.maxDD || 0, tr: m.trades, wr: m.winRate });
  kp.tone("ret", m.total >= 0 ? "ok" : "bad"); kp.tone("sh", m.sharpe >= 0.5 ? "ok" : m.sharpe < 0 ? "bad" : "");
  eqChart.set([thin(r.equity), thin(b)]);
  const bt0 = b.length ? b.at(-1) / b[0] - 1 : 0, ex = (m.total || 0) - bt0;
  $("#alpha").textContent = `${pct(ex)} vs B&H ${multi() ? "NIFTYX" : cfg.sym}`; $("#alpha").className = "pill " + (ex >= 0 ? "ok" : "bad");
  drawDD(r.dd, drawdowns(b).dd);
  $("#ddp").textContent = `${(m.maxDD * 100).toFixed(0)}% vs ${(drawdowns(b).max * 100).toFixed(0)}%`; $("#ddp").title = "strategy max drawdown vs buy & hold";
  renderTrades(r.trades, r.open);
}
function drawDD(dd, bdd) {
  const { ctx, w, h } = fit($("#ddc")); ctx.clearRect(0, 0, w, h);
  const a = thin(dd), b = thin(bdd), lo = Math.min(-0.05, ...a, ...b) * 1.1, n = Math.max(a.length, 2), X = (i) => 34 + (i / (n - 1)) * (w - 40), Y = (v) => 8 + (v / lo) * (h - 22);
  ctx.font = `10px ${mono}`; ctx.fillStyle = MUTED; ctx.strokeStyle = "rgba(255,255,255,.05)";
  for (const v of [0, lo / 2, lo]) { ctx.beginPath(); ctx.moveTo(34, Y(v)); ctx.lineTo(w - 6, Y(v)); ctx.stroke(); ctx.fillText((v * 100).toFixed(0) + "%", 0, Y(v) + 3); }
  const path = (arr, col, fill) => { ctx.beginPath(); ctx.moveTo(X(0), Y(0)); arr.forEach((v, i) => ctx.lineTo(X(i), Y(v))); ctx.lineTo(X(arr.length - 1), Y(0)); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.beginPath(); arr.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke(); };
  path(b, hexA(MUTED, 0.8), hexA(MUTED, 0.08)); path(a, BAD, hexA(BAD, 0.16));
  ctx.fillStyle = MUTED; ctx.fillText("— buy & hold", w - 92, h - 4); ctx.fillStyle = BAD; ctx.fillText("— strategy", 36, h - 4);
}
function renderTrades(trades, open) {
  $("#tn").textContent = `${trades.length} closed${open.length ? " · " + open.length + " open" : ""}`;
  const rows = [...open.map((p) => ({ ...p, open: true })), ...trades.slice(-30).reverse()];
  $("#trades").innerHTML = rows.length ? rows.map((t) => t.open
    ? `<div class="tr"><span class="sd ${t.side}">${t.side.toUpperCase()}</span><div>${t.sym} <span class="dim">open · ${Math.abs(t.qty)} @ ${f2(t.entry)}</span><small>mark ${f2(t.mark)}${t.stop ? " · stop " + f2(t.stop) : ""}</small></div><span class="pn ${t.upnl >= 0 ? "up" : "dn"}">${inr(t.upnl)}</span></div>`
    : `<div class="tr"><span class="sd ${t.side}">${t.side.toUpperCase()}</span><div>${t.sym} <span class="dim">${t.bars}d · ${esc(t.exitTag)}</span><small>${t.entryD} → ${t.exitD} · ${f2(t.entry)} → ${f2(t.exit)}</small></div><span class="pn ${t.pnl >= 0 ? "up" : "dn"}">${inr(t.pnl)}<small>${pct(t.ret)}</small></span></div>`).join("") : `<div class="empty">No trades yet: waiting for the first signal.</div>`;
}

// ---------- price canvas ----------
function draw() {
  const { ctx, w, h } = fit($("#px")); ctx.clearRect(0, 0, w, h);
  const n = H.dates.length; if (!n) return;
  const narrow = w < 560, axisW = narrow ? 46 : 58, x0 = 10, x1 = w - axisW, N = Math.max(40, Math.min(150, Math.floor((x1 - x0) / (narrow ? 6.5 : 7.5))));
  const right = n - 1 + acc, left = right - N + 1, bw = (x1 - x0) / N, X = (i) => x0 + (i - left) * bw;
  const top = 46, pBot = Math.round(h * (view.oscDef ? 0.64 : 0.7)), rib = pBot + 8, oTop = rib + 18, oBot = h - 30;
  const i0 = Math.max(0, Math.floor(left) - 1), i1 = n - 1, syms = universe();
  ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, h); ctx.clip();
  // position shading
  for (let i = i0; i <= i1; i++) { const p = view.pos[i]; if (!p) continue; ctx.fillStyle = p > 0 ? "rgba(52,245,197,.055)" : "rgba(255,92,138,.06)"; ctx.fillRect(X(i) - bw / 2, top - 4, bw + 0.5, pBot - top + 8); }
  let lo = Infinity, hi = -Infinity, Y;
  if (!multi()) {
    const B = H.bars[cfg.sym];
    for (let i = i0; i <= i1; i++) { lo = Math.min(lo, B[i].l); hi = Math.max(hi, B[i].h); const o = view.ov[i]; if (o) for (const v of Object.values(o)) if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad; Y = (p) => pBot - ((p - lo) / (hi - lo)) * (pBot - top);
    // overlays
    const keys = Object.keys(view.ov[i1] || {}), oc = { fast: ACC, slow: ACC2, trend: ACC2, up: CYAN, mid: MUTED, lo: CYAN };
    for (const k of keys) { ctx.beginPath(); let on = false; for (let i = i0; i <= i1; i++) { const v = view.ov[i]?.[k]; if (!isFinite(v)) { on = false; continue; } on ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); on = true; } ctx.strokeStyle = hexA(oc[k] || ACC, k === "mid" ? 0.6 : 0.9); ctx.lineWidth = k === "mid" ? 1 : 1.5; ctx.setLineDash(k === "mid" ? [3, 3] : []); ctx.stroke(); ctx.setLineDash([]); }
    // candles
    for (let i = i0; i <= i1; i++) {
      const b = B[i], up = b.c >= b.o, col = up ? OK : BAD, cx = X(i), age = i === i1 ? Math.min(1, 0.35 + acc * 1.6) : 1;
      ctx.globalAlpha = age; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, Y(b.h)); ctx.lineTo(cx, Y(b.l)); ctx.stroke();
      const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c)); ctx.fillStyle = up ? hexA(OK, 0.85) : hexA(BAD, 0.85); ctx.fillRect(cx - Math.max(1, bw * 0.32), y1, Math.max(2, bw * 0.64), Math.max(1, y2 - y1)); ctx.globalAlpha = 1;
    }
  } else {
    const base = Object.fromEntries(syms.map((s) => [s, H.bars[s][Math.max(0, Math.floor(left))]?.c || H.bars[s][0].c]));
    for (const s of syms) for (let i = i0; i <= i1; i++) { const v = H.bars[s][i].c / base[s] * 100; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad; Y = (p) => pBot - ((p - lo) / (hi - lo)) * (pBot - top);
    const held = new Set(view.held[i1] || []);
    syms.forEach((s, k) => {
      ctx.beginPath(); for (let i = i0; i <= i1; i++) { const v = H.bars[s][i].c / base[s] * 100; i === i0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)); }
      ctx.strokeStyle = hexA(LINE_COL[k], held.has(s) ? 1 : 0.4); ctx.lineWidth = held.has(s) ? 2.2 : 1.1; ctx.stroke();
    });
    view._base = base;
  }
  // fill markers
  const fills = bt.fills; let dLab = null;
  for (let k = fills.length - 1; k >= 0; k--) {
    const f = fills[k]; if (f.i < i0) break; if (!syms.includes(f.sym)) continue;
    const b = H.bars[f.sym][f.i], cx = X(f.i), stop = /stop|kill/.test(f.tag), buy = f.side === "buy";
    const yv = multi() ? Y(b.c / view._base[f.sym] * 100) : buy ? Y(b.l) + 12 : Y(b.h) - 12, col = stop ? WARN : buy ? OK : BAD;
    const pp = pop.find((q) => q.i === f.i), s = 5 * (1 + (pp ? pp.t * 0.9 : 0));
    ctx.fillStyle = col; ctx.beginPath();
    if (stop) { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.moveTo(cx - s, yv - s); ctx.lineTo(cx + s, yv + s); ctx.moveTo(cx + s, yv - s); ctx.lineTo(cx - s, yv + s); ctx.stroke(); }
    else if (buy) { ctx.moveTo(cx, yv - s); ctx.lineTo(cx - s, yv + s * 0.8); ctx.lineTo(cx + s, yv + s * 0.8); ctx.fill(); }
    else { ctx.moveTo(cx, yv + s); ctx.lineTo(cx - s, yv - s * 0.8); ctx.lineTo(cx + s, yv - s * 0.8); ctx.fill(); }
    if (!dLab && f.i > i1 - 25) dLab = { f, cx, yv, col, buy, stop };
  }
  ctx.restore();
  // open position: entry + stop lines
  if (!multi()) {
    const o = bt.result ? metricsNow().open.find((p) => p.sym === cfg.sym) : null;
    if (o) {
      const line = (p, col, lab, dash) => { const y = Y(p); if (y < top - 6 || y > pBot + 6) return; ctx.setLineDash(dash); ctx.strokeStyle = hexA(col, 0.8); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.setLineDash([]); ctx.font = `10px ${mono}`; const tw = ctx.measureText(lab).width + 10; ctx.fillStyle = "rgba(10,13,24,.85)"; ctx.fillRect(x0 + 4, y - 15, tw, 14); ctx.fillStyle = col; ctx.fillText(lab, x0 + 9, y - 4); };
      line(o.entry, MUTED, `entry ${f2(o.entry)} · ${o.qty > 0 ? "long" : "short"} ${Math.abs(o.qty)}`, [2, 4]);
      if (o.stop) line(o.stop, BAD, `stop ${f2(o.stop)}`, [5, 4]);
    }
  }
  if (dLab) {
    const { f, cx, yv, col, buy, stop } = dLab, lab = `${stop ? (f.tag === "kill-switch" ? "KILL" : "STOP") : f.side.toUpperCase()} ${f.qty.toLocaleString("en-IN")} @ ${f2(f.px)}`;
    ctx.font = `600 10.5px ${mono}`; const tw = ctx.measureText(lab).width + 12; let lx = Math.min(x1 - tw - 2, Math.max(x0 + 2, cx - tw / 2)), ly = buy ? Math.min(pBot - 4, yv + 12) : Math.max(top + 2, yv - 26);
    ctx.fillStyle = "rgba(10,13,24,.9)"; ctx.strokeStyle = hexA(col, 0.6); ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(lx, ly, tw, 18, 5); ctx.fill(); ctx.stroke(); ctx.fillStyle = col; ctx.fillText(lab, lx + 6, ly + 12.5);
  }
  // price axis
  ctx.font = `10px ${mono}`; ctx.fillStyle = MUTED; ctx.strokeStyle = "rgba(255,255,255,.04)"; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const p = lo + ((hi - lo) * k) / 4, y = Y(p); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.fillText(multi() ? p.toFixed(0) : p >= 1000 ? p.toFixed(0) : p.toFixed(1), x1 + 6, y + 3); }
  if (!multi()) { const c = H.bars[cfg.sym][i1].c, y = Y(c); ctx.fillStyle = ACC; ctx.fillRect(x1 + 1, y - 8, axisW - 2, 16); ctx.fillStyle = "#0a0d18"; ctx.font = `600 10px ${mono}`; ctx.fillText(c >= 1000 ? c.toFixed(0) : c.toFixed(2), x1 + 5, y + 3.5); }
  // regime ribbon
  for (let i = i0; i <= i1; i++) { ctx.fillStyle = hexA(REG_COL[H.regimes[i]] || MUTED, 0.75); ctx.fillRect(Math.max(x0, X(i) - bw / 2), rib, Math.min(bw + 0.5, x1 - Math.max(x0, X(i) - bw / 2)), 5); }
  ctx.font = `10px ${mono}`; ctx.fillStyle = REG_COL[H.regimes[i1]]; const rl = `regime: ${H.regimes[i1]}`; ctx.fillText(rl, x1 - ctx.measureText(rl).width, rib + 16);
  // lower pane: oscillator or volume
  ctx.save(); ctx.beginPath(); ctx.rect(x0, oTop - 2, x1 - x0, oBot - oTop + 4); ctx.clip();
  if (view.oscDef) {
    const d = view.oscDef, omin = d.min ?? 0, omax = d.max ?? 100, OY = (v) => oBot - ((v - omin) / (omax - omin)) * (oBot - oTop);
    ctx.fillStyle = "rgba(255,255,255,.02)"; ctx.fillRect(x0, OY(d.hi), x1 - x0, OY(d.lo) - OY(d.hi));
    for (const v of [d.lo, d.hi]) { ctx.strokeStyle = hexA(WARN, 0.4); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x0, OY(v)); ctx.lineTo(x1, OY(v)); ctx.stroke(); ctx.setLineDash([]); }
    ctx.beginPath(); let on = false; for (let i = i0; i <= i1; i++) { const v = Math.max(omin, Math.min(omax, view.osc[i])); if (!isFinite(view.osc[i])) { on = false; continue; } on ? ctx.lineTo(X(i), OY(v)) : ctx.moveTo(X(i), OY(v)); on = true; } ctx.strokeStyle = CYAN; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.restore(); ctx.font = `10px ${mono}`; ctx.fillStyle = MUTED; ctx.fillText(`${d.label} ${f2(view.osc[i1])}`, x0 + 2, oTop + 9); for (const v of [d.lo, d.hi]) ctx.fillText(String(Math.round(v * 10) / 10), x1 + 6, OY(v) + 3);
  } else {
    const s = multi() ? "NIFTYX" : cfg.sym, B = H.bars[s]; let vmax = 1; for (let i = i0; i <= i1; i++) vmax = Math.max(vmax, B[i].v);
    for (let i = i0; i <= i1; i++) { const b = B[i], hh = (b.v / vmax) * (oBot - oTop); ctx.fillStyle = b.c >= b.o ? hexA(OK, 0.35) : hexA(BAD, 0.35); ctx.fillRect(X(i) - bw * 0.32, oBot - hh, Math.max(1.5, bw * 0.64), hh); }
    ctx.restore(); ctx.font = `10px ${mono}`; ctx.fillStyle = MUTED; ctx.fillText(`volume · ${s}`, x0 + 2, oTop + 9);
  }
  // date axis
  ctx.fillStyle = MUTED; ctx.font = `10px ${mono}`; const step = Math.ceil(N / (narrow ? 3 : 6));
  let axLab = ""; for (let i = Math.ceil(left / step) * step; i <= i1; i += step) if (i >= 0 && X(i) > x0 + 30 && X(i) < x1 - 30) { const lab = narrow ? H.dates[i].slice(2, 7) : H.dates[i].slice(0, 7); if (lab === axLab) continue; axLab = lab; ctx.fillText(lab, X(i) - 18, h - 17); }
  // legend
  let lx = x0 + 2; const ly = h - 2, item = (col, t) => { ctx.fillStyle = col; ctx.fillRect(lx, ly - 7, 8, 3); ctx.fillStyle = MUTED; ctx.fillText(t, lx + 11, ly - 3); lx += ctx.measureText(t).width + 24; };
  if (multi()) syms.forEach((s, k) => item(LINE_COL[k], s)); else { const keys = Object.keys(view.ov[i1] || {}); const nm = { fast: `SMA ${bt.params.fast}`, slow: `SMA ${bt.params.slow}`, trend: `SMA ${bt.params.trend}`, up: narrow ? "bands" : "upper / lower", mid: "mid" }; const oc = { fast: ACC, slow: ACC2, trend: ACC2, up: CYAN, mid: MUTED }; for (const k of keys) if (k !== "lo") item(oc[k], nm[k] || k); if (!narrow) { item(OK, "buy"); item(BAD, "sell"); item(WARN, "stop"); } }
  // kill-switch banner
  if (bt.halted) { const t = narrow ? "KILL SWITCH · halted" : `KILL SWITCH · trading halted at ${cfg.risk.ddHalt}% drawdown`; ctx.font = `600 12px ${mono}`; const tw = ctx.measureText(t).width + 24, bx = Math.max(x0, (x0 + x1 - tw) / 2); ctx.fillStyle = "rgba(255,46,110,.16)"; ctx.strokeStyle = hexA(BAD, 0.7); ctx.beginPath(); ctx.roundRect(bx, top + 4, tw, 26, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = BAD; ctx.fillText(t, bx + 12, top + 21); }
  pop = pop.filter((p) => (p.t -= 0.04) > 0);
}
function setTag() {
  const s = multi() ? (cfg.strategy === "pairs" ? "BANKX / FINX rebased to 100" : "6-stock universe rebased to 100") : `${cfg.sym} · ${UNIVERSE.find((u) => u.sym === cfg.sym).name}`;
  $("#tag").innerHTML = `${esc(s)} · daily${cfg.peek ? ' · <span style="color:' + WARN + '">look-ahead: fills at signal close</span>' : ""}`;
}

// ---------- sweep heatmap ----------
function gridFor() {
  const g = GRIDS[cfg.strategy]; if (!g) return null; const ks = Object.keys(g); if (ks.length < 2) return null;
  const cut = (a) => (a.length > 10 ? a.filter((_, i) => i % Math.ceil(a.length / 10) === 0) : a);
  return { [ks[0]]: cut(g[ks[0]]), [ks[1]]: cut(g[ks[1]]) };
}
function runSweep() {
  const g = gridFor(); if (!g) { $("#sweepi").innerHTML = "Buy and hold has no parameters to tune."; return; }
  $("#sweepi").textContent = "running…";
  setTimeout(() => {
    const data = Object.fromEntries(universe().map((s) => [s, H.bars[s]])), t0 = performance.now();
    const keep = { ...cfg.params }; for (const k of Object.keys(g)) delete keep[k];
    const grid = { ...g }; for (const [k, v] of Object.entries(keep)) grid[k] = [v];
    const slip = cfg.slip === "none" ? { model: "none" } : cfg.slip === "bps" ? { model: "bps", bps: 5 } : { model: "sqrt", k: 0.6, spreadBps: 2 };
    sw = sweep(data, { strategy: cfg.strategy, grid, costs: cfg.costs, slippage: slip, risk: riskObj() }); sw.keys = Object.keys(g); sw.g = g; sw.ms = performance.now() - t0;
    drawHeat();
    const cur = metricsNow().metrics, b = sw.best, cls = sw.dsr > 0.9 ? "ok" : sw.dsr > 0.6 ? "warn" : "bad";
    $("#sweepi").innerHTML = `best <b>${sw.keys.map((k) => k + " " + b.params[k]).join(" · ")}</b> Sharpe <b>${f2(b.m.sharpe)}</b> (yours ${f2(cur.sharpe)})<br>P(Sharpe&gt;0) ${Math.round(sw.psr * 100)}% → deflated for ${sw.trials} trials <b class="${cls}">${Math.round(sw.dsr * 100)}%</b> <span class="dim">· ${sw.ms.toFixed(0)} ms</span>`;
    L(`<span class="acc">SWEEP</span> ${sw.trials} backtests in ${sw.ms.toFixed(0)} ms · best Sharpe ${f2(b.m.sharpe)} · deflated ${Math.round(sw.dsr * 100)}%`);
  }, 30);
}
let heatCells = [];
function drawHeat() {
  const { ctx, w, h } = fit($("#heat")); ctx.clearRect(0, 0, w, h); heatCells = [];
  ctx.font = `10px ${mono}`;
  if (!sw) { ctx.fillStyle = MUTED; ctx.fillText(gridFor() ? "press Sweep to grid-search the history" : "no parameters to sweep", 8, h / 2); return; }
  const [a, b] = sw.keys, va = sw.g[a], vb = sw.g[b], lx = 30, ty = 4, cw = (w - lx - 4) / vb.length, ch = (h - ty - 26) / va.length;
  const ok = sw.rows.filter((r) => r.ok), mx = Math.max(0.3, ...ok.map((r) => Math.abs(r.m.sharpe)));
  va.forEach((x, yi) => vb.forEach((y, xi) => {
    const r = sw.rows.find((q) => q.params[a] === x && q.params[b] === y), X = lx + xi * cw, Y = ty + yi * ch;
    if (!r || !r.ok) { ctx.fillStyle = "rgba(255,255,255,.03)"; ctx.fillRect(X + 1, Y + 1, cw - 2, ch - 2); return; }
    const s = r.m.sharpe / mx; ctx.fillStyle = s >= 0 ? hexA(OK, 0.12 + 0.75 * s) : hexA(BAD, 0.12 + 0.75 * -s); ctx.fillRect(X + 1, Y + 1, cw - 2, ch - 2);
    const best = JSON.stringify(r.params) === JSON.stringify(sw.best.params), mine = r.params[a] === bt.params[a] && r.params[b] === bt.params[b];
    if (best || mine) { ctx.strokeStyle = best ? ACC : TEXT; ctx.lineWidth = 2; ctx.strokeRect(X + 2, Y + 2, cw - 4, ch - 4); }
    heatCells.push({ X, Y, cw, ch, params: r.params });
  }));
  ctx.fillStyle = MUTED; va.forEach((x, yi) => { if (va.length <= 8 || yi % 2 === 0) ctx.fillText(String(x), 2, ty + yi * ch + ch / 2 + 3); });
  vb.forEach((y, xi) => { if (vb.length <= 8 || xi % 2 === 0) ctx.fillText(String(y), lx + xi * cw + cw / 2 - 8, h - 12); });
  ctx.fillText(`${a} ↓  ${b} →   ▢ best  ▢ yours`, lx, h - 1); ctx.strokeStyle = ACC; ctx.strokeRect(lx + ctx.measureText(`${a} ↓  ${b} →   `).width, h - 9, 7, 7);
}
$("#heat").addEventListener("click", (e) => {
  const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, c = heatCells.find((q) => x >= q.X && x < q.X + q.cw && y >= q.Y && y < q.Y + q.ch); if (!c) return;
  Object.assign(cfg.params, c.params); buildParams(); const keep = sw; const m = replay(); sw = keep; drawHeat(); refreshStats();
  toast(`${Object.entries(c.params).map(([k, v]) => k + " " + v).join(" · ")}: Sharpe ${f2(m.sharpe)}`);
});

// ---------- Monte Carlo fan ----------
function runMC() {
  const r = metricsNow(); if (r.equity.length < 60) { toast("need at least 60 bars"); return; }
  mc = monteCarlo(r, { runs: 400, block: 10, seed: H.dates.length }); mc.actual = r.equity.map((x) => x / r.equity[0]); drawFan();
  $("#mci").innerHTML = `final p5 <b>${f2(mc.final[0.05])}×</b> · p50 <b>${f2(mc.final[0.5])}×</b> · p95 <b>${f2(mc.final[0.95])}×</b><br>P(loss) <b class="${mc.pLoss > 0.2 ? "bad" : "ok"}">${Math.round(mc.pLoss * 100)}%</b> · P(drawdown ≥ 20%) <b class="${mc.pDD20 > 0.3 ? "bad" : "warn"}">${Math.round(mc.pDD20 * 100)}%</b> · max DD p95 ${(mc.maxDD[0.95] * 100).toFixed(0)}%`;
  L(`<span class="acc">MONTE CARLO</span> 400 paths · median ${f2(mc.final[0.5])}× · P(loss) ${Math.round(mc.pLoss * 100)}%`);
}
function drawFan() {
  const { ctx, w, h } = fit($("#fan")); ctx.clearRect(0, 0, w, h); ctx.font = `10px ${mono}`;
  if (!mc) { ctx.fillStyle = MUTED; ctx.fillText("press Bootstrap to resample the returns", 8, h / 2); return; }
  const F = mc.fan, n = F.length, lo = Math.min(...F.map((r) => r[0]), 0.8), hi = Math.max(...F.map((r) => r[4]), ...mc.actual) * 1.02, X = (i) => 34 + (i / (n - 1)) * (w - 40), Y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (h - 22);
  const band = (a, b, al) => { ctx.beginPath(); F.forEach((r, i) => (i ? ctx.lineTo(X(i), Y(r[a])) : ctx.moveTo(X(i), Y(r[a])))); for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(i), Y(F[i][b])); ctx.closePath(); ctx.fillStyle = hexA(ACC2, al); ctx.fill(); };
  band(0, 4, 0.16); band(1, 3, 0.3);
  ctx.beginPath(); F.forEach((r, i) => (i ? ctx.lineTo(X(i), Y(r[2])) : ctx.moveTo(X(i), Y(r[2])))); ctx.strokeStyle = ACC2; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.beginPath(); for (let i = 0; i < n; i++) { const v = mc.actual[Math.min(mc.actual.length - 1, i * mc.step)]; i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)); } ctx.strokeStyle = ACC; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(34, Y(1)); ctx.lineTo(w - 6, Y(1)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = MUTED; for (const v of [lo, 1, hi]) ctx.fillText(v.toFixed(1) + "×", 0, Y(v) + 3);
  ctx.fillStyle = ACC; ctx.fillText("— actual", 36, h - 2); ctx.fillStyle = ACC2; ctx.fillText("▮ 5–95% · 25–75%", 100, h - 2);
}

// ---------- controls ----------
const sel = $("#strat"); sel.innerHTML = Object.entries(STRATEGIES).map(([k, s]) => `<option value="${k}">${esc(s.label)}</option>`).join(""); sel.value = cfg.strategy;
function buildSym() {
  const s = $("#sym");
  if (cfg.strategy === "pairs") { s.innerHTML = `<option>BANKX / FINX</option>`; s.disabled = true; }
  else if (cfg.strategy === "momentum") { s.innerHTML = `<option>6-stock universe</option>`; s.disabled = true; }
  else { s.innerHTML = SYMBOLS.map((x) => `<option value="${x}">${x}</option>`).join(""); s.value = cfg.sym; s.disabled = false; }
}
function slider(id, label, spec, val, onIn) { return `<label><span>${esc(label)} <b id="${id}v">${val}</b></span><input type="range" id="${id}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${val}"></label>`; }
function buildParams() {
  const def = STRATEGIES[cfg.strategy];
  $("#sdesc").textContent = def.desc; $("#kind").textContent = def.kind;
  $("#params").innerHTML = Object.entries(def.params).map(([k, p]) => slider("p_" + k, p.label, p, cfg.params[k] ?? p.v)).join("") || `<span class="dim">no parameters</span>`;
  for (const [k, p] of Object.entries(def.params)) { const el = $("#p_" + k); el.oninput = () => { $("#p_" + k + "v").textContent = el.value; }; el.onchange = () => { cfg.params[k] = +el.value; apply(); }; }
  const R = [["stopLoss", "stop loss % (0 off)", { min: 0, max: 20, step: 1 }], ["trail", "trailing stop %", { min: 0, max: 25, step: 1 }], ["ddHalt", "kill switch DD %", { min: 0, max: 50, step: 5 }]];
  $("#risk").innerHTML = R.map(([k, l, s]) => slider("r_" + k, l, s, cfg.risk[k])).join("");
  for (const [k] of R) { const el = $("#r_" + k); el.oninput = () => { $("#r_" + k + "v").textContent = el.value; }; el.onchange = () => { cfg.risk[k] = +el.value; apply(); }; }
}
function apply() {
  try { const m = replay(); refreshStats(); L(`<span class="acc">REPLAY</span> ${esc(STRATEGIES[cfg.strategy].label)} ${esc(JSON.stringify(bt.params))} on ${H.dates.length} bars → Sharpe <b>${f2(m.sharpe)}</b>, ${pct(m.total)}, max DD ${(m.maxDD * 100).toFixed(1)}%`); }
  catch (e) { $("#rstat").className = "rstat bad"; $("#rstat").textContent = e.message; toast(e.message); }
}
function strategyDefaults() { cfg.params = {}; const r = STRATEGIES[cfg.strategy].risk || {}; cfg.risk.stopLoss = Math.round((r.stopLoss || 0) * 100); }
sel.onchange = () => { cfg.strategy = sel.value; strategyDefaults(); if (cfg.strategy === "pairs") $("#short").checked = true; buildSym(); buildParams(); setTag(); apply(); };
$("#sym").onchange = () => { cfg.sym = $("#sym").value; setTag(); apply(); };
$("#costs").onchange = () => { cfg.costs = $("#costs").value; apply(); };
$("#slip").onchange = () => { cfg.slip = $("#slip").value; apply(); };
$("#short").onchange = () => { cfg.short = $("#short").checked; apply(); };
$("#apply").onclick = apply;
$("#sweep").onclick = runSweep; $("#mc").onclick = runMC;
$("#peek").onclick = () => { cfg.peek = !cfg.peek; $("#peek").classList.toggle("on", cfg.peek); setTag(); const before = metricsNow().metrics.sharpe; apply(); const after = metricsNow().metrics.sharpe; toast(cfg.peek ? `Look-ahead on: Sharpe ${f2(before)} → ${f2(after)}` : `Back to next-open fills: Sharpe ${f2(after)}`); };
$("#resume").onclick = () => { bt.resume(); mAt = -1; $("#resume").style.display = "none"; L(`<span class="ok">RESUMED</span> kill switch cleared, drawdown peak reset`); };
$("#reseed").onclick = () => { seed++; boot(); toast(`new market · seed ${seed}`); };
for (const b of document.querySelectorAll("[data-shock]")) b.onclick = () => { const k = b.dataset.shock; M.shock(k); lastShock = k; L(`<span class="${k === "crash" ? "bad" : k === "rally" ? "ok" : "dim"}">SCENARIO</span> ${k === "crash" ? "crash: −7.5% gap at the open, then a crisis regime" : k === "rally" ? "rally regime: strong drift up" : "choppy, trendless market"}`); };

// ---------- loop ----------
let frame = 0;
const loop = new Loop((dt) => {
  acc += dt * BPS;
  while (acc >= 1) { acc -= 1; const i = nextBar(); feed(i); }
  draw();
  if (frame++ % 6 === 0) refreshStats();
});
bindLoop(loop, $("#sim") || document);
new ResizeObserver(() => { draw(); drawHeat(); drawFan(); refreshStats(); }).observe($("#pxw"));

function boot() {
  newMarket(); quiet = true; for (let i = 0; i < 420; i++) nextBar(); quiet = false;
  log.clear(); replay(); refreshStats(); setTag(); draw();
  L(`<span class="acc">READY</span> ${H.dates.length} bars of a synthetic NSE-like market (seed ${seed}) · ${esc(STRATEGIES[cfg.strategy].label)} replayed over all of it`);
  L(`<span class="dim">Orders decided on a close fill at the next open, with NSE delivery charges and √-impact slippage.</span>`);
}
buildSym(); buildParams(); boot(); loop.start();
setTimeout(() => document.querySelector('[data-shock="crash"]').click(), 1500);
setTimeout(runSweep, 4000);
setTimeout(runMC, 5600);
