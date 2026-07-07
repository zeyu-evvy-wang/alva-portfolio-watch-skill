"use strict";

/**
 * Portfolio Watch — signal engine (reference implementation).
 *
 * Pure functions only: no I/O, no Alva API calls, no Node builtins, so it
 * runs unchanged in the jagent runtime. Feed code wires session-discovered
 * Data Skills endpoints to these inputs; see references/build-plan.md.
 *
 * Formulas implement references/signal-taxonomy.md exactly. If the two ever
 * disagree, the taxonomy doc wins — fix this file.
 *
 * Bar shape: { date:number(ms), open, high, low, close, volume }
 * Bars are daily, oldest-first. The last bar may be a live partial bar.
 */

const DEFAULTS = {
  sensitivity: "standard", // quiet | standard | verbose
  zScale: { quiet: 1.25, standard: 1.0, verbose: 0.8 },
  zRecord: 1.5, // record a move.day signal at this z
  absFloor: 0.01, // ignore |day move| < 1% regardless of z
  gapSigma: 1.5,
  intradaySigma: 3.0,
  volSpikeRatio: 3.0,
  driftSigma: 2.2, // 5-session cumulative z threshold (episode-edged)
  driftWindow: 5,
  residualExplainZ: 1.0, // below this residual z on a market day = market-explained
  benchMoveFloor: 0.01, // benchmark must move at least this for the Residual rule
  betaWindow: 60, // sessions for beta regression
  statsWindow: 20, // trading days for sigma / avg volume
  pfSigma: 2.0,
  drawdownSteps: [-0.05, -0.1, -0.15],
  buckets: { p0: 60, p1: 35 }, // p0 is calibrated within clamp
  p0Clamp: [55, 75],
  p0TargetPerWeek: [1, 3],
  budgetPerDay: { quiet: 2, standard: 4, verbose: 6 },
  cooldownMs: 4 * 3600 * 1000,
  eventBase: {
    "evt.earnings.result": 10,
    "evt.news.mna": 8,
    "evt.news.regulatory": 8,
    "evt.news.guidance": 8,
    "evt.rating.cluster": 6,
    "evt.insider.cluster": 5,
    "evt.rating": 4,
    "evt.news.other": 4,
    "evt.insider": 3,
    "level.52w": 3,
    "level.ma200": 3,
    "social.kol": 3,
    "vol.spike": 2,
    "evt.corp": 1,
  },
};

// ---------------------------------------------------------------- helpers

function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function signalId(ticker, dimension, dateMs) {
  return ticker + ":" + dimension + ":" + dayKey(dateMs);
}

function dailyReturns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    out.push(bars[i].close / bars[i - 1].close - 1);
  }
  return out;
}

// ------------------------------------------------------------------ stats

/**
 * Baselines exclude the latest (possibly live) bar.
 * Needs >= statsWindow+1 closed bars; throws otherwise (fail fast, per
 * feed-lifecycle rules — no silent fallbacks).
 */
function computeStats(bars, cfg = DEFAULTS) {
  const w = cfg.statsWindow;
  if (bars.length < w + 2) {
    throw new Error("computeStats: need >= " + (w + 2) + " bars, got " + bars.length);
  }
  const closed = bars.slice(0, -1);
  const rets = dailyReturns(closed).slice(-w);
  const vols = closed.slice(-w).map((b) => b.volume);
  const year = closed.slice(-252);
  const ma200src = closed.slice(-200);
  return {
    sigma: stdev(rets),
    avgVolume: mean(vols),
    high52w: Math.max.apply(null, year.map((b) => b.high)),
    low52w: Math.min.apply(null, year.map((b) => b.low)),
    ma200: ma200src.length >= 200 ? mean(ma200src.map((b) => b.close)) : null,
    prevClose: closed[closed.length - 1].close,
  };
}

/**
 * Beta + residual volatility of a ticker vs its benchmark, from aligned
 * daily bars (both oldest-first, excluding the live bar). Implements the
 * Residual rule in signal-taxonomy.md.
 */
