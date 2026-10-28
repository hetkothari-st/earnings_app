/**
 * JP reader gate scoring (controller ruling): the shared scoring of `domain/readerGate.ts` with JP's six fields. A
 * field is exact when `===` the hand-read value (null === null counts), blank when the reader returned null for a
 * non-null value, wrong otherwise; a release is exact when all six fields are. The main set needs >= 20 exact
 * releases that carry a value (an all-null expected entry, e.g. a press release with nothing to read, proves nothing
 * and never counts toward the floor) and none wrong; a held-out set needs none wrong. Blanks are acceptable in both.
 */
import { GATE_MIN_EXACT, carriesValue, gateCounts, gateMarks, gatePasses, gateVerdict, type GateCounts, type GateMark } from '../../domain/readerGate.js';

export const JP_GATE_FIELDS = ['revenue', 'eps', 'epsDiluted', 'currency', 'span', 'ytdMonths'] as const;
export const JP_GATE_MIN_EXACT = GATE_MIN_EXACT;

type Values = Record<(typeof JP_GATE_FIELDS)[number], unknown>;
export type JpMark = GateMark;
export type JpGateCounts = GateCounts;

export const jpMarks = (expected: Values, got: Values): JpMark[] => gateMarks(JP_GATE_FIELDS, expected, got);
export const jpVerdict = (expected: Values, got: Values): JpMark => gateVerdict(JP_GATE_FIELDS, expected, got);
/** The expected entry states at least one value (any of the six fields non-null). */
export const jpCarriesValue = (expected: Values): boolean => carriesValue(JP_GATE_FIELDS, expected);
export const jpGateCounts = (rows: { expected: Values; got: Values }[]): JpGateCounts => gateCounts(JP_GATE_FIELDS, rows);
export const jpGatePasses = (c: JpGateCounts, heldout: boolean): boolean => gatePasses(c, heldout);
