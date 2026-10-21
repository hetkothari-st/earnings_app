import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/repo.js';
import { toInDto } from '../../src/india/api/dto.js';
import {
  confirmInPrelim, getInReport, mergeInFiling, saveFoList, saveInPrelim, setInEstimates, upsertInCalendarRow,
} from '../../src/india/db/inRepo.js';
import { fetchResultsPdf, readInResultsPdf, unitOf } from '../../src/india/sources/resultsPdf.js';

/** Results PDFs in the corpus (each with an expected.json entry from the XBRL filing). Target 30; grows with collect-in-corpus. */
const MIN_CORPUS = 11;
const corpus = new URL('../fixtures/india/pdf/', import.meta.url);
const cases = new URL('../fixtures/india/pdf-cases/', import.meta.url);
const pdf = (dir: URL, f: string) => new Uint8Array(readFileSync(new URL(f, dir)));

interface Expected {
  symbol: string; quarterEnd: string; type: 'company' | 'bank' | 'nbfc'; basis: 'Consolidated' | 'Standalone';
  eps: number | null; revenue: number | null; revenueKind: 'revenue-from-ops' | 'total-income'; profit: number | null;
  /** Hand-read from the PDF where it differs from the filing. */
  pdf?: { eps?: number; revenue?: number; profit?: number };
}

