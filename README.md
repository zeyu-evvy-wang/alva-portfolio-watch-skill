# Portfolio Watch — an Alva Skill

Turn one sentence — *"keep an eye on my NVDA, TSLA, AAPL, ping me when
something big happens"* — into a running Alva Playbook: a live interface
showing what's happening to each holding, plus Telegram alerts calibrated
so a critical push means something.

> **Live Playbook built from this skill:**
> <https://alva.ai/u/evvywang/playbooks/tech-core-watch>
> Built from one sentence — *"Watch my portfolio: 25% NVDA, 15% MSFT, 15%
> AAPL, 15% TSLA, 10% MU, 10% JPM, 10% KO — ping me when something big
> happens."*
> Two automations run behind it (signal engine every 30 min in market hours;
> catalysts + Daily Brief push after close), calibrated on the portfolio's
> trailing 60 sessions.

## Why this design

- **The page opens with an Action Board, not a chart.** Red/amber/green
  status plus at most three verb-first items (look now / read tonight's
  brief / prepare for earnings) — attention verbs only, never trading
  advice. Everything below is evidence.
- **"Big" must pass three questions.** Abnormal for that stock (z-score vs
  its own 20-day volatility — a 3% day is routine for TSLA and an event
  for KO), meaningful for this portfolio (weight × move), and not
  explained by the market (β-residual filter: a broad risk-off day is one
  portfolio alert, not six stock pings). A 5-session drift check catches
  slow bleeds that daily thresholds structurally miss.
- **Ranking follows your money.** Severity = magnitude (σ) + position
  impact (bps) + corroboration + event weight → P0 interrupt / P1 daily
  digest / P2 interface-only.
- **Alerts spend a trust budget.** Daily P0 cap, per-signal cooldowns,
  quiet-run sentinel, digest safety net — and before going live, the engine
  replays the trailing 60 trading days to calibrate the P0 boundary to
  **1–3 critical alerts per week**. Thresholds are derived from the
  attention budget, not guessed.
- **A watch is also content.** An opinionated three-beat Daily Brief,
  tracked-KOL quotes as attributed context on moves, a per-holding
  tripwire table ("NVDA would ping you today at ±7.3%") — all live in the
  demo. The skill also specs a public-watchlist mode (position sizes shown
  as bands) for making a watch followable; it's designed but this demo runs
  in personal mode. Informed by what Alva's most-subscribed playbooks have
  in common.

Full reasoning: [ONE-PAGER.md](ONE-PAGER.md)（中文）.

## Structure

```
├── ONE-PAGER.md                    # 交付物 3：一页纸思路（中文）
├── portfolio-watch/                # 交付物 1：the Skill
│   ├── SKILL.md                    #   entry point — methodology + build directives
│   ├── references/
│   │   ├── signal-taxonomy.md      #   dimensions, adaptive thresholds, severity model
│   │   ├── alert-policy.md         #   P0/P1/P2, budget, cooldowns, templates, deep links
│   │   ├── interface-spec.md       #   Action Board + playbook information architecture
│   │   └── build-plan.md           #   feed architecture, build order, acceptance gates
│   └── scripts/
│       └── signal-engine.js        #   pure-JS reference implementation (jagent-safe)
└── playbook-build/                 # 交付物 2 的构建产物 — what the skill actually built
    ├── feed-signals.js             #   fast lane: signal engine feed (live on Alva)
    ├── feed-catalysts.js           #   slow lane: calendar + KOL echo + Daily Brief
    ├── calibrate.js                #   60-session calibration backfill
    ├── index.html                  #   the playbook interface (lint-clean)
    └── README-playbook.md          #   the playbook's About page
```

Layers on top of the official [alva-ai/skills](https://github.com/alva-ai/skills)
skill, which stays authoritative for platform mechanics (feed lifecycle,
release gates, push verification, design system).

## Use it

```bash
npx skills add https://github.com/alva-ai/skills   # official Alva skill first
git clone https://github.com/zeyu-evvy-wang/alva-portfolio-watch-skill
# then add this repo's portfolio-watch/ folder to your agent's skills
```

Then tell your agent:

> Use the portfolio-watch skill: keep an eye on my NVDA, TSLA and AAPL,
> ping me on Telegram when something big happens.

The agent will confirm the plan in one message (tickers, weights,
expected alert rates, channel), then build feeds → calibrate → playbook →
alerts, and hand you the share URL.

---

*PM take-home for Alva · 王泽宇 (Alva handle: @evvywang) · 2026-07*
