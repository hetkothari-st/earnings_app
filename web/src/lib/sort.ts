export type SortKey = 'date' | 'cap' | 'gainers' | 'losers';

interface Sortable {
  symbol: string;
  reportDate: string;
  marketCap: number | null;
  previousMove: { pct: number } | null;
}

/** Larger first; missing values always last. */
const desc = (a: number | null | undefined, b: number | null | undefined) =>
  a == null ? (b == null ? 0 : 1) : b == null ? -1 : b - a;

/** Returns a sorted copy. 'gainers'/'losers' use the stock's reaction to its previous report. */
export function sortRows<T extends Sortable>(rows: T[], key: SortKey): T[] {
  const out = [...rows];
  switch (key) {
    case 'cap':
      return out.sort((a, b) => desc(a.marketCap, b.marketCap));
    case 'gainers':
      return out.sort((a, b) => desc(a.previousMove?.pct, b.previousMove?.pct));
    case 'losers':
      return out.sort((a, b) => desc(
        a.previousMove == null ? null : -a.previousMove.pct,
        b.previousMove == null ? null : -b.previousMove.pct,
      ));
    case 'date':
      return out.sort((a, b) => a.reportDate.localeCompare(b.reportDate) || desc(a.marketCap, b.marketCap));
  }
}
