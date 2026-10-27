import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { getHkReport, syncHkUniverse, upsertHkCalendarRow } from '../../src/hk/db/hkRepo.js';
import type { HkJobContext } from '../../src/hk/jobs/context.js';
import { refreshHkLiveMoves, snapshotHkMoves } from '../../src/hk/jobs/moves.js';
import type { HkUniverseEntry } from '../../src/hk/universe.js';
import { parseCboeChain } from '../../src/sources/cboe.js';
import type { OptionChain } from '../../src/types.js';

const raw = JSON.parse(readFileSync(new URL('../fixtures/hk/cboe_BABA.json', import.meta.url), 'utf8'));
const NOW = '2026-10-27T04:00:00.000Z';
const ENTRIES: HkUniverseEntry[] = [
  { code: '9988', name: 'Alibaba', cadence: 'Q', fyEndMonth: 3, adr: 'BABA', adrRatio: 8, cik: 1577552 },
  { code: '0700', name: 'Tencent', cadence: 'Q', fyEndMonth: 12, adr: null, adrRatio: null, cik: null },
];
const chainAt = (asOfDate: string | null): OptionChain => ({ ...parseCboeChain(raw, 'BABA')!, asOfDate });

function setup(opts: { chain?: OptionChain | null | Error; now?: string; today?: string; timing?: 'UNKNOWN' | 'AMC' | 'BMO' } = {}) {
  const db = openDb(':memory:');
  syncHkUniverse(db, ENTRIES, NOW);
  const state = { chain: opts.chain === undefined ? chainAt('2026-11-19') : opts.chain };
  const ctx: HkJobContext = {
    db, now: () => opts.now ?? NOW, todayHKT: () => opts.today ?? '2026-11-17',
    yahoo: async () => null, yahooPastDates: async () => [], yahooCloses: async () => new Map(),
    optionChain: async () => { if (state.chain instanceof Error) throw state.chain; return state.chain; },
    secHttp: null,
  };
  const row = (code: string, name: string) => upsertHkCalendarRow(db, {
    code, name, periodEnd: '2026-09-30', periodKind: 'Q', periodLabel: 'Q3 26', reportDate: '2026-11-20',
    dateStatus: 'estimated', timing: opts.timing ?? 'UNKNOWN', timingSource: 'sec-6k',
  }, NOW);
  return { db, ctx, state, row };
}

describe('snapshotHkMoves', () => {
  it('quotes from the last US close before the HK date are final', async () => {
    const { db, ctx, row } = setup({ chain: chainAt('2026-11-19') });
    const id = row('9988', 'Alibaba');
    expect(await snapshotHkMoves(ctx)).toEqual([id]);
    const em = getHkReport(db, id)!.expectedMove!;
    expect(em).toMatchObject({ final: true, adr: 'BABA', quoteDate: '2026-11-19' });
    expect(em.movePct).toBeGreaterThan(0);
  });

  it('an earlier close is provisional and later replaced', async () => {
    const { db, ctx, state, row } = setup({ chain: chainAt('2026-11-18') });
    const id = row('9988', 'Alibaba');
    await snapshotHkMoves(ctx);
    expect(getHkReport(db, id)!.expectedMove).toMatchObject({ final: false, quoteDate: '2026-11-18' });
    state.chain = chainAt('2026-11-19');
    await snapshotHkMoves(ctx);
    expect(getHkReport(db, id)!.expectedMove).toMatchObject({ final: true, quoteDate: '2026-11-19' });
    // a final snapshot is never replaced
    state.chain = chainAt('2026-11-18');
    expect(await snapshotHkMoves(ctx)).toEqual([]);
    expect(getHkReport(db, id)!.expectedMove!.quoteDate).toBe('2026-11-19');
  });

  it('quotes after the release are never used', async () => {
    const { db, ctx, row } = setup({ chain: chainAt('2026-11-20') });
    const id = row('9988', 'Alibaba');
    expect(await snapshotHkMoves(ctx)).toEqual([]);
    expect(getHkReport(db, id)!.expectedMove).toBeNull();
  });

  it('expiry is on or after the first US session after the release', async () => {
    const u = setup({ timing: 'UNKNOWN' });
    const uid = u.row('9988', 'Alibaba');
    await snapshotHkMoves(u.ctx);
    expect(getHkReport(u.db, uid)!.expectedMove!.expiry > '2026-11-20').toBe(true);

    const a = setup({ timing: 'AMC' });
    const aid = a.row('9988', 'Alibaba');
    await snapshotHkMoves(a.ctx);
    expect(getHkReport(a.db, aid)!.expectedMove!.expiry >= '2026-11-20').toBe(true);
  });

  it('basic level and no-ADR rows are skipped', async () => {
    const { db, ctx, row } = setup();
    const id = row('0700', 'Tencent');
    expect(await snapshotHkMoves(ctx)).toEqual([]);
    expect(getHkReport(db, id)!.expectedMove).toBeNull();
  });

  it('released and out-of-range rows are skipped', async () => {
    const rel = setup();
    const rid = rel.row('9988', 'Alibaba');
    rel.db.prepare('UPDATE hk_reports SET released_at = ? WHERE id = ?').run('2026-11-20T01:00:00Z', rid);
    expect(await snapshotHkMoves(rel.ctx)).toEqual([]);
    const far = setup({ today: '2026-11-01' });
    far.row('9988', 'Alibaba');
    expect(await snapshotHkMoves(far.ctx)).toEqual([]);
  });

  it('Cboe blocked: nothing written, stored value kept', async () => {
    const { db, ctx, state, row } = setup({ chain: chainAt('2026-11-18') });
    const id = row('9988', 'Alibaba');
    await snapshotHkMoves(ctx);
    const before = getHkReport(db, id)!.expectedMove;
    expect(before).not.toBeNull();
    state.chain = new Error('HTTP 403');
    expect(await snapshotHkMoves(ctx)).toEqual([]);
    state.chain = null;
    expect(await snapshotHkMoves(ctx)).toEqual([]);
    expect(getHkReport(db, id)!.expectedMove).toEqual(before);
  });
});

describe('refreshHkLiveMoves', () => {
  it('only on the US day before the HK date, and stores the live move', async () => {
    const on = setup({ now: '2026-11-19T20:00:00.000Z', today: '2026-11-20', chain: chainAt('2026-11-19') });
    const id = on.row('9988', 'Alibaba');
    expect(await refreshHkLiveMoves(on.ctx)).toEqual([id]);
    expect(getHkReport(on.db, id)!.liveMovePct).toBeGreaterThan(0);

    const off = setup({ now: '2026-11-18T20:00:00.000Z', today: '2026-11-18', chain: chainAt('2026-11-18') });
    off.row('9988', 'Alibaba');
    expect(await refreshHkLiveMoves(off.ctx)).toEqual([]);
  });
});
