import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { europeFiscalQuarter, readEuropeRelease, type EuropeReleaseValues } from '../../src/europe/sources/releaseEurope.js';
import { EU_FULL, UK_FULL, europeIssuerFor } from '../../src/europe/universe.js';
import { EUROPE_BANK_TICKERS } from '../../src/sources/releaseReader.js';

/** A release body: an optional caption paragraph, then a table of header rows and data rows. */
const table = (caption: string, head: string[][], rows: string[][]) =>
  `${caption ? `<p>${caption}</p>` : ''}<table>${[...head, ...rows].map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
const doc = (...tables: string[]) => `<html><body><p>Results announcement</p>${tables.join('<p>Notes follow.</p>')}</body></html>`;

const Q3 = { periodEnd: '2026-09-30', fiscalQuarter: 3 as const, profile: 'uk' as const };
const H1 = { periodEnd: '2026-06-30', fiscalQuarter: 2 as const, profile: 'uk' as const };
const FY = { periodEnd: '2026-12-31', fiscalQuarter: 4 as const, profile: 'uk' as const };

const pick = (v: EuropeReleaseValues) => {
  const { notes: _notes, ...rest } = v;
  return rest;
};

describe('readEuropeRelease — inline tables', () => {
  it('UK pence EPS: Basic earnings per share (pence) 12.3 → eps 12.3 GBp, revenue £m → GBP', () => {
    const html = doc(table('', [['£m', 'Q3 2026', 'Q3 2025']], [
      ['Revenue', '1,234', '1,100'],
      ['Operating profit', '300', '250'],
      ['Basic earnings per share (pence)', '12.3', '10.1'],
      ['Diluted earnings per share (pence)', '12.1', '10.0'],
    ]));
    expect(pick(readEuropeRelease(html, Q3))).toEqual({
      revenue: 1_234_000_000, revenueCurrency: 'GBP', eps: 12.3, epsDiluted: 12.1, epsCurrency: 'GBp', span: 'quarter', ytdMonths: null,
    });
    // "12.3p" figures and a "(p)" label say the same: pence, never divided by 100.
    const signed = doc(table('', [['£m', 'Q3 2026', 'Q3 2025']], [['Revenue', '1,234', '1,100'], ['Basic EPS (p)', '12.3p', '10.1p']]));
    const v = readEuropeRelease(signed, Q3);
    expect([v.eps, v.epsCurrency]).toEqual([12.3, 'GBp']);
  });

  it('£ EPS stays GBP', () => {
    const html = doc(table('', [['£m', 'Q3 2026', 'Q3 2025']], [['Revenue', '1,234', '1,100'], ['Basic earnings per share (£)', '1.23', '1.01']]));
    const v = readEuropeRelease(html, Q3);
    expect([v.eps, v.epsCurrency]).toEqual([1.23, 'GBP']);
    const signed = doc(table('', [['£m', 'Q3 2026', 'Q3 2025']], [['Revenue', '1,234', '1,100'], ['Basic earnings per share', '£1.23', '£1.01']]));
    expect([readEuropeRelease(signed, Q3).eps, readEuropeRelease(signed, Q3).epsCurrency]).toEqual([1.23, 'GBP']);
  });

  it('H1 only → ytd 6; Q2 column present → quarter', () => {
    const h1Only = doc(table('', [['£m', 'H1 2026', 'H1 2025']], [['Revenue', '2,000', '1,900'], ['Basic EPS (p)', '20.5', '19.0']]));
    expect(pick(readEuropeRelease(h1Only, H1))).toEqual({
      revenue: 2_000_000_000, revenueCurrency: 'GBP', eps: 20.5, epsDiluted: null, epsCurrency: 'GBp', span: 'ytd', ytdMonths: 6,
    });
    const sixMonths = doc(table('', [['£m', 'Six months ended 30 June 2026', 'Six months ended 30 June 2025']], [['Revenue', '2,000', '1,900'], ['Basic EPS (p)', '20.5', '19.0']]));
    expect([readEuropeRelease(sixMonths, H1).span, readEuropeRelease(sixMonths, H1).ytdMonths, readEuropeRelease(sixMonths, H1).revenue]).toEqual(['ytd', 6, 2_000_000_000]);
    const withQ2 = doc(table('', [['£m', 'Q2 2026', 'Q2 2025', 'H1 2026', 'H1 2025']], [
      ['Revenue', '1,100', '1,000', '2,000', '1,900'],
      ['Basic EPS (p)', '11.2', '10.0', '20.5', '19.0'],
    ]));
    expect(pick(readEuropeRelease(withQ2, H1))).toEqual({
      revenue: 1_100_000_000, revenueCurrency: 'GBP', eps: 11.2, epsDiluted: null, epsCurrency: 'GBp', span: 'quarter', ytdMonths: null,
    });
  });

  it('quarter header forms: Three months ended <date>, 3Q 2026, July–September 2026; the comparative year is never read', () => {
    for (const [now, prior] of [['Three months ended 30 September 2026', 'Three months ended 30 September 2025'], ['3Q 2026', '3Q 2025'], ['July–September 2026', 'July–September 2025'], ['Q3 26', 'Q3 25']]) {
      const html = doc(table('', [['£m', now!, prior!]], [['Revenue', '1,234', '1,100'], ['Basic EPS (p)', '12.3', '10.1']]));
      expect([readEuropeRelease(html, Q3).revenue, readEuropeRelease(html, Q3).eps]).toEqual([1_234_000_000, 12.3]);
    }
    const priorOnly = doc(table('', [['£m', 'Q3 2025']], [['Revenue', '1,100'], ['Basic EPS (p)', '10.1']]));
    expect(pick(readEuropeRelease(priorOnly, Q3))).toEqual({ revenue: null, revenueCurrency: null, eps: null, epsDiluted: null, epsCurrency: null, span: null, ytdMonths: null });
  });

  it('underlying/adjusted/core EPS never read; statutory basic read', () => {
    const html = doc(table('', [['£m', 'Q3 2026', 'Q3 2025']], [
      ['Revenue', '1,234', '1,100'],
      ['Underlying basic EPS (p)', '30.1', '28.0'],
      ['Adjusted basic earnings per share (p)', '29.0', '27.0'],
      ['Core basic EPS (p)', '28.0', '26.0'],
      ['Headline basic earnings per share (p)', '27.5', '25.0'],
      ['Statutory basic EPS (p)', '12.5', '11.0'],
      ['Diluted earnings per ADS ($)', '1.50', '1.30'],
    ]));
    const v = readEuropeRelease(html, Q3);
    expect([v.eps, v.epsDiluted, v.epsCurrency]).toEqual([12.5, null, 'GBp']);
    const adjustedOnly = doc(table('', [['£m', 'Q3 2026', 'Q3 2025']], [['Revenue', '1,234', '1,100'], ['Adjusted basic EPS (p)', '29.0', '27.0']]));
    expect(readEuropeRelease(adjustedOnly, Q3).eps).toBeNull();
  });

  it('bank: total income read, net interest income never', () => {
    const bank = { names: ['Barclays PLC'], ticker: 'BCS' };
    const html = doc(table('', [['£m', 'Q3 2026', 'Q3 2025']], [
      ['Net interest income', '3,000', '2,800'],
      ['Total income', '7,000', '6,500'],
      ['Profit before tax', '2,000', '1,800'],
      ['Basic earnings per share (p)', '10.5', '9.0'],
    ]));
    expect(readEuropeRelease(html, { ...Q3, issuer: bank }).revenue).toBe(7_000_000_000);
    // "Total income" is a bank's top line only: for another issuer it is not revenue.
    expect(readEuropeRelease(html, { ...Q3, issuer: { names: ['AstraZeneca PLC'], ticker: 'AZN' } }).revenue).toBeNull();
    const niiOnly = doc(table('', [['£m', 'Q3 2026', 'Q3 2025']], [['Net interest income', '3,000', '2,800'], ['Basic earnings per share (p)', '10.5', '9.0']]));
    expect(readEuropeRelease(niiOnly, { ...Q3, issuer: bank }).revenue).toBeNull();
  });

  it('US$ convenience column skipped in a € table; two currencies left → null', () => {
    const html = doc(table('(in millions of euros)', [['', 'Q3 2026', 'Q3 2025', 'Q3 2026'], ['', '€m', '€m', 'US$m']], [
      ['Revenue', '5,000', '4,800', '5,800'],
      ['Basic earnings per share (€)', '1.25', '1.10', '1.45'],
    ]));
    const v = readEuropeRelease(html, { ...Q3, profile: 'eu' });
    expect([v.revenue, v.revenueCurrency, v.eps, v.epsCurrency]).toEqual([5_000_000_000, 'EUR', 1.25, 'EUR']);
    const twoLeft = doc(table('', [['', 'Q3 2026', 'Q3 2026'], ['', '€m', 'US$m']], [['Revenue', '5,000', '5,800'], ['Basic earnings per share', '€1.25', '$1.45']]));
    const w = readEuropeRelease(twoLeft, { ...Q3, profile: 'eu' });
    expect([w.revenue, w.revenueCurrency, w.eps, w.epsCurrency]).toEqual([null, null, null, null]);
  });

  it('Q4 row reads FY column, never H2', () => {
    const html = doc(table('', [['£m', 'H2 2026', 'H2 2025', 'Q4 2026', 'FY 2026', 'FY 2025']], [
      ['Revenue', '1,500', '1,400', '800', '3,000', '2,800'],
      ['Basic EPS (p)', '15.0', '14.0', '8.0', '30.0', '28.0'],
    ]));
    expect(pick(readEuropeRelease(html, FY))).toEqual({
      revenue: 3_000_000_000, revenueCurrency: 'GBP', eps: 30, epsDiluted: null, epsCurrency: 'GBp', span: 'ytd', ytdMonths: 12,
    });
    const yearEnded = doc(table('', [['£m', 'Year ended 31 December 2026', 'Year ended 31 December 2025']], [['Revenue', '3,000', '2,800'], ['Basic EPS (p)', '30.0', '28.0']]));
    expect([readEuropeRelease(yearEnded, FY).revenue, readEuropeRelease(yearEnded, FY).ytdMonths]).toEqual([3_000_000_000, 12]);
    const h2Only = doc(table('', [['£m', 'H2 2026', 'Second half 2025', 'Q4 2026']], [['Revenue', '1,500', '1,400', '800'], ['Basic EPS (p)', '15.0', '14.0', '8.0']]));
    expect(pick(readEuropeRelease(h2Only, FY))).toEqual({ revenue: null, revenueCurrency: null, eps: null, epsDiluted: null, epsCurrency: null, span: null, ytdMonths: null });
  });

  it('trading update with revenue only → eps null', () => {
    const html = doc(table('', [['£m', 'Q3 2026', 'Q3 2025']], [['Revenue', '1,234', '1,100']]));
    expect(pick(readEuropeRelease(html, Q3))).toEqual({
      revenue: 1_234_000_000, revenueCurrency: 'GBP', eps: null, epsDiluted: null, epsCurrency: null, span: 'quarter', ytdMonths: null,
    });
  });

  it('no unit caption → revenue null', () => {
    const html = doc(table('', [['', 'Q3 2026', 'Q3 2025']], [['Revenue', '1,234', '1,100'], ['Basic EPS (p)', '12.3', '10.1']]));
    const v = readEuropeRelease(html, Q3);
    expect([v.revenue, v.revenueCurrency, v.eps, v.epsCurrency]).toEqual([null, null, 12.3, 'GBp']);
    // Prose that mentions millions is no unit caption.
    const prose = doc(table('Sales grew to many millions of pounds in the quarter.', [['', 'Q3 2026', 'Q3 2025']], [['Revenue', '1,234', '1,100'], ['Basic EPS (p)', '12.3', '10.1']]));
    expect(readEuropeRelease(prose, Q3).revenue).toBeNull();
  });
});

describe('readEuropeRelease — SEC fixtures (values hand-read from each document)', () => {
  const fixture = (name: string) => readFileSync(new URL(`../fixtures/europe/sec/${name}`, import.meta.url), 'utf8');

  it('AZN Q1 2026 (6-K): Total Revenue $15,288m; basic $1.99, diluted $1.97 per $0.25 Ordinary Share', () => {
    const v = readEuropeRelease(fixture('azn_q1_2026_results_6k.htm'), { periodEnd: '2026-03-31', fiscalQuarter: 1, profile: 'uk', issuer: europeIssuerFor('AZN') });
    expect(pick(v)).toEqual({ revenue: 15_288_000_000, revenueCurrency: 'USD', eps: 1.99, epsDiluted: 1.97, epsCurrency: 'USD', span: 'quarter', ytdMonths: null });
  });

  it('HSBC 3Q26 (6-K): revenue (net operating income before ECL) $18,620m; basic and diluted $0.41 for the quarter', () => {
    const v = readEuropeRelease(fixture('hsbc_3q26_earnings_release_6k.htm'), { periodEnd: '2026-09-30', fiscalQuarter: 3, profile: 'uk', issuer: europeIssuerFor('HSBC') });
    expect(pick(v)).toEqual({ revenue: 18_620_000_000, revenueCurrency: 'USD', eps: 0.41, epsDiluted: 0.41, epsCurrency: 'USD', span: 'quarter', ytdMonths: null });
  });

  it('ASML Q3 2026 (6-K): total net sales €11,662m; EPS (basic; in euros) 12.95; no diluted figure stated', () => {
    const v = readEuropeRelease(fixture('asml_q3_2026_results_6k.htm'), { periodEnd: '2026-09-30', fiscalQuarter: 3, profile: 'eu', issuer: europeIssuerFor('ASML') });
    expect(pick(v)).toEqual({ revenue: 11_662_000_000, revenueCurrency: 'EUR', eps: 12.95, epsDiluted: null, epsCurrency: 'EUR', span: 'quarter', ytdMonths: null });
  });

  it('NVO H1 2026 (6-K): Q2 2026 net sales DKK 78,488m; basic DKK 4.74, diluted DKK 4.75 (the per-ADR row is not read)', () => {
    const v = readEuropeRelease(fixture('nvo_h1_2026_results_6k.htm'), { periodEnd: '2026-06-30', fiscalQuarter: 2, profile: 'eu', issuer: europeIssuerFor('NVO') });
    expect(pick(v)).toEqual({ revenue: 78_488_000_000, revenueCurrency: 'DKK', eps: 4.74, epsDiluted: 4.75, epsCurrency: 'DKK', span: 'quarter', ytdMonths: null });
  });

  it('LOGI Q2 FY27 (8-K Ex-99.1): basic $1.26, diluted $1.25; "(In thousands …)" is no allowlisted unit, so revenue stays blank', () => {
    const v = readEuropeRelease(fixture('logi_q2_fy27_8k_ex991.htm'), { periodEnd: '2026-09-30', fiscalQuarter: 2, profile: 'eu', issuer: europeIssuerFor('LOGI') });
    expect(pick(v)).toEqual({ revenue: null, revenueCurrency: null, eps: 1.26, epsDiluted: 1.25, epsCurrency: 'USD', span: 'quarter', ytdMonths: null });
  });
});

describe('readEuropeRelease — fix round 1 probes', () => {
  const EU_Q3 = { ...Q3, profile: 'eu' as const };

  it('cents EPS is converted to the major unit (/100), never read 100x: euro cents, EUR cents, US cents, US$ cents', () => {
    const t = (label: string, fig: string, head = '€m') => doc(table('', [[head, 'Q3 2026', 'Q3 2025']], [['Revenue', '5,000', '4,800'], [label, fig, '40.1']]));
    const e1 = readEuropeRelease(t('Basic earnings per share (euro cents)', '45.3'), EU_Q3);
    expect([e1.eps, e1.epsCurrency]).toEqual([0.453, 'EUR']);
    const e2 = readEuropeRelease(t('Basic EPS (EUR cents)', '45.3'), EU_Q3);
    expect([e2.eps, e2.epsCurrency]).toEqual([0.453, 'EUR']);
    const e3 = readEuropeRelease(t('Basic EPS (in euro cents)', '45.3'), EU_Q3);
    expect([e3.eps, e3.epsCurrency]).toEqual([0.453, 'EUR']);
    // BHP / RIO: "US cents".
    const bhp = readEuropeRelease(t('Basic earnings per ordinary share (US cents)', '177.7', 'US$m'), Q3);
    expect([bhp.eps, bhp.epsCurrency]).toEqual([1.777, 'USD']);
    const usd = readEuropeRelease(t('Basic earnings per share (US$ cents)', '177.7', 'US$m'), Q3);
    expect([usd.eps, usd.epsCurrency]).toEqual([1.777, 'USD']);
    // A "cents" column mark under a "($)" label: cents of US dollars.
    const mark = doc(table('', [['US$m', 'Q3 2026', 'Q3 2025'], ['', 'cents', 'cents']], [['Revenue', '5,000', '4,800'], ['Basic earnings per share ($)', '177.7', '150.0']]));
    const m = readEuropeRelease(mark, Q3);
    expect([m.eps, m.epsCurrency]).toEqual([1.777, 'USD']);
    // Bare "cents" with no currency anywhere: blank.
    expect(readEuropeRelease(t('Basic EPS (cents)', '45.3', ''), EU_Q3).eps).toBeNull();
    // Pence stay pence (GBp), never divided.
    const p = readEuropeRelease(t('Basic EPS (pence)', '12.3', '£m'), Q3);
    expect([p.eps, p.epsCurrency]).toEqual([12.3, 'GBp']);
  });

  it('the own head unit of a table beats the caption above it; two in-table units disagreeing → blank', () => {
    const thousands = doc(table('(Figures in millions of euros unless otherwise indicated)', [['€ thousands', 'Q3 2026', 'Q3 2025']], [['Revenue', '5,000,000', '4,800,000'], ['Basic EPS (€)', '1.25', '1.10']]));
    expect(readEuropeRelease(thousands, EU_Q3).revenue).toBe(5_000_000_000);
    const bn = doc(table('(in millions of euros, unless otherwise indicated)', [['€bn', 'Q3 2026', 'Q3 2025']], [['Revenue', '11.66', '10.50'], ['Basic EPS (€)', '1.25', '1.10']]));
    expect(readEuropeRelease(bn, EU_Q3).revenue).toBe(11_660_000_000);
    const conflict = doc(table('', [['€ thousands', 'Q3 2026', 'Q3 2025'], ['', '€m', '€m']], [['Revenue', '5,000', '4,800'], ['Basic EPS (€)', '1.25', '1.10']]));
    const c = readEuropeRelease(conflict, EU_Q3);
    expect([c.revenue, c.eps]).toEqual([null, 1.25]);
    // An in-table scale that names no currency ("(In thousands)") is no unit, and the caption does not stand in for it.
    const unknown = doc(table('(in millions of euros)', [['(In thousands, except per share amounts)', 'Q3 2026', 'Q3 2025']], [['Revenue', '5,000', '4,800'], ['Basic EPS (€)', '1.25', '1.10']]));
    const u = readEuropeRelease(unknown, EU_Q3);
    expect([u.revenue, u.notes.filter((n) => n === 'revenue: no unit stated for table').length]).toEqual([null, 1]);
  });

  it('net operating income: only the "before … credit losses" row, and only for banks; Santander reads total income', () => {
    const fullAdrs = new Set([...UK_FULL, ...EU_FULL].map((e) => e.adr));
    expect([...EUROPE_BANK_TICKERS].filter((t) => !fullAdrs.has(t))).toEqual([]);
    const asml = { names: ['ASML Holding N.V.'], ticker: 'ASML' };
    const nonBank = doc(table('', [['€m', 'Q3 2026', 'Q3 2025']], [['Net operating income', '800', '700'], ['Basic EPS (€)', '1.25', '1.10']]));
    expect(readEuropeRelease(nonBank, { ...EU_Q3, issuer: asml }).revenue).toBeNull();
    const nonBankBefore = doc(table('', [['€m', 'Q3 2026', 'Q3 2025']], [['Net operating income before expected credit losses', '800', '700'], ['Basic EPS (€)', '1.25', '1.10']]));
    expect(readEuropeRelease(nonBankBefore, { ...EU_Q3, issuer: asml }).revenue).toBeNull();
    const san = { names: ['Banco Santander, S.A.'], ticker: 'SAN' };
    expect(readEuropeRelease(nonBankBefore, { ...EU_Q3, issuer: san }).revenue).toBe(800_000_000);
    const both = doc(table('', [['€m', 'Q3 2026', 'Q3 2025']], [['Total income', '15,000', '14,000'], ['Net operating income', '8,000', '7,500'], ['Basic EPS (€)', '0.25', '0.22']]));
    expect(readEuropeRelease(both, { ...EU_Q3, issuer: san }).revenue).toBe(15_000_000_000);
    const plainOnly = doc(table('', [['€m', 'Q3 2026', 'Q3 2025']], [['Net operating income', '8,000', '7,500'], ['Basic EPS (€)', '0.25', '0.22']]));
    expect(readEuropeRelease(plainOnly, { ...EU_Q3, issuer: san }).revenue).toBeNull();
  });

  it('"per ordinary share of 10 pence" is the nominal value, not the EPS unit', () => {
    const html = doc(table('', [['$m', 'Q3 2026', 'Q3 2025']], [['Revenue', '5,000', '4,800'], ['Basic earnings per ordinary share of 10 pence', '$1.25', '$1.10']]));
    const v = readEuropeRelease(html, Q3);
    expect([v.eps, v.epsCurrency]).toEqual([1.25, 'USD']);
    const unsigned = doc(table('', [['$m', 'Q3 2026', 'Q3 2025']], [['Revenue', '5,000', '4,800'], ['Basic earnings per ordinary share of 10 pence', '1.25', '1.10']]));
    expect(readEuropeRelease(unsigned, Q3).eps).toBeNull();
  });

  it('"Year to date" is not a full-year span', () => {
    const html = doc(table('', [['£m', 'Year to date 31 December 2026', 'Year to date 31 December 2025']], [['Revenue', '3,000', '2,800'], ['Basic EPS (p)', '30.0', '28.0']]));
    expect(readEuropeRelease(html, FY).span).toBeNull();
  });

  it('starting fiscal quarter from SEC fiscalYearEnd (MMDD); missing → null', () => {
    expect(europeFiscalQuarter('2026-09-30', '1231')).toBe(3);
    expect(europeFiscalQuarter('2026-12-31', '1231')).toBe(4);
    expect(europeFiscalQuarter('2026-09-30', '0331')).toBe(2);
    expect(europeFiscalQuarter('2026-06-30', '0630')).toBe(4);
    expect(europeFiscalQuarter('2026-09-28', '0103')).toBe(3);
    expect(europeFiscalQuarter('2026-08-31', '1231')).toBeNull();
    expect(europeFiscalQuarter('2026-09-30', null)).toBeNull();
    expect(europeFiscalQuarter('2026-09-30', '13xx')).toBeNull();
  });
});
