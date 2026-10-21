/**
 * Company name → NSE F&O symbol matcher.
 *
 * The RSS feeds carry company names (e.g. "GAIL (India) Limited") while the
 * F&O list has symbols (e.g. "GAIL") and short names ("GAIL (INDIA)").
 * This module resolves names to symbols without ever mapping to a wrong symbol.
 */

export interface StockRef {
  symbol: string;
  name: string;     // from fo_mktlots.csv (short, uppercase)
}

/** Normalise a company name for fuzzy matching. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+ltd\.?$/i, '')       // "Limited" / "Ltd"
    .replace(/\s+limited$/i, '')
    .replace(/\s+private$/i, '')
    .replace(/[^a-z0-9&]/g, '')       // remove punctuation (keep & for M&M)
    .trim();
}

/** Build a lookup map from the F&O stock list. */
export function buildSymbolIndex(stocks: StockRef[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const s of stocks) {
    idx.set(normalize(s.symbol), s.symbol);
    idx.set(normalize(s.name), s.symbol);
    // Also index symbol without suffix for "BAJAJ-AUTO" → "bajajauto"
    idx.set(s.symbol.toLowerCase().replace(/[^a-z0-9]/g, ''), s.symbol);
  }
  return idx;
}

/**
 * Resolve a company name or symbol to the canonical NSE F&O symbol.
 * Returns null if not found or ambiguous — never maps to a wrong symbol.
 */
export function resolveSymbol(
  nameOrSymbol: string,
  index: Map<string, string>,
): string | null {
  if (!nameOrSymbol) return null;
  const key = normalize(nameOrSymbol);
  const direct = index.get(key);
  if (direct) return direct;

  // Also try without special characters
  const stripped = nameOrSymbol.toLowerCase().replace(/[^a-z0-9]/g, '');
  return index.get(stripped) ?? null;
}
