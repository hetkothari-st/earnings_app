import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gateCounts, gatePasses } from '../../src/domain/readerGate.js';
import { EUROPE_GATE_FIELDS, readEuropeRelease, type EuropeReleaseValues } from '../../src/europe/sources/releaseEurope.js';
import { europeIssuerFor } from '../../src/europe/universe.js';

/**
 * EU reader gate (Global Constraints, as JP): of the hand-checked 6-K / 8-K releases of the EU full-level issuers, the
 * main set needs >= 20 exact releases carrying a value and 0 wrong, and the held-out set (>= 6 releases) 0 wrong —
 * blanks are acceptable — before euEps / euRevenue may go on.
 * Expected values in expected.json are hand-read from each release's own tables (`note` quotes the row and column).
 */
interface EuExpected {
  adr: string; cik: number; accession: string; periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4;
  revenue: number | null; revenueCurrency: string | null; eps: number | null; epsDiluted: number | null;
  epsCurrency: string | null; span: 'quarter' | 'ytd' | null; ytdMonths: 6 | 9 | 12 | null; checked: boolean; note: string;
}

const dirOf = (sub: string) => new URL(`../fixtures/europe/releases/eu/${sub}`, import.meta.url);
function load(sub: string): Array<[string, EuExpected]> {
  const path = dirOf(`${sub}expected.json`);
  if (!existsSync(path)) return [];
  return Object.entries(JSON.parse(readFileSync(path, 'utf8')) as Record<string, EuExpected>).filter(([, e]) => e.checked);
}
const read = (sub: string, file: string, e: EuExpected): EuropeReleaseValues =>
  readEuropeRelease(readFileSync(dirOf(`${sub}${file}`), 'utf8'), {
    periodEnd: e.periodEnd, fiscalQuarter: e.fiscalQuarter, profile: 'eu', issuer: europeIssuerFor(e.adr),
  });

const score = (sub: string) => gateCounts(EUROPE_GATE_FIELDS, load(sub).map(([file, e]) => ({ expected: e, got: read(sub, file, e) })));

const main = load('');
const heldout = load('heldout/');

/**
 * Generic 'eu' reader fixes found on the main corpus (Task 18 Step 5). Each probe is the corpus document's shape, cut
 * down; the 'uk' profile is unchanged by them.
 */
