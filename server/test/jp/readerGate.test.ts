import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { readJpRelease, type JpReleaseValues } from '../../src/jp/sources/releaseJp.js';
import { JP_FULL } from '../../src/jp/universe.js';

/**
 * JP reader gate (Global Constraints): the 'jp' profile must read >= 20 hand-checked 6-K releases (all 8 issuers)
 * all exact with 0 wrong, and the held-out set (>= 6) all exact with 0 wrong, before jpEps / jpRevenue go on.
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
  readJpRelease(readFileSync(dirOf(`${sub}${file}`), 'utf8'), { periodEnd: e.periodEnd, fiscalQuarter: e.fiscalQuarter });

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

  it('flags follow both gates', () => {
    const m = score('');
    const h = score('heldout/');
    const passes = m.checked >= 20 && m.exact === m.checked && m.wrong === 0 && h.checked >= 6 && h.exact === h.checked && h.wrong === 0;
    expect(config.fastFields.jpEps ?? false).toBe(passes);
    expect(config.fastFields.jpRevenue ?? false).toBe(passes);
  });

  it('corpus big enough', () => {
    expect(main.length).toBeGreaterThanOrEqual(20);
    expect(new Set(main.map(([, e]) => e.adr))).toEqual(new Set(JP_FULL.map((f) => f.adr)));
    expect(heldout.length).toBeGreaterThanOrEqual(6);
  });
});
