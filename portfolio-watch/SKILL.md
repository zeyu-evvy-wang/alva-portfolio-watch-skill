---
name: portfolio-watch
description: >-
  Use this skill when the user wants to watch a portfolio or a list of
  tickers and be pinged when something big happens — "keep an eye on my
  NVDA, TSLA and AAPL", "monitor my holdings", "alert me on big moves in my
  portfolio". It generates a Portfolio Watch Playbook on Alva: a live
  interface showing what's happening to each holding, plus IM alerts
  (Telegram/Discord/Slack) whose severity is calibrated to the portfolio so
  pushes stay rare and trustworthy. Includes an opinionated daily brief,
  tracked-KOL context on moves, and an optional public-watchlist mode that
  makes a watch followable by others. Works for any mix of US equities and
  crypto, with or without position sizes.
metadata:
  author: zeyu
  version: v1.2.0
---

# Portfolio Watch

This skill turns one sentence — "keep an eye on my NVDA, TSLA, AAPL, ping me
when something big happens" — into a running Playbook with two properties
most watchlists get wrong:

1. **It knows what "big" means for each holding.** Every threshold is
   normalized to the ticker's own volatility, so the same skill works on a
   meme-stock portfolio and a dividend portfolio without retuning — and a
   β-residual filter keeps market-wide days from turning into N separate
   stock pings.
2. **Its alerts are worth interrupting the user for.** A severity model
   ranks every signal by portfolio impact, a daily push budget and
   calibration keep critical alerts at ~1–3 per week, and everything else
   waits in the daily brief or in the interface.
3. **It is a content product, not just a tool.** The playbooks people
   actually subscribe to on Alva have a voice and a rhythm: an opinionated
   daily brief, grounded KOL context on moves, and an optional
   public-watchlist mode where a personal watch becomes something others
   can follow.

## Layering

This skill is a methodology layer **on top of the official Alva skill**
(`npx skills add https://github.com/alva-ai/skills`; written and verified
against v1.15.1), which must be installed and remains authoritative for all
platform mechanics: preflight, data discovery, jagent runtime, feed lifecycle and
gates, playbook creation and release, push verification, and the design
system. Where this skill says *what* to build, the official references say
*how*. Never bypass an official HARD-GATE.

| This skill owns | File |
| --- | --- |
| Dimensions, noise thresholds, severity scoring, calibration | [references/signal-taxonomy.md](references/signal-taxonomy.md) |
| Push policy: P0/P1/P2, budget, cooldowns, message templates, deep links | [references/alert-policy.md](references/alert-policy.md) |
| Interface information architecture and deep-link handling | [references/interface-spec.md](references/interface-spec.md) |
| Feed architecture, build order, acceptance checklist, failure modes | [references/build-plan.md](references/build-plan.md) |
| Reference implementation (pure JS, jagent-safe) | [scripts/signal-engine.js](scripts/signal-engine.js) |

## Inputs

| Input | Required | Default when absent |
| --- | --- | --- |
| Tickers | yes | — parse from the user's sentence; validate every one against live Data Skills coverage before promising anything |
| Position sizes/weights | no | Equal weight, disclosed in the interface and README. If `alva whoami`/trading shows a connected brokerage, offer to import real holdings instead. |
| Sensitivity | no | `standard` (also: `quiet`, `verbose`) — scales thresholds and the daily push budget |
| Digest time & timezone | no | End of exchange day, user's locale if known |
| Benchmark | no | SPY for equities, BTC for all-crypto portfolios |
| Mode | no | `personal` (default). `public-watchlist` writes the brief follower-facing and **hides real position sizes behind bands** — see the privacy rules in [interface-spec.md](references/interface-spec.md). Offer this mode when the user hints at sharing ("my followers", "make it public"). |

## Intake — one confirmation, then build

Per the official one-blocking-question principle, do the silent work first
(parse tickers, check coverage, check delivery channel from `alva whoami`),
then send **one** confirmation covering everything:

> Watching **NVDA, TSLA, AAPL** — equal-weighted since you didn't give
> sizes (tell me sizes anytime to sharpen ranking). You'll get a critical
> alert when a move is truly abnormal *for that stock* (expect ~1–3/week
> after calibration), a daily close digest for the rest, and earnings
> reminders. Alerts to your connected Telegram. OK to build, or adjust?

