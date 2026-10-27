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
    const html = table('1. Consolidated Financial Data for the Three Months ended June 30, 2026',
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

  const cons = table('1. Consolidated Financial Results',
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

  const parentNull = { revenue: null, eps: null, span: null };

  it('P1: prose mentioning "consolidated" never ends a non-consolidated section', () => {
    const p1 = `<p>Non-consolidated results. Net sales decreased compared with the consolidated figures. (Millions of yen)</p><table>${ncBody}</table>`;
    expect(readJpRelease(p1, Q4)).toMatchObject(parentNull);
    expect(readJpRelease(cons + p1, Q4)).toMatchObject({ revenue: 48_000_000_000_000, eps: 250, span: 'ytd', ytdMonths: 12 });
  });

  it('P2: "Dividends from consolidated subsidiaries" prose after a non-consolidated heading', () => {
    const html = `<p>2. Summary of Non-consolidated Financial Results</p><p>Dividends from consolidated subsidiaries increased.</p><p>(1) Operating Results</p><table>${ncBody}</table>`;
    expect(readJpRelease(html, Q4)).toMatchObject(parentNull);
  });

  it('P3: a Japanese 個別 / 非連結 heading opens a non-consolidated section', () => {
    expect(readJpRelease(`<p>2. 個別業績の概要（非連結）</p><table>${ncBody}</table>`, Q4)).toMatchObject(parentNull);
  });

  it('P4: 単体 heading, then 連結子会社 prose: still non-consolidated', () => {
    expect(readJpRelease(`<p>単体業績</p><p>連結子会社からの配当金が増加しました。</p><table>${ncBody}</table>`, Q4)).toMatchObject(parentNull);
  });

  it('P5 / P6: a non-consolidated section covers the tables that follow it', () => {
    expect(readJpRelease(`<p>Non-consolidated Financial Results</p><table>${ncBody}</table><table>${ncBody}</table>`, Q4)).toMatchObject(parentNull);
    const p6 = cons + `<p>(Reference) Summary of Non-consolidated Financial Results</p><table>${ncBody}</table>`;
    expect(readJpRelease(p6, Q4)).toMatchObject({ revenue: 48_000_000_000_000, eps: 250, span: 'ytd', ytdMonths: 12 });
  });

  it('P7: a note "on a consolidated basis" does not end the section', () => {
    const html = `<p>Non-consolidated Financial Results</p><p>Note: Figures on a consolidated basis are shown above.</p><table>${ncBody}</table>`;
    expect(readJpRelease(html, Q4)).toMatchObject(parentNull);
  });

  it('A1–A5: blocks merely mentioning consolidation never end a non-consolidated section', () => {
    const nc = '<p>2. Summary of Non-consolidated Financial Results</p>';
    const cases = [
      `${nc}<p>Consolidated subsidiaries</p><table>${tr('Number', '12')}</table><p>(1) Operating Results</p><table>${ncBody}</table>`,
      `${nc}<p>Consolidated subsidiaries</p><table>${ncBody}</table>`,
      `${nc}<p>Consolidated basis comparison</p><table>${ncBody}</table>`,
      `<p>単体業績</p><p>連結子会社数</p><table>${ncBody}</table>`,
      `<p>Non-consolidated Financial Results</p><p>Note: Consolidated figures are shown above</p><table>${ncBody}</table>`,
      `<p>Non-consolidated Financial Results<br>Compared with Consolidated results<br>(Millions of yen)</p><table>${ncBody}</table>`,
    ];
    for (const html of cases) expect(readJpRelease(html, Q4), html.slice(0, 80)).toMatchObject(parentNull);
  });

  it('A6–A9: comparison / ratio / share / negation blocks never end a non-consolidated section', () => {
    const nc = '<p>2. Summary of Non-consolidated Financial Results</p>';
    for (const heading of ['Parent Company vs Consolidated', 'Ratio to Consolidated Results', '(1) Share of Consolidated', 'Not Consolidated']) {
      expect(readJpRelease(`${nc}<p>${heading}</p><table>${ncBody}</table>`, Q4), heading).toMatchObject(parentNull);
    }
  });

  it('A10: "Unconsolidated" and "Parent Company Only" headings open a non-consolidated section', () => {
    for (const heading of ['Unconsolidated Financial Results', 'Parent Company Only']) {
      expect(readJpRelease(`<p>${heading}</p><table>${ncBody}</table>`, Q4), heading).toMatchObject(parentNull);
    }
  });

  it('a group-results heading (anchored allowlist) ends a non-consolidated section', () => {
    // The unit sits inside the table, so the heading text just above is not mistaken for the caption.
    const consTable = `<table>${tr('', 'Fiscal year ended March 31, 2026') + tr('', 'Millions of yen') +
      tr('Net sales', '48,000,000') + tr('Basic earnings per share', '250.00')}</table>`;
    const group = { revenue: 48_000_000_000_000, eps: 250, span: 'ytd', ytdMonths: 12 };
    for (const heading of ['MUFG Consolidated', '[ MUFG Consolidated ]', '(2) Consolidated Statements of Income', 'Ⅱ. Consolidated Financial Results', '連結業績']) {
      expect(readJpRelease(`<p>BK Non-consolidated</p><table>${ncBody}</table><p>${heading}</p>${consTable}`, Q4), heading).toMatchObject(group);
    }
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

  it('MUFG 1Q FY2026: ordinary income is not revenue; the EPS summary has no group heading of its own → blank', () => {
    // Ruling (fix round 2): the summary layout needs the table's own heading to name the group. MUFG's EPS table sits
    // under the comprehensive-income note; "1. Consolidated Financial Data …" heads the tables above it. Blank, never wrong.
    expect(readJpRelease(fx('MUFG_2026-06-30.htm'), { periodEnd: '2026-06-30', fiscalQuarter: 1 })).toMatchObject({
      revenue: null, eps: null, epsDiluted: null,
    });
  });
});

/** The six gate fields of a real release, read for its period. */
const six = (file: string, periodEnd: string, fiscalQuarter: 1 | 2 | 3 | 4) => {
  const { revenue, eps, epsDiluted, currency, span, ytdMonths } = readJpRelease(fx(file), { periodEnd, fiscalQuarter });
  return { revenue, eps, epsDiluted, currency, span, ytdMonths };
};

describe('Task 12b: unit headers "Yen (millions)", "JPY (millions)", "Million JPY"', () => {
  it('U1: "Yen (millions)" / "JPY (millions)" / "(Million JPY)" / "Billion JPY" state the unit', () => {
    for (const [unit, mult] of [['Yen (millions)', 1e6], ['JPY (millions)', 1e6], ['(Million JPY)', 1e6], ['JPY millions', 1e6], ['Billion JPY, except EPS', 1e9], ['(Billions of JPY)', 1e9]] as const) {
      const html = table('Condensed Consolidated Statements of Income',
        tr('', unit) +
        tr('', 'Three months ended June 30, 2026') +
        tr('Sales revenue', '6,061') +
        tr('Basic earnings per share', '115.84'));
      expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 }), unit).toMatchObject({ revenue: 6061 * mult, eps: 115.84 });
    }
  });

  it('U2: "Yen" alone, "Yen (thousands)" and a US$ unit are still no yen unit', () => {
    for (const unit of ['Yen', 'Yen (thousands)', 'USD (millions)']) {
      const html = table('Condensed Consolidated Statements of Income',
        tr('', unit) +
        tr('', 'Three months ended June 30, 2026') +
        tr('Sales revenue', '6,061'));
      expect(readJpRelease(html, { periodEnd: '2026-06-30', fiscalQuarter: 1 }).revenue, unit).toBeNull();
    }
  });

  it('Honda: statements in "Yen (millions)"', () => {
    expect(six('HMC_2026-06-30.htm', '2026-06-30', 1)).toEqual({ revenue: 6_061_514_000_000, eps: 115.84, epsDiluted: 115.84, currency: 'JPY', span: 'quarter', ytdMonths: null });
    expect(six('HMC_2026-03-31.htm', '2026-03-31', 4)).toEqual({ revenue: 21_796_610_000_000, eps: -106.06, epsDiluted: -106.06, currency: 'JPY', span: 'ytd', ytdMonths: 12 });
    expect(six('HMC_2025-12-31.htm', '2025-12-31', 3)).toEqual({ revenue: 15_975_664_000_000, eps: 115.53, epsDiluted: 115.53, currency: 'JPY', span: 'ytd', ytdMonths: 9 });
  });

  it('Takeda FY2025 Tanshin: statement in "JPY (millions)"', () => {
    expect(six('TAK_2026-03-31.htm', '2026-03-31', 4)).toEqual({ revenue: 4_505_720_000_000, eps: 121.75, epsDiluted: 119.64, currency: 'JPY', span: 'ytd', ytdMonths: 12 });
  });
});

