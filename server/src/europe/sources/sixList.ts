/**
 * The SIX share list (Switzerland is outside FIRDS; Ruling 4's substitute for `SIX`).
 *
 * Verified live (Task 1): `UNIVERSE_URLS.sixList` answers a `;`-separated CSV (ISO-8859-1 header, ASCII content)
 * with the columns ShortName;ValorSymbol;ValorNumber;ISIN;TradingBaseCurrency;ListingSegmentDesc;
 * GeographicalAreaDesc;SecTypeDesc. Dropped: the `SIX Sponsored Segment` (foreign lines traded on SIX),
 * `Standard for Derivatives` (rights) and the `2. LINIE` second lines (buy-back lines). ValorSymbol + `.SW` is the
 * Yahoo symbol. An empty answer, a header without a required column, or no share rows throws `SourceFormatError`.
 */

import { SourceFormatError } from '../../sources/http.js';

export interface SixShare {
  isin: string;
  symbol: string;
  name: string;
  currency: string;
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const DROPPED_SEGMENTS = new Set(['SIX Sponsored Segment', 'Standard for Derivatives']);

export function parseSixList(text: string): SixShare[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) throw new SourceFormatError('six list: empty answer');
  const header = lines[0]!.split(';').map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [iName, iSymbol, iIsin, iCcy, iSegment] = ['ShortName', 'ValorSymbol', 'ISIN', 'TradingBaseCurrency', 'ListingSegmentDesc'].map(col);
  if ([iName, iSymbol, iIsin, iCcy, iSegment].some((i) => i! < 0)) throw new SourceFormatError('six list: header lacks a required column');
  const out: SixShare[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split(';').map((x) => x.trim());
    const name = f[iName!] ?? '';
    const symbol = f[iSymbol!] ?? '';
    const isin = f[iIsin!] ?? '';
    const currency = f[iCcy!] ?? '';
    if (!name || !symbol || !ISIN_RE.test(isin) || !currency) continue;
    if (DROPPED_SEGMENTS.has(f[iSegment!] ?? '')) continue;
    if (/\b2\.\s?LINIE\b/i.test(name)) continue;
    out.push({ isin, symbol, name, currency });
  }
  // Never a silent empty list: that would drop every Swiss row as if the refresh had worked.
  if (out.length === 0) throw new SourceFormatError('six list: no share rows');
  return out;
}
