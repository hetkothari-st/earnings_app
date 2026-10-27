import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jpFiscalYear, readJpRelease } from '../../src/jp/sources/releaseJp.js';
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

  it('quarter tokens only narrow: a token column is read only through its own explicit date', () => {
    // A date shared by both token columns is not either column's own: the token would be selecting → blank.
    const shared = table('(Millions of yen)',
      span2('', 'Three months ended September 30, 2026') +
      tr('', '2Q FY2026', '2Q FY2027') +
      tr('Net sales', '11,444', '12,377') +
      tr('Basic earnings per share', '248.25', '239.10'));
    expect(readJpRelease(shared, Q2)).toMatchObject({ revenue: null, eps: null, span: null });
    // Each column states its own date: read by the date; the tokens agree.
    const own = table('(Millions of yen)',
      tr('', '2Q FY2026 (three months ended September 30, 2025)', '2Q FY2027 (three months ended September 30, 2026)') +
      tr('Net sales', '11,444', '12,377') +
      tr('Basic earnings per share', '248.25', '239.10'));
    expect(readJpRelease(own, Q2)).toMatchObject({ revenue: 12_377_000_000, eps: 239.1, span: 'quarter' });
    // An explicit date for periodEnd, but a token naming another fiscal year: skipped.
    const disagree = table('(Millions of yen)',
      tr('', '2Q FY2026 (three months ended September 30, 2026)') +
      tr('Net sales', '12,377') +
      tr('Basic earnings per share', '239.10'));
    expect(readJpRelease(disagree, Q2)).toMatchObject({ revenue: null, eps: null, span: null });
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

describe('review round 1', () => {
  const span = (n: number, t: string) => `<td colspan="${n}">${t}</td>`;
  const Q1 = { periodEnd: '2026-06-30', fiscalQuarter: 1 as const };
  const Q4 = { periodEnd: '2026-03-31', fiscalQuarter: 4 as const };

  it('E1: 1Q / 1H token columns under a shared date are never read', () => {
    const html = table('(Millions of yen, except per share amounts)',
      `<tr><td></td>${span(2, 'September 30, 2026')}</tr>` + tr('', '1Q FY2027', '1H FY2027') +
      tr('Net sales', '11,000,000', '24,560,124') + tr('Basic earnings per share', '211.02', '450.12'));
    expect(readJpRelease(html, Q2)).toMatchObject({ revenue: null, eps: null, span: null });
  });

  it('E5: a dated quarter header over a Q2 FY2025 token is not the 3rd quarter', () => {
    const html = table('(Millions of yen, except per share amounts)',
      `<tr><td></td>${span(1, 'Three months ended December 31, 2025')}</tr>` + tr('', 'Q2 FY2025') +
      tr('Sales', '3,500,000') + tr('Basic earnings per share', '60.00'));
    expect(readJpRelease(html, { periodEnd: '2025-12-31', fiscalQuarter: 3 })).toMatchObject({ revenue: null, eps: null, span: null });
  });

  it('E3: undated FY columns under a shared "Year ended" date are never read (FY naming differs by issuer)', () => {
    const html = table('(Millions of yen, except per share amounts)',
      `<tr><td></td>${span(2, 'Year ended March 31, 2026')}</tr>` + tr('', 'FY2025', 'FY2026') +
      tr('Sales', '12,000,000', '12,500,000') + tr('Basic earnings per share', '180.00', '190.00'));
    expect(readJpRelease(html, Q4)).toMatchObject({ revenue: null, eps: null, span: null });
  });

  it('E4: Sony-style FY columns (named by start year) under a shared date are never read', () => {
    const html = table('(Millions of yen, except per share amounts)',
      `<tr><td></td>${span(3, 'March 31, 2026')}</tr>` + tr('', 'FY2024', 'FY2025', 'FY2026') +
      tr('Sales', '12,000,000', '12,500,000', '13,000,000') + tr('Basic earnings per share', '180.00', '190.00', '200.00'));
    expect(readJpRelease(html, Q4)).toMatchObject({ revenue: null, eps: null, span: null });
  });

  it('an FY column stating its own year-end date is read; its FY token only narrows', () => {
    const html = table('(Millions of yen, except per share amounts)',
      tr('', 'FY2025 (year ended March 31, 2025)', 'FY2026 (year ended March 31, 2026)') +
      tr('Sales', '12,000,000', '12,500,000') + tr('Basic earnings per share', '180.00', '190.00'));
    expect(readJpRelease(html, Q4)).toMatchObject({ revenue: 12_500_000_000_000, eps: 190, span: 'ytd', ytdMonths: 12 });
  });

  it('jpFiscalYear: named by the calendar year the fiscal year ends in', () => {
    expect(jpFiscalYear('2026-09-30', 2)).toBe(2027);
    expect(jpFiscalYear('2026-06-30', 1)).toBe(2027);
    expect(jpFiscalYear('2025-12-31', 3)).toBe(2026);
    expect(jpFiscalYear('2026-03-31', 4)).toBe(2026);
    expect(jpFiscalYear('2026-12-31', 4)).toBe(2026);
  });

  it('G1b: a segment row in the summary layout never inherits the label-column header period', () => {
    const html = table('(Millions of yen)',
      tr('Three months ended June 30, 2026', 'Net sales', 'Basic earnings per share') + tr('Automotive', '9,000', '10.00'));
    expect(readJpRelease(html, Q1)).toMatchObject({ revenue: null, eps: null, span: null });
  });

  it('C3: "$" figures are never yen', () => {
    const html = table('(Millions of yen, except per share amounts)',
      tr('', 'Three months ended June 30, 2026') + tr('Net sales', '$7') + tr('Basic earnings per share', '$0.07'));
    expect(readJpRelease(html, Q1)).toMatchObject({ revenue: null, eps: null, span: null });
  });

  const cons = table('',
    tr('', 'Net sales', '', 'Basic earnings per share') + tr('', 'Million yen', '%', 'Yen') +
    tr('Fiscal year ended March 31, 2026', '48,000,000', '4.1', '250.00'));
  const nonc = table('(Reference) Summary of Non-consolidated Financial Results',
    tr('', 'Net sales', '', 'Basic earnings per share') + tr('', 'Million yen', '%', 'Yen') +
    tr('Fiscal year ended March 31, 2026', '15,000,000', '2.0', '300.00'));

  it('N2: non-consolidated figures do not blank the consolidated ones', () => {
    expect(readJpRelease(cons + nonc, Q4)).toMatchObject({ revenue: 48_000_000_000_000, eps: 250, span: 'ytd', ytdMonths: 12 });
  });

  it('N3: non-consolidated figures alone are never read as the company', () => {
    expect(readJpRelease(nonc, Q4)).toMatchObject({ revenue: null, eps: null, span: null });
    const section = table('(Millions of yen, except per share amounts)',
      tr('Non-consolidated') + tr('', 'Fiscal year ended March 31, 2026') + tr('Net sales', '15,000,000') + tr('Basic earnings per share', '300.00'));
    expect(readJpRelease(section, Q4)).toMatchObject({ revenue: null, eps: null });
  });

  const ncBody = tr('', 'Net sales', '', 'Basic earnings per share') + tr('', 'Million yen', '%', 'Yen') +
    tr('Fiscal year ended March 31, 2026', '15,000,000', '2.0', '300.00');
  const ncSection = `<p>2. Summary of Non-consolidated Financial Results for FY2026. (1) Operating Results</p><table>${ncBody}</table>`;

  it('X1: a non-consolidated section heading above the caption sentence is never read as the group', () => {
    expect(readJpRelease(ncSection, Q4)).toMatchObject({ revenue: null, eps: null, span: null });
    const twoParas = `<p>2. Non-consolidated Financial Results</p><p>(1) Operating Results</p><table>${ncBody}</table>`;
    expect(readJpRelease(twoParas, Q4)).toMatchObject({ revenue: null, eps: null, span: null });
  });

  it('X1: consolidated first, then the non-consolidated section → the consolidated values', () => {
    expect(readJpRelease(cons + ncSection, Q4)).toMatchObject({ revenue: 48_000_000_000_000, eps: 250, span: 'ytd', ytdMonths: 12 });
  });

  it('X1: a consolidated heading after a non-consolidated section reopens the group figures', () => {
    const html = ncSection + `<p>3. Consolidated Financial Statements.</p>` +
      table('(Millions of yen, except per share amounts)', tr('', 'Fiscal year ended March 31, 2026') + tr('Net sales', '48,000,000') + tr('Basic earnings per share', '250.00'));
    expect(readJpRelease(html, Q4)).toMatchObject({ revenue: 48_000_000_000_000, eps: 250, span: 'ytd', ytdMonths: 12 });
  });

  it('X2: token columns under a shared date are read through their own explicit span word', () => {
    const html = table('(Millions of yen, except per share amounts)',
      `<tr><td></td>${span(2, 'September 30, 2026')}</tr>` + tr('', '2Q FY2026 three months', '2Q FY2027 three months') +
      tr('Net sales', '—', '12,377') + tr('Basic earnings per share', '—', '239.10'));
    expect(readJpRelease(html, Q2)).toMatchObject({ revenue: 12_377_000_000, eps: 239.1, span: 'quarter' });
  });

  it('X3: under a shared date, "2Q (three months)" is the quarter, "2Q (six months)" is not', () => {
    const html = table('(Millions of yen, except per share amounts)',
      `<tr><td></td>${span(2, 'Ended September 30, 2026')}</tr>` + tr('', '2Q (three months)', '2Q (six months)') +
      tr('Net sales', '12,377', '24,560') + tr('Basic earnings per share', '239.10', '450.12'));
    expect(readJpRelease(html, Q2)).toMatchObject({ revenue: 12_377_000_000, eps: 239.1, span: 'quarter' });
  });

  it('X4: a "(Reference)" note row does not make a consolidated table non-consolidated', () => {
    const html = table('(Millions of yen, except per share amounts)',
      tr('', 'Fiscal year ended March 31, 2026') + tr('Net sales', '48,000,000') + tr('Basic earnings per share', '250.00') +
      tr('(Reference) Comprehensive income: 1,000 million yen'));
    expect(readJpRelease(html, Q4)).toMatchObject({ revenue: 48_000_000_000_000, eps: 250, span: 'ytd', ytdMonths: 12 });
  });

  it('notes of the YTD read are kept when the quarter read found nothing', () => {
    const html = table('(Millions of yen, except per share amounts)',
      tr('', 'Six months ended September 30, 2026', 'Six months ended September 30, 2026') + tr('Basic earnings per share', '450.12', '451.00'));
    const v = readJpRelease(html, Q2);
    expect(v).toMatchObject({ eps: null, span: null });
    expect(v.notes).toContain('basic: candidates disagree (450.12, 451)');
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
