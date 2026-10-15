import { z } from 'zod';
import { parseOptionSymbol } from '../domain/expectedMove.js';
import type { OptionChain, OptionQuote } from '../types.js';
import { type Http, HttpError, SourceFormatError } from './http.js';

const ResponseSchema = z.object({
  data: z.object({
    close: z.number().nullish(),
    last_trade_time: z.string().nullish(),
    options: z.array(z.object({ option: z.string(), bid: z.number().nullish(), ask: z.number().nullish() })),
  }),
});

/** Cboe URL symbol: BRK/B -> BRK.B */
const urlSymbol = (symbol: string) => symbol.trim().toUpperCase().replace('/', '.');
/** Standard option root: BRK/B -> BRKB. Adjusted roots (e.g. XYZ1) never match. */
const optionRoot = (symbol: string) => symbol.trim().toUpperCase().replace(/[^A-Z]/g, '');

export function parseCboeChain(json: unknown, symbol: string): OptionChain | null {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Cboe chain: ${parsed.error.message}`);
  // Regular-session close, never current_price: after an earnings release the stock trades in extended
  // hours while option quotes stay at the close, so current_price would pick the wrong ATM strike.
  const { close, last_trade_time, options } = parsed.data.data;
  if (!close || close <= 0) return null;
  const root = optionRoot(symbol);
  const quotes: OptionQuote[] = [];
  for (const o of options) {
    const p = parseOptionSymbol(o.option);
    if (!p || o.option.slice(0, -15).trim() !== root) continue;
    quotes.push({ ...p, bid: o.bid ?? 0, ask: o.ask ?? 0 });
  }
  return { underlying: close, quotes, asOfDate: last_trade_time ? last_trade_time.slice(0, 10) : null };
}

export async function fetchCboeChain(http: Http, symbol: string): Promise<OptionChain | null> {
  try {
    return parseCboeChain(await http.json(`https://cdn.cboe.com/api/global/delayed_quotes/options/${urlSymbol(symbol)}.json`), symbol);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}