describe('Task 12b: summaries with periods in rows (banks)', () => {
  const Q3 = { periodEnd: '2025-12-31', fiscalQuarter: 3 as const };
  const Q1 = { periodEnd: '2026-06-30', fiscalQuarter: 1 as const };
  const Q4 = { periodEnd: '2026-03-31', fiscalQuarter: 4 as const };
  const eps = (rows: string) => `<table>${tr('', 'Earnings per Share of Common Stock', 'Diluted Earnings per Share of Common Stock')}${tr('', '&yen;', '&yen;')}${rows}</table>`;
  const group = '<p>(1) Consolidated Results of Operations</p>';
  const def9 = '<p>1. Financial Highlights for the Third Quarter of Fiscal 2025 (for the nine months ended December 31, 2025)</p>';
  const yenRows = (head: [string, string]) =>
    `<table>${tr('', ...head)}${tr('Three months ended June 30, 2026', '&yen; 131.62', '&yen; 131.59')}${tr('Three months ended June 30, 2025', '97.46', '97.44')}</table>`;
  const smfg = yenRows(['Earnings per share', 'Earnings per share (Diluted)']);

  it('S1: a "&yen; 131.62" figure cell is read, and its ¥ sign states the currency, under a group heading', () => {
    expect(readJpRelease(group + smfg, Q1)).toMatchObject({ eps: 131.62, epsDiluted: 131.59, span: 'quarter', currency: 'JPY' });
    // A statement / note layout still needs its header or caption to name the currency (unchanged rule).
    const note = `<p>(Per Share Information)</p><table>${tr('', 'For the three months ended June 30, 2026')}${tr('Basic earnings per common share', '&yen;', '131.62')}</table>`;
    expect(readJpRelease(note, Q1)).toMatchObject({ eps: null });
  });

  it('S1 (b1–b4): subsidiary summaries, US$ heads / captions against a ¥ sign, and dividend columns are never EPS', () => {
    // b1: no group heading, and a subsidiary's own title.
    expect(readJpRelease(smfg, Q1)).toMatchObject({ eps: null, epsDiluted: null });
    expect(readJpRelease(`<p>Summary of SMBC Nikko Securities</p>${smfg}`, Q1)).toMatchObject({ eps: null, epsDiluted: null });
    expect(readJpRelease(`<p>Consolidated results of SMBC Nikko Securities Co., Ltd.</p>${smfg}`, Q1)).toMatchObject({ eps: null, epsDiluted: null });
    // b2: the column heads name US$.
    expect(readJpRelease(group + yenRows(['Earnings per share (US$)', 'Diluted EPS (US$)']), Q1)).toMatchObject({ eps: null, epsDiluted: null });
    // b3: a ¥-signed dividends column is not EPS.
    expect(readJpRelease(group + yenRows(['Dividends per share', 'Earnings per share']), Q1)).toMatchObject({ eps: 131.59, epsDiluted: null });
    // b4: a US$ caption against the ¥ sign: conflicting evidence.
    expect(readJpRelease(`${group}<p>(U.S. dollars)</p>${smfg}`, Q1)).toMatchObject({ eps: null, epsDiluted: null });
  });

  it('S1 (n1, n1b, n1c, n2, n6): a document-level group title never vouches for a summary whose own heading does not name the group', () => {
    const doc = '<p>Consolidated Financial Results for the First Quarter of Fiscal 2026</p><p>Our results were strong.</p>';
    const sumT = `<table>${tr('', 'Earnings per share', 'Earnings per share (Diluted)')}${tr('Three months ended June 30, 2026', '&yen; 31.62', '&yen; 31.59')}</table>`;
    const blank = { eps: null, epsDiluted: null };
    expect(readJpRelease(doc + '<p>Summary of results of Mizuho Bank</p>' + sumT, Q1), 'n1').toMatchObject(blank);
    expect(readJpRelease('<p>Summary of results of Mizuho Bank</p>' + sumT, Q1), 'n1b').toMatchObject(blank);
    expect(readJpRelease(doc + '<p>Results of Toyota Financial Services Corporation</p>' + sumT, Q1), 'n1c').toMatchObject(blank);
    expect(readJpRelease(doc + '<p>Summary of SMBC Nikko Securities</p>' + `<table>${tr('Branches', '120')}</table>` + '<p>(Yen)</p>' + sumT, Q1), 'n2').toMatchObject(blank);
    expect(readJpRelease(doc + '<p>Summary of SMBC Nikko Securities</p>' + `<table>${tr('Branches', '120')}</table>` + sumT, Q1), 'n2b').toMatchObject(blank);
    expect(readJpRelease(doc + '<p>Results of equity-method affiliate Sony Financial Group</p>' + sumT, Q1), 'n6').toMatchObject(blank);
    // The nearest heading is the table's own title: a group heading right above a subsidiary's does not count.
    expect(readJpRelease('<p>Consolidated Financial Results</p><p>Summary of results of Mizuho Bank</p>' + sumT, Q1)).toMatchObject(blank);
    // Controls: the table's own heading names the group, or is a numbered sub-heading under the group heading.
    expect(readJpRelease(doc + '<p>(1) Consolidated Results of Operations</p>' + sumT, Q1)).toMatchObject({ eps: 31.62, epsDiluted: 31.59 });
    expect(readJpRelease('<p>1. Consolidated financial results</p><p>(1) Operating results</p><p>(Yen)</p>' + sumT, Q1)).toMatchObject({ eps: 31.62, epsDiluted: 31.59 });
  });

  it('S1 (probe5 m1–m7): only generic sub-headings inherit the group heading; named ones, parentheticals and title rows do not', () => {
    const sumT = `<table>${tr('', 'Earnings per share', 'Earnings per share (Diluted)')}${tr('Three months ended June 30, 2026', '&yen; 31.62', '&yen; 31.59')}</table>`;
    const kpi = `<table>${tr('Branches', '120')}</table>`;
    const G = '<p>1. Consolidated financial results</p>';
    const blank = { eps: null, epsDiluted: null };
    const cases: Array<[string, string]> = [
      ['m1', G + '<p>(2) Results of Mizuho Bank</p>' + sumT],
      ['m1b', G + '<p>(2) Mizuho Bank, Ltd.</p>' + sumT],
      ['m2', G + kpi + kpi + sumT],
      ['m2b', G + kpi + '<table><tr><td colspan="3">Mizuho Bank</td></tr></table>' + sumT],
      ['m2c', G + `<table><tr><td colspan="3">Mizuho Bank</td></tr>${tr('', 'Earnings per share', 'Earnings per share (Diluted)')}${tr('Three months ended June 30, 2026', '&yen; 31.62', '&yen; 31.59')}</table>`],
      ['m3', '<p>1. 連結業績</p><p>(2) 子会社の業績</p>' + sumT],
      ['m3b', '<p>1. 連結業績</p><p>(2) みずほ銀行の業績</p>' + sumT],
      ['m3c', '<p>1. 連結業績</p><p>（２）みずほ銀行</p>' + sumT],
      ['m4', '<p>Consolidated Financial Results</p><p>(Reference: Summary of results of Mizuho Bank)</p>' + sumT],
      ['m4b', '<p>Consolidated Financial Results</p><p>(Mizuho Bank)</p>' + sumT],
      ['m5', G + '<p>(a) Mizuho Bank</p>' + sumT],
      ['m6', G + '<p>(ii) Mizuho Bank</p>' + sumT],
      ['m7', G + kpi + '<p>2. Mizuho Bank</p>' + sumT],
    ];
    for (const [name, html] of cases) expect(readJpRelease(html, Q1), name).toMatchObject(blank);
    // m1c: the group's own "(1) Operating results" table is read; the bank's "(2) Results of …" table adds nothing.
    const m1c = G + '<p>(1) Operating results</p>' + sumT.replace('31.6', '30.6') + '<p>(2) Results of Mizuho Trust &amp; Banking</p>' + sumT;
    expect(readJpRelease(m1c, Q1)).toMatchObject({ eps: 30.62, epsDiluted: 31.59 });
    // Controls: generic sub-headings (English and Japanese), unit / note parentheticals, a generic title row.
    const read = { eps: 31.62, epsDiluted: 31.59 };
    expect(readJpRelease(G + '<p>(1) Operating results</p>' + sumT, Q1)).toMatchObject(read);
    expect(readJpRelease(G + '<p>(2) Earnings per share</p><p>(Yen)</p>' + sumT, Q1)).toMatchObject(read);
    expect(readJpRelease('<p>1. 連結業績</p><p>（１）経営成績</p><p>(Millions of yen, except per share data)</p>' + sumT, Q1)).toMatchObject(read);
    expect(readJpRelease(G + '<p>(1) Operating results (Millions of yen, except per share data and percentages)</p>' + sumT, Q1)).toMatchObject(read);
    expect(readJpRelease(G + `<table><tr><td colspan="3">(% represents the change from the same period)</td></tr>${tr('', 'Earnings per share', 'Earnings per share (Diluted)')}${tr('Three months ended June 30, 2026', '&yen; 31.62', '&yen; 31.59')}</table>`, Q1)).toMatchObject(read);
  });

  it('S2: a "3Q F2025" row is dated only by the definition in its own table\'s heading block', () => {
    const rows = tr('3Q F2025', '409.21', '409.21') + tr('3Q F2024', '337.64', '337.64');
    expect(readJpRelease(def9 + group + eps(rows), Q3)).toMatchObject({ eps: 409.21, epsDiluted: 409.21, span: 'ytd', ytdMonths: 9, currency: 'JPY' });
    // No definition: the token row stays undated → blank.
    expect(readJpRelease(group + eps(rows), Q3)).toMatchObject({ eps: null, epsDiluted: null, span: null });
    // A definition of another label ("Fiscal 2025", or the prior fiscal year) does not date "3Q F2025" (a2).
    expect(readJpRelease('<p>Financial Highlights for Fiscal 2025 (for the fiscal year ended March 31, 2026)</p>' + group + eps(rows), Q3)).toMatchObject({ eps: null, span: null });
    expect(readJpRelease('<p>Third Quarter of Fiscal 2024 (for the nine months ended December 31, 2024)</p>' + group + eps(rows), Q3)).toMatchObject({ eps: null, span: null });
    // a3: the prior-year row with its own definition is not the period.
    expect(readJpRelease('<p>Third Quarter of Fiscal 2024 (for the nine months ended December 31, 2024)</p>' + group + eps(tr('3Q F2024', '337.64', '337.64')), Q3)).toMatchObject({ eps: null, span: null });
    // a4: the definition stands in another section's heading block, not this table's.
    expect(readJpRelease(def9 + '<table><tr><td>Ordinary income</td><td>1</td></tr></table><p>Consolidated Financial Results</p>' + eps(tr('3Q F2025', '409.21', '409.21')), Q3)).toMatchObject({ eps: null, span: null });
  });

  it('S2 (a1, a1b, a5, a8): another span in the heading, the column head or the title, forecasts and subsidiaries → blank', () => {
    const trend = tr('1Q F2025', '120.00', '120.00') + tr('2Q F2025', '140.00', '140.00') + tr('3Q F2025', '149.21', '149.21');
    expect(readJpRelease(def9 + group + '<p>Quarterly trend of earnings per share</p>' + eps(trend), Q3)).toMatchObject({ eps: null, epsDiluted: null });
    expect(readJpRelease(`${def9}${group}<table>${tr('', 'EPS (three months)', 'Diluted EPS (three months)')}${tr('', '&yen;', '&yen;')}${tr('3Q F2025', '149.21', '149.21')}</table>`, Q3)).toMatchObject({ eps: null, epsDiluted: null });
    expect(readJpRelease(`${def9}${group}<p>(Oct-Dec)</p>${eps(tr('3Q F2025', '149.21', '149.21'))}`, Q3)).toMatchObject({ eps: null, epsDiluted: null });
    const fy = '<p>Financial Highlights for Fiscal 2025 (for the fiscal year ended March 31, 2026)</p>';
    expect(readJpRelease(fy + '<p>Consolidated earnings estimates for Fiscal 2026</p>' + eps(tr('Fiscal 2025', '502.92', '502.92')), Q4)).toMatchObject({ eps: null });
    expect(readJpRelease(def9 + '<p>Summary of results of Mizuho Securities Co., Ltd.</p>' + eps(tr('3Q F2025', '55.55', '55.55')), Q3)).toMatchObject({ eps: null });
  });

  it('S2 (a6, a7, a9): controls — a defined label in its own group heading block is read', () => {
    expect(readJpRelease('<p>Consolidated Financial Highlights for FY2025 (for the fiscal year ended March 31, 2026)</p>' + eps(tr('FY2025', '502.92', '502.92') + tr('FY2024', '400.00', '400.00')), Q4)).toMatchObject({ eps: 502.92, span: 'ytd', ytdMonths: 12 });
    expect(readJpRelease('<p>Consolidated Highlights for Fiscal 2026 (for the fiscal year ended March 31, 2026)</p>' + eps(tr('Fiscal 2026', '502.92', '502.92') + tr('Fiscal 2025', '400.00', '400.00')), Q4)).toMatchObject({ eps: 502.92, span: 'ytd' });
    expect(readJpRelease('<p>Consolidated results, First Quarter of Fiscal 2026 (for the three months ended June 30, 2026)</p>' + eps(tr('1Q F2026', '173.53', '173.53')), Q1)).toMatchObject({ eps: 173.53, span: 'quarter' });
  });

  it('S3: conflicting definitions of one label → blank; a "3Q" defined as nine months is never the quarter', () => {
    const rows = tr('3Q F2025', '409.21', '409.21');
    const two = '<p>Third Quarter of Fiscal 2025 (for the nine months ended December 31, 2025)</p><p>Third Quarter of Fiscal 2025 (for the three months ended December 31, 2025)</p>';
    expect(readJpRelease(two + group + eps(rows), Q3)).toMatchObject({ eps: null, span: null });
    expect(readRelease(def9 + group + eps(rows), { periodEnd: '2025-12-31', span: 'quarter', profile: 'jp', fiscalQuarter: 3, fiscalYear: 2026 })).toMatchObject({ epsBasic: null, epsGaap: null });
  });

  it('S4: a forecast definition ("fiscal year ending") dates nothing; a row with more than the label is not a token row', () => {
    const rows = tr('Fiscal 2025', '502.92', '502.92');
    const ending = '<p>Forecast for Fiscal 2025 (for the fiscal year ending March 31, 2026)</p>';
    expect(readJpRelease(ending + group + eps(rows), Q4)).toMatchObject({ eps: null, span: null });
    const def = '<p>Financial Highlights for Fiscal 2025 (for the fiscal year ended March 31, 2026)</p>';
    expect(readJpRelease(def + group + eps(rows), Q4)).toMatchObject({ eps: 502.92, span: 'ytd', ytdMonths: 12 });
    expect(readJpRelease(def + group + eps(tr('Fiscal 2025 (estimate)', '502.92', '502.92')), Q4)).toMatchObject({ eps: null });
  });

  it('Mizuho: "1Q F2026" / "3Q F2025" / "Fiscal 2025" summary rows', () => {
    expect(six('MFG_2026-06-30.htm', '2026-06-30', 1)).toEqual({ revenue: null, eps: 173.53, epsDiluted: 173.53, currency: 'JPY', span: 'quarter', ytdMonths: null });
    expect(six('MFG_2025-12-31.htm', '2025-12-31', 3)).toEqual({ revenue: null, eps: 409.21, epsDiluted: 409.21, currency: 'JPY', span: 'ytd', ytdMonths: 9 });
    expect(six('MFG_2026-03-31.htm', '2026-03-31', 4)).toEqual({ revenue: null, eps: 502.92, epsDiluted: 502.92, currency: 'JPY', span: 'ytd', ytdMonths: 12 });
  });

  it('SMFG: "Three months ended June 30, 2026" summary rows with "&yen;" figures', () => {
    expect(six('SMFG_2026-06-30.htm', '2026-06-30', 1)).toEqual({ revenue: null, eps: 131.62, epsDiluted: 131.59, currency: 'JPY', span: 'quarter', ytdMonths: null });
    expect(six('SMFG_2025-12-31.htm', '2025-12-31', 3)).toEqual({ revenue: null, eps: 362.2, epsDiluted: 362.12, currency: 'JPY', span: 'ytd', ytdMonths: 9 });
    expect(six('SMFG_2026-03-31.htm', '2026-03-31', 4)).toEqual({ revenue: null, eps: 411.97, epsDiluted: 411.88, currency: 'JPY', span: 'ytd', ytdMonths: 12 });
  });
});

