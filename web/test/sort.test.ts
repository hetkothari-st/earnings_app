import { describe, expect, test } from 'vitest';
import { sortRows } from '../src/lib/sort';

const r = (symbol: string, reportDate: string, marketCap: number | null, prev: number | null) =>
  ({ symbol, reportDate, marketCap, previousMove: prev == null ? null : { pct: prev, reportDate: '2026-07-01', basis: 'known' as const } });

const rows = [r('A', '2026-10-16', 5e9, 2.0), r('B', '2026-10-15', 9e11, -6.1), r('C', '2026-10-15', null, null), r('D', '2026-10-16', 2e10, 8.4)];

describe('sortRows', () => {
  test('market cap, largest first, unknown last', () => {
    expect(sortRows(rows, 'cap').map((x) => x.symbol)).toEqual(['B', 'D', 'A', 'C']);
  });
  test('gainers: biggest previous rise first, no move last', () => {
    expect(sortRows(rows, 'gainers').map((x) => x.symbol)).toEqual(['D', 'A', 'B', 'C']);
  });
  test('losers: biggest previous fall first, no move last', () => {
    expect(sortRows(rows, 'losers').map((x) => x.symbol)).toEqual(['B', 'A', 'D', 'C']);
  });
  test('date: chronological, then market cap', () => {
    expect(sortRows(rows, 'date').map((x) => x.symbol)).toEqual(['B', 'C', 'D', 'A']);
  });
  test('does not mutate the input', () => {
    const copy = [...rows];
    sortRows(rows, 'cap');
    expect(rows).toEqual(copy);
  });
});