If a ticker fails coverage validation, this message must say what degrades
or drops — never discover it for them after release. If no IM channel is
connected, say alerts start on web and link <https://alva.ai/settings>.

## Method — the three decisions

**What to watch:** two lanes. A fast lane computes market signals (abnormal
moves and slow 5-session drifts, gaps, reversals, volume spikes, 52w/MA
crossings, portfolio-level moves and drawdowns — each move checked against
β×benchmark so market days demote to one portfolio event) every 30 minutes
during market hours. A slow lane
collects catalysts daily (earnings dates and surprises, analyst actions,
insider clusters, material headlines classified by alpi — which labels real
fetched items and never invents facts) plus tracked-KOL echo from Alva's
first-party Fintwit data: a mention burst on a holding is digest-worthy,
and a same-day KOL quote attaches to a price signal as attributed context.
Full definitions: [signal-taxonomy.md](references/signal-taxonomy.md).

**What counts as big:** z-scores against each ticker's trailing 20-day
volatility with a small absolute floor — never fixed percentages. Then a
severity score (magnitude + portfolio impact + corroboration + event
weight) maps to P0 (interrupt) / P1 (digest) / P2 (context). Before going
live, **calibrate**: replay the engine over the trailing 60 trading days of
the actual portfolio and set the P0 boundary so critical alerts land at
1–3/week. Thresholds are derived from the attention budget, not guessed. In
a calm regime the boundary floors at its minimum and the true rate can sit
below 1/week — that is by design; under-alerting beats crying wolf, and the
daily brief still carries everything. Report the expected rate to the user.

**How to alert:** P0 pushes immediately within a daily budget with per-signal
cooldowns; multiple P0s in one run merge into a single portfolio-headline
push; quiet runs emit the skip sentinel; every P0/P1 also lands in the EOD
**Daily Brief** — not a list but a three-beat analyst note (what happened
and what it means → a positioning observation → what to watch next), every
claim traceable to a signal record or computed value. Every push leads with
the number and σ context, adds a grounded "why" line only when a real
headline supports it, and ends with a deep link that opens the interface at
that signal. Full policy: [alert-policy.md](references/alert-policy.md).

**How the interface reads:** the page opens with an **Action Board** — a
red/amber/green status and at most three verb-first items (look now / read
tonight's brief / prepare for earnings), each anchoring to its evidence.
Attention verbs only, never trading advice. Everything below the board is
evidence, ordered by the user's next four questions
([interface-spec.md](references/interface-spec.md)).

## Build

Follow [references/build-plan.md](references/build-plan.md): two feeds
(`pw-<slug>-signals` fast lane with `notify/message` sidecar,
`pw-<slug>-catalysts` slow lane with calendar + EOD digest), then the
playbook per [interface-spec.md](references/interface-spec.md), then alert
enablement and end-to-end push + deep-link verification. Upload
[scripts/signal-engine.js](scripts/signal-engine.js) to ALFS and `require`
it from feed code; it is pure and jagent-safe, while all data wiring uses
endpoints discovered fresh this session via `list → summary → endpoint`.

## Hard rules

1. Every number shown or pushed comes from feed outputs backed by real Data
   Skills fetches. No fabricated values, no memory prices, no fallback
   records (official content-legitimacy rules apply in full).
2. alpi output appears only in clearly-labeled narrative fields ("Why"
   lines, digest prose) — never as factual columns.
3. Respect the push budget and quiet-run sentinel. An over-chatty monitor
   is a broken monitor.
4. The README's methodology section must match the deployed configuration
   (calibrated boundary, cadences, budget) — copy from calibration output.
5. Ship nothing you didn't verify: the acceptance checklist in
   [build-plan.md](references/build-plan.md) gates "done".

## Done means

The user has: a share URL whose interface shows live, fresh, feed-backed
data for every holding; a verified alert on their IM channel; a deep link
that lands on the highlighted signal; and a one-paragraph handoff telling
them what will be pushed, how often to expect it, and how to tune it (change
sensitivity, mute a ticker, move the digest, edit holdings).