describe('Task 12b: split row labels ("Basic-" / "Net income … per share")', () => {
  const head = span2('', 'Millions of yen', '% Change') + span2('', 'For the three months ended') + tr('', 'December 31, 2025', 'March 31, 2026');
  const Q4 = { periodEnd: '2026-03-31', fiscalQuarter: 4 as const };
  const hd = tr('', 'Three months ended March 31, 2026') + tr('', 'Yen');

  it('L1: a dangling "Basic-" / "Diluted-" fragment joins the label row below it', () => {
    const html = table('Consolidated Statements of Income – Quarterly Comparatives',
      head +
      tr('Net revenue', '551,755', '577,181', '4.6') +
      tr('Net income attributable to NHI shareholders', '91,553', '73,933', '(19.2)') +
      span2('', 'Yen', '% Change') +
      tr('Per share of common stock:') +
      tr('Basic-') +
      tr('Net income attributable to NHI shareholders per share', '31.21', '25.29', '(19.0)') +
      tr('Diluted-') +
      tr('Net income attributable to NHI shareholders per share', '30.19', '24.34', '(19.4)'));
    expect(readJpRelease(html, Q4)).toMatchObject({ revenue: 577_181_000_000, eps: 25.29, epsDiluted: 24.34, span: 'quarter' });
  });

  it('L2: a fragment is joined only to the row right below it, and only when that row has figures', () => {
    const html = table('(Millions of yen)',
      tr('', 'Three months ended March 31, 2026') +
      tr('Diluted-') +
      tr('Per share of common stock:') +
      tr('Net income attributable to shareholders per share', '25.29'));
    // "Diluted-" is followed by another label-only row: it is not carried down, so the row stays basic.
    expect(readJpRelease(html, Q4)).toMatchObject({ eps: 25.29, epsDiluted: null });
  });

  it('L3 (c1, c3, c5): "Basic-" / "Diluted-" never join a row that names basic / diluted itself, or no per-share words', () => {
    expect(readJpRelease(`<p>(Millions of yen)</p><table>${hd}${tr('Basic-')}${tr('Diluted net income per share', '24.34')}</table>`, Q4)).toMatchObject({ eps: null, epsDiluted: 24.34 });
    expect(readJpRelease(`<p>(Millions of yen)</p><table>${hd}${tr('Per share of common stock:')}${tr('Basic-')}${tr('Net income attributable to NHI shareholders per share', '25.29')}${tr('Diluted-')}${tr('Return on equity', '8.20')}</table>`, Q4)).toMatchObject({ eps: 25.29, epsDiluted: null });
    expect(readJpRelease(`<p>(Millions of yen)</p><table>${hd}${tr('Per share of common stock:')}${tr('Diluted-')}${tr('Basic net income per share', '25.29')}</table>`, Q4)).toMatchObject({ eps: 25.29, epsDiluted: null });
  });

  it('L4 (c2, c4): equity per share stays excluded after "Basic-"; a "Non-" fragment makes "non-recurring" and excludes the row', () => {
    expect(readJpRelease(`<p>(Millions of yen)</p><table>${hd}${tr('Per share of common stock:')}${tr('Basic-')}${tr('Shareholders equity per share', '1,024.34')}${tr('Net income per share', '25.29')}</table>`, Q4)).toMatchObject({ eps: 25.29, epsDiluted: null });
    expect(readJpRelease(`<p>(Millions of yen)</p><table>${hd}${tr('Non-')}${tr('recurring net income per share', '5.29')}</table>`, Q4)).toMatchObject({ eps: null, epsDiluted: null });
    expect(readJpRelease(`<p>(Millions of yen)</p><table>${hd}${tr('One-time items per share', '5.29')}${tr('Net income per share excluding one-off items', '6.29')}</table>`, Q4)).toMatchObject({ eps: null });
  });

  it('Nomura FY2025 release: the quarterly comparatives\' standalone quarter', () => {
    expect(six('NMR_2026-03-31.htm', '2026-03-31', 4)).toEqual({ revenue: 577_181_000_000, eps: 25.29, epsDiluted: 24.34, currency: 'JPY', span: 'quarter', ytdMonths: null });
  });
});

