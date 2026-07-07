# Alert Policy

This file owns what gets pushed, when, how a push reads, and the trust
budget. Buckets come from [signal-taxonomy.md](signal-taxonomy.md). Delivery
mechanics (sidecars, `--push-notify`, alert enable, verification) belong to
the official Alva skill's `push-notifications.md` and `feed-lifecycle.md` —
follow them exactly; this file only decides *policy*.

## Why policy comes first

An alert product dies one of two deaths: too noisy (the user mutes it and
never comes back) or too quiet (the user misses the one move that mattered
and stops trusting it). Every rule below exists to keep the product between
those two deaths. When in doubt, protect P0 credibility: **a P0 push must
never make the user think "why did you ping me for this?"**

## Attention contract

| Bucket | Delivery |
| --- | --- |
| P0 | Immediate push, within the budget below. |
| P1 | Batched into the end-of-day digest (optional pre-open brief if the user asks). Never an instant push. |
| P2 | Interface only. Never pushed. |

## Trust budget

- **P0 budget:** default 4 pushes/day portfolio-wide (`quiet` 2, `verbose`
  6). Multiple P0s in the same run are **merged into one push** with a
  portfolio-level headline. When the budget is exhausted, further P0s still
  appear in the interface and the digest — they do not generate new pushes.
- **Cooldown:** 4 hours per (ticker, dimension). Escalation bypasses the
  cooldown: severity crosses into a higher bucket, or magnitude doubles.
- **Quiet runs:** if nothing new reaches P0, the notify body is exactly
  `<|SKIP_NOTIFICATION|>` so the run advances without a visible push.
- **Digest guarantee:** every P0 and P1 of the day reappears in the EOD
  digest feed (deduplicated by signal id); the pushed brief lists the top
  few and the interface holds the rest. The digest is the safety net that
  makes a tight P0 budget acceptable — nothing material can be *missed*,
  only *deferred*.

## Message templates

Pushes are written to the `notify/message` stream (`title`, `body`; body is
Markdown). Templates — the engine's `formatP0Push` / `formatDigest`
implement these:

**P0, single ticker**

```
title: 🔴 NVDA −8.2% · your largest holding
body:
NVDA fell 8.2% (2.7σ vs its 20-day norm) on 3.8× average volume.
Portfolio impact: −2.6% today, NVDA contributed −2.4pt.
Why: Q2 guidance cut on China export limits (Reuters).
[Open Portfolio Watch](<share_url>?signal=<signal_id>)
```

**P0, merged (several holdings moving)**

```
title: 🔴 Portfolio −3.1% · 3 holdings moving
body:
NVDA −8.2% (2.7σ, 3.8× vol) · TSLA −4.9% (1.6σ) · AAPL −2.1% (1.5σ)
Portfolio −3.1% today vs SPY −0.9%.
[Open Portfolio Watch](<share_url>?signal=<top_signal_id>)
```

**EOD Daily Brief**

A push is read on a phone in three seconds — so the Brief opens with an
**action verdict computed by code** (the same logic as the interface's
Action Board), followed by labeled one-line facts. The LLM contributes
exactly one sentence: the insight line.

```
title: 📋 Portfolio Brief · 2026-07-07
body:
✅ Nothing needs you today — next: JPM earnings Jul 14 (in 7d)

**Book** +1.2% vs SPY +0.9% · led by TSLA +6.7%
**Signals** none new
**Watch** JPM Jul 14 · TSLA Jul 22 · KO Jul 28 · MSFT Jul 29 · AAPL Jul 30
**Note** NVDA at 25% keeps the book's growth tilt doing most of the work.
[Open Portfolio Watch](<share_url>)
```

The verdict line escalates deterministically: `🔴 Look now — <P0 title>` >
`🟡 Read below — N notable signals (tickers)` > `🟡 Prepare — <earnings
in ≤2d>` > `✅ Nothing needs you today — next: <catalyst>`.

Brief-specific rules: the verdict and every labeled number are composed in
feed code — the LLM never writes the first line and never produces a
number; its single **Note** sentence interprets facts it was given
(positioning, signal pattern, attention), no advice, no prediction. No
signals + no catalysts = verdict line only; don't manufacture insight.

### Writing rules

- **Numbers first, cause second, link always.** First line = ticker +
  magnitude + σ context. Never bury the number under prose.
- The "Why" line comes from alpi over *fetched* headlines with the source
  named. If no grounded cause exists, **omit the line** — an honest absence
  beats an invented reason.
- When a same-day tracked-KOL quote exists (see `social.kol` in the
  taxonomy), one attributed quote may follow the Why line:
  `@handle (tracked): "…" — 2h before the move`. One quote max, always
  attributed, never presented as the cause.
- One push ≤ 6 lines. σ framing ("2.7σ vs its 20-day norm") is what
  justifies the interruption — always include it.
- Every push ends with the deep link: `<share_url>?signal=<signal_id>`
  (see [interface-spec.md](interface-spec.md) for handling).

## Channel

Deliver to the user's active IM channel (Telegram / Discord / Slack) from
`alva whoami`. If none is connected, say so explicitly — web notifications
work immediately and the user can connect an IM app at
<https://alva.ai/settings>. Do not silently ship web-only delivery when the
user asked to be pinged on their phone.

## Verification

A push setup is only done when the official checklist passes end-to-end:
sidecar record exists and is fresh after a real run, automation published
after the sidecar was added, cronjob has `--push-notify`, the user's alert
is enabled, and a quiet run correctly emits the skip sentinel. Additionally
for this skill: **tap the delivered alert once and confirm the interface
opens with the matching signal highlighted.**