function computeBeta(bars, benchBars, cfg = DEFAULTS) {
  const n = Math.min(bars.length, benchBars.length) - 1; // closed bars only
  const w = Math.min(cfg.betaWindow, n - 1);
  if (w < 20) return null; // not enough aligned history — skip the rule
  const rs = dailyReturns(bars.slice(0, n)).slice(-w);
  const rb = dailyReturns(benchBars.slice(0, n)).slice(-w);
  const mS = mean(rs), mB = mean(rb);
  let cov = 0, varB = 0;
  for (let i = 0; i < rs.length; i++) {
    cov += (rs[i] - mS) * (rb[i] - mB);
    varB += (rb[i] - mB) * (rb[i] - mB);
  }
  if (varB === 0) return null;
  const beta = cov / varB;
  const resid = rs.map((r, i) => r - beta * rb[i]).slice(-cfg.statsWindow);
  return { beta: beta, residSigma: stdev(resid) };
}

// ---------------------------------------------------------------- signals

/**
 * Detect fast-lane market signals for one ticker on the latest bar.
 * Returns raw signals: { id, ticker, dimension, dateMs, z, value, detail }.
 * Crossing signals (level.*) need yesterday's state; pass prior close via
 * stats.prevClose and prior-day extremes implicitly via 52w window.
 * marketCtx (optional): { benchReturn, beta, residSigma } enables the
 * Residual rule — market-explained moves are scored on residual z.
 */
function detectMarketSignals(ticker, bars, stats, cfg = DEFAULTS, marketCtx = null) {
  const zk = cfg.zScale[cfg.sensitivity] || 1.0;
  const bar = bars[bars.length - 1];
  const out = [];
  if (!stats.sigma) return out; // degenerate history; caller decides

  const r = bar.close / stats.prevClose - 1;
  const rawZ = Math.abs(r) / stats.sigma;
  let z = rawZ;
  let residual = null;
  if (marketCtx && marketCtx.residSigma > 0 && Math.abs(marketCtx.benchReturn) >= cfg.benchMoveFloor) {
    const rResid = r - marketCtx.beta * marketCtx.benchReturn;
    const zResid = Math.abs(rResid) / marketCtx.residSigma;
    residual = { zResid: zResid, beta: marketCtx.beta, benchReturn: marketCtx.benchReturn };
    if (zResid < cfg.residualExplainZ) z = zResid; // market-explained: demote naturally
  }

  if (rawZ >= cfg.zRecord * zk && Math.abs(r) >= cfg.absFloor) {
    out.push({
      id: signalId(ticker, "move.day", bar.date), ticker, dimension: "move.day", dateMs: bar.date,
      z, value: r,
      detail: {
        sigma: stats.sigma, rawZ: rawZ,
        marketExplained: !!(residual && z !== rawZ),
        zResid: residual ? residual.zResid : null,
        beta: residual ? residual.beta : null,
      },
    });
  }

  // Slow bleed: 5-session cumulative move, episode-edged, only when no
  // daily move fired today (else it double-counts the same event).
  const dw = cfg.driftWindow;
  if (bars.length > dw + 2 && rawZ < cfg.zRecord * zk) {
    const sqrtW = Math.sqrt(dw);
    const cum = bar.close / bars[bars.length - 1 - dw].close - 1;
    const cumPrev = bars[bars.length - 2].close / bars[bars.length - 2 - dw].close - 1;
    const zDrift = Math.abs(cum) / (stats.sigma * sqrtW);
    const zDriftPrev = Math.abs(cumPrev) / (stats.sigma * sqrtW);
    if (zDrift >= cfg.driftSigma * zk && zDriftPrev < cfg.driftSigma * zk) {
      out.push({ id: signalId(ticker, "move.drift", bar.date), ticker, dimension: "move.drift", dateMs: bar.date, z: zDrift, value: cum, detail: { windowSessions: dw } });
    }
  }

  const gap = bar.open / stats.prevClose - 1;
  if (Math.abs(gap) >= cfg.gapSigma * zk * stats.sigma && Math.abs(gap) >= cfg.absFloor) {
    out.push({ id: signalId(ticker, "move.gap", bar.date), ticker, dimension: "move.gap", dateMs: bar.date, z: Math.abs(gap) / stats.sigma, value: gap, detail: {} });
  }

  const range = (bar.high - bar.low) / stats.prevClose;
  const retrace = bar.high === bar.low ? 0 : Math.min(bar.high - bar.close, bar.close - bar.low) / (bar.high - bar.low);
  if (range >= cfg.intradaySigma * zk * stats.sigma && retrace >= 0.5) {
    out.push({ id: signalId(ticker, "move.intraday", bar.date), ticker, dimension: "move.intraday", dateMs: bar.date, z: range / stats.sigma, value: range, detail: { retrace } });
  }

  if (stats.avgVolume > 0 && bar.volume / stats.avgVolume >= cfg.volSpikeRatio) {
    out.push({ id: signalId(ticker, "vol.spike", bar.date), ticker, dimension: "vol.spike", dateMs: bar.date, z: 0, value: bar.volume / stats.avgVolume, detail: {} });
  }

  if (bar.close > stats.high52w && stats.prevClose <= stats.high52w) {
    out.push({ id: signalId(ticker, "level.52w", bar.date), ticker, dimension: "level.52w", dateMs: bar.date, z: 0, value: 1, detail: { side: "high" } });
  } else if (bar.close < stats.low52w && stats.prevClose >= stats.low52w) {
    out.push({ id: signalId(ticker, "level.52w", bar.date), ticker, dimension: "level.52w", dateMs: bar.date, z: 0, value: -1, detail: { side: "low" } });
  }

  if (stats.ma200 != null) {
    const above = bar.close > stats.ma200;
    const wasAbove = stats.prevClose > stats.ma200;
    if (above !== wasAbove) {
      out.push({ id: signalId(ticker, "level.ma200", bar.date), ticker, dimension: "level.ma200", dateMs: bar.date, z: 0, value: above ? 1 : -1, detail: {} });
    }
  }
  return out;
}