describe('Task 12b: financial appendix ("Billion JPY, except EPS", "FY2024 Q4 (Jan-Mar)" columns, Core tables)', () => {
  const Q4 = { periodEnd: '2025-03-31', fiscalQuarter: 4 as const };
  const heading = (title: string) => `<table><tr><td colspan="3">${title}</td></tr></table>`;
  const appendix = (prev: string, cur: string, rev: [string, string], eps: [string, string]) =>
    `<table>${tr('(Billion JPY, except EPS)', prev, cur, 'vs. PY', '(Million USD, except EPS) FY2024 Q4 (Jan-Mar) Convenience USD Translation')}` +
    tr('', '', '', 'Amount of Change', '') +
    tr('Revenue', rev[0], rev[1], '2.5', '7,027') +
    tr('Basic EPS (JPY or USD)', eps[0], eps[1], '(13.81)', '(0.44)') + '</table>';
  const reported = appendix('FY2023 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar)', ['1,050.9', '1,053.4'], ['(51.44)', '(65.25)']);
  /** The document's own dated fiscal-year naming: FY2024 is the year ending March 31, 2025 (start-year naming). */
  const startYear = '<p>The full year consolidated forecast for the fiscal year ending March 31, 2025 (FY2024) is unchanged.</p>';
  const read = { revenue: 1_053_400_000_000, eps: -65.25, epsDiluted: null, currency: 'JPY', span: 'quarter' };
  const none = { revenue: null, eps: null };

  it('F1: a yearless month-range column is read only with a dated fiscal-year mapping in the same document', () => {
    expect(readJpRelease(startYear + heading('FY2024 Q4 (Jan-Mar) Reported Results with CER % Change') + reported, Q4)).toMatchObject(read);
    expect(readJpRelease('<p>FY2024 (April 1, 2024 through March 31, 2025)</p>' + heading('Reported Results') + reported, Q4)).toMatchObject(read);
    // No mapping (d1, d2, d5, d6): never read, whichever naming the labels would fit.
    expect(readJpRelease(heading('FY2024 Q4 (Jan-Mar) Reported Results with CER % Change') + reported, Q4)).toMatchObject(none);
    // An end-year mapping ("FY2025 (April 1, 2024 – March 31, 2025)") makes FY2024 last year: not read.
    expect(readJpRelease('<p>FY2025 (April 1, 2024 – March 31, 2025)</p>' + heading('Reported Results') + reported, Q4)).toMatchObject(none);
    // Mappings that disagree: none.
    expect(readJpRelease(startYear + '<p>FY2025 (April 1, 2024 – March 31, 2025)</p>' + heading('Reported Results') + reported, Q4)).toMatchObject(none);
  });

  it('F1b: only under a title that names the reported (IFRS) figures', () => {
    expect(readJpRelease(startYear + heading('Results with CER % Change') + reported, Q4)).toMatchObject(none);
    expect(readJpRelease(startYear + heading('Revenue by region') + `<table>${tr('(Billion JPY)', 'FY2023 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar)')}${tr('Revenue', '100.0', '120.0')}</table>`, Q4)).toMatchObject(none);
  });

  it('F2 (f0–f7): Core / non-IFRS / adjusted / "excluding" titles, label heads and header rows are never read', () => {
    const core = appendix('FY2023 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar)', ['1,050.9', '1,051.7'], ['(51.44)', '49.00']);
    // Control: the same table under a Reported title is read.
    expect(readJpRelease(startYear + heading('Reported Results') + core, Q4)).toMatchObject({ revenue: 1_051_700_000_000, eps: 49 });
    const titles = ['FY2024 Q4 (Jan-Mar) Reported vs Core Results', 'Non-IFRS Reported Results', 'Adjusted Reported Results', 'Reported Results excluding one-time items', 'Reported Results (non-recurring items excluded)'];
    for (const t of titles) {
      expect(readJpRelease(startYear + heading(t) + core, Q4), t).toMatchObject(none);
      expect(readJpRelease(`${startYear}<p>${t}</p>${core}`, Q4), t).toMatchObject(none);
      // Next to the reported table, the Core table adds no candidate.
      expect(readJpRelease(startYear + heading('Reported Results') + reported + heading(t) + core, Q4), t).toMatchObject(read);
    }
    // f1: a spacer paragraph between the heading table and the table.
    expect(readJpRelease(startYear + heading('Reported Core Results') + '<p>&nbsp;</p>' + core, Q4)).toMatchObject(none);
    // f2: the title, then sentences.
    expect(readJpRelease(`${startYear}<p>Reported Core Results.</p><p>Figures are unaudited. Amounts are rounded.</p>${core}`, Q4)).toMatchObject(none);
    // f3: Core in the label column's head; f4: a Core header row spanning the columns.
    const coreHead = `<table>${tr('Core (Billion JPY, except EPS)', 'FY2023 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar)')}${tr('Revenue', '900.0', '950.0')}${tr('Basic EPS', '10.00', '33.00')}</table>`;
    expect(readJpRelease(startYear + heading('Reported Results') + coreHead, Q4)).toMatchObject(none);
    const coreRow = `<table>${tr('(Billion JPY, except EPS)', 'Core Results', '')}${tr('', 'FY2023 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar)')}${tr('Revenue', '900.0', '950.0')}${tr('Basic EPS', '10.00', '33.00')}</table>`;
    expect(readJpRelease(startYear + heading('Reported Results') + coreRow, Q4)).toMatchObject(none);
    // f5: a heading table with a page number; f6: a heading table over four rows.
    expect(readJpRelease(`${startYear}<table><tr><td>Reported Core Results</td><td>12</td></tr></table>${core}`, Q4)).toMatchObject(none);
    expect(readJpRelease(`${startYear}<table><tr><td>Reported Core Results</td></tr><tr><td>FY2024 Q4</td></tr><tr><td>(Jan-Mar)</td></tr><tr><td>with CER</td></tr></table>${core}`, Q4)).toMatchObject(none);
    // A "CORE" column is never read either.
    const cols = `<table>${tr('(Billion JPY)', 'FY2023 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar) CORE')}${tr('Revenue', '1,050.9', '1,051.7')}${tr('Basic EPS', '1.00', '2.00')}</table>`;
    expect(readJpRelease(startYear + heading('Reported Results') + cols, Q4)).toMatchObject(none);
  });

  it('F3: the prior-year pair is required; no later label, no duplicate head (d3), no extra words in the head (d4)', () => {
    const alone = `<table>${tr('(Billion JPY, except EPS)', 'FY2024 Q4 (Jan-Mar)')}${tr('Revenue', '1,053.4')}${tr('Basic EPS', '(65.25)')}</table>`;
    expect(readJpRelease(startYear + heading('Reported Results') + alone, Q4)).toMatchObject(none);
    const later = appendix('FY2024 Q4 (Jan-Mar)', 'FY2025 Q4 (Jan-Mar)', ['1,053.4', '1,100.0'], ['(65.25)', '10.00']);
    expect(readJpRelease(startYear + heading('Reported Results') + later, Q4)).toMatchObject(none);
    const dup = `<table>${tr('(Billion JPY, except EPS)', 'FY2023 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar)')}${tr('Revenue', '900.0', '950.0', '6.3')}${tr('Basic EPS', '10.00', '20.00', '0.13')}</table>`;
    expect(readJpRelease(startYear + heading('Reported Results') + dup, Q4)).toMatchObject(none);
    const conv = `<table>${tr('(Billion JPY, except EPS)', 'FY2023 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar)', 'FY2024 Q4 (Jan-Mar) Convenience translation')}${tr('Revenue', '900.0', '950.0', '6.3')}${tr('Basic EPS', '10.00', '20.00', '0.13')}</table>`;
    expect(readJpRelease(startYear + heading('Reported Results') + conv, Q4)).toMatchObject({ revenue: 950_000_000_000, eps: 20 });
  });

  it('F4: the range must be the requested span ending on the period end; a quarter token must match', () => {
    const ytd = appendix('FY2023 Q4 (Apr-Mar)', 'FY2024 Q4 (Apr-Mar)', ['4,263.8', '4,581.6'], ['91.16', '68.36']);
    expect(readRelease(startYear + heading('Reported Results') + ytd, { periodEnd: '2025-03-31', span: 'quarter', profile: 'jp', fiscalQuarter: 4, fiscalYear: 2025 })).toMatchObject({ revenue: null, epsBasic: null });
    const q3 = appendix('FY2023 Q3 (Jan-Mar)', 'FY2024 Q3 (Jan-Mar)', ['1,050.9', '1,053.4'], ['(51.44)', '(65.25)']);
    expect(readJpRelease(startYear + heading('Reported Results') + q3, Q4)).toMatchObject(none);
    expect(readJpRelease(startYear + heading('Reported Results') + reported, { periodEnd: '2024-12-31', fiscalQuarter: 3 })).toMatchObject(none);
  });

  it('Takeda Kessan Tanshin (main 6-K document): Q3 nine months and FY2024, Core and unconsolidated figures not read', () => {
    expect(six('TAK_2024-12-31.htm', '2024-12-31', 3)).toEqual({ revenue: 3_528_152_000_000, eps: 133.71, epsDiluted: 131.69, currency: 'JPY', span: 'ytd', ytdMonths: 9 });
    expect(six('TAK_2025-03-31.htm', '2025-03-31', 4)).toEqual({ revenue: 4_581_551_000_000, eps: 68.36, epsDiluted: 67.23, currency: 'JPY', span: 'ytd', ytdMonths: 12 });
  });

  it('Takeda Tanshin: the "(Reference) Summary of Unconsolidated Results" is not read', () => {
    const html = fx('TAK_2026-03-31.htm');
    const at = html.search(/\(Reference\) Summary of Unconsolidated Results/i);
    const end = html.search(/is exempt from audit/i);
    expect(at).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(at);
    // The unconsolidated section alone (its title rows sit in the table: Net sales 591,604; EPS 125.29 / 125.26) gives nothing.
    const section = html.slice(html.lastIndexOf('<table', at), end);
    expect(section).toContain('125.29');
    expect(readJpRelease(section, { periodEnd: '2026-03-31', fiscalQuarter: 4 })).toMatchObject({ revenue: null, eps: null, epsDiluted: null });
    // Titled "Consolidated" instead, the same tables would be read: the exclusion is what blanks them.
    expect(readJpRelease(`<p>Summary of Consolidated Results</p>${section.replace(/Unconsolidated/g, 'Consolidated')}`, { periodEnd: '2026-03-31', fiscalQuarter: 4 }).eps).toBe(125.29);
    expect(six('TAK_2026-03-31.htm', '2026-03-31', 4)).toEqual({ revenue: 4_505_720_000_000, eps: 121.75, epsDiluted: 119.64, currency: 'JPY', span: 'ytd', ytdMonths: 12 });
  });
});

