import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { readJpRelease, type JpReleaseValues } from '../../src/jp/sources/releaseJp.js';
import { JP_FULL, jpIssuerFor } from '../../src/jp/universe.js';

/**
 * JP reader gate (controller ruling): of the hand-checked 6-K releases (all 8 issuers), >= 20 must be exact with 0
 * wrong, and every held-out set (>= 6 releases) must have 0 wrong — blanks are acceptable — before jpEps / jpRevenue
 * may go on.
 * Expected values in expected.json are hand-read from each release's statement tables (`note` names the row and column).
 */
interface JpExpected {
  adr: string; cik: number; accession: string; periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4;
  revenue: number | null; eps: number | null; epsDiluted: number | null; currency: 'JPY' | null;
  span: 'quarter' | 'ytd' | null; ytdMonths: 6 | 9 | 12 | null; checked: boolean; note: string;
}
const FIELDS = ['revenue', 'eps', 'epsDiluted', 'currency', 'span', 'ytdMonths'] as const;

const dirOf = (sub: string) => new URL(`../fixtures/jp/releases/${sub}`, import.meta.url);
function load(sub: string): Array<[string, JpExpected]> {
  const path = dirOf(`${sub}expected.json`);
  if (!existsSync(path)) return [];
  return Object.entries(JSON.parse(readFileSync(path, 'utf8')) as Record<string, JpExpected>).filter(([, e]) => e.checked);
}
const read = (sub: string, file: string, e: JpExpected): JpReleaseValues =>
  readJpRelease(readFileSync(dirOf(`${sub}${file}`), 'utf8'), { periodEnd: e.periodEnd, fiscalQuarter: e.fiscalQuarter, issuer: jpIssuerFor(e.adr) });

function score(sub: string): { checked: number; exact: number; wrong: number } {
  let checked = 0, exact = 0, wrong = 0;
  for (const [file, e] of load(sub)) {
    checked++;
    const got = read(sub, file, e);
    if (FIELDS.every((f) => got[f] === e[f])) exact++;
    if (FIELDS.some((f) => got[f] !== null && got[f] !== e[f])) wrong++;
  }
  return { checked, exact, wrong };
}

const main = load('');
const heldout = load('heldout/');

describe('JP reader gate', () => {
  it('never wrong', () => {
    for (const [sub, set] of [['', main], ['heldout/', heldout]] as const) {
      for (const [file, e] of set) {
        const got = read(sub, file, e);
        for (const f of FIELDS) {
          if (got[f] !== null) expect({ file, field: f, value: got[f] }).toEqual({ file, field: f, value: e[f] });
        }
      }
    }
  });

  it('flags are on only when the gate passes', () => {
    // Gate (controller ruling): main >= 20 exact and 0 wrong; every held-out set 0 wrong (blanks acceptable). Passing
    // the gate allows the flags; turning them on is the controller's decision, so off is always allowed.
    const m = score('');
    const h = score('heldout/');
    const passes = m.exact >= 20 && m.wrong === 0 && h.checked > 0 && h.wrong === 0;
    if (config.fastFields.jpEps ?? false) expect(passes).toBe(true);
    if (config.fastFields.jpRevenue ?? false) expect(passes).toBe(true);
  });

  it('corpus big enough', () => {
    expect(main.length).toBeGreaterThanOrEqual(20);
    expect(new Set(main.map(([, e]) => e.adr))).toEqual(new Set(JP_FULL.map((f) => f.adr)));
    expect(heldout.length).toBeGreaterThanOrEqual(6);
  });
});
