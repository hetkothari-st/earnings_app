import { describe, expect, it } from 'vitest';
import { readEuropeRelease, type EuropeReleaseValues } from '../../src/europe/sources/releaseEurope.js';

/**
 * UK profile fixes found by the Task 17 corpus (test/fixtures/europe/releases/uk). Each keeps the reader fail-closed:
 * it only turns a value into a blank, or reads a figure the release states in an allowlisted form.
 */
const table = (caption: string, head: string[][], rows: string[][]) =>
  `${caption ? `<p>${caption}</p>` : ''}<table>${[...head, ...rows].map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
const doc = (...tables: string[]) => `<html><body><p>Results announcement</p>${tables.join('<p>Notes follow.</p>')}</body></html>`;
const pick = (v: EuropeReleaseValues) => {
  const { notes: _notes, ...rest } = v;
  return rest;
};
const BLANK = { revenue: null, revenueCurrency: null, eps: null, epsDiluted: null, epsCurrency: null, span: null, ytdMonths: null };

const H1 = { periodEnd: '2026-06-30', fiscalQuarter: 2 as const, profile: 'uk' as const };
const Q3 = { periodEnd: '2026-09-30', fiscalQuarter: 3 as const, profile: 'uk' as const };

describe('readEuropeRelease (uk) — the quarter is the release\'s span when it states quarter figures', () => {
  // The half-year income statement (revenue, EPS) and, elsewhere, a three-month revenue figure in a table the quarter
  // pass does not read (no per-share line in it; a non-GAAP caption; a label that is not "Revenue").
  const statement = table('Condensed consolidated income statement', [['£m', 'Six months ended 30 June 2026', 'Six months ended 30 June 2025']], [
    ['Revenue', '6,373', '6,663'],
    ['Basic earnings per share (pence)', '1.8', '4.1'],
  ]);

  it('a Q2 revenue table without a per-share line: the six-month column is not read in its place', () => {
    const q2 = table('', [['£ million', 'Q2 2026', '% reported']], [['Revenue', '3,343', '(2.3)']]);
    expect(pick(readEuropeRelease(doc(q2, statement), H1))).toEqual(BLANK);
  });

  it('a quarter column under a non-GAAP caption, or under a row label that is no revenue label: also blank', () => {
    const nonGaap = table('Non-GAAP measures', [['', 'Quarter ended 30 June 2026', ''], ['', 'Q2 2026', 'Q2 2025'], ['', '£m', '£m']], [['Revenue', '3,343', '3,421']]);
    expect(pick(readEuropeRelease(doc(statement, nonGaap), H1))).toEqual(BLANK);
    const asReported = table('', [['Revenue In millions of £', 'Second Quarter Ended', '', 'Six Months Ended', ''], ['', '30 June 2026', '30 June 2025', '30 June 2026', '30 June 2025']], [
      ['As reported', '3,343', '3,421', '6,373', '6,663'],
    ]);
    expect(pick(readEuropeRelease(doc(asReported, statement), H1))).toEqual(BLANK);
  });

  it('no quarter column anywhere: the six / nine-month column is read as before', () => {
    expect(pick(readEuropeRelease(doc(statement), H1))).toEqual({
      revenue: 6_373_000_000, revenueCurrency: 'GBP', eps: 1.8, epsDiluted: null, epsCurrency: 'GBp', span: 'ytd', ytdMonths: 6,
    });
    const nine = table('', [['£m', 'Nine months ended 30 September 2026', 'Nine months ended 30 September 2025']], [['Revenue', '9,000', '8,500'], ['Basic earnings per share (pence)', '30.1', '28.0']]);
    expect(pick(readEuropeRelease(doc(nine), Q3))).toEqual({
      revenue: 9_000_000_000, revenueCurrency: 'GBP', eps: 30.1, epsDiluted: null, epsCurrency: 'GBp', span: 'ytd', ytdMonths: 9,
    });
    // A prior-year quarter column (comparative only) is no quarter figure of this release.
    const priorQ = table('', [['£m', 'Q2 2025']], [['Revenue', '3,421']]);
    expect(readEuropeRelease(doc(priorQ, statement), H1).span).toBe('ytd');
  });

  it('a quarter figure that is read stays the answer; a percent-only quarter table does not block the half year', () => {
    const q2eps = table('', [['£m', 'Q2 2026', 'Q2 2025']], [['Revenue', '3,343', '3,421'], ['Basic earnings per share (pence)', '0.9', '2.0']]);
    expect(pick(readEuropeRelease(doc(q2eps, statement), H1))).toEqual({
      revenue: 3_343_000_000, revenueCurrency: 'GBP', eps: 0.9, epsDiluted: null, epsCurrency: 'GBp', span: 'quarter', ytdMonths: null,
    });
    const growth = table('', [['', 'Q1 2026', 'Q2 2026'], ['', '%', '%']], [['Revenue growth', '3.1%', '2.3%']]);
    expect(readEuropeRelease(doc(growth, statement), H1).span).toBe('ytd');
  });

  it('the eu profile is unchanged', () => {
    const q2 = table('', [['€ million', 'Q2 2026', '% reported']], [['Revenue', '3,343', '(2.3)']]);
    const st = table('', [['€m', 'Six months ended 30 June 2026']], [['Revenue', '6,373'], ['Basic earnings per share (€)', '1.80']]);
    expect(readEuropeRelease(doc(q2, st), { ...H1, profile: 'eu' }).span).toBe('ytd');
  });
});

describe('readEuropeRelease (uk) — a spanning "Quarter ended" head over dated columns', () => {
  const Q1 = { periodEnd: '2026-03-31', fiscalQuarter: 1 as const, profile: 'uk' as const };
  const bank = { names: ['HSBC Holdings plc'], ticker: 'HSBC' };
  const hsbc = (title: string) => doc(table('', [['', title, '', ''], ['', '31 Mar 2026', '31 Dec 2025', '31 Mar 2025']], [
    ['Net operating income before change in expected credit losses and other credit impairment charges (\'revenue\') ($m)', '18,624', '16,364', '17,649'],
    ['Basic earnings per share ($)', '0.41', '0.28', '0.39'],
    ['Diluted earnings per share ($)', '0.40', '0.27', '0.39'],
  ]).replace(`<td>${title}</td><td></td><td></td>`, `<td colspan="3">${title}</td>`));

  it('reads the release\'s own dated column under the title', () => {
    expect(pick(readEuropeRelease(hsbc('Quarter ended'), { ...Q1, issuer: bank }))).toEqual({
      revenue: 18_624_000_000, revenueCurrency: 'USD', eps: 0.41, epsDiluted: 0.4, epsCurrency: 'USD', span: 'quarter', ytdMonths: null,
    });
    expect(readEuropeRelease(hsbc('Three months ended'), { ...Q1, issuer: bank }).eps).toBe(0.41);
  });

  it('never a title that is no allowlisted quarter head, or that carries a range / cumulative word', () => {
    for (const title of ['Period ended', 'Results', 'Quarter ended (cumulative)', 'Year to date quarter ended', 'Six months ended']) {
      expect([title, readEuropeRelease(hsbc(title), { ...Q1, issuer: bank }).eps]).toEqual([title, null]);
    }
  });
});

describe('readEuropeRelease (uk) — "Half-year to <date>" is six months, not a year', () => {
  const H1x = { periodEnd: '2026-06-30', fiscalQuarter: 2 as const, profile: 'uk' as const };
  const one = (head: string[][]) => doc(table('', head, [['Revenue ($m)', '37,742', '34,122'], ['Basic earnings per share ($)', '0.85', '0.65']]));

  it('reads the half-year column', () => {
    for (const head of [[['', 'Half-year to 30 Jun 2026', 'Half-year to 30 Jun 2025']], [['', 'Half year ended 30 June 2026', 'Half year ended 30 June 2025']], [['', 'Half-year to', ''], ['', '30 Jun 2026', '30 Jun 2025']]]) {
      expect(pick(readEuropeRelease(one(head), H1x))).toEqual({
        revenue: 37_742_000_000, revenueCurrency: 'USD', eps: 0.85, epsDiluted: null, epsCurrency: 'USD', span: 'ytd', ytdMonths: 6,
      });
    }
  });

  it('a fiscal Q4 never reads a "Half-year to" column as the year; a head naming both spans stays blank', () => {
    const FY = { periodEnd: '2026-06-30', fiscalQuarter: 4 as const, profile: 'uk' as const };
    expect(readEuropeRelease(one([['', 'Half-year to 30 Jun 2026', 'Half-year to 30 Jun 2025']]), FY).eps).toBeNull();
    expect(readEuropeRelease(one([['', 'Half year and year ended 30 June 2026', '2025']]), H1x).eps).toBeNull();
  });

  it('the eu profile is unchanged', () => {
    expect(readEuropeRelease(one([['', 'Half-year to 30 Jun 2026', 'Half-year to 30 Jun 2025']]), { ...H1x, profile: 'eu' }).eps).toBeNull();
  });
});
