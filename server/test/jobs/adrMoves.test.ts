import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { type AdrMoveRow, type AdrMovesDeps, refreshAdrLiveMoves, snapshotAdrMoves } from '../../src/jobs/adrMoves.js';
import { parseCboeChain } from '../../src/sources/cboe.js';
import type { ExpectedMove, OptionChain } from '../../src/types.js';

const raw = JSON.parse(readFileSync(new URL('../fixtures/hk/cboe_BABA.json', import.meta.url), 'utf8'));
const NOW = '2026-10-27T04:00:00.000Z';
const chainAt = (asOfDate: string | null, quoteTime: string | null = asOfDate ? `${asOfDate}T16:30:00` : null): OptionChain =>
  ({ ...parseCboeChain(raw, 'BABA')!, asOfDate, quoteTime });

type Saved = ExpectedMove & { adr: string; quoteDate: string; final: boolean };

/** Stub deps over in-memory maps; the store mirrors the repo rule that a final snapshot is never replaced. */
function setup(opts: { chain?: OptionChain | null; now?: string; today?: string; rows?: AdrMoveRow[] } = {}) {
  const state = { chain: opts.chain === undefined ? chainAt('2026-11-19') : opts.chain, fetches: 0 };
  const expected = new Map<number, Saved>();
  const live = new Map<number, number>();
  const rows: AdrMoveRow[] = opts.rows ?? [{ id: 1, reportDate: '2026-11-20', timing: 'UNKNOWN', releasedAt: null, adr: 'BABA' }];
  const asked: [string, string][] = [];
  const d: AdrMovesDeps = {
    db: openDb(':memory:'),
    now: () => opts.now ?? NOW,
    todayLocal: () => opts.today ?? '2026-11-17',
    addDays: (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10),
    optionChain: async () => { state.fetches++; return state.chain; },
    candidates: (from, to) => { asked.push([from, to]); return rows.filter((r) => r.reportDate >= from && r.reportDate <= to); },
    stored: (id) => { const s = expected.get(id); return s ? { quoteDate: s.quoteDate, final: s.final } : null; },
    saveExpected: (id, em, final) => { if (expected.get(id)?.final) return false; expected.set(id, { ...em, final }); return true; },
    saveLive: (id, m) => { const prev = live.get(id); live.set(id, m.movePct); return prev !== m.movePct; },
  };
  return { d, state, expected, live, asked };
}

describe('snapshotAdrMoves', () => {
  it('quotes from the last US close before the local date are final', async () => {
    const { d, expected, asked } = setup({ chain: chainAt('2026-11-19') });
    expect(await snapshotAdrMoves(d)).toEqual([1]);
    expect(asked).toEqual([['2026-11-17', '2026-11-24']]);
    expect(expected.get(1)).toMatchObject({ final: true, adr: 'BABA', quoteDate: '2026-11-19' });
    expect(expected.get(1)!.movePct).toBeGreaterThan(0);
  });

  it('an earlier close is provisional and later replaced; a final one is kept', async () => {
    const { d, state, expected } = setup({ chain: chainAt('2026-11-18') });
    await snapshotAdrMoves(d);
    expect(expected.get(1)).toMatchObject({ final: false, quoteDate: '2026-11-18' });
    state.chain = chainAt('2026-11-19');
    expect(await snapshotAdrMoves(d)).toEqual([1]);
    expect(expected.get(1)).toMatchObject({ final: true, quoteDate: '2026-11-19' });
    state.chain = chainAt('2026-11-18');
    expect(await snapshotAdrMoves(d)).toEqual([]);
    expect(expected.get(1)!.quoteDate).toBe('2026-11-19');
  });

  it('quotes after the release are never used', async () => {
    const { d, expected } = setup({ chain: chainAt('2026-11-20') });
    expect(await snapshotAdrMoves(d)).toEqual([]);
    expect(expected.has(1)).toBe(false);
  });

  it('an intraday quote on the last US day is provisional; the post-close quote upgrades it', async () => {
    const { d, state, expected } = setup({ chain: chainAt('2026-11-19', '2026-11-19T11:00:00'), now: '2026-11-19T16:30:00.000Z' });
    await snapshotAdrMoves(d);
    expect(expected.get(1)).toMatchObject({ final: false, quoteDate: '2026-11-19' });
    state.chain = chainAt('2026-11-19', '2026-11-19T16:20:00');
    expect(await snapshotAdrMoves(d)).toEqual([1]);
    expect(expected.get(1)!.final).toBe(true);
  });

  it('an unchanged chain is skipped', async () => {
    const { d } = setup({ chain: chainAt('2026-11-18') });
    expect(await snapshotAdrMoves(d)).toEqual([1]);
    expect(await snapshotAdrMoves(d)).toEqual([]);
  });

  it('one chain per ADR per run', async () => {
    const rows: AdrMoveRow[] = [
      { id: 1, reportDate: '2026-11-20', timing: 'UNKNOWN', releasedAt: null, adr: 'BABA' },
      { id: 2, reportDate: '2026-11-20', timing: 'AMC', releasedAt: null, adr: 'BABA' },
    ];
    const { d, state } = setup({ rows });
    expect(await snapshotAdrMoves(d)).toEqual([1, 2]);
    expect(state.fetches).toBe(1);
  });

  it('blocked Cboe (null chain) keeps the stored value', async () => {
    const { d, state, expected } = setup({ chain: chainAt('2026-11-18') });
    await snapshotAdrMoves(d);
    const before = expected.get(1);
    state.chain = null;
    expect(await snapshotAdrMoves(d)).toEqual([]);
    expect(expected.get(1)).toEqual(before);
  });
});

describe('refreshAdrLiveMoves', () => {
  it('only on the US day before the local date', async () => {
    const on = setup({ now: '2026-11-19T20:00:00.000Z', today: '2026-11-20' });
    expect(await refreshAdrLiveMoves(on.d)).toEqual([1]);
    expect(on.live.get(1)).toBeGreaterThan(0);
    const off = setup({ now: '2026-11-18T20:00:00.000Z', today: '2026-11-18', chain: chainAt('2026-11-18') });
    expect(await refreshAdrLiveMoves(off.d)).toEqual([]);
  });

  it('blocked Cboe writes nothing', async () => {
    const { d, live } = setup({ now: '2026-11-19T20:00:00.000Z', today: '2026-11-20', chain: null });
    expect(await refreshAdrLiveMoves(d)).toEqual([]);
    expect(live.size).toBe(0);
  });
});
