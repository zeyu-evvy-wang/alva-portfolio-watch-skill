"use strict";

/**
 * Portfolio Watch — fast-lane signal feed (pw-tech-core-signals).
 * Built from the portfolio-watch skill; methodology in
 * references/signal-taxonomy.md (incl. Residual rule, drift, earnings-day
 * context), policy in references/alert-policy.md.
 * Outputs: portfolio/overview+history, holdings/state (snapshots),
 * signals/events (event log), notify/message (push sidecar).
 */

const { Feed, feedPath, makeDoc, num, str } = require("@alva/feed");
const alfs = require("alfs");
const env = require("env");
const http = require("net/http");
const secret = require("secret-manager");
const engine = require("./signal-engine.js");

// CONFIG literals below (tickers, weights, boundary, shareUrl) are emitted
// per-portfolio by the portfolio-watch skill at build time from the user's
// intake — they are this watch's instance parameters, not the skill's limits.
const CONFIG = {
  // Example portfolio from the demo sentence: "Watch my portfolio: 25% NVDA,
  // 15% MSFT, 15% AAPL, 15% TSLA, 10% MU, 10% JPM, 10% KO — ping me on big stuff."
  tickers: ["NVDA", "MSFT", "AAPL", "TSLA", "MU", "JPM", "KO"],
  weights: { NVDA: 0.25, MSFT: 0.15, AAPL: 0.15, TSLA: 0.15, MU: 0.1, JPM: 0.1, KO: 0.1 },
  benchmark: "SPY",
  sensitivity: "standard",
  // calibrated 2026-07-06 over trailing 60 sessions: 131 recorded signals,
  // 6 market-explained demotions, expected ~0.4 P0/week (calm regime, clamp floor)
  p0Boundary: 55,
  backfillSessions: 15, // first run replays history; ids dedupe on re-runs
  shareUrl: "https://alva.ai/u/evvywang/playbooks/tech-core-watch",
};

const feed = new Feed({ path: feedPath("pw-tech-core-signals") });

feed.def("portfolio", {
  overview: makeDoc("Portfolio Overview", "Portfolio-level state of the watch, one snapshot per day", [
    num("day_return"), num("benchmark_return"), str("benchmark"),
    str("biggest_mover"), num("biggest_move"), str("top_contributor"), num("top_contribution_bps"),
    num("p0_today"), num("p1_today"), num("active_holdings"), str("market_day"), str("as_of"),
  ]),
  history: makeDoc("Portfolio History", "60-session cumulative return of the watch vs its benchmark", [
    num("nav"), num("bench_nav"), num("day_return"), num("bench_return"),
  ]),
});

feed.def("holdings", {
  state: makeDoc("Holdings State", "Per-ticker daily stats and tripwires", [
    str("ticker"), num("weight"), num("last"), num("day_return"), num("z"),
    num("ret_5d"), num("ret_1m"), num("sigma20"), num("beta"), num("vol_ratio"),
    num("off_52w_high"), num("contribution_bps"), num("tripwire_pct"),
  ]),
});

feed.def("signals", {
  events: makeDoc("Signal Events", "Scored watch signals (P0 interrupt / P1 brief / P2 context)", [
    str("signal_id"), str("ticker"), str("dimension"), num("z"), num("value"),
    num("score"), str("bucket"), str("title"), str("detail_json"),
  ]),
});

feed.def("notify", {
  message: makeDoc("Notification", "P0 push per alert-policy; quiet runs carry the skip sentinel", [
    str("title"), str("body"),
  ]),
});

// ---------------------------------------------------------------- helpers

async function fetchDailyBars(jwt, symbol, calendarDays) {
  const now = Math.floor(Date.now() / 1000);
  const url =
    "https://data-tools.prd.space.id/api/v1/stocks/kline?symbol=" + symbol +
    "&start_time=" + (now - calendarDays * 86400) +
    "&end_time=" + now + "&interval=1d&limit=600";
  const resp = await http.fetch(url, { headers: { Authorization: "Bearer " + jwt } });
  if (resp.status !== 200) throw new Error("kline " + symbol + " HTTP " + resp.status);
  const body = await resp.json();
  if (!body.data || body.data.length < engine.DEFAULTS.statsWindow + 2) {
    throw new Error("kline " + symbol + " insufficient: " + ((body.data || []).length) + " bars");
  }
  return body.data.slice().reverse().map((b) => ({
    date: b.time_open * 1000,
    open: b.price_open,
    high: b.price_high,
    low: b.price_low,
    close: b.price_close,
    volume: b.volume_traded,
  }));
}

