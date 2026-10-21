import type { Http } from '../../sources/http.js';
import { SourceFormatError } from '../../sources/http.js';

const FO_LIST_URL = 'https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv';
const KITE_INSTRUMENTS_BASE = 'https://api.kite.trade/instruments/';

export interface FoStock {
  symbol: string;
  name: string;        // truncated name from fo_mktlots.csv col 0
  lotSize: number;
}

/**
 * Fetch and parse the NSE F&O stock list (fo_mktlots.csv).
 * Returns only stocks (not indices) — rows after the "Derivatives on Individual Securities" marker.
 */
export async function fetchFoList(http: Http): Promise<FoStock[]> {
  const text = await http.text(FO_LIST_URL);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Find the "Derivatives on Individual Securities" marker
  const markerIdx = lines.findIndex((l) => l.includes('Derivatives on Individual Securities'));
  if (markerIdx < 0) throw new SourceFormatError('fo_mktlots.csv: marker row not found');

  const stocks: FoStock[] = [];
  // Skip marker row itself; process subsequent rows until we hit another "Derivatives on ..." section or empty
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('Derivatives on')) break; // next section

    // Columns are space-padded with comma separation: name, symbol, lots...
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 3) continue;
    const name = cols[0]!.trim();
    const symbol = cols[1]!.trim().toUpperCase();
    const lotSizeRaw = cols[2]?.trim() ?? '0';
    if (!symbol || symbol === 'SYMBOL') continue;
    const lotSize = Number(lotSizeRaw.replace(/\s/g, ''));
    if (!Number.isFinite(lotSize) || lotSize <= 0) continue;
    stocks.push({ symbol, name, lotSize });
  }

  if (stocks.length === 0) throw new SourceFormatError('fo_mktlots.csv: no stocks parsed');
  return stocks;
}

export interface KiteInstrument {
  instrumentToken: number;
  tradingsymbol: string;       // e.g. "RELIANCE26NOV1180CE" or "RELIANCE"
  name: string;                // underlying symbol for derivatives
  expiry: string | null;       // YYYY-MM-DD or null
  strike: number;
  instrumentType: string;      // CE, PE, EQ, FUT
  segment: string;             // NFO-OPT, NFO-FUT, NSE, INDICES
  exchange: string;
  lotSize: number;
}

/** One CSV line; Kite quotes the name column ("RELIANCE"). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Parse a Kite instruments dump (https://api.kite.trade/instruments/<EXCHANGE>). */
export function parseKiteInstruments(csv: string): KiteInstrument[] {
  const lines = csv.split(/\r?\n/);
  const header = splitCsv(lines[0] ?? '');
  const col = (name: string) => header.indexOf(name);
  const c = {
    token: col('instrument_token'), ts: col('tradingsymbol'), name: col('name'), expiry: col('expiry'), strike: col('strike'),
    type: col('instrument_type'), seg: col('segment'), exch: col('exchange'), lot: col('lot_size'),
  };
  if (Object.values(c).some((i) => i < 0)) throw new SourceFormatError('Kite instruments CSV missing expected columns');
  const out: KiteInstrument[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    const cols = splitCsv(lines[i]!);
    const token = Number(cols[c.token]);
    if (!Number.isInteger(token) || token <= 0) continue;
    out.push({
      instrumentToken: token,
      tradingsymbol: cols[c.ts] ?? '',
      name: cols[c.name] ?? '',
      expiry: cols[c.expiry] || null,
      strike: Number(cols[c.strike] ?? 0),
      instrumentType: cols[c.type] ?? '',
      segment: cols[c.seg] ?? '',
      exchange: cols[c.exch] ?? '',
      lotSize: Number(cols[c.lot] ?? 0),
    });
  }
  if (out.length === 0) throw new SourceFormatError('Kite instruments CSV has no rows');
  return out;
}

/** Kite instruments for one exchange (no auth needed). */
export async function fetchKiteInstruments(http: Http, exchange: 'NFO' | 'NSE' = 'NFO'): Promise<KiteInstrument[]> {
  return parseKiteInstruments(await http.text(`${KITE_INSTRUMENTS_BASE}${exchange}`));
}

/** Stock options of `underlying` expiring on `expiry`, sorted by strike. */
export function filterOptionInstruments(instruments: KiteInstrument[], underlying: string, expiry: string): KiteInstrument[] {
  return instruments.filter((i) => i.segment === 'NFO-OPT' && i.name === underlying && i.expiry === expiry
    && (i.instrumentType === 'CE' || i.instrumentType === 'PE')).sort((a, b) => a.strike - b.strike);
}

/** Option expiries listed for `underlying`. */
export function optionExpiries(instruments: KiteInstrument[], underlying: string): string[] {
  return [...new Set(instruments.filter((i) => i.segment === 'NFO-OPT' && i.name === underlying && i.expiry).map((i) => i.expiry!))].sort();
}

/** NSE cash-market equity tokens by symbol. */
export function equityTokens(instruments: KiteInstrument[]): Map<string, number> {
  return new Map(instruments.filter((i) => i.exchange === 'NSE' && i.segment === 'NSE' && i.instrumentType === 'EQ')
    .map((i) => [i.tradingsymbol, i.instrumentToken]));
}
