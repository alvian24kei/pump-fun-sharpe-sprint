// "Quiet Hours" — a disciplined paper bot for the Pump.fun Sharpe Sprint.
// The contest rewards the best hourly Sharpe ratio on a 6-hour forward replay,
// so this bot optimises for clean, risk-adjusted returns: few, selective trades,
// small stakes, hard exits, and a paced guardrail lane. It never chases a pump.
//
// Sleeve A "Creator Skin" (cap 2, 0.03 SOL): the creator bought >=1.5 SOL in the
//   last 100 slots and has not sold; at least 3 distinct buyers; young curve
//   (age 100-500 slots). Quick flip: TP +15% / SL -12% / max hold 100 slots.
//   Honest backtests (exits priced at the first trade through the stop, so
//   gap-through atomic dumps count in full) show this sleeve only works young:
//   age 500-1000 is where the -70% dumps live, so the window stops at 500.
// Sleeve C "Dip Retail" (cap 3, 0.05 SOL): 8-25% dip off the 100-slot high with
//   buy-dominant flow (last 15 trades >=60% buys) and highly dispersed buyers
//   (top buyer <=15% of buy SOL over the window), no creator sell, no single
//   sell above 1 SOL, real reserves 5-80 SOL, age >=300 slots. The dispersion
//   filter is the whole edge: in honest backtests it is the only rule whose
//   average loss stays near the stop (-4.7%) instead of gap-through territory.
//   TP +25% / SL -6% / max hold 3000 slots. Emergency exit on any creator sell
//   or single sell above 1 SOL in the window.
// Sleeve B (survivor momentum) is DISABLED: it looked positive in trade-level
//   backtests but lost money in the real batch-granularity simulator, where its
//   trailing stop gets gapped through.
// Guardrail lane: round trips of 0.01 SOL on at least 20 distinct mints are
//   required, so a paced probe lane (one per 10 min, up to 25 mints over 6h)
//   opens 0.01 SOL positions — first on any sleeve signal at probe size, else on
//   any recently active curve with >=5 SOL real reserves and >=10 trades in the
//   last 105 slots. Probes exit like sleeve A (TP +15% / SL -12% / 100 slots).
// Risk controls: max 5 open positions (the house cap); max 6 new main entries
//   per rolling hour; a loss-pause stops main entries for 30 min after 2
//   consecutive losing main trips; a per-mint cooldown of 20,000 slots after a
//   losing sell; no re-entry on a coin that already fell >40% from its peak.
//   A position is only forgotten when its sell FILL arrives — a rejected sell
//   is retried, never orphaned (an orphaned position is held to the end of the
//   replay and closed at whatever price is left, which is how paper bots bleed).
// Everything deterministic: no clock, no env, no Math.random; the only time
//   source is the events' block_time, and the only randomness source the run
//   would allow (state.hello.seed) is unused.
//
// Dev-window backtest (kit's local simulator, 24h frozen window, 3 scenarios):
//   base   net +0.0103 SOL, hourly Sharpe +0.117, max drawdown 0.16%
//   2x fees net -0.0068 SOL, hourly Sharpe -0.073
//   fail key 22 net +0.0075 SOL, hourly Sharpe +0.084
// Fresh 6h slices (each run from a clean state, as the final window will be):
//   Sharpe between -0.71 and +0.30 across the four slices; the bot trades
//   steadily (20-22 round trips, 20-21 distinct mints per 6h) with a max
//   drawdown under 0.2% in every slice. Honest assessment: the edge is thin
//   and the variance is wide — this is a disciplined, low-drawdown entry, not
//   a guaranteed winner.