describe('Task 12b: "Unaudited Consolidated Statement of …" headings end a non-consolidated section', () => {
  const Q4 = { periodEnd: '2026-03-31', fiscalQuarter: 4 as const };
  const nc = `<p>Unconsolidated Results for FY2026 (April 1, 2025 through March 31, 2026)</p><table>${tr('', 'Net revenues', 'Basic EPS')}${tr('', 'Million yen', 'Yen')}${tr('Fiscal year ended March 31, 2026', '15,000,000', '260.28')}</table>`;
  const statement = `<table>${tr('', 'Yen in millions')}${tr('', 'For the year ended March 31, 2026')}${tr('Total sales revenues', '50,684,952')}${tr('Basic earnings per share', '295.25')}</table>`;

  it('H1: an "Unaudited / Condensed Consolidated Statement(s) of …" heading reopens the group figures', () => {
    for (const h of ['Unaudited Consolidated Statement of Income', 'Unaudited Condensed Consolidated Statements of Income', 'Condensed Quarterly Consolidated Statement of Financial Position']) {
      expect(readJpRelease(`${nc}<p>${h}</p>${statement}`, Q4), h).toMatchObject({ revenue: 50_684_952_000_000, eps: 295.25, span: 'ytd', ytdMonths: 12 });
    }
  });

  it('H2: qualified headings that are not group-statement titles keep the section closed', () => {
    for (const h of ['Unaudited Consolidated subsidiaries', 'Unaudited Non-consolidated Statement of Income', 'Unaudited Consolidated Statement of Income compared with the parent', 'Preliminary Consolidated Statement of Income']) {
      expect(readJpRelease(`${nc}<p>${h}</p>${statement}`, Q4), h).toMatchObject({ revenue: null, eps: null });
    }
  });

  it('H3 (e1): "(Parent Company)" / an entity in parentheses keeps the section closed; "Parent Company" opens one', () => {
    for (const h of ['Unaudited Consolidated Statement of Income (Parent Company)', 'Condensed Consolidated Statements of Income (Toyota Motor Corporation)', 'Consolidated Statement of Income (Parent Company)', 'Interim Consolidated Statement of Income [Toyota Financial Services]']) {
      expect(readJpRelease(`${nc}<p>${h}</p>${statement}`, Q4), h).toMatchObject({ revenue: null, eps: null });
    }
    // Group statements first, then a "Parent Company" heading: the tables after it are the parent's.
    const parent = `<p>Consolidated Statement of Income</p>${statement}<p>Statement of Income (Parent Company)</p>` +
      `<table>${tr('', 'Yen in millions')}${tr('', 'For the year ended March 31, 2026')}${tr('Total sales revenues', '15,684,952')}${tr('Basic earnings per share', '195.25')}</table>`;
    expect(readJpRelease(parent, Q4)).toMatchObject({ revenue: 50_684_952_000_000, eps: 295.25 });
  });

  it('H4 (probe4): "attributable to owners of the parent (company)" is IFRS wording, not a parent-only marker', () => {
    for (const h of ['Earnings per share attributable to owners of the parent company:', 'Earnings per share attributable to owners of the parent:']) {
      const html = `<p>Consolidated Statement of Income</p><table>${tr('', 'Yen in millions')}${tr('', 'For the year ended March 31, 2026')}${tr('Revenue', '15,684,952')}${tr(h)}${tr('Basic', '195.25')}${tr('Diluted', '195.20')}</table>`;
      expect(readJpRelease(html, Q4), h).toMatchObject({ revenue: 15_684_952_000_000, eps: 195.25, epsDiluted: 195.2 });
      // The same words between tables do not open a parent-only section either.
      expect(readJpRelease(`<p>Net income attributable to owners of the parent company increased.</p>${statement}`, Q4)).toMatchObject({ revenue: 50_684_952_000_000, eps: 295.25 });
    }
  });

  it('Toyota FY2026: statements after the unconsolidated summary are read', () => {
    expect(six('TM_2026-03-31.htm', '2026-03-31', 4)).toEqual({ revenue: 50_684_952_000_000, eps: 295.25, epsDiluted: 295.25, currency: 'JPY', span: 'ytd', ytdMonths: 12 });
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
