# Signal Taxonomy & Severity Model

This file owns the monitoring methodology: which dimensions Portfolio Watch
tracks, what counts as a material move versus noise, and how simultaneous
signals are ranked. The reference implementation of every formula here is
[scripts/signal-engine.js](../scripts/signal-engine.js).

## Design Stance

A move deserves the user's attention only if it passes **three questions**:

1. **Is it abnormal for this stock?** All move thresholds are z-scores
   against the ticker's own trailing volatility, never absolute
   percentages. A 3% day is routine for TSLA and an event for KO. This is
   what makes the skill work on portfolios it has never seen.
2. **Is it economically meaningful for this portfolio?** Rank comes from
   what the move does to the user's money (weight × move, in bps), not
   from how dramatic the headline is.
3. **Is it explained by the market as a whole?** A holding falling 4% on a
   day the index falls 3% is one portfolio-level event, not N stock-level
   events. Single-name attention is reserved for moves the benchmark
   can't explain (see Residual rule below).

One severity score (0–100) → bucket (P0/P1/P2) encodes all three and
drives both interface ranking and push behavior
([alert-policy.md](alert-policy.md)).

## Dimensions

### Fast lane — market signals (every fast-lane run)

Baselines use the trailing 20 trading days *excluding* the current bar.
σ20 = stdev of daily returns; avg20 = average daily volume.

| ID | Signal | Fires when | Notes |
| --- | --- | --- | --- |
| `move.day` | Abnormal day move | z = \|r_day\|/σ20 ≥ 1.5 (record) and \|r_day\| ≥ 1% | The workhorse. z ≥ 1.5 records the signal; buckets decide attention. The 1% absolute floor keeps ultra-low-vol names from pinging on economically trivial moves. Subject to the Residual rule below. |
| `move.drift` | Slow bleed / grind | \|5-session cumulative return\| / (σ20·√5) ≥ 2.2, firing on the day the condition first becomes true, **only when no `move.day` fired the same session** (else it double-counts the same event) | Catches what `move.day` structurally misses: −1.5% a day for five days is −7.3% a week and never trips a daily threshold. Episode-edged: fires once per drift episode, not daily while it persists. |
| `move.gap` | Opening gap | \|open/prevClose − 1\| ≥ 1.5×σ20 **and ≥ the 1% absolute floor** | Catches overnight news before the day move accumulates. Merges into `move.day` if still active at close. |
| `move.intraday` | Intraday swing / reversal | (high−low)/prevClose ≥ 3×σ20 and close retraces ≥ 50% of the range | Catches violent reversals that end the day flat — `move.day` alone misses these. |
| `vol.spike` | Volume spike | volume/avg20 ≥ 3 | Alone it is context (capped at P2). Its real job is **corroboration** of a same-day move (z ≥ 1.5). |
| `level.52w` | 52-week high/low cross | Crossing event only | Fires once per cross, not continuously while beyond the level. |
| `level.ma200` | 200-day MA cross | Close crosses the 200DMA | Crossing event only; at most once per direction per 20 sessions. |
| `pf.move` | Portfolio day move | z_pf = \|Σ wᵢrᵢ\|/σ_pf20 ≥ 2.0 | Computed on the weighted portfolio return series. |
| `pf.drawdown` | Portfolio drawdown step | Drawdown from trailing 90d peak crosses −5% / −10% / −15% | Each step fires once until the portfolio recovers above the previous step. |

### Slow lane — events & catalysts (daily)