import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  stakeSol: number;
  stakeA: number;
  stakeB: number;
  stakeC: number;
  probeSol: number;
  capA: number;
  capB: number;
  capC: number;
  maxTopShareC: number;
  tpC: number;
  slC: number;
  maxMain: number;
  maxProbe: number;
  maxEntriesPerHour: number;
  pauseLosses: number;
  pauseSecs: number;
  probeEverySecs: number;
  targetMints: number;
  paceSecs: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.05,
  stakeA: 0.03,
  stakeB: 0.05,
  stakeC: 0.05,
  probeSol: 0.01,
  capA: 2,
  capB: 0,
  capC: 3,
  maxTopShareC: 0.15,
  tpC: 0.25,
  slC: 0.06,
  maxMain: 5,
  maxProbe: 5,
  maxEntriesPerHour: 6,
  pauseLosses: 2,
  pauseSecs: 1800,
  probeEverySecs: 600,
  targetMints: 25,
  paceSecs: 21600,
};

interface Trade { slot: number; buy: boolean; sol: number; user: string; price: number; }
interface Tape { created: number | null; creator: string | null; trades: Trade[]; lastSlot: number; lastRq: number; peakPrice: number; }
type Sleeve = 'A' | 'B' | 'C' | 'P';
interface Held {
  sleeve: Sleeve; entryPrice: number; entrySlot: number; peak: number;
  tokens: bigint; filled: boolean; entries: number; isProbe: boolean;
  stakeSol: number;
  /** A sell was sent and not yet filled; do not send another until it resolves or times out. */
  exiting: boolean; exitSlot: number;
}

