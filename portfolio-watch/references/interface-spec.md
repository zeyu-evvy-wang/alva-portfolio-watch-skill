# Interface Spec

The playbook answers five questions in order, top to bottom:

1. **Do I need to do anything?** (the Action Board — one glance, zero reading)
2. **Am I OK today?** (pulse numbers, ≤ 3 seconds)
3. **What fired, and why?** (the reason a push brought me here)
4. **What's the state of each holding?**
5. **What's coming up?**

**Row 0 — Action Board (full-width, `.col-8`, always first)**

A bulletin board that tells the user what to do, not what happened. One
status light + at most three verb-first items:

| Status | Condition | Headline |
| --- | --- | --- |
| 🔴 red | new P0 in the last 24h | "Needs your attention" |
| 🟡 amber | P1 signal today, or a catalyst within 2 days | "Worth a look" |
| 🟢 green | neither | "All clear — nothing needs you" |

Item templates (in priority order, max 3, each deep-anchors to its row):

1. `Look now — <P0 title>` → `#signal-<id>` (fresh P0s only, last 24h)
2. `Read tonight's Brief — <N> notable signal(s): <tickers>` → the Brief
   card (P1s from today)
3. `Catch up — <N> notable signal(s) this week: <tickers>` → the signal
   feed (P0/P1s from the last 5 sessions when nothing fired today; keeps a
   green board informative without faking urgency)
4. `Prepare — <ticker> earnings <date> (in <n>d, <note>)` → the calendar
   card (within 10 days)
5. Green fallback: `Nothing to do — all <N> holdings inside their normal
   range. Next check: <cadence>.`

Hard rules: verbs are **attention verbs** (look, read, prepare) — never
trading verbs (buy, sell, trim); Alva is not financial advice and the
board must not become a recommendation engine. The board is computed
client-side from feed outputs (signals + calendar + overview) — it is a
presentation layer, not a new data product. A green board must look
deliberate: state it plainly, with the next check time.

Design mechanics (tokens, grid, widget CSS, lint) are owned by the official
Alva skill's `design.md`, `design-widgets.md`, `design-components.md` — they
are the authority and the release lint must pass. This file owns the
information architecture. The hosted shell already renders playbook chrome:
start directly with content, no in-iframe header.

## Page structure

**Row 1 — Portfolio Pulse: 4 Metric Cards (`.col-2` each)**

| Card | Value | Subtitle |
| --- | --- | --- |
| Portfolio Today | Weighted return %, bull/bear colored | vs benchmark, e.g. "SPY −0.4%" |
| Biggest Mover | Ticker + move % | Its contribution to portfolio, e.g. "−2.4pt" |
| Active Signals | e.g. "1 Critical · 4 Notable" | Last-updated time |
| Next Catalyst | e.g. "NVDA earnings" | "Wed · in 2 days" |

On mobile these collapse to a 2×2 grid (default `.col-2` behavior).

**Row 2 — Portfolio chart (Chart Card, `.col-8`)**

30-day portfolio cumulative return vs benchmark (two lines, ECharts, time
axis). P0 signal dates rendered as markPoints on the portfolio line —
clicking one scrolls to that signal card. This chart is the trust surface:
it shows alerts landing exactly where the line jumps.

**Row 3 — Daily Brief (Free Text Card, `.col-8`)**

The latest EOD Daily Brief (see [alert-policy.md](alert-policy.md)) with
its date. This is the playbook's editorial voice — the reason the page
reads like an analyst's desk, not a quote terminal. For public watchlists
it is the content followers come back for. One card, latest brief only;
history stays in the feed output.

**Row 4 — Signal Feed (`.col-8`)**

Ranked by severity, then recency. Filter Tabs: All / Critical / per-ticker
(Dropdown). Each signal card (grey-g01 row, like Feed Card):

- Severity Tag (P0 red / P1 amber / P2 neutral) + dimension tag
- One-line title with the number first: "NVDA −8.2% (2.7σ) on 3.8× volume"
- "Why" line from alpi when grounded in a fetched headline (source named);
  omitted otherwise
