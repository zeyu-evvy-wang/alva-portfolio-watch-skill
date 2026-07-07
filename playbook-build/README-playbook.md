# Tech-Core Portfolio Watch

A continuous watch on an example tech-tilted portfolio — **NVDA 25% ·
MSFT 15% · AAPL 15% · TSLA 15% · MU 10% · JPM 10% · KO 10%** — that separates real
moves from noise and only interrupts when it matters. Built with the
reusable **portfolio-watch** skill from one sentence: *"Watch my
portfolio: 25% NVDA, 15% MSFT, 15% AAPL, 15% TSLA, 10% MU, 10% JPM, 10%
KO — ping me when something big happens."* The same skill produces a watch for any
ticker list, with or without position sizes.

## The Action Board & signal feed

The top of the page tells you what to do, not what happened: 🔴 needs
attention now / 🟡 worth a look / 🟢 all clear, with at most three
verb-first items (look now / read tonight's brief / prepare for earnings),
each linking to its evidence. Verbs are attention verbs, never trading
advice. The signal feed keeps itself scannable: Critical/Notable render
as cards, Context (including KOL echo) stays collapsed until expanded.
The first run backfills 15 sessions of signal history so the page opens
with real evidence — backfill never triggers pushes.

## What counts as big

A move earns attention only if it passes three questions:

1. **Abnormal for that stock?** Day moves, gaps, reversals and slow
   5-session drifts are z-scored against each ticker's own 20-day
   volatility — a 3% day is routine for TSLA and an event for KO.
2. **Meaningful for this portfolio?** Severity adds weight × move (bps):
   the 25% NVDA position trips at ±7.3%, while high-vol MU at 10% won't
   interrupt on price alone — its news lands in the brief.
3. **Not explained by the market?** Each move is regressed against SPY
   (60-session β). On a broad risk-off day, single names that merely
   followed the market demote to context and you get **one** portfolio
   alert, not six stock pings. Moves on confirmed earnings days are
   labeled "elevated volatility expected"; abnormal moves with no
   catalyst in tracked sources are labeled exactly that.

Score ≥ 55 → **Critical**: immediate push, max 4/day, 4h cooldowns,
same-run alerts merged. 35–54 → **Notable**: waits for the Daily Brief.
Below 35 → context, page only.

**Calibrated, not guessed** (2026-07-06, trailing 60 sessions): 131
recorded signals, 6 demoted as market-explained, expected ≈0.4
critical/week in the current calm regime (boundary at the [55,75] clamp
floor). Live per-holding tripwires are shown in the page footer.

## Daily Brief, catalysts, KOL echo

After US close: a three-beat analyst note (what the session did → one
positioning/attention observation → what to watch next) written by an LLM
over computed facts only — it interprets, never invents. Plus earnings
calendar with T-5/T-1 reminders, analyst price-target news, and
tracked-KOL mention counts with the day's top attributed quote — always
context, never presented as cause.

## Data & cadence

| Source | What | Cadence |
| --- | --- | --- |
| Arrays US stock klines | OHLCV for the 7 holdings + SPY | Every 30 min, 13:00–21:30 UTC weekdays |
| Arrays earnings calendar | Confirmed report dates | Daily, 21:15 UTC |
| Arrays price-target news | Analyst PT actions (sparse) | Daily, 21:15 UTC |
| Arrays social feeds (X) | Tracked-KOL mentions & top quote | Daily, 21:15 UTC |

Backing automations: `pw-tech-core-signals` (signal engine + critical
pushes; quiet runs send nothing) and `pw-tech-core-catalysts` (calendar,
KOL echo, Daily Brief push).

## Alerts

Subscribe to this playbook's alerts for Critical pushes and the Daily
Brief. Every push leads with the number and σ context and deep-links to
the matching signal here. Quiet days stay quiet — the Brief guarantees
nothing material is missed, only deferred.

## Blind spots, honestly

- This is an **example** portfolio with stated weights, not anyone's real
  book; the skill accepts your actual holdings and sizes.
- Signal state reflects the last completed session between runs; intraday
  bars update during market hours only.
- Analyst price-target coverage is sparse in the current window; absence
  of PT rows ≠ absence of analyst activity.
- KOL mention counts cap at 50/day per ticker (index page limit) and
  cover tracked handles only.
- β and residuals need ~60 aligned sessions; new listings fall back to
  raw z-scores until history accrues.
