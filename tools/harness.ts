// Shared backtest harness for the Sharpe Sprint: slices the kit's 24h
// dataset into 6-hour windows and scores a bot on each one exactly the way
// the house scorer does (sim/metrics.ts):
//   - hourly equity marks from the window's first block time, carried
//     forward through empty hours, last mark after the final flatten
//   - r_i = (m_i - m_{i-1}) / m_{i-1}; sharpe = mean(r) / sample stdev(r)
// Equity points are recorded by wrapping the bot: after each batch the
// wrapper reads state.cash + positions marked at the batch's reserves
// (same point in time the house marks equity). Positions are held seconds,
// so the mark-to-market at hour boundaries is tiny — but it is included,
// not ignored.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const START_CASH = 10_000_000_000n;
const CURVE_FEE_BPS = 125n;
const BPS = 10_000n;

export interface Win {
  label: string;
  startTime: number;
  events: any[];
  batches: { slot: number; events: any[] }[];
  endSlot: number;
}

export interface WinResult {
  label: string;
  netPnlSol: number;
  sharpe: number | null;
  hourlyPnlSol: number[];
  hourlyReturns: number[];
  trips: number;
  wins: number;
  mints: number;
  qualifyingMints: number;
  dd: number;
  fills: number;
  rejected: number;
  failed: number;
  bestTripSol: number;
  worstTripSol: number;
}

