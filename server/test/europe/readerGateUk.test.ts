import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gateCounts, gatePasses, GATE_MIN_EXACT } from '../../src/domain/readerGate.js';
import { EUROPE_GATE_FIELDS, readEuropeRelease, type EuropeReleaseValues } from '../../src/europe/sources/releaseEurope.js';
import { europeIssuerFor } from '../../src/europe/universe.js';

/**
 * UK reader gate (Global Constraints, as Japan): of the hand-checked UK 6-K / 8-K releases, >= 20 must be exact and
 * carry a value with 0 wrong, and the held-out set (>= 6 releases, 6 issuers, never tuned on) must have 0 wrong —
 * blanks are acceptable — before ukEps / ukRevenue may go on. Exact is `===` on all seven EUROPE_GATE_FIELDS.
 * Expected values in expected.json are hand-read from each release (`note` quotes the row label and column head).
 */
interface UkExpected {
  adr: string; cik: number; accession: string; periodEnd: string; fiscalQuarter: 1 | 2 | 3 | 4;
  revenue: number | null; revenueCurrency: string | null; eps: number | null; epsDiluted: number | null;
  epsCurrency: string | null; span: 'quarter' | 'ytd' | null; ytdMonths: 6 | 9 | 12 | null; checked: boolean; note: string;
}

const dirOf = (sub: string) => new URL(`../fixtures/europe/releases/uk/${sub}`, import.meta.url);
function load(sub: string): Array<[string, UkExpected]> {
  const path = dirOf(`${sub}expected.json`);
  if (!existsSync(path)) return [];
  return Object.entries(JSON.parse(readFileSync(path, 'utf8')) as Record<string, UkExpected>).filter(([, e]) => e.checked);
}
const read = (sub: string, file: string, e: UkExpected): EuropeReleaseValues =>
  readEuropeRelease(readFileSync(dirOf(`${sub}${file}`), 'utf8'), {
    periodEnd: e.periodEnd, fiscalQuarter: e.fiscalQuarter, profile: 'uk', issuer: europeIssuerFor(e.adr),
  });

const score = (sub: string) => gateCounts(EUROPE_GATE_FIELDS, load(sub).map(([file, e]) => ({ expected: e, got: read(sub, file, e) })));

const main = load('');
const heldout = load('heldout/');

describe('UK reader gate', () => {
  it('never wrong', { timeout: 30_000 }, () => {
    expect(main.length).toBeGreaterThan(0);
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
    const passes = gatePasses(score(''), false) && gatePasses(score('heldout/'), true) && heldout.length >= 6;
    expect(config.fastFields.ukEps ?? false).toBe(passes);
    expect(config.fastFields.ukRevenue ?? false).toBe(passes);
  });

  it('corpus big enough', { timeout: 30_000 }, () => {
    const m = score('');
    const flagsOff = !(config.fastFields.ukEps ?? false) && !(config.fastFields.ukRevenue ?? false);
    expect(m.exactWithValues >= GATE_MIN_EXACT || flagsOff).toBe(true);
    expect(main.length).toBeGreaterThanOrEqual(20);
    expect(heldout.length).toBeGreaterThanOrEqual(6);
  });
});
