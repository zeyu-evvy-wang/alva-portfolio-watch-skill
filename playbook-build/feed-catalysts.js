"use strict";

/**
 * Portfolio Watch — slow-lane catalysts feed (pw-tech-core-catalysts).
 * Daily run after US close: earnings calendar, analyst PT news, tracked-KOL
 * echo, and the three-beat Daily Brief (grounded on computed inputs only).
 * Outputs: events/stream (event log), calendar/upcoming (snapshot),
 * digest/daily (event log), notify/message (brief push).
 */

const { ask } = require("@alva/alvaask");
const { Feed, feedPath, makeDoc, num, str } = require("@alva/feed");
const http = require("net/http");
const secret = require("secret-manager");

// CONFIG literals below (tickers, weights, boundary, shareUrl) are emitted
// per-portfolio by the portfolio-watch skill at build time from the user's
// intake — they are this watch's instance parameters, not the skill's limits.
const CONFIG = {
  tickers: ["NVDA", "MSFT", "AAPL", "TSLA", "MU", "JPM", "KO"],
  weights: { NVDA: 0.25, MSFT: 0.15, AAPL: 0.15, TSLA: 0.15, MU: 0.1, JPM: 0.1, KO: 0.1 },
  shareUrl: "https://alva.ai/u/evvywang/playbooks/tech-core-watch",
  kolBurstRatio: 3,
  kolBurstMin: 15,
};

const feed = new Feed({
  path: feedPath("pw-tech-core-catalysts"),
  upstreams: { signals: "@evvywang/feeds/pw-tech-core-signals/v1" },
});

feed.def("events", {
  stream: makeDoc("Catalyst Events", "Earnings reminders, analyst actions, KOL echo (context, not causes)", [
    str("event_id"), str("ticker"), str("kind"), str("bucket"), str("title"),
    str("detail"), str("source"),
  ]),
});

feed.def("calendar", {
  upcoming: makeDoc("Upcoming Catalysts", "Confirmed upcoming catalysts (earnings dates)", [
    str("ticker"), str("event"), str("event_date"), str("note"),
  ]),
});

feed.def("digest", {
  daily: makeDoc("Daily Brief", "Three-beat grounded analyst brief for the watch", [
    str("brief"), str("facts_json"),
  ]),
});

feed.def("notify", {
  message: makeDoc("Notification", "EOD Daily Brief push", [str("title"), str("body")]),
});

const BASE = "https://data-tools.prd.space.id/api/v1";

async function get(jwt, path) {
  const resp = await http.fetch(BASE + path, { headers: { Authorization: "Bearer " + jwt } });
  if (resp.status !== 200) throw new Error(path.split("?")[0] + " HTTP " + resp.status);
  const body = await resp.json();
  return body.data || [];
}

