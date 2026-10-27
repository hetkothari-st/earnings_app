import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readJpRelease } from '../../src/jp/sources/releaseJp.js';
import { readRelease } from '../../src/sources/releaseReader.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/jp/releases/${n}`, import.meta.url), 'utf8');

const tr = (...cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const span2 = (label: string, ...heads: string[]) => `<tr><td>${label}</td>${heads.map((h) => `<td colspan="2">${h}</td>`).join('')}</tr>`;
const table = (caption: string, rows: string) => `<p>${caption}</p><table>${rows}</table>`;
const Q2 = { periodEnd: '2026-09-30', fiscalQuarter: 2 as const };

describe('readJpRelease', () => {
  it('quarter column preferred', () => {
    const html = table('(Millions of yen, except per share amounts)',
      span2('', 'Three months ended September 30,', 'Six months ended September 30,') +
      tr('', '2025', '2026', '2025', '2026') +
      tr('Sales revenues', '11,444,573', '12,377,550', '22,868,108', '24,560,124') +
      tr('Earnings per share attributable to owners of the parent') +
      tr('Basic', '248.25', '239.10', '461.70', '450.12'));
    expect(readJpRelease(html, Q2)).toMatchObject({ revenue: 12_377_550_000_000, eps: 239.1, span: 'quarter', ytdMonths: null, currency: 'JPY' });
  });

  it('only YTD columns → ytd 6, never subtracted', () => {
    const html = table('(Millions of yen, except per share amounts)',
      span2('', 'Six months ended September 30,') +
      tr('', '2025', '2026') +
      tr('Sales revenues', '22,868,108', '24,560,124') +
      tr('Earnings per share attributable to owners of the parent') +
      tr('Basic', '461.70', '450.12') +
      tr('Diluted', '461.00', '449.90'));
    expect(readJpRelease(html, Q2)).toEqual({
      revenue: 24_560_124_000_000, eps: 450.12, epsDiluted: 449.9, currency: 'JPY', span: 'ytd', ytdMonths: 6, notes: [],
    });
  });

  it('a Q1 document is quarter-only: a six-month column is never read for Q1', () => {
    const html = table('(Millions of yen)',
      tr('', 'Six months ended June 30, 2026') +
      tr('Net sales', '5,000') +
      tr('Basic earnings per share', '10.00'));
    expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({ revenue: null, eps: null, span: null, currency: null });
  });

  it('Japanese month-range headers', () => {
    const ytd = table('(Millions of yen, except per share amounts)',
      tr('', 'Apr.-Sep. 2025', 'Apr.-Sep. 2026') +
      tr('Net sales', '22,868', '24,560') +
      tr('Basic earnings per share', '461.70', '450.12'));
    expect(readJpRelease(ytd, Q2)).toMatchObject({ revenue: 24_560_000_000, eps: 450.12, span: 'ytd', ytdMonths: 6 });
    const q = table('(Yen in millions)',
      tr('', 'Jul.-Sep. 2025', 'Jul.-Sep. 2026') +
      tr('Net sales', '11,444', '12,377') +
      tr('Basic earnings per share', '248.25', '239.10'));
    expect(readJpRelease(q, Q2)).toMatchObject({ revenue: 12_377_000_000, eps: 239.1, span: 'quarter', ytdMonths: null });
    const numeric = table('(¥ in millions)',
      tr('', '2Q (2025/7-9)', '2Q (2026/7-9)', '6 months (2026/4-9)') +
      tr('Net sales', '11,444', '12,377', '24,560') +
      tr('Basic earnings per share', '248.25', '239.10', '450.12'));
    expect(readJpRelease(numeric, Q2)).toMatchObject({ revenue: 12_377_000_000, eps: 239.1, span: 'quarter' });
  });

  it('a quarter token column is read only within a block dated periodEnd', () => {
    const dated = table('(Millions of yen)',
      span2('', 'Three months ended September 30, 2026') +
      tr('', '2Q FY2026', '2Q FY2027') +
      tr('Net sales', '11,444', '12,377') +
      tr('Basic earnings per share', '248.25', '239.10'));
    // Both columns are quarter tokens in a block dated periodEnd: they disagree → blank, never a guess.
    expect(readJpRelease(dated, Q2)).toMatchObject({ revenue: null, eps: null });
    const undated = table('(Millions of yen)',
      tr('', '2Q FY2027') +
      tr('Net sales', '12,377') +
      tr('Basic earnings per share', '239.10'));
    expect(readJpRelease(undated, Q2)).toMatchObject({ revenue: null, eps: null, span: null });
  });

  it('ordinary income is never revenue', () => {
    const html = table('(in millions of yen)',
      tr('', 'For the three months ended June 30, 2025', 'For the three months ended June 30, 2026') +
      tr('Ordinary income', '3,253,932', '3,907,543') +
      tr('Interest income', '2,022,572', '2,336,667') +
      tr('Fees and commissions', '566,731', '682,130') +
      tr('Ordinary profits', '708,535', '1,117,934') +
      tr('Net income attributable to owners of the parent per share', '47.55', '71.77'));
    expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({ revenue: null, eps: 71.77, span: 'quarter', currency: 'JPY' });
  });

  it('Nomura: net revenue over total revenue', () => {
    const html = table('(Millions of yen, except per share data)',
      tr('', 'Three months ended June 30, 2025', 'Three months ended June 30, 2026') +
      tr('Revenues:') +
      tr('Commissions', '100,000', '120,000') +
      tr('Interest and dividends', '500,000', '550,000') +
      tr('Total revenues', '1,200,000', '1,300,000') +
      tr('Interest expense', '600,000', '620,000') +
      tr('Net revenue', '600,000', '680,000') +
      tr('Net income attributable to Nomura Holdings, Inc. shareholders per share:') +
      tr('Basic', '30.10', '33.20') +
      tr('Diluted', '29.50', '32.60'));
    expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({ revenue: 680_000_000_000, eps: 33.2, epsDiluted: 32.6 });
  });

  it('US$ convenience column ignored', () => {
    const html = table('Consolidated Statements of Income',
      tr('', 'Three months ended June 30, 2025', 'Three months ended June 30, 2026', 'Three months ended June 30, 2026') +
      tr('', 'Millions of yen', 'Millions of yen', 'Millions of U.S. dollars') +
      tr('Net sales', '1,000', '1,100', '7') +
      tr('', 'Yen', 'Yen', 'U.S. dollars') +
      tr('Basic earnings per share', '10.00', '11.00', '0.07'));
    expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({ revenue: 1_100_000_000, eps: 11, currency: 'JPY' });
  });

  it('no unit stated → revenue null', () => {
    const html = table('Amounts are in yen',
      tr('', 'Three months ended June 30, 2025', 'Three months ended June 30, 2026') +
      tr('Net sales', '1,000', '1,100') +
      tr('Basic earnings per share', '10.00', '11.00'));
    const v = readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 });
    expect(v).toMatchObject({ revenue: null, eps: 11, span: 'quarter' });
    expect(v.notes).toContain('revenue: no unit stated for table');
  });

  it('a caption in prose is not a unit statement', () => {
    const html = table('Revenue rose to several millions of yen in the quarter',
      tr('', 'Three months ended June 30, 2026') +
      tr('Net sales', '1,100') +
      tr('Basic earnings per share', '11.00'));
    expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({ revenue: null, eps: 11 });
  });

  it('forecast column never read', () => {
    const html = table('(Millions of yen, except per share amounts)',
      tr('', 'Forecast for the fiscal year ending March 31, 2027') +
      tr('Net sales', '50,000,000') +
      tr('Basic earnings per share', '272.17'));
    expect(readJpRelease(html, { periodEnd: '2027-03-31', fiscalQuarter: 4 })).toEqual({
      revenue: null, eps: null, epsDiluted: null, currency: null, span: null, ytdMonths: null, notes: [],
    });
    // The same column as an actual is read (12-month YTD for the 4th quarter).
    const actual = html.replace('Forecast for the fiscal year ending', 'Fiscal year ended');
    expect(readJpRelease(actual, { periodEnd: '2027-03-31', fiscalQuarter: 4 })).toMatchObject({ revenue: 50_000_000_000_000, eps: 272.17, span: 'ytd', ytdMonths: 12 });
  });

  it('basic and diluted under a parent EPS row', () => {
    const html = table('Yen in millions',
      tr('', 'For the first quarter ended June 30, 2025', 'For the first quarter ended June 30, 2026') +
      tr('Total sales revenues', '12,253,326', '13,525,400') +
      tr('Earnings per share attributable to Toyota Motor Corporation') +
      tr('Basic', '64.56', '120.69') +
      tr('Diluted', '64.50', '120.60'));
    expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({
      revenue: 13_525_400_000_000, eps: 120.69, epsDiluted: 120.6, span: 'quarter', currency: 'JPY',
    });
    // A bare "Basic" with no per-share parent is not read.
    const orphan = table('Consolidated Statements of Income (Yen in millions)',
      tr('', 'Three months ended June 30, 2026') + tr('Total sales revenues', '13,525,400') + tr('Basic', '120.69'));
    expect(readJpRelease(orphan, { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({ revenue: 13_525_400_000_000, eps: null });
  });

  it('per ADS and adjusted rows are never read', () => {
    const html = table('(Millions of yen, except per share amounts)',
      tr('', 'Three months ended June 30, 2026') +
      tr('Net sales', '1,100') +
      tr('Basic earnings per ADS', '22.00') +
      tr('Adjusted basic earnings per share', '12.00'));
    expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({ revenue: null, eps: null });
  });

  it('a summary table with the period in the rows (Kessan Tanshin layout)', () => {
    const html = table('',
      tr('', 'Basic earnings per share', 'Diluted earnings per share') +
      tr('', 'yen', 'yen') +
      tr('For the three months ended') +
      tr('June 30, 2026', '71.77', '71.59') +
      tr('June 30, 2025', '47.55', '47.45'));
    expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({ eps: 71.77, epsDiluted: 71.59, revenue: null, span: 'quarter' });
  });
});

describe('real 6-K releases', () => {
  it('Toyota 1Q FY2027 (quarter)', () => {
    expect(readJpRelease(fx('TM_2026-06-30.htm'), { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({
      revenue: 13_525_400_000_000, eps: 120.69, epsDiluted: 120.69, currency: 'JPY', span: 'quarter', ytdMonths: null,
    });
  });

  it('Toyota 3Q FY2026: only nine-month statements → ytd 9', () => {
    expect(readJpRelease(fx('TM_2025-12-31.htm'), { periodEnd: '2025-12-31', fiscalQuarter: 3 })).toMatchObject({
      revenue: 38_087_604_000_000, eps: 232.55, epsDiluted: 232.55, currency: 'JPY', span: 'ytd', ytdMonths: 9,
    });
  });

  it('Sony 1Q FY2026 (statement split over two tables)', () => {
    expect(readJpRelease(fx('SONY_2026-06-30.htm'), { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({
      revenue: 2_837_771_000_000, eps: 58.07, epsDiluted: 57.82, currency: 'JPY', span: 'quarter',
    });
  });

  it('Sony 3Q FY2025: the three-month statement, not the nine-month one', () => {
    expect(readJpRelease(fx('SONY_2025-12-31.htm'), { periodEnd: '2025-12-31', fiscalQuarter: 3 })).toMatchObject({
      revenue: 3_713_681_000_000, eps: -169.03, epsDiluted: -167.92, currency: 'JPY', span: 'quarter',
    });
  });

  it('MUFG 1Q FY2026: ordinary income is not revenue, EPS read from the summary', () => {
    expect(readJpRelease(fx('MUFG_2026-06-30.htm'), { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({
      revenue: null, eps: 71.77, epsDiluted: 71.59, currency: 'JPY', span: 'quarter',
    });
  });
});

describe("readRelease profile 'jp'", () => {
  it('yen is detected only under jp: the hk profile reads nothing from a yen table', () => {
    const html = table('(Millions of yen, except per share amounts)',
      tr('', 'Three months ended June 30, 2026') +
      tr('Net sales', '1,100') +
      tr('Diluted earnings per share', '11.00'));
    const jp = readRelease(html, { periodEnd: '2026-06-30', span: 'quarter', profile: 'jp' });
    expect(jp).toMatchObject({ revenue: 1_100_000_000, epsGaap: 11, epsBasic: null });
    const hk = readRelease(html, { periodEnd: '2026-06-30', span: 'quarter', profile: 'hk', currency: 'USD' });
    expect(hk).toMatchObject({ revenue: null, epsGaap: null, epsBasic: null });
  });
});
