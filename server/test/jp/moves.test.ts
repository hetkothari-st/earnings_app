import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { getJpReport, syncJpUniverse, upsertJpCalendarRow } from '../../src/jp/db/jpRepo.js';
import type { JpJobContext } from '../../src/jp/jobs/context.js';
import { refreshJpLiveMoves, snapshotJpMoves } from '../../src/jp/jobs/moves.js';
import type { JpUniverseEntry } from '../../src/jp/universe.js';
import { parseCboeChain } from '../../src/sources/cboe.js';
import type { OptionChain } from '../../src/types.js';

// Live Cboe chain for TM, saved as-is on 2026-10-27.
const raw = JSON.parse(readFileSync(new URL('../fixtures/jp/cboe_TM.json', import.meta.url), 'utf8'));
const NOW = '2026-10-27T04:00:00.000Z';
const ENTRIES: JpUniverseEntry[] = [
  { code: '7203', edinetCode: 'E02144', name: 'TOYOTA MOTOR CORPORATION', nameJa: 'トヨタ自動車株式会社', fyEndMonth: 3, industryJa: '輸送用機器',
    adr: 'TM', adrRatio: 10, cik: 1094517 },
  { code: '7974', edinetCode: 'E02367', name: 'Nintendo Co., Ltd.', nameJa: '任天堂株式会社', fyEndMonth: 3, industryJa: 'その他製品',
    adr: null, adrRatio: null, cik: null },
];
const chainAt = (asOfDate: string | null, quoteTime: string | null): OptionChain => ({ ...parseCboeChain(raw, 'TM')!, asOfDate, quoteTime });

function setup(opts: { chain: OptionChain | null; now: string; today: string }) {
  const db = openDb(':memory:');
  syncJpUniverse(db, ENTRIES, NOW);
  const asked: string[] = [];
  const ctx = {
    db, now: () => opts.now, todayJST: () => opts.today, edinet: null, secHttp: null,
    optionChain: async (adr: string) => { asked.push(adr); return opts.chain; },
  } as unknown as JpJobContext;
  const row = (code: string, name: string) => upsertJpCalendarRow(db, {
    code, name, period: { periodEnd: '2026-09-30', fiscalQuarter: 2, fyEnd: '2027-03-31' }, periodLabel: '2Q FY27',
    reportDate: '2026-11-05', dateStatus: 'estimated', timing: 'AMC', timingSource: 'yahoo',
  }, NOW);
  return { db, ctx, row, asked };
}

describe('snapshotJpMoves', () => {
  it('TM chain: report 2026-11-05, asOf 2026-11-04 after 16:00 ET → final', async () => {
    const { db, ctx, row } = setup({
      chain: chainAt('2026-11-04', '2026-11-04T16:15:00'), now: '2026-11-04T21:30:00.000Z', today: '2026-11-05',
    });
    const id = row('7203', 'TOYOTA MOTOR CORPORATION');
    expect(await snapshotJpMoves(ctx)).toEqual([id]);
    const em = getJpReport(db, id)!.expectedMove!;
    expect(em).toMatchObject({ final: true, adr: 'TM', quoteDate: '2026-11-04' });
    // The first US session after an AMC Tokyo release on 11-05 is 11-05 itself: the first expiry on or after it.
    const expiries = [...new Set(parseCboeChain(raw, 'TM')!.quotes.map((q) => q.expiry))].sort();
    expect(em.expiry).toBe(expiries.find((e) => e >= '2026-11-05'));
    expect(em.movePct).toBeGreaterThan(0);
  });

  it('an intraday quote on the last US day is provisional', async () => {
    const { db, ctx, row } = setup({
      chain: chainAt('2026-11-04', '2026-11-04T11:00:00'), now: '2026-11-04T16:00:00.000Z', today: '2026-11-05',
    });
    const id = row('7203', 'TOYOTA MOTOR CORPORATION');
    expect(await snapshotJpMoves(ctx)).toEqual([id]);
    expect(getJpReport(db, id)!.expectedMove).toMatchObject({ final: false, quoteDate: '2026-11-04' });
  });

  it('basic rows skipped', async () => {
    const { db, ctx, row, asked } = setup({
      chain: chainAt('2026-11-04', '2026-11-04T16:15:00'), now: '2026-11-04T21:30:00.000Z', today: '2026-11-05',
    });
    const id = row('7974', 'Nintendo Co., Ltd.');
    expect(await snapshotJpMoves(ctx)).toEqual([]);
    expect(await refreshJpLiveMoves(ctx)).toEqual([]);
    expect(asked).toEqual([]);
    expect(getJpReport(db, id)!.expectedMove).toBeNull();
  });
});

describe('refreshJpLiveMoves', () => {
  it('stores the live move on the US day before the Tokyo date', async () => {
    const { db, ctx, row } = setup({
      chain: chainAt('2026-11-04', '2026-11-04T14:00:00'), now: '2026-11-04T19:00:00.000Z', today: '2026-11-05',
    });
    const id = row('7203', 'TOYOTA MOTOR CORPORATION');
    expect(await refreshJpLiveMoves(ctx)).toEqual([id]);
    expect(getJpReport(db, id)!.liveMovePct).toBeGreaterThan(0);
  });
});
