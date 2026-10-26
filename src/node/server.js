import http from "node:http";
import { backtest, sweep, walkForward, monteCarlo, GRIDS, strategyList, generate, parseCSV, SYMBOLS, UNIVERSE, StrategyError, BacktestError, DataError } from "../index.js";

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body, (k, v) => (typeof v === "number" && !isFinite(v) ? null : v))); };
const read = (req) => new Promise((ok, bad) => { let b = ""; req.on("data", (d) => { b += d; if (b.length > 8e6) { bad(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } }); req.on("end", () => ok(b)); });
const thin = (arr, n = 400) => { const k = Math.max(1, Math.ceil(arr.length / n)); return arr.filter((_, i) => i % k === 0 || i === arr.length - 1); };

/** Request body → { data, opts }. Data is either uploaded CSV ({ csv: { SYM: "date,open,..." } }) or the synthetic universe. */
function input(body) {
  let data;
  if (body.csv) { data = {}; for (const [s, t] of Object.entries(body.csv)) { try { data[s] = parseCSV(t); } catch (e) { throw new DataError(`${s}: ${e.message}`); } } }
  else {
    const syms = body.symbols || (body.strategy === "pairs" ? ["BANKX", "FINX"] : ["NIFTYX"]);
    if (!Array.isArray(syms) || !syms.length) throw new DataError("symbols must be a non-empty array");
    for (const s of syms) if (!SYMBOLS.includes(s)) throw new DataError(`unknown symbol ${s}`);
    const need = [...new Set([...syms, ...syms.map((s) => UNIVERSE.find((u) => u.sym === s).pairOf).filter(Boolean)])];
    const years = body.years ?? 6; if (!(years > 0 && years <= 30)) throw new DataError("years must be in (0, 30]");
    const all = generate({ seed: body.seed ?? 6, years, symbols: need }); data = Object.fromEntries(syms.map((s) => [s, all[s]]));
  }
  const opts = { strategy: body.strategy || "sma-cross", params: body.params || {}, cash: body.cash, costs: body.costs, slippage: body.slippage, fill: body.fill, risk: body.risk, rf: body.rf, benchmark: data.NIFTYX ? "NIFTYX" : null };
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  return { data, opts };
}

/** HTTP API: GET /healthz, GET /v1/strategies, POST /v1/backtest, /v1/sweep, /v1/walkforward, /v1/montecarlo */
export function createServer() {
  return http.createServer(async (req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    try {
      if (p === "/healthz") return json(res, 200, { ok: true });
      if (p === "/v1/strategies" && req.method === "GET") return json(res, 200, { strategies: strategyList(), grids: GRIDS, symbols: SYMBOLS });
      if (req.method !== "POST" || !["/v1/backtest", "/v1/sweep", "/v1/walkforward", "/v1/montecarlo"].includes(p)) return json(res, 404, { error: "not found" });
      let body; try { body = JSON.parse((await read(req)) || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      const { data, opts } = input(body);
      if (p === "/v1/backtest") { const r = backtest(data, opts); return json(res, 200, { strategy: r.strategy, params: r.params, metrics: r.metrics, trades: body.trades === false ? undefined : r.trades, open: r.open, monthly: r.monthly, equity: thin(r.dates.map((d, i) => [d, Math.round(r.equity[i]), r.bench ? Math.round(r.bench[i]) : null])) }); }
      if (p === "/v1/sweep") { const s = sweep(data, { ...opts, grid: body.grid || GRIDS[opts.strategy], metric: body.metric }); return json(res, 200, s); }
      if (p === "/v1/walkforward") { const w = walkForward(data, { ...opts, grid: body.grid || GRIDS[opts.strategy], train: body.train, test: body.test }); return json(res, 200, { folds: w.folds, oos: w.oos, isSharpe: w.isSharpe, efficiency: w.efficiency, stable: w.stable }); }
      if (p === "/v1/montecarlo") { const runs = body.runs ?? 1000; if (!(runs >= 10 && runs <= 20000)) return json(res, 400, { error: "runs must be 10..20000" }); const r = backtest(data, opts), mc = monteCarlo(r, { runs, block: body.block ?? 10 }); return json(res, 200, { runs: mc.runs, block: mc.block, final: mc.final, cagr: mc.cagr, maxDD: mc.maxDD, pLoss: mc.pLoss, pDD20: mc.pDD20, pDD30: mc.pDD30 }); }
    } catch (e) {
      if (e instanceof StrategyError || e instanceof BacktestError || e instanceof DataError) return json(res, 400, { error: e.message });
      return json(res, e.status || 500, { error: e.message });
    }
  });
}