| ID | Signal | Fires when | Notes |
| --- | --- | --- | --- |
| `evt.earnings.upcoming` | Earnings approaching | T−5 and T−1 before a confirmed date | Calendar + digest only. Never an instant push. |
| `evt.earnings.result` | Earnings surprise | EPS or revenue surprise beyond ±4% vs consensus, or a guidance revision | Escalates when paired with a market reaction (same-day z ≥ 1.5). |
| `evt.rating` | Analyst action | Rating change, or price-target change ≥ 10% | ≥ 2 same-direction actions in one day = cluster, escalates. |
| `evt.insider` | Insider trades | Officer/director open-market buy ≥ $250k, or ≥ 2 insiders buying within 5 sessions | Buys weigh more than sells (sells are often routine); 10b5-1 scheduled sells cap at P2. |
| `evt.news` | Material headline | alpi classifies a fetched headline into {M&A, guidance, regulatory/legal, product, management} | alpi only *labels* real fetched headlines — it never invents events. News reaches P0 only with same-day price/volume confirmation. |
| `evt.corp` | Dividend / split / corporate action | On announcement | P2 informational; goes to the calendar. |
| `social.kol` | Tracked-KOL echo | Arrays' tracked-handle index shows an unusual mention burst on a holding: ≥ 3× the ticker's trailing daily average (up to 30 days of baseline, min 5 days before bursts can fire) and ≥ 15 mentions | Read-only platform data, snapshot date cited. A burst alone caps at P1 (digest). Its main job is **context**: when a price signal fires the same day, attach the most relevant KOL quote (with handle and time) to that signal's "why" line. Never fabricate rankings or views. |

**Crypto holdings:** same engine with session adjustments — no `move.gap`
(24/7 market), σ from 30 daily UTC closes, fast lane runs around the clock.
Funding-rate and exchange-flow dimensions are opt-in extensions.

### The Residual rule — market moves are not stock news

For every `move.day`, compute the **residual move**: r_resid = r_stock −
β·r_bench, with β from a 60-session regression against the benchmark and
σ_resid from the trailing 20 residuals.

- **Market-explained** (\|r_bench\| ≥ 1% and residual z < 1.0): the stock
  merely followed the market. Its magnitude is scored on the *residual* z,
  which demotes it naturally — usually to context. The market-wide event
  itself is carried by `pf.move`, which is where that attention belongs.
  The title says so: "MSFT −3.1% (2.0σ raw · 0.4σ vs market) — moved with
  the market."
- **Stock-specific** (residual z ≥ 1.5): scored on raw z as usual, and the
  title notes it when the market was calm: "no market-wide move to explain
  it."
- On a broad risk-off day this collapses N per-stock pings into one
  portfolio-level alert plus context rows — the single biggest noise
  reduction in the design.

### Earnings-day context

If today is a confirmed earnings date for the ticker (from the slow lane's
calendar), a `move.day` is labeled "earnings day — elevated volatility is
expected"; the real earnings verdict (surprise + guidance) is scored by
`evt.earnings.result` after the numbers are out. A big move on a *known*
event date is less informative than the same move out of nowhere.

### The unexplained-move flag

When a stock-specific P0/P1 move has **no** same-day catalyst in tracked
sources (no earnings, no rating action, no material headline, no KOL
burst), the interface and push say exactly that: "no clear catalyst in
tracked sources (yet)." An unexplained abnormal move is the highest-value
alert a watch can send — never dress it up, and never invent a cause.

## Severity Score

`severity = magnitude + impact + corroboration + event_base`, capped at 100.

| Component | Range | Formula |
| --- | --- | --- |
| Magnitude | 0–40 | `min(40, 20 × (z − 1.5))` for move signals. Event signals take magnitude from their paired market reaction, if any. |
| Portfolio impact | 0–30 | contribution in bps = \|w × r\| × 10000 → `min(30, bps / 5)`. No weights known → equal weight, disclosed in the interface. |
| Corroboration | 0–20 | +10 per *additional* distinct dimension firing on the same ticker in the same window. |
| Event base | 0–10 | earnings surprise 10 · M&A/regulatory 8 · guidance 8 · rating cluster 6 · insider cluster 5 · single rating 4 · 52w/MA cross 3 · KOL burst 3 · volume-only 2 |

### Buckets