describe('readInResultsPdf', () => {
  test('consolidated quarter column, ₹ crore scaled to rupees', async () => {
    // Tata Communications Q2 FY27: standalone and consolidated statements, quarter / half-year / year columns, "(₹ in crores)".
    const v = await readInResultsPdf(pdf(corpus, 'TATACOMM_15102026135741_18526.pdf'), '2026-09-30');
    expect(v).toMatchObject({ basis: 'Consolidated', eps: 11.96, revenue: 66_878_900_000, revenueKind: 'revenue-from-ops', profit: 3_356_100_000 });
  });

  test('bank PDF: total income', async () => {
    // Indian Bank Q2 FY27, consolidated results page: "Interest earned" rows, "Total Income (1 + 2)" 23,335.98 crore.
    const v = await readInResultsPdf(pdf(cases, 'INDIANB_15102026125328_p10.pdf'), '2026-09-30');
    expect(v).toMatchObject({ basis: 'Consolidated', revenue: 233_359_800_000, revenueKind: 'total-income' });
    // Its EPS and profit figures sit on continuation lines of multi-line labels: not read rather than guessed.
    expect(v.eps).toBeNull();
    expect(v.profit).toBeNull();
  });

  test('half-year column never read', async () => {
    const bytes = pdf(corpus, 'TATACOMM_15102026135741_18526.pdf');
    // 30 Sep 2026 heads both the quarter and the half-year column (13,270.71 crore): the quarter is read.
    expect((await readInResultsPdf(bytes, '2026-09-30')).revenue).not.toBe(132_707_100_000);
    // 31 Mar 2026 heads only the year column: nothing is read.
    expect(await readInResultsPdf(bytes, '2026-03-31')).toMatchObject({ basis: null, eps: null, revenue: null, profit: null });
  });

  test('scanned PDF: all null', async () => {
    // Karur Vysya Bank results page: an image with no text layer.
    const v = await readInResultsPdf(pdf(cases, 'KARURVYSYA_15102026140444_p4.pdf'), '2026-09-30');
    expect(v).toMatchObject({ basis: null, eps: null, revenue: null, revenueKind: null, profit: null });
    expect(v.notes).toContain('no text layer');
  });

  // synthetic_*.pdf: one generated standalone table (1,234.56 / 123.45 / EPS 4.56), not corpus data.
  test('a lakh table scales x1e5', async () => {
    const v = await readInResultsPdf(pdf(cases, 'synthetic_lakh.pdf'), '2026-09-30');
    expect(v).toMatchObject({ basis: 'Standalone', eps: 4.56, revenue: 123_456_000, profit: 12_345_000 });
  });

  test('no unit: revenue and profit null, EPS still read', async () => {
    const v = await readInResultsPdf(pdf(cases, 'synthetic_no_unit.pdf'), '2026-09-30');
    expect(v).toMatchObject({ eps: 4.56, revenue: null, profit: null });
  });

  test('an amount in prose ("Rs. 500 crore") is not a unit', async () => {
    const v = await readInResultsPdf(pdf(cases, 'synthetic_prose_crore.pdf'), '2026-09-30');
    expect(v).toMatchObject({ eps: 4.56, revenue: null, profit: null });
    for (const prose of ['approved borrowing up to Rs. 500 crore', 'an investment of ₹ 50 crore', 'within 5 lakh units', 'INR 587 crore', '(5 lakh units)']) {
      expect(unitOf(prose), prose).toBeNull();
    }
    for (const [line, unit] of [['(₹ in crore)', 'crore'], ['Rs. in Lakhs', 'lakh'], ['(Amount in Rs million, unless stated)', 'million'],
      ["(₹ '000)", 'thousand'], ['(Rs. Lakhs)', 'lakh'], ['(₹ crore)', 'crore'], ['(Z in Million)', 'million'], ['flakhs', 'lakh'],
      ['(All amounts are in Rs. crores unless otherwise stated)', 'crore'], ['(Rupees In Crores)', 'crore']] as const) {
      expect(unitOf(line), line).toBe(unit);
    }
  });

  test('not a PDF: all null, no throw', async () => {
    const v = await readInResultsPdf(new TextEncoder().encode('<html>Request Rate Threshold Exceeded</html>'), '2026-09-30');
    expect(v).toMatchObject({ basis: null, eps: null, revenue: null, profit: null });
  });

  test('every accepted corpus value matches expected.json', async () => {
    const expected: Record<string, Expected> = JSON.parse(readFileSync(new URL('expected.json', corpus), 'utf8'));
    const files = readdirSync(corpus).filter((f) => f.endsWith('.pdf'));
    expect(files.length).toBeGreaterThanOrEqual(MIN_CORPUS);
    const bad: string[] = [];
    const accepted = { eps: 0, revenue: 0, profit: 0 };
    for (const f of files) {
      const e = expected[f];
      expect(e, `expected.json entry for ${f}`).toBeDefined();
      const v = await readInResultsPdf(pdf(corpus, f), e!.quarterEnd);
      for (const k of ['eps', 'revenue', 'profit'] as const) {
        const got = v[k];
        if (got === null) continue;
        accepted[k]++;
        if (v.basis !== e!.basis) { bad.push(`${f} ${k} read on the ${v.basis} basis, filing is ${e!.basis}`); continue; }
        if (k === 'revenue' && v.revenueKind !== e!.revenueKind) { bad.push(`${f} revenue kind ${v.revenueKind} != ${e!.revenueKind}`); continue; }
        const w = e!.pdf?.[k] ?? e![k];
        if (w === null) { bad.push(`${f} ${k} ${got} but expected.json has null`); continue; }
        const ok = k === 'eps' ? Math.abs(got - w) <= 0.01 + 1e-9 : Math.abs(got - w) <= 0.005 * Math.abs(w);
        if (!ok) bad.push(`${f} ${k} ${got} != ${w}`);
      }
    }
    expect(bad).toEqual([]);
    // The reader must keep reading: an all-null reader would pass the check above. Raise as the corpus grows.
    expect(accepted).toMatchObject({ eps: expect.any(Number), revenue: expect.any(Number), profit: expect.any(Number) });
    expect(accepted.eps).toBeGreaterThanOrEqual(6);
    expect(accepted.revenue).toBeGreaterThanOrEqual(6);
    expect(accepted.profit).toBeGreaterThanOrEqual(5);
  }, 120_000);
});

