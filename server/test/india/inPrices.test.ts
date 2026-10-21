import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { saveFoList, setEqTokens, syncWatched, upsertInCalendarRow } from '../../src/india/db/inRepo.js';
import { InPrices, type InLivePrice, optionTokensFor, type TickStream } from '../../src/india/live/inPrices.js';
import type { KiteInstrument } from '../../src/india/sources/foList.js';
import type { KiteTick } from '../../src/india/sources/kiteStream.js';

const NOW = '2026-10-21T05:00:00.000Z'; // 10:30 IST on a Wednesday: in session
const SESSION = { apiKey: 'k', accessToken: 't', expiresAt: Date.now() + 3_600_000 };

class FakeStream extends EventEmitter implements TickStream {
  connects: { tokens: number[]; full: number[] }[] = [];
  sets: { tokens: number[]; full: number[] }[] = [];
  connect(tokens: number[], full: number[] = []) { this.connects.push({ tokens, full }); }
  setTokens(tokens: number[], full: number[] = []) { this.sets.push({ tokens, full }); }
  disconnect() {}
  get last() { return this.sets.at(-1) ?? this.connects.at(-1)!; }
}

const tick = (token: number, ltp: number, extra: Partial<KiteTick> = {}): KiteTick =>
  ({ token, ltp, close: ltp, isIndex: false, bid: null, ask: null, ...extra });

const option = (token: number, strike: number, type: 'CE' | 'PE'): KiteInstrument => ({
  instrumentToken: token, tradingsymbol: `RELIANCE26OCT${strike}${type}`, name: 'RELIANCE', expiry: '2026-10-27',
  strike, instrumentType: type, segment: 'NFO-OPT', exchange: 'NFO', lotSize: 250,
});
// Strikes 970..1030 (7), calls token 1000+strike, puts 2000+strike.
const STRIKES = [970, 980, 990, 1000, 1010, 1020, 1030];
const CHAIN = STRIKES.flatMap((k) => [option(1000 + k, k, 'CE'), option(2000 + k, k, 'PE')]);

function setup(opts: { yahoo?: (s: string) => Promise<{ price: number; prevClose: number | null } | null> } = {}) {
  const db = openDb(':memory:') as unknown as DatabaseSync;
  saveFoList(db, [
    { symbol: 'RELIANCE', name: 'RELIANCE INDUSTRIES', lotSize: 250 },
    { symbol: 'GAIL', name: 'GAIL (INDIA)', lotSize: 3150 },
  ], NOW);
  syncWatched(db, ['SMALLCAP'], new Map([['SMALLCAP', 'SMALL CAP LTD']]), NOW);
  setEqTokens(db, new Map([['RELIANCE', 10], ['GAIL', 20], ['SMALLCAP', 30]]));
  const reportId = upsertInCalendarRow(db, {
    symbol: 'RELIANCE', name: 'RELIANCE INDUSTRIES', quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-22',
  }, NOW);
  const stream = new FakeStream();
  const prices: Record<string, InLivePrice>[] = [];
  const moves: number[][] = [];
  const p = new InPrices(db, () => SESSION, () => '2026-10-21', (x) => prices.push(x), {
    makeStream: () => stream,
    instruments: async () => CHAIN,
    yahoo: opts.yahoo ?? (async () => null),
    onMoves: (ids) => moves.push(ids),
  });
  return { db, p, stream, prices, moves, reportId };
}

const liveMove = (db: DatabaseSync, id: number) =>
  db.prepare('SELECT move_pct AS movePct, illiquid FROM in_live_moves WHERE report_id = ?').get(id) as { movePct: number; illiquid: number } | undefined;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
afterEach(() => vi.useRealTimers());

describe('InPrices universe', () => {
  it('universe = F&O ∪ watched', async () => {
    const { p, stream } = setup();
    await p.refresh();
    const indices = [256265, 265, 260105, 256777];
    expect(new Set(stream.connects[0]!.tokens)).toEqual(new Set([10, 20, 30, ...indices]));
    expect(stream.connects[0]!.full).toEqual([]);
  });
});

