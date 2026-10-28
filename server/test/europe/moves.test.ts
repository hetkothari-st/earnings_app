import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import { getEuropeReport, syncEuropeUniverse, upsertEuropeCalendarRow } from '../../src/europe/db/europeRepo.js';
import type { EuropeJobContext } from '../../src/europe/jobs/context.js';
import { refreshEuropeLiveMoves, snapshotEuropeMoves } from '../../src/europe/jobs/moves.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';
import { parseCboeChain } from '../../src/sources/cboe.js';
import { cachedChains } from '../../src/sources/cboeCache.js';
import type { OptionChain } from '../../src/types.js';

// Live Cboe chain for AZN (the AstraZeneca ADR), one request with EUROPE_UA, saved as-is on 2026-10-28.
const raw = JSON.parse(readFileSync(new URL('../fixtures/europe/cboe_AZN.json', import.meta.url), 'utf8'));
const NOW = '2026-10-28T09:00:00.000Z';
const entry = (symbol: string, isin: string, full: boolean): EuropeUniverseEntry => ({
  market: 'UK', symbol, isin, lei: null, name: symbol, exchange: 'LSE', mic: 'XLON', country: 'GB', currency: 'GBp',
  adr: full ? 'AZN' : null, adrRatio: full ? 1 : null, adrRatioVerified: full, cik: full ? 901832 : null, secForm: full ? '6-K' : null,
});
const chainAt = (asOfDate: string | null, quoteTime: string | null): OptionChain => ({ ...parseCboeChain(raw, 'AZN')!, asOfDate, quoteTime });

function setup(o: { chain: OptionChain | null; now: string; today: string; cached?: boolean }) {
  const db = openDb(':memory:');
  syncEuropeUniverse(db, 'UK', [entry('AZN.L', 'GB0009895292', true), entry('TSCO.L', 'GB00BLGZ9862', false)], NOW);
  const asked: string[] = [];
  const fetchChain = async (adr: string) => { asked.push(adr); return o.chain; };
  const ctx = {
    db, market: 'UK', now: () => o.now, today: () => o.today,
    optionChain: o.cached ? cachedChains(fetchChain, { now: () => Date.parse(o.now) }) : fetchChain,
  } as unknown as EuropeJobContext;
  const row = (symbol: string) => upsertEuropeCalendarRow(db, 'UK', {
    symbol, name: symbol, exchange: 'LSE', period: { periodEnd: '2026-09-30', fiscalQuarter: 3, fyEnd: '2026-12-31' }, periodLabel: 'Q3 FY26',
    periodConfirmed: false, reportDate: '2026-11-06', dateStatus: 'confirmed', timing: 'BMO', timingSource: 'sec-notice',
  }, NOW);
  return { db, ctx, row, asked };
}

describe('snapshotEuropeMoves', () => {
  it('AZN chain: LSE report 2026-11-06, quote after 16:00 ET on 11-05 → final', async () => {
    const { db, ctx, row } = setup({ chain: chainAt('2026-11-05', '2026-11-05T16:15:00'), now: '2026-11-05T21:30:00.000Z', today: '2026-11-05' });
    const id = row('AZN.L');
    expect(await snapshotEuropeMoves(ctx)).toEqual([id]);
    const em = getEuropeReport(db, id)!.expectedMove!;
    expect(em).toMatchObject({ final: true, adr: 'AZN', quoteDate: '2026-11-05' });
    // A 07:00 London (BMO) release on 11-06 is first traded in the US on 11-06: the first expiry on or after it.
    const expiries = [...new Set(parseCboeChain(raw, 'AZN')!.quotes.map((q) => q.expiry))].sort();
    expect(em.expiry).toBe(expiries.find((e) => e >= '2026-11-06'));
    expect(em.movePct).toBeGreaterThan(0);
  });

  it('an intraday quote on the last US day is provisional', async () => {
    const { db, ctx, row } = setup({ chain: chainAt('2026-11-05', '2026-11-05T11:00:00'), now: '2026-11-05T16:00:00.000Z', today: '2026-11-05' });
    const id = row('AZN.L');
    expect(await snapshotEuropeMoves(ctx)).toEqual([id]);
    expect(getEuropeReport(db, id)!.expectedMove).toMatchObject({ final: false, quoteDate: '2026-11-05' });
  });

  it('basic rows skipped', async () => {
    const { db, ctx, row, asked } = setup({ chain: chainAt('2026-11-05', '2026-11-05T16:15:00'), now: '2026-11-05T21:30:00.000Z', today: '2026-11-05' });
    const id = row('TSCO.L');
    expect(await snapshotEuropeMoves(ctx)).toEqual([]);
    expect(await refreshEuropeLiveMoves(ctx)).toEqual([]);
    expect(asked).toEqual([]);
    expect(getEuropeReport(db, id)!.expectedMove).toBeNull();
  });

  it('second chain call within 15 min hits the cache', async () => {
    const { ctx, row, asked } = setup({
      chain: chainAt('2026-11-05', '2026-11-05T14:00:00'), now: '2026-11-05T19:00:00.000Z', today: '2026-11-05', cached: true,
    });
    row('AZN.L');
    await snapshotEuropeMoves(ctx);
    await refreshEuropeLiveMoves(ctx);
    await snapshotEuropeMoves(ctx);
    expect(asked).toEqual(['AZN']);
  });
});

describe('refreshEuropeLiveMoves', () => {
  it('stores the live move on the US day before the London date', async () => {
    const { db, ctx, row } = setup({ chain: chainAt('2026-11-05', '2026-11-05T14:00:00'), now: '2026-11-05T19:00:00.000Z', today: '2026-11-05' });
    const id = row('AZN.L');
    expect(await refreshEuropeLiveMoves(ctx)).toEqual([id]);
    expect(getEuropeReport(db, id)!.liveMovePct).toBeGreaterThan(0);
  });
});
