import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readHkRelease } from '../../src/hk/sources/releaseHk.js';
import { HK_UNIVERSE } from '../../src/hk/universe.js';
import { readRelease, readUsRelease } from '../../src/sources/releaseReader.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/hk/${n}`, import.meta.url), 'utf8');
const Q3 = { periodEnd: '2026-09-30', kind: 'Q' as const };

/** An Alibaba-style table: a period row, a year row, then a currency row (RMB | RMB | US$). */
const rmbUsd = (rows: string, caption = '<p>(in millions)</p>') => `${caption}
<table>
  <tr><td></td><td colspan="6">Three months ended September 30,</td></tr>
  <tr><td></td><td colspan="2">2025</td><td colspan="4">2026</td></tr>
  <tr><td></td><td colspan="2">RMB</td><td colspan="2">RMB</td><td colspan="2">US$</td></tr>
  ${rows}
</table>`;
const row = (label: string, ...v: string[]) => `<tr><td>${label}</td>${v.map((x) => `<td></td><td>${x}</td>`).join('')}</tr>`;

describe('readHkRelease', () => {
  it('RMB and US$ columns: only RMB is read', () => {
    const html = rmbUsd(row('Revenue', '236,503', '247,652', '34,786') + row('Diluted earnings per share', '1.02', '1.10', '0.15'));
    const v = readHkRelease(html, Q3);
    expect(v).toMatchObject({ revenue: 247_652_000_000, revenueCurrency: 'CNY', eps: 1.1, epsCurrency: 'CNY', epsBasis: 'share' });
  });

  it('per ordinary share preferred over per ADS', () => {
    const html = rmbUsd(row('Diluted earnings per share', '1.02', '1.10', '0.15') + row('Diluted earnings per ADS', '8.16', '8.80', '1.21'));
    expect(readHkRelease(html, Q3)).toMatchObject({ eps: 1.1, epsBasis: 'share', epsCurrency: 'CNY' });
  });

  it('only per ADS stated → ads basis', () => {
    const html = rmbUsd(row('Diluted earnings per ADS', '8.16', '8.80', '1.21'));
    expect(readHkRelease(html, Q3)).toMatchObject({ eps: 8.8, epsBasis: 'ads', epsCurrency: 'CNY' });
  });

  it('per Class A ordinary share counts as per share; a combined "share/ADS" row does not', () => {
    const a = rmbUsd(row('Net income per Class A ordinary share — diluted', '1.02', '1.10', '0.15'));
    expect(readHkRelease(a, Q3)).toMatchObject({ eps: 1.1, epsBasis: 'share' });
    const b = rmbUsd(row('Diluted earnings per share/ADS', '1.02', '1.10', '0.15'));
    expect(readHkRelease(b, Q3)).toMatchObject({ eps: null, epsBasis: null, epsCurrency: null });
  });

  it('half-year: six months ended June 30 column read, quarter column ignored', () => {
    const html = `<p>(RMB in millions, except per share data)</p>
    <table>
      <tr><td></td><td colspan="2">Three months ended June 30, 2026</td><td colspan="2">Six months ended June 30, 2026</td></tr>
      <tr><td></td><td colspan="2">RMB</td><td colspan="2">RMB</td></tr>
      ${row('Total revenues', '5,000', '9,800')}
      ${row('Diluted earnings per share', '0.50', '0.95')}
    </table>`;
    const v = readHkRelease(html, { periodEnd: '2026-06-30', kind: 'H' });
    expect(v).toMatchObject({ revenue: 9_800_000_000, revenueCurrency: 'CNY', eps: 0.95, epsBasis: 'share' });
    // The same table read for the quarter takes the three-month column.
    expect(readHkRelease(html, { periodEnd: '2026-06-30', kind: 'Q' })).toMatchObject({ revenue: 5_000_000_000, eps: 0.5 });
  });

  it('quarter expected: six- and nine-month columns never read', () => {
    const html = `<p>(in millions of RMB, except per share data)</p>
    <table>
      <tr><td></td><td colspan="2">Six months ended September 30, 2026</td><td colspan="2">Nine months ended September 30, 2026</td></tr>
      <tr><td></td><td colspan="2">RMB</td><td colspan="2">RMB</td></tr>
      ${row('Revenues', '9,800', '14,900')}
      ${row('Diluted earnings per share', '0.95', '1.40')}
    </table>`;
    const v = readHkRelease(html, Q3);
    expect(v).toMatchObject({ revenue: null, eps: null, epsBasis: null });
    // ... nor for a half-year whose period end is September 30 (the nine-month column is year-to-date).
    expect(readHkRelease(html, { periodEnd: '2026-09-30', kind: 'H' })).toMatchObject({ revenue: 9_800_000_000, eps: 0.95 });
  });

  it('half-year: a "1H 2026" / "interim" header with that year is accepted; another year is not', () => {
    const t = (h: string) => `<p>(HK$ in millions, except per share amounts)</p>
    <table>
      <tr><td></td><td colspan="2">${h}</td></tr>
      <tr><td></td><td colspan="2">HK$</td></tr>
      ${row('Revenue', '12,345')}
      ${row('Diluted earnings per share', '1.23')}
    </table>`;
    const H = { periodEnd: '2026-06-30', kind: 'H' as const };
    expect(readHkRelease(t('1H 2026'), H)).toMatchObject({ revenue: 12_345_000_000, revenueCurrency: 'HKD', eps: 1.23, epsCurrency: 'HKD' });
    expect(readHkRelease(t('Interim 2026'), H)).toMatchObject({ eps: 1.23 });
    expect(readHkRelease(t('1H 2025'), H)).toMatchObject({ revenue: null, eps: null });
  });

  it('full year: only the year ended period-end column', () => {
    const html = `<p>(in millions of RMB, except per share data)</p>
    <table>
      <tr><td></td><td colspan="2">Three months ended December 31, 2026</td><td colspan="2">Year ended December 31, 2026</td></tr>
      <tr><td></td><td colspan="2">RMB</td><td colspan="2">RMB</td></tr>
      ${row('Revenues', '5,100', '19,900')}
      ${row('Diluted earnings per share', '0.48', '1.88')}
    </table>`;
    expect(readHkRelease(html, { periodEnd: '2026-12-31', kind: 'FY' })).toMatchObject({ revenue: 19_900_000_000, eps: 1.88 });
  });

  it('non-GAAP row never replaces GAAP', () => {
    const both = rmbUsd(row('Non-GAAP diluted earnings per share', '1.84', '1.07', '0.16') + row('Diluted earnings per share', '2.25', '0.46', '0.07'));
    expect(readHkRelease(both, Q3)).toMatchObject({ eps: 0.46, epsBasis: 'share' });
    const onlyAdj = rmbUsd(row('Non-GAAP diluted earnings per share', '1.84', '1.07', '0.16') + row('Adjusted diluted earnings per ADS', '14.75', '8.52', '1.26'));
    expect(readHkRelease(onlyAdj, Q3)).toMatchObject({ eps: null, epsBasis: null });
  });

  it('$m table in USD (HSBC style)', () => {
    const html = `<p>Consolidated income statement</p>
    <table>
      <tr><td></td><td colspan="2">Half-year to</td></tr>
      <tr><td></td><td>30 Jun 2026</td><td>30 Jun 2025</td></tr>
      <tr><td></td><td>$m</td><td>$m</td></tr>
      <tr><td>Revenue 1,2</td><td>37,742</td><td>34,122</td></tr>
      <tr><td>Profit after tax</td><td>15,321</td><td>12,441</td></tr>
      <tr><td></td><td>$</td><td>$</td></tr>
      <tr><td>Basic earnings per ordinary share</td><td>0.85</td><td>0.65</td></tr>
      <tr><td>Diluted earnings per ordinary share</td><td>0.84</td><td>0.65</td></tr>
    </table>`;
    expect(readHkRelease(html, { periodEnd: '2026-06-30', kind: 'H' })).toEqual({
      revenue: 37_742_000_000, revenueCurrency: 'USD', eps: 0.84, epsCurrency: 'USD', epsBasis: 'share', notes: [],
    });
  });

  it('a "Highlights" $m table: reported revenue read, constant-currency and notable-item sections skipped', () => {
    const html = `<table>
      <tr><td></td><td colspan="2">Half-year to</td></tr>
      <tr><td></td><td>30 Jun 2026</td><td>30 Jun 2025</td></tr>
      <tr><td></td><td>$m</td><td>$m</td></tr>
      <tr><td>Reported</td></tr>
      <tr><td>Revenue 1,2</td><td>37,742</td><td>34,122</td></tr>
      <tr><td>Constant currency 3</td></tr>
      <tr><td>Revenue 1,2</td><td>37,700</td><td>34,812</td></tr>
    </table>`;
    expect(readHkRelease(html, { periodEnd: '2026-06-30', kind: 'H' })).toMatchObject({ revenue: 37_742_000_000, revenueCurrency: 'USD' });
  });

  it('no unit stated → revenue null', () => {
    const html = rmbUsd(row('Revenue', '236,503', '247,652', '34,786') + row('Diluted earnings per share', '1.02', '1.10', '0.15'), '<p>Unaudited income statement</p>');
    const v = readHkRelease(html, Q3);
    expect(v).toMatchObject({ revenue: null, revenueCurrency: null, eps: 1.1, epsCurrency: 'CNY' });
    expect(v.notes.join(' ')).toMatch(/no unit/);
  });

  it('per-share rows stated but disagreeing → eps null, never the agreeing per-ADS figure', () => {
    const html = rmbUsd(row('Diluted earnings per share', '1.02', '1.10', '0.15') + row('Diluted earnings per ADS', '8.16', '8.80', '1.21'))
      + rmbUsd(row('Diluted earnings per share', '1.02', '1.12', '0.15') + row('Diluted earnings per ADS', '8.16', '8.80', '1.21'));
    const v = readHkRelease(html, Q3);
    expect(v).toMatchObject({ eps: null, epsBasis: null, epsCurrency: null });
    expect(v.notes.join(' ')).toMatch(/epsGaap: candidates disagree/);
  });

  it('values whose candidates disagree are null', () => {
    const html = rmbUsd(row('Diluted earnings per share', '1.02', '1.10', '0.15')) + rmbUsd(row('Diluted earnings per share', '1.02', '1.12', '0.15'));
    const v = readHkRelease(html, Q3);
    expect(v).toMatchObject({ eps: null, epsBasis: null });
    expect(v.notes.join(' ')).toMatch(/disagree/);
  });

  it('no currency stated anywhere → nothing read', () => {
    const html = `<p>(in millions)</p><table>
      <tr><td></td><td>Three months ended September 30, 2026</td></tr>
      <tr><td>Revenue</td><td>1,000</td></tr>
      <tr><td>Diluted earnings per share</td><td>1.10</td></tr>
    </table>`;
    // Plain "$" means US$ only when stated; bare numbers carry no currency.
    expect(readHkRelease(html, Q3)).toMatchObject({ revenue: null, eps: null, revenueCurrency: null, epsCurrency: null });
  });

  it('plain "$" is US$ when the caption says US dollars, even if another table names RMB', () => {
    const fxTable = `<p>Exchange rates</p><table><tr><td>RMB per US$1.00</td><td>7.1</td></tr></table>`;
    const stmt = (caption: string) => `<p>${caption}</p><table>
      <tr><td></td><td colspan="2">Three months ended September 30, 2026</td></tr>
      <tr><td></td><td colspan="2">$</td></tr>
      <tr><td>Total revenues</td><td></td><td>1,000</td></tr>
      <tr><td>Diluted earnings per ADS</td><td></td><td>0.88</td></tr>
    </table>`;
    expect(readHkRelease(fxTable + stmt('(in millions of US dollars, except per ADS data)'), Q3)).toMatchObject({
      revenue: 1_000_000_000, revenueCurrency: 'USD', eps: 0.88, epsCurrency: 'USD', epsBasis: 'ads',
    });
    expect(readHkRelease(fxTable + stmt('(in millions, except per ADS data)'), Q3)).toMatchObject({ revenue: null, eps: null });
    // With no other currency named anywhere, a plain "$" is US$.
    expect(readHkRelease(stmt('(in millions, except per ADS data)'), Q3)).toMatchObject({ revenue: 1_000_000_000, revenueCurrency: 'USD', eps: 0.88 });
  });

  it('Alibaba June-quarter 6-K (real EX-99.1): RMB column, per share', () => {
    expect(readHkRelease(fx('baba_results_ex99.htm'), { periodEnd: '2026-06-30', kind: 'Q' })).toMatchObject({
      revenue: 268_953_000_000, revenueCurrency: 'CNY', eps: 0.46, epsCurrency: 'CNY', epsBasis: 'share',
    });
    // Read for the wrong period, nothing is read.
    expect(readHkRelease(fx('baba_results_ex99.htm'), { periodEnd: '2026-06-30', kind: 'H' })).toMatchObject({ revenue: null, eps: null });
  });

  it('Alibaba September-quarter release (real EX-99.1): three- and six-month columns side by side', () => {
    // Fixture: SEC 0001104659-25-115949 EX-99.1. Income statement: Three months ended September 30 | Six months ended
    // September 30, each 2024 RMB | 2025 RMB | 2025 US$.
    const html = fx('baba_sep2025_results_ex99.htm');
    expect(readHkRelease(html, { periodEnd: '2025-09-30', kind: 'Q' })).toMatchObject({
      revenue: 247_795_000_000, revenueCurrency: 'CNY', eps: 1.09, epsCurrency: 'CNY', epsBasis: 'share',
    });
    expect(readHkRelease(html, { periodEnd: '2025-09-30', kind: 'H' })).toMatchObject({
      revenue: 495_447_000_000, revenueCurrency: 'CNY', eps: 3.34, epsCurrency: 'CNY', epsBasis: 'share',
    });
    // The US$ convenience column is there, but never read under RMB.
    const usd = readRelease(html, { periodEnd: '2025-09-30', span: 'quarter', profile: 'hk', currency: 'USD' });
    expect(usd).toMatchObject({ revenue: 34_808_000_000, epsShare: 0.15, epsAds: 1.23 });
  });

  it('Alibaba March-quarter release (real EX-99.1): quarter vs fiscal year ended March 31', () => {
    // Fixture: SEC 0001104659-26-060224 EX-99.1. Three months ended March 31 | Year ended March 31.
    const html = fx('baba_mar2026_results_ex99.htm');
    expect(readHkRelease(html, { periodEnd: '2026-03-31', kind: 'Q' })).toMatchObject({ revenue: 243_380_000_000, eps: 1.3, epsBasis: 'share' });
    expect(readHkRelease(html, { periodEnd: '2026-03-31', kind: 'FY' })).toMatchObject({
      revenue: 1_023_670_000_000, revenueCurrency: 'CNY', eps: 5.5, epsCurrency: 'CNY', epsBasis: 'share',
    });
    expect(readHkRelease(html, { periodEnd: '2026-03-31', kind: 'H' })).toMatchObject({ revenue: null, eps: null });
  });

  it('HSBC interim 6-K (real document): US$ $m revenue and diluted EPS per ordinary share', () => {
    expect(readHkRelease(fx('hsbc_interim_6k.htm'), { periodEnd: '2026-06-30', kind: 'H' })).toMatchObject({
      revenue: 37_742_000_000, revenueCurrency: 'USD', eps: 0.85, epsCurrency: 'USD', epsBasis: 'share',
    });
  });

  it('date notices read nothing', () => {
    for (const f of ['tme_date_notice_ex99.htm', 'tcom_date_notice_ex99.htm', 'baba_board_meeting_ex99.htm']) {
      expect(readHkRelease(fx(f), Q3), f).toMatchObject({ revenue: null, eps: null });
    }
  });
});