describe('optionTokensFor', () => {
  it('six nearest strikes, calls and puts, for the expiry after the report date', () => {
    const reports = [{ id: 7, symbol: 'RELIANCE', reportDate: '2026-10-22', timing: 'UNKNOWN' as const, quarterEnd: '2026-09-30' }];
    const m = optionTokensFor(CHAIN, reports, new Map([['RELIANCE', 1000]]));
    expect(m.size).toBe(12);
    expect(m.get(2000 + 1000)).toEqual({ reportId: 7, strike: 1000, type: 'PE' });
    expect([...m.values()].some((o) => o.strike === 1030)).toBe(false); // the 7th, furthest strike
    expect(optionTokensFor(CHAIN, reports, new Map()).size).toBe(0); // no price yet
  });
});

describe('option ticks drive the live move', () => {
  it('option ticks update the live move within one throttle window', async () => {
    const { p, stream, db, moves, reportId } = setup();
    await p.refresh();
    stream.emit('tick', tick(10, 1000));
    await vi.advanceTimersByTimeAsync(0);
    // The reporter's contracts are now subscribed in full mode.
    expect(stream.last.full.length).toBe(12);
    expect(stream.last.tokens).toEqual(expect.arrayContaining(stream.last.full));

    stream.emit('tick', tick(2000 + 1000, 28, { bid: 28, ask: 29 }));
    expect(liveMove(db, reportId)).toBeUndefined(); // call side not quoted yet
    stream.emit('tick', tick(1000 + 1000, 29.5, { bid: 29.5, ask: 31 }));
    expect(liveMove(db, reportId)).toMatchObject({ movePct: 5.88, illiquid: 0 }); // (30.25 + 28.5) / 1000
    expect(moves).toEqual([[reportId]]);

    // A new quote inside the 5 s window waits for the window to end, then one save.
    stream.emit('tick', tick(1000 + 1000, 31, { bid: 31, ask: 32.5 }));
    expect(liveMove(db, reportId)!.movePct).toBe(5.88);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(liveMove(db, reportId)!.movePct).toBe(6.03); // (31.75 + 28.5) / 1000
    expect(moves).toEqual([[reportId], [reportId]]);
  });
});

describe('Yahoo backup for silent equities', () => {
  it('no ticks for 2 min in session: Yahoo price, source backup', async () => {
    const yahoo = vi.fn(async (s: string) => (s === 'GAIL' ? { price: 200, prevClose: 190 } : null));
    const { p, stream, prices } = setup({ yahoo });
    await p.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    stream.emit('tick', tick(10, 1000)); // RELIANCE is alive
    await vi.advanceTimersByTimeAsync(61_000);

    await p.checkBackup(); // GAIL and SMALLCAP silent for 121 s, RELIANCE for 61 s
    expect(yahoo.mock.calls.map((c) => c[0]).sort()).toEqual(['GAIL', 'SMALLCAP']);
    expect(p.snapshot().GAIL).toMatchObject({ price: 200, prevClose: 190, changePct: 5.26, source: 'backup' });
    expect(p.snapshot().RELIANCE!.source).toBe('stream');
    expect(prices.at(-1)).toMatchObject({ GAIL: { source: 'backup' } });

    // A fresh tick takes over again.
    stream.emit('tick', tick(20, 201));
    expect(p.snapshot().GAIL).toMatchObject({ price: 201, source: 'stream' });
  });

  it('outside the session nothing is fetched', async () => {
    const yahoo = vi.fn(async () => ({ price: 1, prevClose: 1 }));
    const { p } = setup({ yahoo });
    await p.refresh();
    vi.setSystemTime(new Date('2026-10-21T14:00:00.000Z')); // 19:30 IST
    await p.checkBackup();
    expect(yahoo).not.toHaveBeenCalled();
  });
});
