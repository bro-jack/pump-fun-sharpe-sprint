// Parameter sweep for the Sharpe Sprint entry: scores each combo on all
// seven 6h windows and ranks by worst-window Sharpe (the number that has
// to survive the real final window), subject to the guardrails.
// Usage:
//   node tools/sweep.ts <kit-dir> --stage 1|2|3
// Stage 1: entry looseness. Stage 2: exits. Stage 3: sizing.
import { readFileSync } from 'node:fs';
import { createBot, STRATEGY_PARAMS, type ScalpParams } from '../strategy.ts';
import { loadWindows, runWindow, type WinResult } from './harness.ts';

const kit = process.argv[2]!;
const stage = process.argv.find((a) => a.startsWith('--stage='))?.slice(8) ?? '1';
const kitJson = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8'));
const wins = loadWindows(kit, [0, 3, 6, 9, 12, 15, 18]);

const base: ScalpParams = { ...STRATEGY_PARAMS };
const combos: { name: string; patch: Partial<ScalpParams> }[] = [];
if (stage === '1') {
  for (const minBuyers of [3, 4, 6]) {
    for (const minDevBuy of [0, 300_000_000, 500_000_000, 700_000_000]) {
      for (const maxAge of [2, 4]) {
        combos.push({ name: `buyers>=${minBuyers} dev>=${minDevBuy / 1e9} age<=${maxAge}`, patch: { minBuyers, minDevBuy, maxAge } });
      }
    }
  }
} else if (stage === '2') {
  // Entry set is overridden by --entry JSON: {"minBuyers":3,"minDevBuy":300000000,"maxAge":4}
  const entryArg = process.argv.find((a) => a.startsWith('--entry='));
  const entry = entryArg ? JSON.parse(entryArg.slice(8)) : {};
  Object.assign(base, entry);
  for (const tpBps of [600, 800, 1000, 1500]) {
    for (const slBps of [400, 600, 800, 1200]) {
      for (const maxHold of [6, 10]) {
        combos.push({ name: `tp${tpBps} sl${slBps} hold${maxHold}`, patch: { tpBps, slBps, maxHold } });
      }
    }
  }
} else if (stage === '8') {
  // Payoff shape: partial take-profit x second tranche on winners.
  const entryArg = process.argv.find((a) => a.startsWith('--entry='));
  const entry = entryArg ? JSON.parse(entryArg.slice(8)) : {};
  Object.assign(base, entry);
  combos.push({ name: 'base (no tp1, no adds)', patch: {} });
  combos.push({ name: 'tp1 +8% half', patch: { tp1Bps: 800, tp1PartBps: 5000, slAfterTp1Bps: 0 } });
  combos.push({ name: 'tp1 +5% half', patch: { tp1Bps: 500, tp1PartBps: 5000, slAfterTp1Bps: 0 } });
  combos.push({ name: 'tp1 +8% half, slAfter 0', patch: { tp1Bps: 800, tp1PartBps: 5000, slAfterTp1Bps: 0 } });
  combos.push({ name: 'adds +5% step', patch: { maxAdds: 1, addStepBps: 500, addDelay: 2 } });
  combos.push({ name: 'tp1 +8% half + adds', patch: { tp1Bps: 800, tp1PartBps: 5000, slAfterTp1Bps: 0, maxAdds: 1, addStepBps: 500, addDelay: 2 } });
} else if (stage === '7') {
  // Entry-signal refinements: momentum confirmation, buyer-count cap,
  // early-sell filters. (runup is in bps vs create price: 10000 = flat.)
  const entryArg = process.argv.find((a) => a.startsWith('--entry='));
  const entry = entryArg ? JSON.parse(entryArg.slice(8)) : {};
  Object.assign(base, entry);
  for (const minRunupBps of [10000, 10500, 11000, 12000]) {
    for (const maxBuyers of [30, 100]) {
      combos.push({ name: `runup>=${minRunupBps} maxBuyers${maxBuyers}`, patch: { minRunupBps, maxBuyers } });
    }
  }
  for (const maxSellRatioBps of [2000, 5000]) {
    combos.push({ name: `sellRatio<=${maxSellRatioBps}`, patch: { maxSellRatioBps } });
  }
  for (const maxBigSellBps of [2000, 5000]) {
    combos.push({ name: `bigSell<=${maxBigSellBps}`, patch: { maxBigSellBps } });
  }
} else if (stage === '6') {
  // Hourly PnL governor: cap x floor grid.
  const entryArg = process.argv.find((a) => a.startsWith('--entry='));
  const entry = entryArg ? JSON.parse(entryArg.slice(8)) : {};
  Object.assign(base, entry);
  for (const hourCapLamports of [10_000_000, 20_000_000, 40_000_000, 80_000_000]) {
    for (const hourFloorLamports of [0, -10_000_000, -20_000_000, -40_000_000]) {
      combos.push({ name: `cap${hourCapLamports / 1e6}M floor${hourFloorLamports / 1e6}M`, patch: { hourCapLamports, hourFloorLamports } });
    }
  }
} else if (stage === '5') {
  // Exits round 2: wider/no stop-loss, hold 8, wider TP.
  const entryArg = process.argv.find((a) => a.startsWith('--entry='));
  const entry = entryArg ? JSON.parse(entryArg.slice(8)) : {};
  Object.assign(base, entry);
  for (const tpBps of [1500, 2500]) {
    for (const slBps of [1200, 2000, 100_000]) {
      for (const maxHold of [8, 10]) {
        combos.push({ name: `tp${tpBps} sl${slBps} hold${maxHold}`, patch: { tpBps, slBps, maxHold } });
      }
    }
  }
} else if (stage === '4') {
  // Hold time x entry age window, on the stage-1 entry set.
  const entryArg = process.argv.find((a) => a.startsWith('--entry='));
  const entry = entryArg ? JSON.parse(entryArg.slice(8)) : {};
  Object.assign(base, entry);
  for (const [minAge, maxAge] of [[0, 2], [0, 4], [1, 4], [2, 6], [3, 8]] as const) {
    for (const maxHold of [10, 15, 20]) {
      combos.push({ name: `age${minAge}-${maxAge} hold${maxHold}`, patch: { minAge, maxAge, maxHold } });
    }
  }
} else {
  const entryArg = process.argv.find((a) => a.startsWith('--entry='));
  const entry = entryArg ? JSON.parse(entryArg.slice(8)) : {};
  Object.assign(base, entry);
  for (const stakeLamports of [100_000_000, 200_000_000, 400_000_000]) {
    for (const minRealSol of [300_000_000, 1_000_000_000]) {
      combos.push({ name: `stake${stakeLamports / 1e9} minReal${minRealSol / 1e9}`, patch: { stakeLamports, minRealSol } });
    }
  }
}

