// Backtest for the Sharpe Sprint entry: runs strategy.ts over 6-hour
// windows of the kit's 24h dataset and prints the per-window table the
// house would score (hourly Sharpe, net PnL, round trips, drawdown).
// Usage:
//   node tools/backtest.ts <kit-dir> [--params '{"minBuyers":3,"tpBps":800}'] [--offsets 0,6,12,18]
// No network, no randomness: two runs print byte-identical numbers.
import { readFileSync } from 'node:fs';
import { createBot, STRATEGY_PARAMS, type ScalpParams } from '../strategy.ts';
import { loadWindows, runWindow } from './harness.ts';

const kit = process.argv[2]!;
const args = process.argv.slice(3);
const paramsArg = args.find((a) => a.startsWith('--params='));
const offsetsArg = args.find((a) => a.startsWith('--offsets='));
const hoursArg = args.find((a) => a.startsWith('--hours='));
const params: ScalpParams = paramsArg ? { ...STRATEGY_PARAMS, ...JSON.parse(paramsArg.slice(9)) } : STRATEGY_PARAMS;
const offsets = offsetsArg ? offsetsArg.slice(10).split(',').map(Number) : [0, 3, 6, 9, 12, 15, 18];
const hours = hoursArg ? Number(hoursArg.slice(8)) : 6;

const kitJson = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8'));
const wins = loadWindows(kit, offsets, hours);
console.log(`strategy: ${JSON.stringify(params)}`);
console.log(`windows: ${wins.map((w) => w.label).join(' ')}  (${hours}h each, from ${new Date(wins[0]!.startTime * 1000).toISOString()})`);
console.log('label   netSOL  sharpe  trips wins mints qualMin  dd      fills rej fail  best    worst   hourlyPnL(SOL)');
let worstSharpe = Infinity;
let minQual = Infinity;
let allPositive = true;
for (const w of wins) {
  const r = await runWindow(kit, w, createBot(params), kitJson.dataset_sha256);
  if (r.sharpe !== null && r.sharpe < worstSharpe) worstSharpe = r.sharpe;
  if (r.qualifyingMints < minQual) minQual = r.qualifyingMints;
  if (r.netPnlSol <= 0) allPositive = false;
  const sh = r.sharpe === null ? '  null' : r.sharpe.toFixed(2).padStart(6);
  console.log(
    `${r.label.padEnd(6)} ${r.netPnlSol.toFixed(3).padStart(7)} ${sh} ${String(r.trips).padStart(5)} ${String(r.wins).padStart(4)} ${String(r.mints).padStart(5)} ${String(r.qualifyingMints).padStart(7)} ${r.dd.toFixed(4).padStart(7)} ${String(r.fills).padStart(6)} ${String(r.rejected).padStart(3)} ${String(r.failed).padStart(4)} ${r.bestTripSol.toFixed(3).padStart(7)} ${r.worstTripSol.toFixed(3).padStart(7)}  [${r.hourlyPnlSol.map((x) => x.toFixed(3)).join(' ')}]`,
  );
}
console.log(`aggregate: worst sharpe ${worstSharpe === Infinity ? 'null' : worstSharpe.toFixed(2)}, min qualifying mints ${minQual}, all windows PnL>0: ${allPositive}`);