describe('EU reader fixes (profile eu)', () => {
  const page = (...parts: string[]) => `<html><body>${parts.join('')}</body></html>`;
  const tbl = (rows: string[][]) => `<table>${rows.map((r) => `<tr>${r.map((c) => (c.startsWith('<td') ? c : `<td>${c}</td>`)).join('')}</tr>`).join('')}</table>`;
  const values = (v: EuropeReleaseValues) => {
    const { notes: _n, ...rest } = v;
    return rest;
  };
  const H1 = { periodEnd: '2025-06-30', fiscalQuarter: 2 as const, profile: 'eu' as const };
  const Q1 = { periodEnd: '2025-03-31', fiscalQuarter: 1 as const, profile: 'eu' as const };
  const Q2 = { periodEnd: '2026-06-30', fiscalQuarter: 2 as const, profile: 'eu' as const };

  it('self-closing <td/> cells keep the columns in place (SNY: the comparative column is never read)', () => {
    const empty = '<td colspan="3"/>';
    const html = page('<p>Consolidated income statements</p>', `<table>
      <tr><td colspan="3">(&#8364; million)</td><td colspan="3">Note</td><td colspan="3">June 30, 2025 (6 months)</td><td colspan="3">June 30, 2024 (6 months) (a)</td></tr>
      <tr><td colspan="3">Net sales</td><td colspan="3">B.20.</td><td colspan="2">19,889</td><td/><td colspan="2">18,360</td><td/></tr>
      <tr><td colspan="3">Basic earnings per share (&#8364;)</td>${empty}<td colspan="2">4.74</td><td/><td colspan="2">1.80</td><td/></tr>
      <tr><td colspan="3">Diluted earnings per share (&#8364;)</td>${empty}<td colspan="2">4.72</td><td/><td colspan="2">1.79</td><td/></tr>
    </table>`);
    expect(values(readEuropeRelease(html, H1))).toEqual({
      revenue: 19_889_000_000, revenueCurrency: 'EUR', eps: 4.74, epsDiluted: 4.72, epsCurrency: 'EUR', span: 'ytd', ytdMonths: 6,
    });
  });

  it('agreeing revenue figures: the most precise one is kept; a rounded figure is blank when the document states the line more precisely (ERIC: SEK b. 55.0, SEK million 55,025)', () => {
    const summary = tbl([['SEK b.', 'Q1 2025', 'Q1 2024'], ['Net sales', '55.0', '53.3'], ['EPS diluted, SEK', '1.24', '0.77']]);
    const statement = (head: string[]) => tbl([head, ['SEK million', '2025', '2024'], ['Net sales', '55,025', '53,325'], ['Earnings per share, basic (SEK)', '1.25', '0.77'], ['Earnings per share, diluted (SEK)', '1.24', '0.77']]);
    const placed = statement(['', 'Q1 2025', 'Q1 2024']).replace('<tr><td>SEK million</td><td>2025</td><td>2024</td></tr>', '<tr><td>SEK million</td><td></td><td></td></tr>');
    expect(readEuropeRelease(page(summary, '<p>Condensed consolidated income statement</p>', placed), Q1).revenue).toBe(55_025_000_000);
    // The statement's "Q1" title sits over the comparative column only, so its current column cannot be placed: the
    // summary's rounded 55.0 is not read either.
    const unplaced = statement(['', '', 'Q1']);
    expect(readEuropeRelease(page(summary, '<p>Condensed consolidated income statement</p>', unplaced), Q1).revenue).toBeNull();
    // Alone, a billions figure is read at its own precision (Task 7).
    expect(readEuropeRelease(page(summary), Q1).revenue).toBe(55_000_000_000);
  });

  it('a "Three months ended" title over every figure column is the quarter head (STM): the quarter is read, not the six months', () => {
    const statement = (title: string, a: string, b: string, sales: string, eps: string) => tbl([
      ['CONSOLIDATED STATEMENTS OF INCOME'],
      ['(in millions of U.S. dollars, except per share data ($))'],
      ['', title],
      ['', a, b],
      ['', '2026', '2025'],
      ['Net sales', sales, '2,745'],
      ['Basic earnings per share ($)', eps, '(0.11)'],
    ]).replace(`<td>${title}</td>`, `<td colspan="2">${title}</td>`);
    const html = page(
      statement('Three months ended', 'June 27,', 'June 28,', '3,481', '0.25'),
      '<p>Notes follow.</p>',
      statement('Six months ended', 'June 27,', 'June 28,', '6,570', '0.29'),
    );
    expect(values(readEuropeRelease(html, Q2))).toEqual({
      revenue: 3_481_000_000, revenueCurrency: 'USD', eps: 0.25, epsDiluted: null, epsCurrency: 'USD', span: 'quarter', ytdMonths: null,
    });
  });

  it('"non-U.S. GAAP" EPS rows and tables are never read (STM)', () => {
    const html = page(
      tbl([['', 'Q2 2026', 'Q2 2025'], ['Diluted earnings per share ($)', '0.24', '(0.11)'], ['Diluted Earnings Per Share (non-U.S. GAAP) ($)', '0.31', '0.06']]),
      '<p>Non-U.S. GAAP measures on earnings</p>',
      tbl([['', 'Q2 2026', 'Q2 2025'], ['Diluted earnings per share ($)', '0.31', '0.06']]),
    );
    expect(readEuropeRelease(html, Q2).epsDiluted).toBe(0.24);
  });

  it('a sales line gross of excise taxes, or a component of a later net revenues total, is never revenue — anywhere in the document (TTE, STM)', () => {
    const tte = page(
      tbl([['In millions of dollars, except earnings per share and number of shares', '1Q26', '4Q25'], ['Sales', '54,163', '50,624'], ['Fully-diluted earnings per shares ($)', '2.64', '1.30']]),
      '<p>Consolidated statement of income</p>',
      tbl([['(M$)', '1st quarter 2026', '4th quarter 2025'], ['Sales', '54,163', '50,624'], ['Excise taxes', '(4,647)', '(4,699)'], ['Revenues from sales', '49,516', '45,925'], ['Earnings per share ($)', '2.68', '1.31']]),
    );
    expect(readEuropeRelease(tte, { periodEnd: '2026-03-31', fiscalQuarter: 1, profile: 'eu' }).revenue).toBeNull();
    const stm = page(tbl([['In millions of U.S. dollars', 'Q2 2026', 'Q2 2025'], ['Net sales', '3,481', '2,745'], ['Other revenues', '6', '21'], ['Net revenues', '3,487', '2,766'], ['Basic earnings per share ($)', '0.25', '(0.11)']]));
    expect(readEuropeRelease(stm, Q2).revenue).toBeNull();
    // A breakdown line after the total is no rival: ASML keeps its total net sales.
    const asml = page(tbl([['(Figures in millions of euros unless otherwise indicated)', 'Q2 2026', 'Q3 2026'], ['Total net sales', '9,326', '11,662'], ['...of which Installed Base Management sales', '2,762', '3,289'], ['EPS (basic; in euros)', '7.59', '12.95']]));
    expect(readEuropeRelease(asml, { periodEnd: '2026-09-30', fiscalQuarter: 3, profile: 'eu' }).revenue).toBe(11_662_000_000);
  });
});

describe('EU reader gate', () => {
  it('never wrong', { timeout: 30_000 }, () => {
    for (const [sub, set] of [['', main], ['heldout/', heldout]] as const) {
      for (const [file, e] of set) {
        const got = read(sub, file, e);
        for (const f of EUROPE_GATE_FIELDS) {
          if (got[f] !== null) expect({ file, field: f, value: got[f] }).toEqual({ file, field: f, value: e[f] });
        }
      }
    }
  });

  it('flags follow both gates', { timeout: 30_000 }, () => {
    const passes = gatePasses(score(''), false) && gatePasses(score('heldout/'), true);
    expect(config.fastFields.euEps ?? false).toBe(passes);
    expect(config.fastFields.euRevenue ?? false).toBe(passes);
  });

  it('corpus big enough', { timeout: 30_000 }, () => {
    const m = score('');
    if (m.exactWithValues < 20) {
      expect(config.fastFields.euEps ?? false).toBe(false);
      expect(config.fastFields.euRevenue ?? false).toBe(false);
    }
    expect(main.length).toBeGreaterThanOrEqual(20);
    expect(heldout.length).toBeGreaterThanOrEqual(6);
  });
});
