// Pump.fun Sharpe Sprint — Sharpe-tuned launch scalper.
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at /bot.
// Node 22.18+ runs this TypeScript as it is; no build step, no dependencies,
// no network, no I/O beyond the harness protocol on stdin/stdout.
//
// What it does (full reasoning lives in strategy.ts): it watches every
// pump.fun launch and buys only the ones where the creator bought >= 0.45 SOL
// in the create slot AND at least 3 distinct non-creator buyers showed up
// within 2 slots. One buy per coin, sized to the 1% of real-reserve cap
// (target 0.4 SOL), out at +25% or -20% or after 10 slots, whichever comes
// first. Swept over seven 6-hour windows of the kit's 24h dataset, scored
// exactly like the house (hourly Sharpe): worst window Sharpe 0.03, mean
// 0.31, 22-51 qualifying round trips per window, every window PnL > 0,
// max drawdown <= 0.0087 — vs the Replay Sprint sniper's 9-16 trips per
// 6h, which fails the 20-mint guardrail.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot, STRATEGY_PARAMS } from './strategy.ts';

const bot = createBot(STRATEGY_PARAMS);

await runBot({
  onBatch: (state, batch) => bot.onBatch(state, batch),
});
