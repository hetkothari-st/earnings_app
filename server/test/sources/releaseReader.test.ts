import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readUsRelease } from '../../src/sources/releaseReader.js';

const dir = new URL('../fixtures/us/releases/', import.meta.url);
const fx = (n: string) => readFileSync(new URL(n, dir), 'utf8');

interface Expected {
  symbol: string;
  quarterEnd: string;
  epsAdjusted: number | null;
  epsGaap: number | null;
  revenue: number | null;
  /** Hand-read from the release where the company's non-GAAP EPS differs from Nasdaq's (JBL, MU, SNX). */
  releaseEpsAdjusted?: number;
}
const expected: Record<string, Expected> = JSON.parse(fx('expected.json'));

describe('readUsRelease', () => {
  it('adjusted EPS from the reconciliation, not GAAP', () => {
    // General Mills: GAAP diluted EPS 0.74, "Adjusted diluted earnings per share" 0.75.
    const v = readUsRelease(fx('GIS_Aug2026.htm'), '2026-08-30');
    expect(v.epsAdjusted).toBe(0.75);
    expect(v.epsGaap).toBe(0.74);
  });

  it('quarter column only when a nine-months column exists', () => {
    // Fastenal puts the nine-month columns first: 7,051.9 / 0.98 must not be read.
    const v = readUsRelease(fx('FAST_Sep2026.htm'), '2026-09-30');
    expect(v.epsGaap).toBe(0.35);
    expect(v.revenue).toBe(2_463_300_000);
  });

  it('revenue in millions is scaled', () => {
    // Carnival: "(in millions, except per share data)", Total Revenues 8,435.
    const v = readUsRelease(fx('CCL_Aug2026.htm'), '2026-08-31');
    expect(v.revenue).toBe(8_435_000_000);
    expect(v.unit).toBe(1e6);
    expect(v.epsAdjusted).toBe(1.43);
  });

  it('GAAP-only release: epsAdjusted null, epsGaap set', () => {
    const v = readUsRelease(fx('COST_Aug2026.htm'), '2026-08-30');
    expect(v.epsAdjusted).toBeNull();
    expect(v.epsGaap).toBe(6.75);
  });

  it('negatives in parentheses and disagreement → null with a note', () => {
    const html = `<table>
      <tr><td></td><td colspan="2">Three Months Ended September 30, 2026</td></tr>
      <tr><td>Adjusted diluted EPS</td><td>$</td><td>(0.15)</td></tr>
      <tr><td>Diluted earnings per share</td><td>$</td><td>(0.20)</td></tr>
      <tr><td>Revenues</td><td>$</td><td>1,000</td></tr>
    </table>
    <table>
      <tr><td></td><td colspan="2">Three Months Ended September 30, 2026</td></tr>
      <tr><td>Adjusted diluted EPS</td><td>$</td><td>(0.17)</td></tr>
    </table>`;
    const v = readUsRelease(html, '2026-09-30');
    expect(v.epsGaap).toBe(-0.2);
    expect(v.epsAdjusted).toBeNull();
    expect(v.notes.join(' ')).toMatch(/epsAdjusted/);
    expect(v.revenue).toBeNull(); // no unit stated
  });

  it('prose above a unit-less table is not a unit ("tens of millions of customers")', () => {
    const html = `<p>Our platform now serves tens of millions of customers worldwide.</p>
    <table>
      <tr><td></td><td colspan="2">Three Months Ended September 30, 2026</td></tr>
      <tr><td>Total revenues</td><td>$</td><td>1,234</td></tr>
      <tr><td>Diluted earnings per share</td><td>$</td><td>0.50</td></tr>
    </table>`;
    const v = readUsRelease(html, '2026-09-30');
    expect(v.revenue).toBeNull();
    expect(v.unit).toBeNull();
    expect(v.epsGaap).toBe(0.5);
  });

  it('a caption just above the table is a unit ("(unaudited, in millions, except per share amounts)")', () => {
    const html = `<p>Consolidated Statements of Earnings (unaudited, in millions, except per share amounts)</p>
    <table>
      <tr><td></td><td colspan="2">Three Months Ended September 30, 2026</td></tr>
      <tr><td>Net sales</td><td>$</td><td>1,234.5</td></tr>
      <tr><td>Diluted earnings per share</td><td>$</td><td>0.50</td></tr>
    </table>`;
    expect(readUsRelease(html, '2026-09-30').revenue).toBe(1_234_500_000);
  });

  it('only an adjusted table: a plain "Diluted earnings per share" row there is not GAAP', () => {
    // Delta's "Adjusted" summary table, cut out of the real release: its row reads
    // "Diluted earnings per share 1.72", which is adjusted EPS (GAAP is 1.15).
    const dal = fx('DAL_Sep2026.htm');
    const tables = [...dal.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((m) => m[0]);
    const text = (t: string) => t.replace(/<[^>]*>/g, ' ').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const adjusted = tables.find((t) => /^\s*Adjusted\b/.test(text(t)) && /\b1\.72\b/.test(text(t)));
    expect(adjusted).toBeDefined();
    const v = readUsRelease(adjusted!, '2026-09-30');
    expect(v.epsGaap).toBeNull();
    expect(v.epsAdjusted).toBe(1.72);

    // A reconciliation captioned non-GAAP, with no GAAP marker on the row: not GAAP either.
    const recon = `<p>Reconciliation of Non-GAAP Financial Measures (in millions, except per share data)</p>
    <table>
      <tr><td></td><td colspan="2">Three Months Ended September 30, 2026</td></tr>
      <tr><td>Diluted earnings per share</td><td>$</td><td>2.10</td></tr>
    </table>`;
    expect(readUsRelease(recon, '2026-09-30').epsGaap).toBeNull();
  });

  it('BlackRock: GAAP EPS from the "GAAP basis" rows, not the "As Adjusted" ones', () => {
    const v = readUsRelease(fx('BLK_Sep2026.htm'), '2026-09-30');
    expect(v.epsGaap).toBe(10.57);
  });

  it('every accepted value in the corpus matches expected.json', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.htm'));
    expect(files.length).toBeGreaterThanOrEqual(30);
    const bad: string[] = [];
    for (const f of files) {
      const e = expected[f];
      expect(e, `expected.json entry for ${f}`).toBeDefined();
      const v = readUsRelease(fx(f), e!.quarterEnd);
      // Adjusted EPS is checked against the release itself where it differs from Nasdaq.
      const want = { epsAdjusted: e!.releaseEpsAdjusted ?? e!.epsAdjusted, epsGaap: e!.epsGaap, revenue: e!.revenue };
      for (const k of ['epsAdjusted', 'epsGaap', 'revenue'] as const) {
        const got = v[k];
        if (got === null) continue;
        const w = want[k];
        // A value with no expected figure must not pass silently: expected null means "not in the release".
        if (w === null) { bad.push(`${f} ${k} ${got} but expected.json has null`); continue; }
        const ok = k === 'revenue' ? Math.abs(got - w) <= 0.005 * Math.abs(w) : Math.abs(got - w) <= 0.01 + 1e-9;
        if (!ok) bad.push(`${f} ${k} ${got} != ${w}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
