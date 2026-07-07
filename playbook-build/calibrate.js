"use strict";

/**
 * Portfolio Watch — calibration backfill (build-plan.md step 4).
 * Replays the signal engine (incl. the Residual rule) over the trailing 60
 * sessions of the actual portfolio and picks the P0 boundary hitting the
 * 1-3 alerts/week target.
 * Run: alva run --entry-path '~/library/portfolio-watch/calibrate.js'
 */

const http = require("net/http");
const secret = require("secret-manager");
const engine = require("./signal-engine.js");

const TICKERS = ["NVDA", "MSFT", "AAPL", "TSLA", "MU", "JPM", "KO"];
const WEIGHTS = { NVDA: 0.25, MSFT: 0.15, AAPL: 0.15, TSLA: 0.15, MU: 0.1, JPM: 0.1, KO: 0.1 };
const BENCHMARK = "SPY";
const SESSIONS = 60;

async function fetchDailyBars(jwt, symbol, calendarDays) {
  const now = Math.floor(Date.now() / 1000);
  const url =
    "https://data-tools.prd.space.id/api/v1/stocks/kline?symbol=" + symbol +
    "&start_time=" + (now - calendarDays * 86400) +
    "&end_time=" + now + "&interval=1d&limit=600";
  const resp = await http.fetch(url, { headers: { Authorization: "Bearer " + jwt } });
  if (resp.status !== 200) throw new Error("kline " + symbol + " HTTP " + resp.status);
  const body = await resp.json();
  if (!body.data || !body.data.length) throw new Error("kline " + symbol + " empty");
  return body.data.slice().reverse().map((b) => ({
    date: b.time_open * 1000,
    open: b.price_open,
    high: b.price_high,
    low: b.price_low,
    close: b.price_close,
    volume: b.volume_traded,
  }));
}

(async () => {
  const jwt = secret.loadPlaintext("ARRAYS_JWT");
  if (!jwt) throw new Error("ARRAYS_JWT missing");

  const barsBy = {};
  for (const t of TICKERS.concat([BENCHMARK])) barsBy[t] = await fetchDailyBars(jwt, t, 520);
  const len = Math.min.apply(null, TICKERS.concat([BENCHMARK]).map((t) => barsBy[t].length));
  if (len < engine.DEFAULTS.statsWindow + SESSIONS + 2) {
    throw new Error("not enough aligned history: " + len + " bars");
  }

  const dailyScores = [];
  let marketExplainedCount = 0;
  for (let k = len - SESSIONS; k < len; k++) {
    const positions = {};
    const daySignals = [];
    const benchSlice = barsBy[BENCHMARK].slice(0, barsBy[BENCHMARK].length - len + k + 1);
    const benchReturn = benchSlice[benchSlice.length - 1].close / benchSlice[benchSlice.length - 2].close - 1;
    for (const t of TICKERS) {
      const bars = barsBy[t].slice(0, barsBy[t].length - len + k + 1);
      const stats = engine.computeStats(bars);
      const dayReturn = bars[bars.length - 1].close / stats.prevClose - 1;
      positions[t] = { weight: WEIGHTS[t], dayReturn: dayReturn };
      const betaCtx = engine.computeBeta(bars, benchSlice);
      const mc = betaCtx ? Object.assign({ benchReturn: benchReturn }, betaCtx) : null;
      const sigs = engine.detectMarketSignals(t, bars, stats, engine.DEFAULTS, mc);
      for (const s of sigs) if (s.detail && s.detail.marketExplained) marketExplainedCount++;
      daySignals.push.apply(daySignals, sigs);
    }
    const scored = engine.consolidate(engine.scoreAll(daySignals, positions, engine.DEFAULTS.buckets));
    dailyScores.push({ dateMs: k, scores: scored.map((s) => s.score) });
  }

  const cal = engine.calibrateP0Boundary(dailyScores);
  const tripwires = {};
  for (const t of TICKERS) {
    tripwires[t] = engine.p0Tripwire(engine.computeStats(barsBy[t]), WEIGHTS[t], cal.boundary);
  }
  return JSON.stringify({
    sessions: SESSIONS,
    totalRecordedSignals: dailyScores.reduce((n, d) => n + d.scores.length, 0),
    marketExplainedDemotions: marketExplainedCount,
    calibration: cal,
    tripwiresPct: tripwires,
  });
})();