describe('readHkRelease: currency, unit and basis stated outside a plain currency row', () => {
  const Q2 = { periodEnd: '2026-06-30', kind: 'Q' as const };

  it('currency inside a multi-line date header cell ("June 30, 2026 / RMB (million)"), with a row-spanning label cell', () => {
    // Trip.com layout: the label cell spans the header rows (rowspan), so the date cells start one column left.
    const head = (h: string) => `<td colspan="2">${h}</td><td></td><td></td>`;
    const data = (label: string, ...v: string[]) => `<tr><td>${label}</td><td></td>${v.map((x) => `<td></td><td>${x}</td><td></td><td></td>`).join('')}</tr>`;
    const html = `<p>Statements of Income (In millions, except share and per share data)</p>
    <table>
      <tr><td rowspan="3">&nbsp;</td><td></td><td colspan="12">Three Months Ended</td><td colspan="4">Six Months Ended</td></tr>
      <tr><td></td>${head('June 30, 2025<br>RMB (million)')}${head('June 30, 2026<br>RMB (million)')}${head('June 30, 2026<br>USD (million)')}${head('June 30, 2026<br>RMB (million)')}</tr>
      <tr><td>&nbsp;</td></tr>
      ${data('Total net revenues', '14,000', '15,663', '2,300', '31,871')}
      ${data('Earnings per ordinary share - Diluted', '2.00', '(3.89)', '(0.57)', '(0.22)')}
    </table>`;
    expect(readHkRelease(html, Q2)).toMatchObject({ revenue: 15_663_000_000, revenueCurrency: 'CNY', eps: -3.89, epsCurrency: 'CNY', epsBasis: 'share' });
  });

  it('a currency row with footnote marks ("US$ (2)") still names the currencies', () => {
    const html = `<p>(In millions except for per share (or ADS) information, unaudited)</p>
    <table>
      <tr><td></td><td colspan="6">Three Months Ended</td></tr>
      <tr><td></td><td colspan="2">June 30, 2025</td><td colspan="2">June 30, 2026</td><td colspan="2">June 30, 2026</td></tr>
      <tr><td></td><td colspan="2">RMB</td><td colspan="2">RMB</td><td colspan="2">US$ (2)</td></tr>
      ${row('Revenue', '32,713', '31,325', '4,617')}
      ${row('Diluted earnings per share', '0.80', '0.72', '0.11')}
    </table>`;
    expect(readHkRelease(html, Q2)).toMatchObject({ revenue: 31_325_000_000, revenueCurrency: 'CNY', eps: 0.72, epsCurrency: 'CNY' });
  });

  it('currency and unit stated only in the caption ("Amounts in thousands of U.S. dollars")', () => {
    const html = `<p>Condensed Consolidated Statements of Operations (Amounts in thousands of U.S. dollars, except for share and per share amounts)</p>
    <table>
      <tr><td></td><td colspan="4">Three Months Ended June 30,</td></tr>
      <tr><td></td><td colspan="2">2026</td><td colspan="2">2025</td></tr>
      ${row('Total revenues', '1,705,071', '1,315,485')}
      ${row('Earnings per share - Diluted', '0.16', '0.07')}
    </table>`;
    expect(readHkRelease(html, Q2)).toMatchObject({ revenue: 1_705_071_000, revenueCurrency: 'USD', eps: 0.16, epsCurrency: 'USD', epsBasis: 'share' });
  });

  it('"(in US$ million, except per share data)" caption and "Diluted Earnings Per Common Share"', () => {
    const html = `<p>Condensed Consolidated Statements of Income (in US$ million, except per share data) (unaudited)</p>
    <table>
      <tr><td></td><td colspan="4">Quarter Ended</td></tr>
      <tr><td></td><td colspan="2">6/30/2026</td><td colspan="2">6/30/2025</td></tr>
      <tr><td>Total revenues</td><td>$</td><td>3,271</td><td>$</td><td>2,981</td></tr>
      <tr><td>Diluted Earnings Per Common Share</td><td>$</td><td>0.87</td><td>$</td><td>0.77</td></tr>
    </table>`;
    expect(readHkRelease(html, Q2)).toMatchObject({ revenue: 3_271_000_000, revenueCurrency: 'USD', eps: 0.87, epsCurrency: 'USD', epsBasis: 'share' });
  });

  it('a caption that names two currencies leaves an unmarked column blank', () => {
    const html = `<p>Statements of Operations (in thousands of RMB and US$, except per share data)</p>
    <table>
      <tr><td></td><td colspan="2">Three Months Ended June 30, 2026</td></tr>
      ${row('Total revenues', '1,705,071')}
      ${row('Diluted earnings per share', '0.16')}
    </table>`;
    expect(readHkRelease(html, Q2)).toMatchObject({ revenue: null, eps: null, revenueCurrency: null, epsCurrency: null });
  });

  it('combined "per share/ADS" row: per share only when one ADS is one share', () => {
    const html = rmbUsd(row('Net loss per share/ADS attributable to ordinary shareholders - Basic and diluted', '(0.40)', '(0.29)', '(0.04)'));
    expect(readHkRelease(html, Q3, { adrRatio: 1 })).toMatchObject({ eps: -0.29, epsBasis: 'share', epsCurrency: 'CNY' });
    expect(readHkRelease(html, Q3, { adrRatio: 2 })).toMatchObject({ eps: null, epsBasis: null, epsCurrency: null });
    expect(readHkRelease(html, Q3, { adrRatio: null })).toMatchObject({ eps: null, epsBasis: null });
    expect(readHkRelease(html, Q3)).toMatchObject({ eps: null, epsBasis: null });
    const ordinary = rmbUsd(row('Net (loss)/profit per ordinary share/ADS - Diluted', '(0.40)', '(0.20)', '(0.03)'));
    expect(readHkRelease(ordinary, Q3, { adrRatio: 1 })).toMatchObject({ eps: -0.2, epsBasis: 'share' });
  });

  it('a row label naming another currency than its column header is never read (NIO reconciliation rows)', () => {
    const html = `<p>Reconciliation of GAAP and Non-GAAP Results (All amounts in thousands, except for per share/ADS data)</p>
    <table>
      <tr><td></td><td colspan="2">Three Months Ended September 30, 2026</td></tr>
      <tr><td></td><td colspan="2">GAAP Result</td></tr>
      <tr><td></td><td colspan="2">RMB</td></tr>
      ${row('Net loss per share/ADS attributable to ordinary shareholders, basic and diluted (RMB)', '(0.20)')}
      ${row('Net loss per share/ADS attributable to ordinary shareholders, basic and diluted (USD)', '(0.03)')}
    </table>`;
    expect(readHkRelease(html, Q3, { adrRatio: 1 })).toMatchObject({ eps: -0.2, epsBasis: 'share', epsCurrency: 'CNY' });
  });

  it('revenue from an income statement whose per-share lines continue in the next table', () => {
    const head = `<tr><td></td><td colspan="4">Three Months Ended</td></tr>
      <tr><td></td><td colspan="2">June 30, 2026</td><td colspan="2">June 30, 2026</td></tr>
      <tr><td></td><td colspan="2">RMB</td><td colspan="2">US$</td></tr>`;
    const html = `<p>XYZ INC. UNAUDITED CONDENSED CONSOLIDATED STATEMENTS OF COMPREHENSIVE LOSS (All amounts in thousands, except for per share data)</p>
    <table>${head}${row('Total revenues', '19,743,593', '2,756,123')}${row('Net loss', '(1,300,000)', '(180,000)')}</table>
    <p>XYZ INC. UNAUDITED CONDENSED CONSOLIDATED STATEMENTS OF COMPREHENSIVE LOSS (CONTINUED) (All amounts in thousands, except for per share data)</p>
    <table>${head}${row('Net loss per ordinary share - Diluted', '(0.70)', '(0.10)')}</table>`;
    expect(readHkRelease(html, Q2)).toMatchObject({ revenue: 19_743_593_000, revenueCurrency: 'CNY', eps: -0.7 });
    // A key-figures table (no statement caption, no per-share line) is still never read for revenue.
    const kpi = `<p>Key Financial Results (in RMB billions)</p><table>${head}${row('Total revenues', '19.74', '2.76')}</table>`;
    expect(readHkRelease(kpi, Q2)).toMatchObject({ revenue: null });
  });
});

