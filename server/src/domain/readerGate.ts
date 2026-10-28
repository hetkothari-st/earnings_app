/**
 * Reader gate scoring (controller ruling), shared by `npm run reader-corpus -- --jp / --jp-heldout / --uk / --eu …` and
 * the gate tests; each market passes its own field list (JP six fields, UK/EU seven). A field is exact when `===` the
 * hand-read value (null === null counts), blank when the reader returned null for a non-null value, wrong otherwise; a
 * release is exact when all its fields are. The main set needs >= 20 exact releases that carry a value (an all-null
 * expected entry, e.g. a press release with nothing to read, proves nothing and never counts toward the floor) and
 * none wrong; a held-out set needs none wrong. Blanks are acceptable in both.
 */
export const GATE_MIN_EXACT = 20;

export type GateMark = 'exact' | 'blank' | 'wrong';

type Values<F extends string> = Record<F, unknown>;

export function gateMarks<F extends string>(fields: readonly F[], expected: Values<F>, got: Values<F>): GateMark[] {
  return fields.map((f) => (got[f] === expected[f] ? 'exact' : got[f] === null ? 'blank' : 'wrong'));
}

export function gateVerdict<F extends string>(fields: readonly F[], expected: Values<F>, got: Values<F>): GateMark {
  const marks = gateMarks(fields, expected, got);
  return marks.includes('wrong') ? 'wrong' : marks.includes('blank') ? 'blank' : 'exact';
}

/** The expected entry states at least one value (any of the fields non-null). */
export const carriesValue = <F extends string>(fields: readonly F[], expected: Values<F>): boolean => fields.some((f) => expected[f] != null);

export interface GateCounts { checked: number; exact: number; exactWithValues: number; wrong: number }

export function gateCounts<F extends string>(fields: readonly F[], rows: { expected: Values<F>; got: Values<F> }[]): GateCounts {
  const c: GateCounts = { checked: 0, exact: 0, exactWithValues: 0, wrong: 0 };
  for (const { expected, got } of rows) {
    c.checked++;
    const verdict = gateVerdict(fields, expected, got);
    if (verdict === 'exact') {
      c.exact++;
      if (carriesValue(fields, expected)) c.exactWithValues++;
    }
    if (verdict === 'wrong') c.wrong++;
  }
  return c;
}

export function gatePasses(c: GateCounts, heldout: boolean): boolean {
  return c.wrong === 0 && (heldout ? c.checked > 0 : c.exactWithValues >= GATE_MIN_EXACT);
}