export function loadWindows(kitDir: string, offsetsH: number[], hours = 6): Win[] {
  const kitJson = JSON.parse(readFileSync(`${kitDir}/kit.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${kitDir}/dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const allEvents: any[] = [];
  for (let i = 0; i < 3; i++) {
    const raw = gunzipSync(readFileSync(`${kitDir}/dataset/events/part-0000${i}.ndjson.gz`)).toString('utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const members = new Set<string>();
    for (const e of lines) {
      if (e.event === 'CreateEvent' && !members.has(e.mint)) {
        const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        if (e.quote_mint === '11111111111111111111111111111111' && !e.is_mayhem_mode && !e.is_cashback_enabled && !excluded.has(e.mint) && h % BigInt(modulus) === BigInt(residue)) members.add(e.mint);
      }
      if (members.has(e.mint)) allEvents.push(e);
    }
  }
  // Carry block_time forward over nulls; events arrive in slot order.
  let lastT = 0;
  for (const e of allEvents) {
    if (typeof e.block_time === 'number') lastT = e.block_time;
    e._t = lastT;
  }
  const t0 = allEvents[0]._t;
  // A mint belongs to a window only when its CreateEvent is inside it:
  // in the real final window a coin created before the window does not
  // exist at all, so its later trades must not leak in.
  const createTime = new Map<string, number>();
  for (const e of allEvents) if (e.event === 'CreateEvent' && !createTime.has(e.mint)) createTime.set(e.mint, e._t);
  const wins: Win[] = [];
  for (const off of offsetsH) {
    const start = t0 + off * 3600;
    const end = start + hours * 3600;
    const ev = allEvents.filter((e) => {
      const ct = createTime.get(e.mint);
      return ct !== undefined && ct >= start && ct < end && e._t >= start && e._t < end;
    });
    if (ev.length === 0) continue;
    const batches: { slot: number; events: any[] }[] = [];
    for (const e of ev) {
      const tail = batches[batches.length - 1];
      if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
      else batches.push({ slot: e.slot, events: [e] });
    }
    wins.push({ label: `+${off}h`, startTime: start, events: ev, batches, endSlot: ev[ev.length - 1].slot });
  }
  return wins;
}

function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function sharpeOf(returns: number[]): number | null {
  const n = returns.length;
  if (n < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let s2 = 0;
  for (const r of returns) s2 += (r - mean) * (r - mean);
  const sd = Math.sqrt(s2 / (n - 1));
  if (sd === 0) return null;
  return mean / sd;
}

export async function runWindow(kitDir: string, win: Win, bot: any, sha256: string): Promise<WinResult> {
  const simMod: any = await import(`${kitDir}/baselines/pilot/momentum/tools/sim.ts`);
  const { makeHello, phaseSeed, simulate } = simMod;
  // The grader seeds the failed-tx draw from the kit's seed key
  // (kit.json bundle_sha256) AND the frozen dataset's own digest
  // (dataset/manifest.json dataset_sha256) — not kit.json's
  // dataset_sha256 and not the competition slug. Either wrong value
  // changes the failed-tx draws and the trip count.
  const kitJsonLocal = JSON.parse(readFileSync(`${kitDir}/kit.json`, 'utf8'));
  const manifestLocal = JSON.parse(readFileSync(`${kitDir}/dataset/manifest.json`, 'utf8'));
  const seedKey = kitJsonLocal.bundle_sha256 ?? kitJsonLocal.competition;
  const hello = makeHello(phaseSeed(seedKey, 'dev', manifestLocal.dataset_sha256));
  const ds = { sha256, events: win.events, endSlot: win.endSlot, batches: win.batches };

  // Wrap the bot: record (block_time, equity) after every batch, and the
  // filled buy size per mint (for the >= 0.01 SOL round-trip bar).
  const points: { t: number; e: bigint }[] = [];
  const buys = new Map<string, bigint>();
  let lastT = win.startTime;
  const wrapped = {
    onBatch(state: any, batch: any) {
      let t = lastT;
      for (const ev of batch.events) if (typeof ev.block_time === 'number' && ev.block_time > t) t = ev.block_time;
      lastT = t;
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') buys.set(f.mint, (buys.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
      }
      const tx = state.txFeeLamports();
      let eq = state.cash;
      for (const [mint, pos] of state.positions) {
        const mk = batch.marks.find((m: any) => m.mint === mint);
        let vq: bigint, vt: bigint;
        if (mk !== undefined) {
          vq = BigInt(mk.virtual_quote_reserves);
          vt = BigInt(mk.virtual_token_reserves);
        } else {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          vq = cv.virtual_quote_reserves;
          vt = cv.virtual_token_reserves;
        }
        const net = sellValue(pos.token_amount, vq, vt) - tx;
        if (net > 0n) eq += net;
      }
      points.push({ t, e: eq });
      return bot.onBatch(state, batch);
    },
  };
  const r = simulate(ds, hello, wrapped);

  // Hourly marks, house rule: marks[0] = start; carry forward through
  // empty hours; last mark = final cash after the flatten.
  const t0 = win.startTime;
  const finalCash = START_CASH + r.netPnl;
  const marks: bigint[] = [START_CASH];
  let bucket = 0;
  let current = START_CASH;
  for (const p of points) {
    const k = Math.max(bucket, Math.floor((p.t - t0) / 3600));
    while (bucket < k) {
      marks.push(current);
      bucket++;
    }
    current = p.e;
  }
  marks.push(finalCash);
  const hourlyPnlSol = marks.slice(1).map((m, i) => Number(m - marks[i]!) / 1e9);
  const hourlyReturns = marks.slice(1).map((m, i) => (Number(m) - Number(marks[i]!)) / Number(marks[i]!));
  const closedMints = new Set(r.trips.map((t: any) => t.mint));
  let qualifying = 0;
  for (const [mint, amount] of buys) {
    if (closedMints.has(mint) && amount >= 10_000_000n) qualifying++;
  }
  const wins = r.trips.filter((t: any) => t.pnl > 0n).length;
  const pnls = r.trips.map((t: any) => Number(t.pnl) / 1e9);
  return {
    label: win.label,
    netPnlSol: Number(r.netPnl) / 1e9,
    sharpe: sharpeOf(hourlyReturns),
    hourlyPnlSol,
    hourlyReturns,
    trips: r.trips.length,
    wins,
    mints: r.mints,
    qualifyingMints: qualifying,
    dd: r.maxDrawdown,
    fills: r.fills,
    rejected: r.rejected,
    failed: r.failed,
    bestTripSol: pnls.length ? Math.max(...pnls) : 0,
    worstTripSol: pnls.length ? Math.min(...pnls) : 0,
  };
}