interface Row {
  name: string;
  worstSharpe: number;
  meanSharpe: number;
  minQual: number;
  minNet: number;
  posWindows: number;
  meanTrips: number;
}
const rows: Row[] = [];
for (const c of combos) {
  const params = { ...base, ...c.patch };
  const results: WinResult[] = [];
  for (const w of wins) results.push(await runWindow(kit, w, createBot(params), kitJson.dataset_sha256));
  const sharpes = results.map((r) => r.sharpe ?? -9);
  const worstSharpe = Math.min(...sharpes);
  const meanSharpe = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
  const minQual = Math.min(...results.map((r) => r.qualifyingMints));
  const minNet = Math.min(...results.map((r) => r.netPnlSol));
  const posWindows = results.filter((r) => r.netPnlSol > 0).length;
  const meanTrips = results.reduce((a, r) => a + r.trips, 0) / results.length;
  rows.push({ name: c.name, worstSharpe, meanSharpe, minQual, minNet, posWindows, meanTrips });
  console.log(`${c.name.padEnd(38)} worstSharpe ${worstSharpe.toFixed(2).padStart(6)} meanSharpe ${meanSharpe.toFixed(2).padStart(6)} minQual ${String(minQual).padStart(3)} minNet ${minNet.toFixed(3).padStart(7)} posWin ${posWindows}/7 meanTrips ${meanTrips.toFixed(1)}`);
}
rows.sort((a, b) => b.worstSharpe - a.worstSharpe);
console.log('\nTOP 5 by worst-window Sharpe:');
for (const r of rows.slice(0, 5)) {
  console.log(`  ${r.name} — worst ${r.worstSharpe.toFixed(2)}, mean ${r.meanSharpe.toFixed(2)}, minQual ${r.minQual}, minNet ${r.minNet.toFixed(3)}, posWin ${r.posWindows}/7, meanTrips ${r.meanTrips.toFixed(1)}`);
}
