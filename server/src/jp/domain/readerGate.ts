/**
 * JP reader gate scoring (controller ruling), shared by `npm run reader-corpus -- --jp / --jp-heldout` and the gate
 * test. A field is exact when `===` the hand-read value (null === null counts), blank when the reader returned null
 * for a non-null value, wrong otherwise; a release is exact when all six fields are. The main set needs >= 20 exact
 * releases that carry a value (an all-null expected entry, e.g. a press release with nothing to read, proves nothing
 * and never counts toward the floor) and none wrong; a held-out set needs none wrong. Blanks are acceptable in both.
 */
export const JP_GATE_FIELDS = ['revenue', 'eps', 'epsDiluted', 'currency', 'span', 'ytdMonths'] as const;
export const JP_GATE_MIN_EXACT = 20;

type Values = Record<(typeof JP_GATE_FIELDS)[number], unknown>;
export type JpMark = 'exact' | 'blank' | 'wrong';

export function jpMarks(expected: Values, got: Values): JpMark[] {
  return JP_GATE_FIELDS.map((f) => (got[f] === expected[f] ? 'exact' : got[f] === null ? 'blank' : 'wrong'));
}

export function jpVerdict(expected: Values, got: Values): JpMark {
  const marks = jpMarks(expected, got);
  return marks.includes('wrong') ? 'wrong' : marks.includes('blank') ? 'blank' : 'exact';
}

/** The expected entry states at least one value (any of the six fields non-null). */
export const jpCarriesValue = (expected: Values): boolean => JP_GATE_FIELDS.some((f) => expected[f] != null);

export interface JpGateCounts { checked: number; exact: number; exactWithValues: number; wrong: number }

export function jpGateCounts(rows: { expected: Values; got: Values }[]): JpGateCounts {
  const c: JpGateCounts = { checked: 0, exact: 0, exactWithValues: 0, wrong: 0 };
  for (const { expected, got } of rows) {
    c.checked++;
    const verdict = jpVerdict(expected, got);
    if (verdict === 'exact') {
      c.exact++;
      if (jpCarriesValue(expected)) c.exactWithValues++;
    }
    if (verdict === 'wrong') c.wrong++;
  }
  return c;
}

export function jpGatePasses(c: JpGateCounts, heldout: boolean): boolean {
  return c.wrong === 0 && (heldout ? c.checked > 0 : c.exactWithValues >= JP_GATE_MIN_EXACT);
}
