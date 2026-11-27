# Quiet Hours — Pump.fun Sharpe Sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/alvian24kei/pump-fun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/alvian24kei/pump-fun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Quiet Hours — a disciplined paper bot for the Pump.fun Sharpe Sprint

A paper trading bot for make.fun's **"Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins"**
bounty ($2 in USDC, top 3 share $1 / $0.60 / $0.40). The bot trades paper money on a
6-hour pump.fun forward replay; places go by hourly Sharpe ratio, best first, and a
placement needs net PnL above 0 after every fee. So this bot optimises for clean,
risk-adjusted returns — few selective trades, small stakes, hard exits — not raw profit.

## Strategy

Two selective sleeves, plus a paced guardrail lane:

- **Sleeve A "Creator Skin"** (cap 2, 0.03 SOL): the creator bought ≥1.5 SOL in the last
  100 slots and has not sold; at least 3 distinct buyers; young curve (age 100–500
  slots). Quick flip: TP +15% / SL −12% / max hold 100 slots.
- **Sleeve C "Dip Retail"** (cap 3, 0.05 SOL): an 8–25% dip off the 100-slot high with
  buy-dominant flow (last 15 trades ≥60% buys) and highly dispersed buyers (top buyer
  ≤15% of buy SOL over the window), no creator sell, no single sell above 1 SOL, real
  reserves 5–80 SOL, age ≥300 slots. TP +25% / SL −6% / max hold 3,000 slots, with an
  emergency exit on any creator sell or single sell above 1 SOL.
- **Guardrail lane**: the rules require round trips of ≥0.01 SOL on at least 20 distinct
  mints, so a paced probe lane (one per 10 minutes, up to 25 mints over 6h) opens 0.01 SOL
  positions — first on any sleeve signal at probe size, otherwise on any recently active
  curve with ≥5 SOL real reserves and ≥10 trades in the last 105 slots.

## Risk controls

- Max 5 open positions (the house cap); max 6 new main entries per rolling hour.
- A loss-pause stops main entries for 30 minutes after 2 consecutive losing main trips.
- A per-mint cooldown of 20,000 slots after a losing sell; no re-entry on a coin that
  already fell more than 40% from its peak.
- A position is only forgotten when its sell **fill** arrives — a rejected sell is
  retried, never orphaned (an orphaned position is held to the end of the replay and
  closed at whatever price is left, which is how paper bots bleed).
- Everything is deterministic: no clock, no environment, no `Math.random`; the only time
  source is the events' `block_time`.

## Why these rules

Backtested on the kit's frozen 24h dev window (128,058 events, 1,222 mints) with the
kit's own local simulator, plus an honest trade-level lab that prices exits at the
first trade through the stop — so gap-through atomic dumps (a single sell cratering
a coin −70% in one batch, which happens to ~19% of "good-looking" entries) count in
full instead of being assumed to execute at the stop:

- The dip-retail dispersion filter is the whole edge: it is the only rule whose average
  loss stays near the stop (−4.7%) instead of gap-through territory, at +4.9% expected
  value per trade in the lab.
- The creator-skin rule only works young (age 100–500 slots); age 500–1,000 is where
  the −70% dumps live, so the window stops at 500.
- A survivor-momentum sleeve looked positive in trade-level backtests but lost money
  in the real batch-granularity simulator, where its trailing stop gets gapped
  through — so it is disabled (cap 0).

## Measured results (kit's local simulator, dev window)

| Scenario | Net PnL | Hourly Sharpe | Max drawdown | Trips |
| --- | --- | --- | --- | --- |
| Base | +0.0103 SOL | +0.117 | 0.16% | 23 |
| 2× fees | −0.0068 SOL | −0.073 | 0.27% | 23 |
| Fail key 22 | +0.0075 SOL | +0.084 | 0.19% | 25 |

Fresh 6-hour slices (each run from a clean state, as the final window will be):
Sharpe between −0.71 and +0.30 across the four slices; the bot trades steadily
(20–22 round trips, 20–21 distinct mints per 6h) with max drawdown under 0.2% in
every slice. Honest assessment: the edge is thin and the variance is wide — this is
a disciplined, low-drawdown entry, not a guaranteed winner.

## Files

- `main.ts` — entry point; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the whole strategy, written from scratch for this bounty.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte from
  `sdk/ts/makefun-bot.ts` (unchanged).

Paper trading only: no real money, no real trades, no wallet needed.
