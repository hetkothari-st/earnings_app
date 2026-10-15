/** One key per security regardless of source spelling: BRK/B, BRK.B, BRK-B -> BRK-B. */
export function normalizeTicker(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[./]/g, '-');
}
