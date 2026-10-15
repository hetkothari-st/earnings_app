import { describe, expect, test } from 'vitest';
import { reactionMove } from '../../src/domain/reactionMove.js';

// Closes around a Tue 2026-07-14 report.
const closes = new Map([
  ['2026-07-13', 100], ['2026-07-14', 97.5], ['2026-07-15', 102.4],
]);

describe('reactionMove', () => {
  test('BMO: previous close to report-day close', () => {
    expect(reactionMove(closes, '2026-07-14', 'BMO')).toBe(-2.5);
  });
  test('AMC: report-day close to next-day close', () => {
    expect(reactionMove(closes, '2026-07-14', 'AMC')).toBe(5);
  });
  test('during market: previous close to report-day close', () => {
    expect(reactionMove(closes, '2026-07-14', 'DMH')).toBe(-2.5);
  });
  test('unknown timing or a missing close gives no number', () => {
    expect(reactionMove(closes, '2026-07-14', 'UNKNOWN')).toBeNull();
    expect(reactionMove(closes, '2026-07-15', 'AMC')).toBeNull();
  });
});