describe('6-K corpus (test/fixtures/hk/releases): every hand-checked release is read exactly', () => {
  const dir = new URL('../fixtures/hk/releases/', import.meta.url);
  const expected: Record<string, { adr: string; periodEnd: string; kind: 'Q' | 'H' | 'FY'; checked: boolean } & Record<string, unknown>> =
    JSON.parse(readFileSync(new URL('expected.json', dir), 'utf8'));
  for (const [file, e] of Object.entries(expected).filter(([, x]) => x.checked)) {
    it(file, () => {
      const adrRatio = HK_UNIVERSE.find((u) => u.adr === e.adr)?.adrRatio ?? null;
      const got = readHkRelease(readFileSync(new URL(file, dir), 'utf8'), { periodEnd: e.periodEnd, kind: e.kind }, { adrRatio });
      const pick = (o: Record<string, unknown>) => ({ eps: o.eps, epsBasis: o.epsBasis, epsCurrency: o.epsCurrency, revenue: o.revenue, revenueCurrency: o.revenueCurrency });
      expect(pick(got as unknown as Record<string, unknown>)).toEqual(pick(e));
    });
  }
});

describe('readRelease', () => {
  it('US reader unchanged: output over the whole US corpus equals the pre-refactor snapshot', () => {
    // reader-output.json was written by readUsRelease before readRelease existed (all fields, notes included).
    const dir = new URL('../fixtures/us/releases/', import.meta.url);
    const expected: Record<string, { quarterEnd: string }> = JSON.parse(readFileSync(new URL('expected.json', dir), 'utf8'));
    const snapshot: Record<string, unknown> = JSON.parse(readFileSync(new URL('reader-output.json', dir), 'utf8'));
    const files = readdirSync(dir).filter((x) => x.endsWith('.htm')).sort();
    expect(Object.keys(snapshot).sort()).toEqual(files);
    for (const f of files) {
      const html = readFileSync(new URL(f, dir), 'utf8');
      const qe = expected[f]!.quarterEnd;
      expect(readUsRelease(html, qe), f).toEqual(snapshot[f]);
      const r = readRelease(html, { periodEnd: qe, span: 'quarter', profile: 'us' });
      expect(r.epsAds, f).toBeNull();
      expect(r.epsShare, f).toBe(r.epsGaap);
    }
  });
});