function dayStartMs(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtPct(x) {
  return (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(1) + "%";
}

(async () => {
  const jwt = secret.loadPlaintext("ARRAYS_JWT");
  if (!jwt) throw new Error("ARRAYS_JWT missing");
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const snapDate = dayStartMs(nowMs);
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);

  // --- earnings calendar (wide window per endpoint doc; filter client-side)
  const calRows = [];
  const earningsByTicker = {};
  for (const t of CONFIG.tickers) {
    const rows = await get(jwt, "/stocks/earnings-calendar?symbol=" + t +
      "&start_time=" + (now - 30 * 86400) + "&end_time=" + (now + 120 * 86400));
    const future = rows.filter((r) => r.date >= todayIso).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (future.length) {
      earningsByTicker[t] = future[0];
      calRows.push({
        date: snapDate, ticker: t, event: "Earnings",
        event_date: future[0].date,
        note: future[0].time === "amc" ? "after close" : future[0].time === "bmo" ? "before open" : (future[0].time || ""),
      });
    } else {
      calRows.push({ date: snapDate, ticker: t, event: "Earnings", event_date: "", note: "next date not yet confirmed" });
    }
  }

  // --- analyst price-target news (last 3 days; sparse coverage tolerated)
  const ptEvents = [];
  for (const t of CONFIG.tickers) {
    const rows = await get(jwt, "/stocks/company/price-target-news?symbol=" + t +
      "&start_time=" + (now - 3 * 86400) + "&end_time=" + now + "&limit=10");
    for (const r of rows) {
      ptEvents.push({
        event_id: t + ":evt.rating:" + (r.news_url || r.publish_time || todayIso),
        ticker: t, kind: "evt.rating",
        bucket: rows.length >= 2 ? "P1" : "P2",
        title: (r.analyst_company || "Analyst") + " PT $" + r.price_target + " (price $" + r.price_when_posted + ")",
        detail: r.news_title || "",
        source: r.news_publisher || "",
        dateMs: nowMs,
      });
    }
  }

  // --- tracked-KOL echo: mention counts + top quote per ticker
  const kolFacts = {};
  const kolEvents = [];
  for (const t of CONFIG.tickers) {
    const posts = await get(jwt, "/social-feeds/x/search?q=" + t + "&since=" + (now - 86400) + "&until=" + now);
    const top = posts.slice().sort((a, b) => (b.like_count || 0) - (a.like_count || 0))[0];
    // search returns max one page (50); report "50+" rather than a false exact count
    const nLabel = posts.length >= 50 ? "50+" : String(posts.length);
    kolFacts[t] = {
      mentions24h: posts.length,
      mentionsLabel: nLabel,
      topQuote: top ? { handle: top.twitter_handle, text: String(top.full_text || "").slice(0, 180), likes: top.like_count || 0 } : null,
    };
    if (top) {
      kolEvents.push({
        event_id: t + ":social.kol.context:" + todayIso,
        ticker: t, kind: "social.kol", bucket: "P2",
        title: "Tracked-KOL echo: " + nLabel + " mentions in 24h",
        detail: "@" + top.twitter_handle + ": “" + String(top.full_text || "").slice(0, 160) + "”",
        source: "Arrays tracked-handle index, snapshot " + todayIso,
        dateMs: nowMs,
      });
    }
  }

  await feed.run(async (ctx) => {
    // KOL burst detection needs a baseline; build it in kv over the first runs.
    const baseline = JSON.parse((await ctx.kv.load("kolBaseline")) || "{}");
    for (const t of CONFIG.tickers) {
      const hist = baseline[t] || [];
      const avg = hist.length >= 5 ? hist.reduce((a, b) => a + b, 0) / hist.length : null;
      const n = kolFacts[t].mentions24h;
      if (avg != null && avg > 0 && n >= CONFIG.kolBurstMin && n / avg >= CONFIG.kolBurstRatio) {
        kolEvents.push({
          event_id: t + ":social.kol.burst:" + todayIso,
          ticker: t, kind: "social.kol", bucket: "P1",
          title: "KOL mention burst: " + n + " in 24h (" + (n / avg).toFixed(1) + "× the trailing average)",
          detail: "", source: "Arrays tracked-handle index, snapshot " + todayIso,
          dateMs: nowMs,
        });
      }
      baseline[t] = hist.concat([n]).slice(-30);
    }
    await ctx.kv.put("kolBaseline", JSON.stringify(baseline));

    // earnings T-5 / T-1 reminders (once each, via kv)
    const emitted = JSON.parse((await ctx.kv.load("emittedEvt")) || "[]");
    const evtRows = [];
    for (const t of Object.keys(earningsByTicker)) {
      const d = earningsByTicker[t].date;
      const daysAway = Math.round((Date.parse(d + "T00:00:00Z") - snapDate) / 86400000);
      for (const mark of [5, 1]) {
        const id = t + ":evt.earnings.upcoming:T-" + mark + ":" + d;
        if (daysAway <= mark && daysAway >= 0 && emitted.indexOf(id) < 0) {
          evtRows.push({
            event_id: id, ticker: t, kind: "evt.earnings.upcoming", bucket: "P1",
            title: t + " earnings in " + daysAway + " day" + (daysAway === 1 ? "" : "s") + " (" + d + ")",
            detail: earningsByTicker[t].time || "", source: "Arrays earnings calendar", dateMs: nowMs,
          });
        }
      }
    }
    const allEvents = evtRows.concat(ptEvents, kolEvents).filter((e) => emitted.indexOf(e.event_id) < 0);
    if (allEvents.length) {
      await ctx.self.ts("events", "stream").append(allEvents.map((e) => ({
        date: e.dateMs, event_id: e.event_id, ticker: e.ticker, kind: e.kind,
        bucket: e.bucket, title: e.title, detail: e.detail, source: e.source,
      })));
      await ctx.kv.put("emittedEvt", JSON.stringify(emitted.concat(allEvents.map((e) => e.event_id)).slice(-400)));
    }

    await ctx.self.ts("calendar", "upcoming").append(calRows);

    // --- Daily Brief: grounded on computed facts only
    let overview = null;
    let daySignals = [];
    try {
      const ov = await ctx.upstream.signals.ts("portfolio", "overview").last(1);
      overview = ov && ov.length ? ov[ov.length - 1] : null;
      const sigs = await ctx.upstream.signals.ts("signals", "events").last(30);
      daySignals = (sigs || []).filter((s) => dayStartMs(s.date) === snapDate && s.bucket !== "P2");
    } catch (e) {
      throw new Error("fast-lane upstream read failed: " + e.message);
    }
    if (!overview) throw new Error("no fast-lane overview available — run signals feed first");

    // Action verdict — computed by code (same logic as the interface board),
    // never by the LLM. This is the push's first line.
    const p0Today = daySignals.filter((s) => s.bucket === "P0");
    const p1Today = daySignals.filter((s) => s.bucket === "P1");
    const futureCat = calRows.filter((c) => c.event_date).sort((a, b) => (a.event_date < b.event_date ? -1 : 1));
    const nextCat = futureCat[0] || null;
    const daysTo = nextCat ? Math.round((Date.parse(nextCat.event_date + "T00:00:00Z") - snapDate) / 86400000) : null;
    const shortDate = (d) => {
      const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const dt = new Date(d + "T00:00:00Z");
      return M[dt.getUTCMonth()] + " " + dt.getUTCDate();
    };
    let action;
    if (p0Today.length) {
      action = "🔴 Look now — " + p0Today[0].title;
    } else if (p1Today.length) {
      const tk = p1Today.map((s) => s.ticker).filter((t, i, a) => a.indexOf(t) === i);
      action = "🟡 Read below — " + p1Today.length + " notable signal" + (p1Today.length > 1 ? "s" : "") + " (" + tk.join(", ") + ")";
    } else if (nextCat && daysTo <= 2) {
      action = "🟡 Prepare — " + nextCat.ticker + " earnings " + shortDate(nextCat.event_date) + " (in " + daysTo + "d, " + nextCat.note + ")";
    } else {
      action = "✅ Nothing needs you today" + (nextCat ? " — next: " + nextCat.ticker + " earnings " + shortDate(nextCat.event_date) + " (in " + daysTo + "d)" : "");
    }

    const facts = {
      date: todayIso,
      last_session: fmtPct(overview.day_return) + " (as of " + overview.as_of + ")",
      benchmark: overview.benchmark + " " + fmtPct(overview.benchmark_return),
      biggest_mover: overview.biggest_mover + " " + fmtPct(overview.biggest_move),
      weights_note: "user-specified weights: NVDA 25% / MSFT 15% / AAPL 15% / TSLA 15% / MU 10% / JPM 10% / KO 10%",
      signals_new_today: daySignals.map((s) => s.title + " [" + s.bucket + "]"),
      new_events: allEvents.map((e) => e.title + " [" + e.ticker + "]"),
      kol_mentions_24h: Object.keys(kolFacts).map((t) => t + ": " + kolFacts[t].mentionsLabel),
    };

    // The LLM writes exactly ONE insight sentence; everything else is composed
    // deterministically so the push stays scannable and numbers stay exact.
    const result = await ask(
      "ONE sentence, max 22 words, for a portfolio brief. An interpretation grounded ONLY in the " +
      "facts JSON — a positioning, signal-pattern, or attention observation worth knowing. The reader " +
      "already sees the day return, benchmark and biggest mover — do NOT restate them; add something " +
      "different (weight concentration, KOL attention pattern, what did or didn't fire). Use only " +
      "numbers present in the facts. No advice, no prediction, no greeting, no emoji.\n\nFACTS: " +
      JSON.stringify(facts)
    );
    const insight = String((result && result.text) || "").trim().split("\n")[0];

    const signalLines = daySignals.length
      ? daySignals.slice(0, 4).map((s) => "• " + s.title).join("\n")
      : "none new";
    // Sections shared by page and push. The push joins them with blank lines
    // because Markdown/Telegram collapses a single newline into a space; the
    // page uses CSS white-space:pre-line, so single newlines already break.
    const sections = [
      action,
      "**Book** " + fmtPct(overview.day_return) + " vs " + overview.benchmark + " " + fmtPct(overview.benchmark_return) + " · led by " + overview.biggest_mover + " " + fmtPct(overview.biggest_move),
      "**Signals** " + (daySignals.length ? signalLines : "none new"),
      "**Watch** " + (futureCat.length ? futureCat.map((c) => c.ticker + " " + shortDate(c.event_date)).join(" · ") : "no confirmed dates"),
      insight ? "**Note** " + insight : "",
    ].filter(Boolean);
    const pageBody = sections.join("\n");                       // pre-line: tight
    const pushBody = sections.join("\n\n") +                     // Markdown: real breaks
      "\n\n[Open Portfolio Watch](" + CONFIG.shareUrl + ")";

    // digest/daily dedups by snapDate (one record per day, updated on re-runs),
    // so the page always shows the freshest brief without duplicating rows.
    await ctx.self.ts("digest", "daily").append([{ date: snapDate, brief: pageBody, facts_json: JSON.stringify(facts) }]);
    // Push once per day: the first run of the day sends the brief; later runs
    // (manual triggers, cron retries) refresh the page silently via the skip
    // sentinel so subscribers never get duplicate same-day notifications.
    const alreadyBriefed = (await ctx.kv.load("lastBriefDay")) === todayIso;
    await ctx.self.ts("notify", "message").append([{
      date: nowMs,
      title: "📋 Portfolio Brief · " + todayIso,
      body: alreadyBriefed ? "<|SKIP_NOTIFICATION|>" : pushBody,
    }]);
    if (!alreadyBriefed) await ctx.kv.put("lastBriefDay", todayIso);
  });
})();
