import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import type { HkPeriodKind } from '../../src/hk/domain/period.js';
import { readHkRelease, type HkReleaseValues } from '../../src/hk/sources/releaseHk.js';

/**
 * Reader gate (Ruling 10): hand-checked past 6-K releases in test/fixtures/hk/releases/. A release is exact when
 * all five fields equal the hand-read values; the HK flags go on only with >= 20 checked, all exact, 0 wrong.
 */
interface HkExpected {
  adr: string; cik: number; accession: string; periodEnd: string; kind: HkPeriodKind;
  eps: number | null; epsBasis: 'share' | 'ads' | null; epsCurrency: string | null;
  revenue: number | null; revenueCurrency: string | null; checked: boolean; note: string;
}
const FIELDS = ['eps', 'epsBasis', 'epsCurrency', 'revenue', 'revenueCurrency'] as const;

const dir = new URL('../fixtures/hk/releases/', import.meta.url);
const expected: Record<string, HkExpected> = existsSync(new URL('expected.json', dir))
  ? JSON.parse(readFileSync(new URL('expected.json', dir), 'utf8'))
  : {};
const checked = Object.entries(expected).filter(([, e]) => e.checked);
const read = (file: string, e: HkExpected): HkReleaseValues =>
  readHkRelease(readFileSync(new URL(file, dir), 'utf8'), { periodEnd: e.periodEnd, kind: e.kind });

const results = checked.map(([file, e]) => {
  const got = read(file, e);
  const wrong = FIELDS.filter((f) => got[f] !== null && got[f] !== e[f]);
  const exact = FIELDS.every((f) => got[f] === e[f]);
  return { file, got, e, wrong, exact };
});
const exactCount = results.filter((r) => r.exact).length;
const wrongCount = results.filter((r) => r.wrong.length > 0).length;
const gatePasses = checked.length >= 20 && exactCount === checked.length && wrongCount === 0;

describe('HK reader gate', () => {
  it('never wrong', () => {
    const wrong = results.flatMap((r) => r.wrong.map((f) => `${r.file} ${f}: got ${r.got[f]}, expected ${r.e[f]}`));
    expect(wrong).toEqual([]);
  });

  it('gate flags follow the corpus', () => {
    expect(config.fastFields.hkEps).toBe(gatePasses);
    expect(config.fastFields.hkRevenue).toBe(gatePasses);
  });

  it('corpus is big enough to judge', () => {
    expect(checked.length).toBeGreaterThanOrEqual(20);
    expect(checked.filter(([, e]) => e.kind === 'H').length).toBeGreaterThanOrEqual(2);
  });
});
