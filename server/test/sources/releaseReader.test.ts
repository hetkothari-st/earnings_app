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
  /** Fields where the release itself differs from the official figure (reader is right, source differs). */
  knownMismatch?: string[];
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

  it('every accepted value in the corpus matches expected.json', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.htm'));
    expect(files.length).toBeGreaterThanOrEqual(30);
    const bad: string[] = [];
    for (const f of files) {
      const e = expected[f];
      expect(e, `expected.json entry for ${f}`).toBeDefined();
      const v = readUsRelease(fx(f), e!.quarterEnd);
      const skip = new Set(e!.knownMismatch ?? []);
      if (!skip.has('epsAdjusted') && v.epsAdjusted !== null && e!.epsAdjusted !== null && Math.abs(v.epsAdjusted - e!.epsAdjusted) > 0.01 + 1e-9) {
        bad.push(`${f} epsAdjusted ${v.epsAdjusted} != ${e!.epsAdjusted}`);
      }
      if (!skip.has('epsGaap') && v.epsGaap !== null && e!.epsGaap !== null && Math.abs(v.epsGaap - e!.epsGaap) > 0.01 + 1e-9) {
        bad.push(`${f} epsGaap ${v.epsGaap} != ${e!.epsGaap}`);
      }
      if (!skip.has('revenue') && v.revenue !== null && e!.revenue !== null && Math.abs(v.revenue - e!.revenue) > 0.005 * Math.abs(e!.revenue)) {
        bad.push(`${f} revenue ${v.revenue} != ${e!.revenue}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
