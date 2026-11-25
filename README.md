# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![make.fun](https://make.fun/badge/bro-jack/pump-fun-sharpe-sprint.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun rank](https://make.fun/badge/rank/bro-jack/pump-fun-sharpe-sprint.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun reward](https://make.fun/badge/reward/bro-jack/pump-fun-sharpe-sprint.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A Sharpe-tuned launch scalper for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun. It paper-trades a 6-hour pump.fun forward replay; places go by **hourly Sharpe ratio**, so the bot is built for many small, consistent round trips — not moonshots.

## Strategy

Watch every launch. Buy only when, within its first 2 slots, the creator bought **≥ 0.45 SOL** in the create slot **and** at least **3 distinct non-creator buyers** showed up. One buy per coin (target 0.4 SOL, capped at 1% of real reserve, min 0.01 SOL so every trip counts toward the 20-mint bar). Exit at **+25%** / **−20%** / after **10 slots**, or at once when the creator sells. No adds, no trailing, no second chances.

## Backtest (kit's 24h dataset, seven 6h windows, house Sharpe math)

| window | net PnL | Sharpe/hr | trips | wins | mints | max DD |
|--------|--------:|----------:|------:|-----:|------:|-------:|
| +0h | +0.081 SOL | 0.55 | 31 | 11 | 31 | 0.0026 |
| +3h | +0.003 SOL | 0.03 | 22 | 7 | 22 | 0.0034 |
| +6h | +0.016 SOL | 0.20 | 30 | 9 | 30 | 0.0048 |
| +9h | +0.085 SOL | 0.23 | 45 | 12 | 45 | 0.0087 |
| +12h | +0.133 SOL | 0.35 | 51 | 16 | 51 | 0.0077 |
| +15h | +0.244 SOL | 0.50 | 36 | 14 | 36 | 0.0049 |
| +18h | +0.129 SOL | 0.29 | 22 | 4 | 22 | 0.0065 |

Worst window Sharpe **0.03**, mean **0.31**, every window PnL > 0, 22–51 qualifying round trips (bar: ≥ 20). Full sweep log in the workdir CHECKLIST.md — including what was tried and rejected (hourly PnL governor, partial take-profit, adds, later entry, tighter exits).

## Run it

```sh
node tools/backtest.ts <kit-dir>   # 6h-window table, no network, deterministic
```

`main.ts` runs on Node 22 as-is (`node main.ts`); the grader drives it over the `agent-fun/replay/v2` protocol via `vendor/makefun-bot.ts`.

## Referral

Built with [make.fun](https://make.fun/r/7xkxffzs) — my referral link.
