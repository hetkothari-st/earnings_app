import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readHkRelease } from '../../src/hk/sources/releaseHk.js';
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