| Bucket | Default | Meaning |
| --- | --- | --- |
| **P0 — interrupt** | ≥ 60 | Push immediately. "You'd want to be pulled out of a meeting." |
| **P1 — digest** | 35–59 | Batched into the daily digest. "Worth knowing today, not this minute." |
| **P2 — context** | < 35 | Interface only. Never pushed. |

The P0 boundary is **calibrated per portfolio** (below), clamped to [55, 75].
The P1 lower bound is fixed.

## Calibration — the reusability step

Static thresholds tuned on one portfolio fail on the next. Before publishing
feeds, run the engine over the trailing **60 trading days** of the user's
actual tickers and count what would have fired:

- Target: **P0 ≈ 1–3 per week** portfolio-wide; P1 ≤ 2/day on average.
- Backfill P0 rate > 3/week → raise the P0 boundary (never above 75).
- Backfill P0 rate < 0.5/week → lower it (never below 55).
- Report the expected rates to the user and in the playbook README.

Sensitivity presets scale the z triggers and the daily push budget:

| Preset | z multiplier | P0 budget/day |
| --- | --- | --- |
| `quiet` | ×1.25 | 2 |
| `standard` (default) | ×1.0 | 4 |
| `verbose` | ×0.8 | 6 |

## Worked Examples

| Scenario | Score | Bucket |
| --- | --- | --- |
| NVDA −8.2% (σ20 = 3%, z 2.7) on 3.8× volume, 32% position | 24 + 30 + 10 = 64 | **P0** |
| KO +2.1% (σ20 = 0.8%, z 2.6), 5% position | 22 + 2 + 0 = 24 | P2 — same z as above, different life |
| Earnings beat (+6% surprise), +4% reaction (z 1.9), 15% position, volume spike | 10 + 8 + 12 + 10 = 40 | P1 → digest |
| Analyst downgrade, no price reaction, 8% position | 4 + ~1 + 0 = 5 | P2 |

## Ranking when several fire at once

The attention hierarchy, top to bottom:

1. **Portfolio-level beats single-name.** If `pf.move` or `pf.drawdown`
   fires alongside individual moves, the portfolio event is the headline;
   market-explained single-name moves demote to context under the
   Residual rule.
2. **Within a ticker, one event = one card.** Corroborating dimensions
   (gap, intraday, volume) fold into the anchor `move.day` and raise its
   corroboration score instead of appearing separately.
3. **Across tickers, severity ranks; contribution breaks ties.** Two
   signals with equal scores order by \|weight × move\|.
4. **Same run, multiple P0s → one merged push** with a portfolio headline
   (see [alert-policy.md](alert-policy.md)); the interface still shows
   each card.

## Anti-Noise Rules

- Crossing signals (`level.*`, `pf.drawdown`, `move.drift`) fire on the
  **cross/episode edge**, never continuously while the condition holds.
- A continuing move does not re-fire within its cooldown unless it escalates
  (bucket upgrade or magnitude doubles) — see
  [alert-policy.md](alert-policy.md).
- Market-explained moves are scored on residual z (Residual rule) — a
  beta day is one event, not N.
- Volume alone is never more than context.
- News without price/volume confirmation is never P0.
- KOL chatter without a price/volume move is never more than P1, no matter
  how loud.

## Tripwires — making thresholds tangible

Because all thresholds are per-ticker statistics, they can be shown as
concrete numbers. For each holding, compute today's **P0 tripwire**: the
smallest \|day move\| that would reach the calibrated P0 boundary given the
position's weight (assume no corroboration). Illustrative shape:
"NVDA: ±7.3% · AAPL: ±7.0% today" — the live values are computed per
portfolio and rendered in the footer. Implemented as `p0Tripwire()`; the
interface shows it in the methodology footer
([interface-spec.md](interface-spec.md)) so the user always knows exactly
what would ping them. Abstract σ math becomes a number you can argue with.