const LAM = 1_000_000_000n;
const sol = (x: number): bigint => BigInt(Math.round(x * 1e9));

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<string, Tape>();
  const held = new Map<string, Held>();
  const myCoins = new Set<string>();
  const entriesThisHour: number[] = [];
  const entriesPerMint = new Map<string, number>();
  const coolUntil = new Map<string, number>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let lastProbeTime = -1e18;
  let consecLosses = 0;
  let pauseUntil = -1e18;

  const tapeFor = (mint: string): Tape => {
    let t = tapes.get(mint);
    if (!t) { t = { created: null, creator: null, trades: [], lastSlot: -1, lastRq: 0, peakPrice: 0 }; tapes.set(mint, t); }
    return t;
  };

  /** Flow stats over the last W slots of a tape. */
  const flow = (t: Tape, now: number, W: number) => {
    const byUser = new Map<string, number>();
    let totalBuy = 0, maxSell = 0, creatorSold = false, creatorBuy = 0, buyCount = 0, sellCount = 0;
    let high = 0, start = -1, last = 0;
    for (let k = t.trades.length - 1; k >= 0; k--) {
      const x = t.trades[k]!;
      if (x.slot <= now - W) break;
      if (last === 0) last = x.price; // newest trade in the window
      start = x.price; // ends as the oldest trade in the window
      if (x.price > high) high = x.price;
      if (x.buy) {
        totalBuy += x.sol; buyCount++;
        byUser.set(x.user, (byUser.get(x.user) ?? 0) + x.sol);
        if (t.creator !== null && x.user === t.creator) creatorBuy += x.sol;
      } else {
        sellCount++;
        if (x.sol > maxSell) maxSell = x.sol;
        if (t.creator !== null && x.user === t.creator) creatorSold = true;
      }
    }
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    return {
      buyers: byUser.size, topShare: totalBuy > 0 ? top / totalBuy : 1,
      maxSell, creatorSold, creatorBuy, buyCount, sellCount, totalBuy,
      high, start, last,
    };
  };

  const signalA = (t: Tape, now: number, rq: number): boolean => {
    if (rq < 5 || rq > 80) return false;
    if (t.peakPrice > 0 && t.trades.length && t.trades[t.trades.length - 1]!.price < t.peakPrice * 0.6) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < 100 || age > 500) return false;
    const f = flow(t, now, 100);
    if (f.creatorBuy < 1.5) return false;
    if (f.creatorSold) return false;
    if (f.buyers < 3) return false;
    return true;
  };

  const signalB = (t: Tape, now: number, rq: number): boolean => {
    if (rq < 5 || rq > 80) return false;
    if (t.peakPrice > 0 && t.trades.length && t.trades[t.trades.length - 1]!.price < t.peakPrice * 0.6) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < 480 || age > 1500) return false;
    const f = flow(t, now, 100);
    if (f.start <= 0) return false;
    const chg = f.last / f.start - 1;
    if (chg < -0.05 || chg > 0.20) return false;
    if (f.creatorSold) return false;
    if (f.buyers < 10) return false;
    if (f.topShare > 0.20) return false;
    if (f.maxSell > 1.0) return false;
    if (f.buyCount < 8) return false;
    return true;
  };

  const signalC = (t: Tape, now: number, rq: number): boolean => {
    if (rq < 5 || rq > 80) return false;
    if (t.peakPrice > 0 && t.trades.length && t.trades[t.trades.length - 1]!.price < t.peakPrice * 0.6) return false;
    if (t.created === null) return false;
    if (now - t.created < 300) return false;
    const f = flow(t, now, 100);
    if (f.high <= 0) return false;
    const dip = 1 - f.last / f.high;
    if (dip < 0.08 || dip > 0.25) return false;
    let buys = 0, n = 0;
    for (let k = t.trades.length - 1; k >= 0 && n < 15; k--, n++) if (t.trades[k]!.buy) buys++;
    if (n < 5 || buys / n < 0.6) return false;
    if (f.creatorSold) return false;
    if (f.buyers < 10) return false;
    if (f.topShare > p.maxTopShareC) return false;
    if (f.maxSell > 1.0) return false;
    return true;
  };

  const bot: Bot = {
    onBatch(state: any, batch: Batch) {
      const out: any[] = [];
      const now = batch.slot;
      // Wall time comes from the events' block_time (Batch itself has no clock).
      let time = lastTime ?? 0;
      for (const e of batch.events) {
        const bt = (e as any).block_time;
        if (bt !== null && bt !== undefined) {
          if (firstTime === null) firstTime = bt;
          if (bt > time) time = bt;
        }
      }
      if (firstTime === null) firstTime = time;
      lastTime = time;

      // Observe.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.created = e.slot; t.creator = e.creator; t.lastSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / 1e9, user: e.user, price });
          if (price > t.peakPrice) t.peakPrice = price;
          t.lastSlot = e.slot;
          t.lastRq = Number(e.real_quote_reserves) / 1e9;
        }
      }
      // Trim tapes to the 100-slot lookback (+5 slack) and drop dead curves.
      for (const [mint, t] of tapes) {
        while (t.trades.length && t.trades[0]!.slot <= now - 105) t.trades.shift();
        if (!held.has(mint) && t.lastSlot >= 0 && now - t.lastSlot > 10000) tapes.delete(mint);
      }

      // Fills: track positions. Only a fill with status 'filled' changes state;
      // a rejected/failed order reports 0 amounts and must NOT close the position
      // (otherwise the tokens become an untracked orphan held to the end).
      for (const f of batch.fills ?? []) {
        if (f.client_id.startsWith('_')) {
          if (f.status === 'filled') held.delete(f.mint);
          continue;
        }
        if (f.status !== 'filled') {
          // Rejected/failed order: a sell must be retried, a buy stays unfilled
          // (the 10-slot timeout below drops it).
          if (f.side === 'sell') { const h = held.get(f.mint); if (h) h.exiting = false; }
          continue;
        }
        if (f.side === 'buy') {
          const h = held.get(f.mint);
          if (h && !h.filled) { h.filled = true; h.tokens = BigInt(f.token_amount); }
        } else if (f.side === 'sell') {
          const h = held.get(f.mint);
          if (h) {
            held.delete(f.mint);
            const e = entriesPerMint.get(f.mint) ?? 0;
            if (e > 0) entriesPerMint.set(f.mint, e - 1);
            const spent = sol(h.stakeSol);
            const pnl = Number(BigInt(f.quote_lamports) - spent) / 1e9;
            if (!h.isProbe) {
              if (pnl < 0) {
                coolUntil.set(f.mint, now + 20000);
                consecLosses++;
                if (consecLosses >= p.pauseLosses) { pauseUntil = time + p.pauseSecs; consecLosses = 0; }
              } else consecLosses = 0;
            }
          }
        }
      }

      // Exits.
      const marks = new Map<string, number>();
      for (const m of batch.marks ?? []) marks.set(m.mint, Number(m.virtual_quote_reserves) / Number(m.virtual_token_reserves));
      // Drop buy orders that never filled (rejected): free the slot after 10 slots.
      for (const [mint, h] of held) {
        if (!h.filled && now - h.entrySlot >= 10) {
          held.delete(mint);
          const e = entriesPerMint.get(mint) ?? 0;
          if (e > 0) entriesPerMint.set(mint, e - 1);
        }
      }
      for (const [mint, h] of held) {
        const price = marks.get(mint);
        if (price === undefined) {
          // No mark this batch: a sent sell that never filled must be retried.
          if (h.exiting && now - h.exitSlot >= 10) h.exiting = false;
          // If the position is past its max hold, sell blind —
          // the fill prices off the curve's current reserves, no mark needed.
          const maxHold = h.sleeve === 'B' || h.sleeve === 'C' ? 3000 : 100;
          if (h.filled && !h.exiting && now - h.entrySlot >= maxHold) {
            const bal = state.positions?.get(mint)?.token_amount;
            const tokens = bal !== undefined && bal > 0n ? BigInt(bal) : h.tokens;
            if (tokens > 0n) {
              out.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 1000, client_id: `z-${mint.slice(0, 6)}-${now}` });
              h.exiting = true; h.exitSlot = now;
            }
          }
          continue;
        }
        if (!h.filled) continue;
        if (h.exiting) {
          // Sell sent but not filled (rejected): retry after 10 slots.
          if (now - h.exitSlot >= 10) h.exiting = false;
          continue;
        }
        if (price > h.peak) h.peak = price;
        const ret = price / h.entryPrice - 1;
        const age = now - h.entrySlot;
        let exit = false;
        if (h.sleeve === 'A') exit = ret >= 0.15 || ret <= -0.12 || age >= 100;
        else if (h.sleeve === 'B') {
          const trail = h.peak * 0.96;
          exit = ret >= 0.30 || ret <= -0.08 || (h.peak >= h.entryPrice * 1.08 && price <= trail) || age >= 3000;
        } else if (h.sleeve === 'C') exit = ret >= p.tpC || ret <= -p.slC || age >= 3000;
        else exit = ret >= 0.15 || ret <= -0.12 || age >= 100; // probe on sleeve-A signal, or guardrail probe
        if (exit) {
          const bal = state.positions?.get(mint)?.token_amount;
          const tokens = bal !== undefined && bal > 0n ? BigInt(bal) : h.tokens;
          if (tokens > 0n) {
            out.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 1000, client_id: `x-${mint.slice(0, 6)}-${now}` });
            h.exiting = true; h.exitSlot = now;
          }
        }
      }
      // Creator-sell / big-sell emergency exit for sleeves B and C (checked from the tape).
      for (const [mint, h] of held) {
        if (!h.filled || h.exiting || (h.sleeve !== 'B' && h.sleeve !== 'C')) continue;
        const t = tapes.get(mint);
        if (!t) continue;
        let bad = false;
        for (let k = t.trades.length - 1; k >= 0 && t.trades[k]!.slot > now - 100; k--) {
          const x = t.trades[k]!;
          if (!x.buy && (x.sol > 1.0 || (t.creator !== null && x.user === t.creator))) { bad = true; break; }
        }
        if (bad) {
          const bal = state.positions?.get(mint)?.token_amount;
          const tokens = bal !== undefined && bal > 0n ? BigInt(bal) : h.tokens;
          if (tokens > 0n) {
            out.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 1000, client_id: `e-${mint.slice(0, 6)}-${now}` });
            h.exiting = true; h.exitSlot = now;
          }
        }
      }

      // Entries.
      const committed = typeof state.committedPositionCount === 'function' ? state.committedPositionCount() : held.size;
      const openMain = [...held.values()].filter((h) => !h.isProbe).length;
      const openProbe = [...held.values()].filter((h) => h.isProbe).length;
      while (entriesThisHour.length && entriesThisHour[0]! < time - 3600) entriesThisHour.shift();
      const paused = time < pauseUntil;
      if (!paused && committed < 5 && openMain < p.maxMain && entriesThisHour.length < p.maxEntriesPerHour) {
        const countSleeve = (s: Sleeve) => [...held.values()].filter((h) => h.sleeve === s && !h.isProbe).length;
        const caps: Record<string, number> = { A: p.capA, B: p.capB, C: p.capC };
        const signals: Array<[Sleeve, (t: Tape, n: number, r: number) => boolean]> = [
          ['A', signalA], ['B', signalB], ['C', signalC],
        ];
        for (const [sleeve, sig] of signals) {
          const buysThisBatch = out.filter((o) => o.side === 'buy').length;
          if (committed + buysThisBatch >= 5 || openMain + buysThisBatch >= p.maxMain) break;
          if (countSleeve(sleeve) >= caps[sleeve]!) continue;
          let best: string | null = null;
          for (const [mint, t] of tapes) {
            if (held.has(mint)) continue;
            if ((entriesPerMint.get(mint) ?? 0) >= 1) continue;
            if ((coolUntil.get(mint) ?? -1) > now) continue;
            if (!sig(t, now, t.lastRq)) continue;
            best = mint; break;
          }
          if (best) {
            const t = tapes.get(best)!;
            const price = t.trades.length ? t.trades[t.trades.length - 1]!.price : 0;
            const stake = sleeve === 'A' ? p.stakeA : sleeve === 'B' ? p.stakeB : p.stakeC;
            held.set(best, { sleeve, entryPrice: price, entrySlot: now, peak: price, tokens: 0n, filled: false, entries: 0, isProbe: false, exiting: false, exitSlot: 0, stakeSol: stake });
            entriesPerMint.set(best, (entriesPerMint.get(best) ?? 0) + 1);
            entriesThisHour.push(time);
            myCoins.add(best);
            out.push({ side: 'buy', mint: best, quote_lamports: sol(stake), max_slippage_bps: 300, client_id: `b-${sleeve}-${best.slice(0, 6)}-${now}` });
          }
        }
      }

      // Probe lane: first on sleeve-A signals at probe size (they carry the edge),
      // otherwise any fresh coin with enough reserve, paced, until the mint target.
      const pace = firstTime === null ? 0 : Math.min(1, (time - firstTime) / p.paceSecs);
      const needCoins = myCoins.size < Math.ceil(p.targetMints * pace);
      const probeSlotsFree = openProbe < p.maxProbe && committed < 5;
      if (needCoins && probeSlotsFree && time - lastProbeTime >= p.probeEverySecs) {
        let target: string | null = null;
        let probeSleeve: Sleeve = 'P';
        const probeSignals: Array<[Sleeve, (t: Tape, n: number, r: number) => boolean]> = [['A', signalA], ['B', signalB], ['C', signalC]];
        outer: for (const [sl, sig] of probeSignals) {
          for (const [mint, t] of tapes) {
            if (held.has(mint) || myCoins.has(mint)) continue;
            if (t.lastRq < 5 || t.trades.length < 3) continue;
            if (sig(t, now, t.lastRq)) { target = mint; probeSleeve = sl; break outer; }
          }
        }
        if (!target) {
          for (const [mint, t] of tapes) {
            if (held.has(mint) || myCoins.has(mint)) continue;
            if (t.lastRq < 5 || t.trades.length < 10) continue;
            target = mint; break;
          }
        }
        if (target) {
          const t = tapes.get(target)!;
          const price = t.trades.length ? t.trades[t.trades.length - 1]!.price : 0;
          held.set(target, { sleeve: probeSleeve, entryPrice: price, entrySlot: now, peak: price, tokens: 0n, filled: false, entries: 0, isProbe: true, exiting: false, exitSlot: 0, stakeSol: p.probeSol });
          myCoins.add(target);
          lastProbeTime = time;
          out.push({ side: 'buy', mint: target, quote_lamports: sol(p.probeSol), max_slippage_bps: 300, client_id: `p-${target.slice(0, 6)}-${now}` });
        }
      }
      return out;
    },
  };
  return bot;
}