const NOW = '2026-10-21T12:00:00.000Z';
const OPEN = { usEpsAdjusted: false, usEpsGaap: false, usRevenue: false, inEps: true, inRevenue: true, inProfit: true };
const base = { quarterEnd: '2026-09-30', quarterLabel: 'Sep/2026', reportDate: '2026-10-21' };
const filing = (over: Partial<Parameters<typeof mergeInFiling>[1]> = {}) => ({
  symbol: 'KEI', name: 'KEI Industries Limited', ...base, revenueActual: 37_764_180_000, revenueKind: 'revenue-from-ops',
  pnlActual: 2_624_500_000, epsActual: 27.45, nature: 'Consolidated' as const, ...over,
});
const prelim = (over: Partial<Parameters<typeof saveInPrelim>[2]> = {}) => ({
  basis: 'Consolidated' as const, eps: 27.45, revenue: 37_764_180_000, revenueKind: 'revenue-from-ops' as const, profit: 2_624_500_000, ...over,
});

describe('India preliminary values', () => {
  let db: Db;
  let id: number;
  const dto = () => toInDto(getInReport(db, id)!);
  beforeEach(() => {
    db = openDb(':memory:');
    saveFoList(db, [{ symbol: 'KEI', name: 'KEI INDUSTRIES', lotSize: 175 }], NOW);
    id = upsertInCalendarRow(db, { symbol: 'KEI', name: 'KEI Industries Limited', ...base }, NOW);
    setInEstimates(db, id, { eps: 25, epsAnalysts: 10, revenue: 3.5e10, revenueAnalysts: 9 }, NOW);
  });

  test('consolidated prelim shows as the actual, tagged preliminary, and drives colour', () => {
    expect(saveInPrelim(db, id, prelim(), NOW, OPEN)).toBe(true);
    const d = dto();
    expect(d.basis).toBe('consolidated');
    expect(d.eps).toMatchObject({ actual: 27.45, preliminary: true, corrected: false, result: 'beat' });
    expect(d.eps.surprisePct).toBeCloseTo(9.8, 1);
    expect(d.revenue).toMatchObject({ actual: 37_764_180_000, kind: 'revenue-from-ops', preliminary: true, corrected: false, result: 'beat' });
    expect(d.profit).toMatchObject({ actual: 2_624_500_000, preliminary: true, corrected: false });
  });

  test('XBRL equal clears prelim; differs sets corrected', () => {
    saveInPrelim(db, id, prelim({ eps: 27.46, revenue: 37_800_000_000, profit: 2_500_000_000 }), NOW, OPEN);
    mergeInFiling(db, filing(), NOW); // EPS within 0.01, revenue within 0.5%, profit 5% off
    const d = dto();
    expect(d.eps).toMatchObject({ actual: 27.45, preliminary: false, corrected: false });
    expect(d.revenue).toMatchObject({ actual: 37_764_180_000, preliminary: false, corrected: false });
    expect(d.profit).toMatchObject({ actual: 2_624_500_000, preliminary: false, corrected: true });
  });

  test('a standalone XBRL neither confirms nor corrects a consolidated prelim; the consolidated one does', () => {
    saveInPrelim(db, id, prelim({ eps: 30 }), NOW, OPEN);
    mergeInFiling(db, filing({ nature: 'Standalone', epsActual: 20, revenueActual: 1e10, pnlActual: 1e9 }), NOW);
    let d = dto();
    expect(d.basis).toBe('consolidated');
    expect(d.eps).toMatchObject({ actual: 30, preliminary: true, corrected: false, result: 'beat' });
    expect(d.revenue).toMatchObject({ actual: 37_764_180_000, preliminary: true });
    mergeInFiling(db, filing(), NOW);
    d = dto();
    expect(d.eps).toMatchObject({ actual: 27.45, preliminary: false, corrected: true });
    expect(d.revenue).toMatchObject({ actual: 37_764_180_000, preliminary: false, corrected: false });
  });

  test('a standalone prelim is cleared without correction by a consolidated XBRL', () => {
    saveInPrelim(db, id, prelim({ basis: 'Standalone', eps: 1, revenue: 1e9, profit: 1e8 }), NOW, OPEN);
    expect(dto()).toMatchObject({ basis: 'standalone', eps: { actual: 1, preliminary: true, result: null } });
    mergeInFiling(db, filing(), NOW);
    expect(dto()).toMatchObject({
      basis: 'consolidated',
      eps: { actual: 27.45, preliminary: false, corrected: false },
      revenue: { preliminary: false, corrected: false },
      profit: { preliminary: false, corrected: false },
    });
  });

  test('closed gates store nothing; a prelim or an official figure is never replaced', () => {
    expect(saveInPrelim(db, id, prelim(), NOW, { ...OPEN, inEps: false, inRevenue: false, inProfit: false })).toBe(false);
    expect(saveInPrelim(db, id, prelim(), NOW)).toBe(false); // config gates
    expect(dto().eps.actual).toBeNull();
    expect(saveInPrelim(db, id, prelim({ revenue: null, profit: null }), NOW, OPEN)).toBe(true);
    expect(saveInPrelim(db, id, prelim({ eps: 99 }), NOW, OPEN)).toBe(false); // a later read never adds to or replaces it
    expect(dto()).toMatchObject({ eps: { actual: 27.45 }, revenue: { actual: null } });
    mergeInFiling(db, filing(), NOW);
    expect(saveInPrelim(db, id, prelim({ eps: 99 }), NOW, OPEN)).toBe(false);
    expect(dto().eps).toMatchObject({ actual: 27.45, preliminary: false });
    confirmInPrelim(db, id); // nothing left: a no-op
    expect(dto().eps).toMatchObject({ preliminary: false, corrected: false });
  });

  test('a revenue prelim of the other kind is cleared without a correction', () => {
    saveInPrelim(db, id, prelim({ revenue: 40_000_000_000, revenueKind: 'total-income' }), NOW, OPEN);
    mergeInFiling(db, filing(), NOW); // revenue from operations 37,764 Cr vs prelim total income 40,000 Cr
    expect(dto().revenue).toMatchObject({ actual: 37_764_180_000, kind: 'revenue-from-ops', preliminary: false, corrected: false });
  });

  test('bank prelim total income gets no colour; no basis means nothing stored', () => {
    expect(saveInPrelim(db, id, prelim({ basis: null }), NOW, OPEN)).toBe(false);
    saveInPrelim(db, id, prelim({ revenueKind: 'total-income' }), NOW, OPEN);
    expect(dto().revenue).toMatchObject({ actual: 37_764_180_000, kind: 'total-income', preliminary: true, result: null, surprisePct: null });
  });
});

describe('fetchResultsPdf', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('only nsearchives PDFs; a block page is never handed to the reader', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>Request Rate Threshold Exceeded</html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchResultsPdf('https://www.nseindia.com/x.pdf', 'UA')).rejects.toThrow(/host/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fetchResultsPdf('https://nsearchives.nseindia.com/corporate/X_21102026120000_R.pdf', 'UA')).rejects.toThrow(/not a PDF/);
    fetchMock.mockImplementationOnce(async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), { status: 200 }));
    const b = await fetchResultsPdf('https://nsearchives.nseindia.com/corporate/X_21102026120000_R.pdf', 'UA');
    expect([...b.slice(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
    const init = (fetchMock.mock.calls as unknown as [string, RequestInit][])[1]![1];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('UA');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('a feed link missing "/corporate/" is repaired', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchResultsPdf('https://nsearchives.nseindia.comRAJRATAN_21102026162006_UFR.PDF', 'UA');
    expect((fetchMock.mock.calls as unknown as [string][])[0]![0]).toBe('https://nsearchives.nseindia.com/corporate/RAJRATAN_21102026162006_UFR.PDF');
  });
});