/**
 * Portfolio-level signals.
 * positions: [{ ticker, weight, dayReturn }], pfReturns: trailing daily
 * portfolio returns (excluding today), pfState: { peak90d, firedStep }.
 */
function detectPortfolioSignals(positions, pfReturns, pfState, nowMs, cfg = DEFAULTS) {
  const out = [];
  const rPf = positions.reduce((s, p) => s + p.weight * p.dayReturn, 0);
  const sigmaPf = stdev(pfReturns.slice(-cfg.statsWindow));
  if (sigmaPf > 0 && Math.abs(rPf) / sigmaPf >= cfg.pfSigma * (cfg.zScale[cfg.sensitivity] || 1)) {
    out.push({ id: signalId("PF", "pf.move", nowMs), ticker: "PF", dimension: "pf.move", dateMs: nowMs, z: Math.abs(rPf) / sigmaPf, value: rPf, detail: { sigmaPf } });
  }
  if (pfState && pfState.peak90d > 0) {
    const dd = pfState.nav / pfState.peak90d - 1;
    for (const step of cfg.drawdownSteps) {
      if (dd <= step && (pfState.firedStep == null || step < pfState.firedStep)) {
        out.push({ id: signalId("PF", "pf.drawdown", nowMs), ticker: "PF", dimension: "pf.drawdown", dateMs: nowMs, z: 0, value: dd, detail: { step } });
        pfState.firedStep = step;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- scoring

/**
 * severity = magnitude + impact + corroboration + eventBase, capped 100.
 * opts: { weight, dayReturn, corroborationCount, eventKey }
 */
function scoreSignal(sig, opts, cfg = DEFAULTS) {
  const magnitude = sig.z > 0 ? Math.min(40, Math.max(0, 20 * (sig.z - 1.5))) : 0;
  // Crossing/volume dims carry no portfolio impact of their own — their
  // attention value flows through corroboration of a same-day move.
  const noImpact = /^(level\.|vol\.)/.test(sig.dimension);
  const bps = noImpact ? 0 : Math.abs((opts.weight || 0) * (opts.dayReturn || 0)) * 10000;
  const impact = Math.min(30, bps / 5);
  const corroboration = Math.min(20, 10 * (opts.corroborationCount || 0));
  const eventBase = cfg.eventBase[opts.eventKey || sig.dimension] || 0;
  return Math.min(100, Math.round(magnitude + impact + corroboration + eventBase));
}

function bucketize(score, buckets = DEFAULTS.buckets) {
  if (score >= buckets.p0) return "P0";
  if (score >= buckets.p1) return "P1";
  return "P2";
}

/**
 * Count distinct co-firing dimensions per (ticker, day) — batches may span
 * several sessions when a feed backfills — then score+bucket all. Move
 * signals carry their own day's return, so historical replays score
 * correctly.
 */
function scoreAll(signals, positionsByTicker, buckets, cfg = DEFAULTS) {
  const dims = {};
  for (const s of signals) {
    const key = s.ticker + ":" + dayKey(s.dateMs);
    (dims[key] = dims[key] || new Set()).add(s.dimension);
  }
  return signals.map((s) => {
    const pos = positionsByTicker[s.ticker] || { weight: 0, dayReturn: s.value || 0 };
    const ownMove = s.ticker === "PF" || s.dimension.indexOf("move.") === 0;
    const score = scoreSignal(s, {
      weight: s.ticker === "PF" ? 1 : pos.weight,
      dayReturn: ownMove ? (s.value || 0) : pos.dayReturn,
      corroborationCount: Math.max(0, dims[s.ticker + ":" + dayKey(s.dateMs)].size - 1),
    }, cfg);
    return Object.assign({}, s, { score, bucket: bucketize(score, buckets) });
  });
}

const CORROBORATING = ["move.gap", "move.intraday", "vol.spike"];

/**
 * One market event = one signal. If move.day fired for a ticker, fold
 * same-day corroborating dimensions into it — they already raised its
 * corroboration score in scoreAll, so standalone they would double-count
 * (and double-push) the same event. level.* and pf.* stay standalone.
 * Pipeline: detect → scoreAll → consolidate → applyCooldownAndBudget.
 */
function consolidate(scored) {
  const anchors = {};
  for (const s of scored) {
    if (s.dimension === "move.day") anchors[s.ticker + ":" + dayKey(s.dateMs)] = s;
  }
  const out = [];
  for (const s of scored) {
    const anchor = anchors[s.ticker + ":" + dayKey(s.dateMs)];
    if (anchor && anchor !== s && CORROBORATING.indexOf(s.dimension) >= 0) {
      (anchor.detail.corroborators = anchor.detail.corroborators || []).push({ dimension: s.dimension, value: s.value });
      if (s.dimension === "vol.spike") anchor.detail.volRatio = s.value;
      continue;
    }
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------ calibration

/**
 * Pick the P0 boundary from a backfill so the trailing P0 rate lands in
 * target/week. dailyScores: [{ dateMs, scores:[...] }] over ~60 sessions.
 */
function calibrateP0Boundary(dailyScores, cfg = DEFAULTS) {
  const weeks = Math.max(1, dailyScores.length / 5);
  const [lo, hi] = cfg.p0Clamp;
  const [tLo, tHi] = cfg.p0TargetPerWeek;
  let boundary = cfg.buckets.p0;
  const ratePerWeek = (b) => dailyScores.reduce((n, d) => n + d.scores.filter((s) => s >= b).length, 0) / weeks;
  for (let i = 0; i < 25 && ratePerWeek(boundary) > tHi && boundary < hi; i++) boundary += 1;
  for (let i = 0; i < 25 && ratePerWeek(boundary) < tLo / 2 && boundary > lo; i++) boundary -= 1;
  return {
    boundary,
    expectedP0PerWeek: Math.round(ratePerWeek(boundary) * 10) / 10,
    expectedP1PerDay: Math.round((dailyScores.reduce((n, d) => n + d.scores.filter((s) => s >= cfg.buckets.p1 && s < boundary).length, 0) / Math.max(1, dailyScores.length)) * 10) / 10,
  };
}

/**
 * Smallest |day move| that would reach the P0 boundary for this holding
 * today, assuming no corroboration: solves
 *   20*(|r|/sigma - 1.5) + min(30, |r|*weight*10000/5) >= boundary
 * Shown in the interface methodology footer ("would ping you today at ±x%").
 */
function p0Tripwire(stats, weight, boundary, cfg = DEFAULTS) {
  if (!stats.sigma) return null;
  for (let r = 0.005; r <= 0.5; r += 0.001) {
    const magnitude = Math.min(40, Math.max(0, 20 * (r / stats.sigma - 1.5)));
    const impact = Math.min(30, (r * (weight || 0) * 10000) / 5);
    if (r >= cfg.absFloor && magnitude + impact >= boundary) {
      return Math.round(r * 1000) / 10; // percent, 1 decimal
    }
  }
  return null; // unreachable within ±50% — report as "no realistic tripwire"
}

// ------------------------------------------------- cooldown, budget, push

/**
 * state: { lastFired: {"tkr:dim": {ts, score, bucket}}, budgetDay, budgetUsed }
 * Returns { push, deferred, state }. Deferred P0s still go to interface+digest.
 */
function applyCooldownAndBudget(scored, state, nowMs, cfg = DEFAULTS) {
  const st = {
    lastFired: (state && state.lastFired) || {},
    budgetDay: (state && state.budgetDay) || dayKey(nowMs),
    budgetUsed: (state && state.budgetUsed) || 0,
  };
  if (st.budgetDay !== dayKey(nowMs)) {
    st.budgetDay = dayKey(nowMs);
    st.budgetUsed = 0;
  }
  const budget = cfg.budgetPerDay[cfg.sensitivity] || 4;
  const push = [];
  const deferred = [];
  for (const s of scored) {
    if (s.bucket !== "P0") continue;
    const key = s.ticker + ":" + s.dimension;
    const prev = st.lastFired[key];
    const cooled = !prev || nowMs - prev.ts >= cfg.cooldownMs;
    const escalated = prev && (bucketRank(s.bucket) > bucketRank(prev.bucket) || Math.abs(s.value || 0) >= 2 * Math.abs(prev.value || 0));
    if (!cooled && !escalated) continue; // suppressed repeat
    st.lastFired[key] = { ts: nowMs, score: s.score, bucket: s.bucket, value: s.value };
    if (st.budgetUsed < budget) push.push(s);
    else deferred.push(s);
  }
  if (push.length) st.budgetUsed += 1; // merged pushes cost one budget unit
  return { push, deferred, state: st };
}

function bucketRank(b) {
  return b === "P0" ? 2 : b === "P1" ? 1 : 0;
}

// ------------------------------------------------------------- formatting

function pct(x, digits = 1) {
  return (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(digits) + "%";
}

function signalLine(s) {
  const zPart = s.z > 0 ? " (" + s.z.toFixed(1) + "σ vs its 20-day norm)" : "";
  return s.ticker + " " + pct(s.value || 0) + zPart;
}

/** Templates per references/alert-policy.md. Returns { title, body }. */
function formatP0Push(pushSignals, portfolio, shareUrl) {
  if (!pushSignals.length) return null;
  const top = pushSignals.slice().sort((a, b) => b.score - a.score)[0];
  const link = "[Open Portfolio Watch](" + shareUrl + "?signal=" + encodeURIComponent(top.id) + ")";
  if (pushSignals.length === 1) {
    const lines = [signalLine(top) + (top.detail && top.detail.volRatio ? " on " + top.detail.volRatio.toFixed(1) + "× average volume." : ".")];
    if (portfolio) lines.push("Portfolio impact: " + pct(portfolio.dayReturn) + " today; " + top.ticker + " contributed " + (portfolio.topContributionPt || "n/a") + ".");
    if (top.why) lines.push("Why: " + top.why);
    lines.push(link);
    return { title: "🔴 " + top.ticker + " " + pct(top.value || 0) + (portfolio && portfolio.largestHolding === top.ticker ? " · your largest holding" : ""), body: lines.join("\n") };
  }
  const tickers = pushSignals.map((s) => s.ticker).filter((t, i, a) => a.indexOf(t) === i);
  const body = [
    pushSignals.map(signalLine).join(" · "),
    portfolio ? "Portfolio " + pct(portfolio.dayReturn) + " today" + (portfolio.benchmark ? " vs " + portfolio.benchmark.name + " " + pct(portfolio.benchmark.dayReturn) : "") + "." : "",
    link,
  ].filter(Boolean).join("\n");
  return { title: "🔴 Portfolio " + pct(portfolio ? portfolio.dayReturn : 0) + " · " + tickers.length + " holding" + (tickers.length > 1 ? "s" : "") + " moving", body };
}

const SKIP_NOTIFICATION = "<|SKIP_NOTIFICATION|>";

module.exports = {
  DEFAULTS,
  SKIP_NOTIFICATION,
  computeStats,
  computeBeta,
  detectMarketSignals,
  detectPortfolioSignals,
  scoreSignal,
  scoreAll,
  consolidate,
  bucketize,
  calibrateP0Boundary,
  p0Tripwire,
  applyCooldownAndBudget,
  formatP0Push,
  // exported for feed-side unit tests
  _internals: { mean, stdev, dailyReturns, signalId },
};