async function readEarningsToday(todayIso) {
  // Calendar comes from the slow lane; tolerate absence on first runs.
  try {
    const raw = await alfs.readFile("/alva/home/" + env.username + "/feeds/pw-tech-core-catalysts/v1/data/calendar/upcoming/@last/1");
    const rows = JSON.parse(String(raw));
    const set = {};
    (Array.isArray(rows) ? rows : []).forEach((r) => { if (r.event_date === todayIso) set[r.ticker] = true; });
    return set;
  } catch (e) {
    return {};
  }
}

function dayStartMs(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function retOver(bars, sessions) {
  const i = bars.length - 1 - sessions;
  if (i < 0) return 0;
  return bars[bars.length - 1].close / bars[i].close - 1;
}

function r4(x) { return Math.round(x * 10000) / 10000; }
function r2(x) { return Math.round(x * 100) / 100; }
function fmtPct(x) { return (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(1) + "%"; }

function portfolioReturns(barsBy, cfg, sessions) {
  const len = Math.min.apply(null, cfg.tickers.map((t) => barsBy[t].length));
  const out = [];
  for (let k = len - sessions; k < len; k++) {
    if (k < 1) continue;
    let r = 0;
    for (const t of cfg.tickers) {
      const bars = barsBy[t];
      const i = bars.length - len + k;
      r += cfg.weights[t] * (bars[i].close / bars[i - 1].close - 1);
    }
    out.push(r);
  }
  return out;
}

function signalTitle(s) {
  const d = s.detail || {};
  if (s.dimension === "pf.move") return "Portfolio " + fmtPct(s.value) + " (" + s.z.toFixed(1) + "σ vs its own 20-day norm)";
  if (s.dimension === "pf.drawdown") return "Portfolio drawdown crossed " + Math.round((d.step || 0) * 100) + "% from its 90-day peak";
  if (s.dimension === "level.52w") return s.ticker + " crossed its 52-week " + (d.side === "high" ? "high" : "low");
  if (s.dimension === "level.ma200") return s.ticker + " crossed " + (s.value > 0 ? "above" : "below") + " its 200-day average";
  if (s.dimension === "vol.spike") return s.ticker + " volume " + s.value.toFixed(1) + "× its 20-day average";
  if (s.dimension === "move.drift") return s.ticker + " has ground " + fmtPct(s.value) + " over " + (d.windowSessions || 5) + " sessions (" + s.z.toFixed(1) + "σ weekly) — no single big day";
  if (s.dimension === "move.intraday") return s.ticker + " intraday swing " + fmtPct(s.value) + " with sharp reversal";
  let t = s.ticker + " " + fmtPct(s.value);
  if (d.marketExplained) {
    t += " (" + (d.rawZ || 0).toFixed(1) + "σ raw · " + (d.zResid || 0).toFixed(1) + "σ vs market) — moved with the market";
  } else {
    t += " (" + s.z.toFixed(1) + "σ)";
    if (d.volRatio) t += " on " + d.volRatio.toFixed(1) + "× volume";
  }
  if (s.dimension === "move.gap") t += " at the open";
  if (d.earningsDay) t += " · earnings day (elevated volatility expected)";
  return t;
}

// ------------------------------------------------------------------- main

(async () => {
  const jwt = secret.loadPlaintext("ARRAYS_JWT");
  if (!jwt) throw new Error("ARRAYS_JWT missing — run alva arrays token ensure");

  const barsBy = {};
  for (const t of CONFIG.tickers.concat([CONFIG.benchmark])) {
    barsBy[t] = await fetchDailyBars(jwt, t, 520);
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  const earningsToday = await readEarningsToday(todayIso);

  await feed.run(async (ctx) => {
    const nowMs = Date.now();
    const snapDate = dayStartMs(nowMs);
    const positions = {};
    const holdingRows = [];
    const rawSignals = [];

    const benchBars = barsBy[CONFIG.benchmark];
    const benchStats = engine.computeStats(benchBars);
    const benchLast = benchBars[benchBars.length - 1];
    const benchDay = benchLast.close / benchStats.prevClose - 1;

    for (const t of CONFIG.tickers) {
      const bars = barsBy[t];
      const stats = engine.computeStats(bars);
      const last = bars[bars.length - 1];
      const dayReturn = last.close / stats.prevClose - 1;
      positions[t] = { weight: CONFIG.weights[t], dayReturn: dayReturn };
      const betaCtx = engine.computeBeta(bars, benchBars);
      const mc = betaCtx ? Object.assign({ benchReturn: benchDay }, betaCtx) : null;
      const tw = engine.p0Tripwire(stats, CONFIG.weights[t], CONFIG.p0Boundary);
      holdingRows.push({
        date: snapDate,
        ticker: t,
        weight: r4(CONFIG.weights[t]),
        last: last.close,
        day_return: r4(dayReturn),
        z: stats.sigma ? r2(Math.abs(dayReturn) / stats.sigma) : 0,
        ret_5d: r4(retOver(bars, 5)),
        ret_1m: r4(retOver(bars, 21)),
        sigma20: r4(stats.sigma),
        beta: betaCtx ? r2(betaCtx.beta) : 0,
        vol_ratio: stats.avgVolume ? r2(last.volume / stats.avgVolume) : 0,
        off_52w_high: r4(last.close / stats.high52w - 1),
        contribution_bps: Math.round(CONFIG.weights[t] * dayReturn * 10000),
        tripwire_pct: tw == null ? -1 : tw,
      });
      const sigs = engine.detectMarketSignals(t, bars, stats, engine.DEFAULTS, mc);
      for (const s of sigs) {
        if (earningsToday[t] && s.dimension.indexOf("move.") === 0) s.detail.earningsDay = true;
      }
      rawSignals.push.apply(rawSignals, sigs);
    }

    // Backfill: replay the trailing sessions so the interface opens with
    // real history (ids dedupe; pushes only consider the latest session).
    for (const t of CONFIG.tickers) {
      const full = barsBy[t];
      for (let off = 1; off < CONFIG.backfillSessions; off++) {
        if (full.length - off < engine.DEFAULTS.statsWindow + 2) break;
        const bars = full.slice(0, full.length - off);
        const stats = engine.computeStats(bars);
        const bSlice = benchBars.slice(0, benchBars.length - off);
        const bReturn = bSlice[bSlice.length - 1].close / bSlice[bSlice.length - 2].close - 1;
        const bCtx = engine.computeBeta(bars, bSlice);
        const mc = bCtx ? Object.assign({ benchReturn: bReturn }, bCtx) : null;
        rawSignals.push.apply(rawSignals, engine.detectMarketSignals(t, bars, stats, engine.DEFAULTS, mc));
      }
    }

    // Portfolio-level signals over the 120-session weighted return series.
    const pfSeries = portfolioReturns(barsBy, CONFIG, 120);
    const pfPast = pfSeries.slice(0, -1);
    let nav = 1;
    const navs = pfSeries.map((r) => (nav *= 1 + r));
    const peak90 = Math.max.apply(null, navs.slice(-90));
    const firedStep = await ctx.kv.load("pfFiredStep");
    const pfState = { nav: navs[navs.length - 1], peak90d: peak90, firedStep: firedStep ? Number(firedStep) : null };
    const posList = CONFIG.tickers.map((t) => ({ ticker: t, weight: positions[t].weight, dayReturn: positions[t].dayReturn }));
    rawSignals.push.apply(rawSignals, engine.detectPortfolioSignals(posList, pfPast, pfState, nowMs));
    if (pfState.firedStep != null) await ctx.kv.put("pfFiredStep", String(pfState.firedStep));

    const buckets = { p0: CONFIG.p0Boundary, p1: engine.DEFAULTS.buckets.p1 };
    const scored = engine.consolidate(engine.scoreAll(rawSignals, positions, buckets));

    const emitted = JSON.parse((await ctx.kv.load("emittedIds")) || "[]");
    const fresh = scored.filter((s) => emitted.indexOf(s.id) < 0);
    if (fresh.length) {
      await ctx.self.ts("signals", "events").append(fresh.map((s) => ({
        date: s.dateMs,
        signal_id: s.id,
        ticker: s.ticker,
        dimension: s.dimension,
        z: r2(s.z || 0),
        value: r4(s.value || 0),
        score: s.score,
        bucket: s.bucket,
        title: signalTitle(s),
        detail_json: JSON.stringify(s.detail || {}),
      })));
      await ctx.kv.put("emittedIds", JSON.stringify(emitted.concat(fresh.map((s) => s.id)).slice(-300)));
    }

    // Overview snapshot. "Market day" = benchmark itself moved abnormally.
    const pfDay = posList.reduce((s, p) => s + p.weight * p.dayReturn, 0);
    const biggest = posList.slice().sort((a, b) => Math.abs(b.dayReturn) - Math.abs(a.dayReturn))[0];
    const topContrib = posList.slice().sort((a, b) => Math.abs(b.weight * b.dayReturn) - Math.abs(a.weight * a.dayReturn))[0];
    const todayScored = scored.filter((s) => dayStartMs(s.dateMs) === snapDate);
    const marketDay = benchStats.sigma > 0 && Math.abs(benchDay) / benchStats.sigma >= 1.5;
    await ctx.self.ts("portfolio", "overview").append([{
      date: snapDate,
      day_return: r4(pfDay),
      benchmark_return: r4(benchDay),
      benchmark: CONFIG.benchmark,
      biggest_mover: biggest.ticker,
      biggest_move: r4(biggest.dayReturn),
      top_contributor: topContrib.ticker,
      top_contribution_bps: Math.round(topContrib.weight * topContrib.dayReturn * 10000),
      p0_today: todayScored.filter((s) => s.bucket === "P0").length,
      p1_today: todayScored.filter((s) => s.bucket === "P1").length,
      active_holdings: CONFIG.tickers.length,
      market_day: marketDay ? "yes" : "no",
      as_of: new Date(nowMs).toISOString(),
    }]);
    await ctx.self.ts("holdings", "state").append(holdingRows);

    // 60-session NAV history vs benchmark (append dedups by date).
    const histLen = Math.min.apply(null, CONFIG.tickers.concat([CONFIG.benchmark]).map((t) => barsBy[t].length));
    const histRows = [];
    let hNav = 1, hBench = 1;
    for (let k = histLen - 60; k < histLen; k++) {
      if (k < 1) continue;
      let r = 0;
      for (const t of CONFIG.tickers) {
        const bars = barsBy[t];
        const i = bars.length - histLen + k;
        r += CONFIG.weights[t] * (bars[i].close / bars[i - 1].close - 1);
      }
      const bi = benchBars.length - histLen + k;
      const br = benchBars[bi].close / benchBars[bi - 1].close - 1;
      hNav *= 1 + r;
      hBench *= 1 + br;
      histRows.push({ date: benchBars[bi].date, nav: r4(hNav), bench_nav: r4(hBench), day_return: r4(r), bench_return: r4(br) });
    }
    await ctx.self.ts("portfolio", "history").append(histRows);

    // Push: cooldown + budget over the LATEST session's fresh P0s only —
    // backfilled history must never page the user about old news.
    const latestBarDay = dayStartMs(barsBy[CONFIG.tickers[0]][barsBy[CONFIG.tickers[0]].length - 1].date);
    const freshToday = fresh.filter((s) => dayStartMs(s.dateMs) >= latestBarDay);
    const cbState = JSON.parse((await ctx.kv.load("cooldownState")) || "null");
    const res = engine.applyCooldownAndBudget(freshToday, cbState, nowMs);
    await ctx.kv.put("cooldownState", JSON.stringify(res.state));
    let title = "Portfolio Watch";
    let body = engine.SKIP_NOTIFICATION;
    if (res.push.length) {
      const largestHolding = posList.slice().sort((a, b) => b.weight - a.weight)[0].ticker;
      const msg = engine.formatP0Push(res.push, {
        dayReturn: pfDay,
        largestHolding: largestHolding,
        topContributionPt: (topContrib.weight * topContrib.dayReturn >= 0 ? "+" : "−") + Math.abs(topContrib.weight * topContrib.dayReturn * 100).toFixed(1) + "pt",
        benchmark: { name: CONFIG.benchmark, dayReturn: benchDay },
      }, CONFIG.shareUrl);
      title = msg.title;
      body = msg.body;
    }
    await ctx.self.ts("notify", "message").append([{ date: nowMs, title: title, body: body }]);
  });
})();
