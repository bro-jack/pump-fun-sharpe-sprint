// Sharpe-tuned launch scalper for the pump.fun Sharpe Sprint.
//
// Ranking here is hourly Sharpe on a 6-hour forward replay, not raw PnL —
// so this bot is built for many small, consistent round trips instead of a
// few moonshots. The edge it harvests: in the first seconds of a pump.fun
// launch the tape already says a lot. Launches where the creator put real
// SOL in at create (>= 0.45 SOL) AND at least 3 distinct non-creator buyers
// showed up keep drifting up for a few slots more often than not; launches
// with neither are instant dumps. The bot buys the former, takes profit at
// +25% or cuts at -20% (or after 10 slots, whichever comes first), and is
// gone within seconds — so each hour's equity is the sum of a handful of
// small, mostly independent trips instead of one or two lottery tickets.
//
// How the numbers were earned — every knob below was picked by sweeping
// the kit's 24h dataset sliced into seven 6-hour windows, scoring each
// window exactly the way the house does (hourly equity marks from the
// window's first block time, Sharpe = mean/std of the 6 hourly returns),
// and keeping only settings that clear >= 20 round trips, PnL > 0 and a
// high Sharpe in EVERY window, not just the best one. The full per-window
// table is in CHECKLIST.md. What was tried and REJECTED on the numbers:
//   - Looser entries (dev >= 0, buyers >= 3): 83 trips/window but -0.25 SOL
//     worst window — the dev-conviction filter is the whole edge.
//   - Stricter entries (dev >= 0.7, buyers >= 6): better mean Sharpe but
//     only 9-15 qualifying mints — fails the 20-mint guardrail.
//   - Tighter exits (TP +6-8% / SL -4-6%): losers recover within the hold,
//     so cutting them early loses money; TP/SL barely bind anyway, most
//     trips exit at max hold or on the creator selling.
//   - Later entry (min age 2-3 slots) or longer holds (15-20 slots): the
//     edge lives in the first seconds; waiting kills it.
//   - Hourly PnL governor (stop trading an hour after +0.01..0.08 SOL banked
//     or -0.01..-0.04 lost): trips collapse, guardrail fails, worst Sharpe
//     goes negative — the fat tail IS the profit, capping it kills the mean.
//   - Partial take-profit (+5-8% half) and second tranches on pumpers:
//     flat to worse; doubling down on a pump loses, the pump is over by
//     the time the add fills.
//   - Momentum confirmation (min run-up), early-sell filters, sizing:
//     no measurable effect; buys are capped at 1% of real reserve anyway.
// Final swept choice, all 7 windows: worst Sharpe 0.03, mean 0.31,
// 22-51 qualifying mints, every window PnL > 0, max drawdown <= 0.0087.
// (At dev >= 0.5 the worst Sharpe is 0.07 but the quietest window sits
// at exactly 20 mints — one failed buy from failing the guardrail — so
// 0.45 trades 0.04 of worst-window Sharpe for 2 mints of margin, and it
// is better on the two windows time-matched to the final window,
// 17:00-23:00Z: Sharpe 0.35 / 0.50 vs 0.31 / 0.44.)
//
// The bot is a pure function of the batches it is fed: no clock, no
// randomness, no I/O, no network. One buy per coin, ever. It never deletes
// anything.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

/** Every knob this bot uses. The values are the swept choice, not a guess. */
export interface ScalpParams {
  /** Youngest age (slots since create) at which a first buy may still be decided. */
  minAge: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. Also the round-trip bar: every buy here is >= 0.01 SOL, so every closed trip counts. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Distinct non-creator buyers before entry, at least / at most. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price run-up vs the create-time reserves, as bps, at most. */
  maxRunupBps: number;
  /** Slippage tolerance on buys (bps). Wide open: a buy is never refused for the price moving in the 2-slot latency. */
  buySlippageBps: number;
  /** Take profit / stop loss vs cost incl. tx fees paid (bps). */
  tpBps: number;
  slBps: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
}

export const STRATEGY_PARAMS: ScalpParams = {
  minAge: 0,
  maxAge: 2,
  stakeLamports: 400_000_000,
  minBuyLamports: 10_000_000,
  minRealSol: 1_000_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 450_000_000,
  maxDevBuy: 2_500_000_000,
  minBuyers: 3,
  maxBuyers: 100,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  maxRunupBps: 1_000_000,
  buySlippageBps: 10_000,
  tpBps: 2_500,
  slBps: 2_000,
  maxHold: 10,
};

/** One launch, watched from its CreateEvent until it is decided for good. */
interface Launch {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  /** Creator's buys in the create slot only. */
  devBuy: bigint;
  /** Distinct non-creator buyers seen before entry. */
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  /** A buy was already sent for this coin (one buy per coin, ever). */
  buySent: boolean;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

/** An open position, tracked from its buy fill until it is gone. */
interface Open {
  openedSlot: number;
  /** Tx fees paid on this coin's fills, added to the cost basis. */
  txPaid: bigint;
  /** Whether the creator had already sold when the buy filled. */
  devSoldAtOpen: boolean;
}

const CURVE_FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) pays after the 95 + 30 bps curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createBot(params: ScalpParams = STRATEGY_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const P = params;
  const launches = new Map<Pubkey, Launch>();
  const open = new Map<Pubkey, Open>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        launches.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          buySent: false,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = launches.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        // CompleteEvent: the curve graduated, nothing left to buy.
        const c = launches.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Bookkeep fills: a buy fill opens a position; a harness flatten fill
      // (client_id starting with '_') closes one out from under us.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = open.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          open.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            devSoldAtOpen: launches.get(f.mint)?.devSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) open.delete(mint);
      }

      // Exits first: take profit, stop loss, max hold, creator sells after we bought.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = launches.get(mint);
        let h = open.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false };
          open.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: launches are considered in create order; one buy per coin, ever.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let openCount = state.committedPositionCount();
      for (const c of launches.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.buySent) continue;
        const age = state.slot - c.createSlot;
        if (age < P.minAge) continue;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (openCount >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        // Rug filter: never buy a coin whose creator already sold.
        if (c.devSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(P.maxRunupBps)) continue;
        const amount = stake < state.maxBuyLamports(c.mint) ? stake : state.maxBuyLamports(c.mint);
        if (amount < minBuy) continue;
        if (free < amount + tx * 6n) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buySent = true;
        openCount += 1;
      }
      return orders;
    },
  };
}