- KOL echo line when a same-day tracked-KOL quote exists: one attributed
  quote, per the alert-policy rule — context, never presented as cause
- Timestamp + anchor `id="signal-<signal_id>"`

**Two tiers, so the feed stays scannable:** Critical and Notable render as
full cards; Context signals (including KOL echo) collapse by default into
a single toggle row — "Context (<N>) ▸" — expanding to compact one-line
entries. Most signals on a normal day are context; they must not bury the
few that matter. **Empty state matters:** "No signals today — all <N>
holdings within their normal range." A calm day must look intentional,
not broken.

**Row 5 — Holdings (Table Card, `.col-8`)**

One row per ticker, sorted by |today's contribution| descending:

`Ticker · Weight · Last · 1D (colored, with σ) · 5D · 1M · Vol vs avg ·
Off 52w high · Contribution today · active signal badges`

Degraded-coverage tickers show a badge ("daily data only") instead of
silently missing fields.

**Row 6 — Catalyst calendar (Table Card, `.col-8`)**

Confirmed upcoming catalysts: `Date · Ticker · Event · Note`, soonest
first. Sourced from the slow-lane feed's calendar output.

**Footer — Methodology (Free Text Card)**

"What counts as big here": plain-language explanation of per-ticker σ
thresholds, the calibrated P0 boundary and expected alert rates, the daily
push budget, data cadence and freshness, the equal-weight disclosure if the
user gave no position sizes, and any excluded/degraded tickers. Include the
**tripwire table** — each holding's concrete P0 trigger for today, computed
by the engine's `p0Tripwire()`:

| Holding | Would ping you today at | σ20 | β |
| --- | --- | --- | --- |
| NVDA | ±7.3% | 2.6% | 1.92 |
| AAPL | ±7.0% | 2.2% | 0.61 |
| KO | — price alone won't interrupt; lands in the brief | 1.6% | −0.59 |

(values are illustrative — the live table computes per portfolio, and the
σ20/β columns let the user sanity-check *why* each tripwire sits where it
does)

Display rule: a tripwire above 15% renders as the "won't interrupt" dash —
that is the impact-weighted design being honest about itself, not a bug.
Transparency about the rules is what lets the user trust the silence, and
a concrete tripwire is the most honest form of transparency: abstract σ
math becomes a number the user can argue with.

## Public watchlist mode

Released playbooks are public by default, and a good watch is *followable
content* — the same interface serves strangers who subscribe to the
creator's watch. When the user opts into `public-watchlist` mode
([SKILL.md](../SKILL.md)):

- **Never display real position sizes or values.** Show ranking weights as
  bands (Core / Large / Small) instead of percentages; portfolio return
  stays in % terms only. Privacy is a hard rule, not a preference.
- The Daily Brief is written follower-facing ("the book", "this watch")
  rather than second-person ("your portfolio").
- README and creator's note present the playbook as a curated watch —
  what the basket is, why these names, what followers will receive and
  when (per official `creators-note.md` conventions).
- Followers get alerts via playbook alert / group subscription per the
  official push references; the owner's personal alert setup is unchanged.

## Deep-link handling

Every push links to `<share_url>?signal=<signal_id>`.

1. **Primary:** on load, read the `signal` query param (also accept
   `#signal-<id>` hash). If present: scroll to the card, apply a highlight
   style for ~2s.
2. **Fallback:** query params may not propagate into the iframe on every
   client. If no param is present and the latest `notify/message` record is
   non-quiet and < 24h old, auto-highlight the most recent P0 signal.
3. During the build, verify which path works on the deployed playbook and
   state it in the README.

## Data reads

All quantitative values are fetched at runtime via `AlvaToolkit.AlvaClient`
from the two feeds' output paths (`portfolio/overview`, `holdings/state`,
`signals/events`, `calendar/upcoming`, `digest/daily`) per the official
browser-safe read rules. No inline data literals. Render a loading skeleton,
and an explicit staleness note ("data as of <t>") whenever the newest record
is older than 2× the feed cadence — a stale dashboard that admits it beats a
stale dashboard that doesn't.
