# Build Plan

Feed-first, aligned with the official Alva skill's gates. The official
references own all mechanics (`feed-lifecycle.md`, `playbook-creation.md`,
`push-notifications.md`, `deployment.md`, `design*.md`,
`operational-pitfalls.md`, `content-legitimacy.md`) — read them at each step
as that skill instructs. This file owns *what to build*.

## Architecture

Two feeds + one playbook. Names use a slug from the tickers (e.g.
`nvda-tsla-aapl`) — or, when the list is long (> 4 tickers), a short theme
name that describes the basket (e.g. `tech-core`), confirmed at intake.

**Fast lane — `pw-<slug>-signals`**
Fetch bars + volume for all tickers (endpoints discovered fresh via
`list → summary → endpoint`; never from memory) → compute per-ticker stats →
run the signal engine → score & bucket → write outputs, push P0s.

| Group/output | Pattern | Content |
| --- | --- | --- |
| `portfolio/overview` | snapshot | portfolio return today, benchmark, drawdown, biggest mover, signal counts |
| `holdings/state` | snapshot | per-ticker row: last, 1D/5D/1M, σ20, vol ratio, off-52w-high, weight, contribution |
| `signals/events` | event log | one record per signal: id, ticker, dimension, magnitude, z, score, bucket, title, why, timestamp |
| `notify/message` | push sidecar | P0 pushes per [alert-policy.md](alert-policy.md); `<\|SKIP_NOTIFICATION\|>` on quiet runs |

Cron: every 30 min during exchange hours plus one post-close run — e.g.
`*/30 13-21 * * 1-5` covering the US session and post-close (UTC, US
summer time; **recompute
for DST and the user's exchange**). Crypto portfolios: hourly, 24/7.

**Slow lane — `pw-<slug>-catalysts`**
Daily pre-open: earnings calendar & results, analyst actions, insider
trades, headlines, and tracked-KOL echo from Alva's first-party Fintwit
data (read-only, snapshot date cited, per the official `fintwit.md`) →
alpi classifies and writes why-lines (labels real fetched items only — it
never invents facts, and its text goes to clearly AI-labeled fields).

| Group/output | Pattern | Content |
| --- | --- | --- |
| `events/stream` | event log | event signals with the same schema as `signals/events` |
| `calendar/upcoming` | snapshot | next-14-day catalyst rows |
| `digest/daily` | event log | the EOD Daily Brief (also what the push says) |
| `notify/message` | push sidecar | EOD Daily Brief push |

The brief run (post-close cron on this feed) reads the fast-lane feed **as
an upstream** to recap the day's P0/P1s. Numbers the brief cites beyond
signal records — pairwise co-movement counts, concentration, options
implied move when available — are **computed in feed code** and passed to
alpi as inputs; the LLM interprets, it never calculates or invents. Keep
per-source `ctx.kv` watermarks separate (official watermark pitfall).

**State (`ctx.kv`):** cooldown map, push-budget counter (UTC day), fired
crossing levels, drawdown step, calibrated P0 boundary.

**Playbook — `<slug>-watch`** reads both feeds live per
[interface-spec.md](interface-spec.md). Display name like
"Portfolio Watch — NVDA · TSLA · AAPL" (subject first, < 40 chars).

## Build steps

1. **Preflight** per the official skill: version check, `alva whoami`
   (capture username, tier, **delivery channel fields** — needed for the
   alert conversation), Arrays JWT, memory.
2. **Intake** per [SKILL.md](../SKILL.md): parse tickers/weights/
   sensitivity, validate coverage for every ticker via Data Skills
   discovery, then ask the single confirmation question.
3. **Wire the engine.** Upload
   [scripts/signal-engine.js](../scripts/signal-engine.js) to ALFS (e.g.
   `~/library/portfolio-watch/signal-engine.js`) and `require` it from feed
   code, or inline it. The engine is pure: all data wiring stays in feed
   code against endpoints discovered this session.
4. **Calibrate.** Via `alva run`, execute the engine over the trailing 60
   trading days of the actual tickers. Set the P0 boundary within its
   [55, 75] clamp to hit the 1–3 P0/week target; persist it to `ctx.kv`;
   record expected P0/week and P1/day for the README and the handoff
   message. If a backfill produces zero recordable signals in 60 days,
   thresholds are mis-wired — debug before proceeding, don't loosen blindly.
5. **Fast-lane feed:** implement → `alva run` → shape-check (fail fast; no
   fallback records; empty upstream ⇒ throw) → grant public read → deploy
   with `--push-notify` → `alva automation publish`. Pass the official
   `before-automation-publish` gate. The first run **replays the trailing
   15 sessions** of signal detection (ids dedupe on re-runs) so the
   interface opens with real history instead of a single bar — but pushes
   are computed **only from the latest session's fresh signals**; backfill
   must never page the user about old news.
6. **Slow-lane feed:** same path.
7. **Playbook:** HTML per [interface-spec.md](interface-spec.md) with the
   design-system bundle; README whose methodology section **matches the
   deployed config** (calibrated boundary, cadences, budget — copy from
   calibration output, don't restate defaults); `alva lint playbook`; draft
   (`--skill-id` if invoked via Skillhub); release; screenshot must show
   real feed-backed values.
8. **Alerts:** enable the user's alert on both automations (or the playbook)
   per the official verification list, including one real run with a fresh
   sidecar record. Then verify the deep link end-to-end: tap the delivered
   message, confirm the interface highlights the matching signal.
9. **Handoff message to the user:** share URL; what will be pushed and when
   (calibrated expected rates); how to tune in one line each — change
   sensitivity word, mute a ticker, move brief time, add/remove holdings.
   In `public-watchlist` mode, also post the creator's note (official
   `creators-note.md`) framing the watch for followers.

## Acceptance checklist

All must pass before calling the build done:

- [ ] Every ticker validated against live coverage, or explicitly
      degraded/excluded with the user told.
- [ ] Calibration ran on the real trailing window; boundary within clamp;
      expected rates reported to user and README.
- [ ] No constant in the build is portfolio-specific except the calibrated
      boundary — all thresholds derive from per-ticker stats at runtime, so
      the same skill works on an unseen portfolio.
- [ ] Both feeds: fresh successful run, published automation, public read
      returns 200, non-empty `@last` for every path the HTML reads.
- [ ] Lint passes; screenshot shows real data (not skeletons/empty states);
      no duplicated in-iframe chrome.
- [ ] Push verified: fresh sidecar record, quiet-run sentinel works, alert
      enabled on the right channel, deep link opens the highlighted signal.
- [ ] Daily Brief renders in the interface and every number it cites traces
      to a signal record or a feed-computed value; tripwire table present
      in the methodology footer.
- [ ] `public-watchlist` mode only: no real position sizes or values
      anywhere in the interface, README, brief, or pushes — bands only.
- [ ] README methodology == deployed behavior (sources, cadences,
      thresholds, budget).

## Failure modes

| Failure | Response |
| --- | --- |
| Ticker not covered (e.g. non-US) | Degrade to daily-only if a daily source exists, else exclude — always disclosed in confirmation, interface footer, and README. Never fabricate. |
| > 20% of symbol lookups fail | Data-quality blocker per official rules: stop and report, don't ship partial junk. |
| Endpoint shape surprise | Re-fetch endpoint doc; run a small shape check before the full feed. |
| OOM on backfill | Retry with `--max-heap-size-mb` (≤ 2048) before touching logic. |
| Feed stale at release (> 2× cadence) | Fix the feed first; don't release a dashboard that opens stale. |
