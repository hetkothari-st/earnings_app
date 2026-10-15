import { z } from 'zod';
import { parseOptionSymbol } from '../domain/expectedMove.js';
import type { OptionChain, OptionQuote } from '../types.js';
import { type Http, HttpError, SourceFormatError } from './http.js';

const ResponseSchema = z.object({
  data: z.object({
    current_price: z.number().nullish(),
    options: z.array(z.object({ option: z.string(), bid: z.number().nullish(), ask: z.number().nullish() })),
  }),
});

export function parseCboeChain(json: unknown): OptionChain | null {
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`Cboe chain: ${parsed.error.message}`);
  const { current_price, options } = parsed.data.data;
  if (!current_price || current_price <= 0) return null;
  const quotes: OptionQuote[] = [];
  for (const o of options) {
    const p = parseOptionSymbol(o.option);
    if (p) quotes.push({ ...p, bid: o.bid ?? 0, ask: o.ask ?? 0 });
  }
  return { underlying: current_price, quotes };
}

export async function fetchCboeChain(http: Http, symbol: string): Promise<OptionChain | null> {
  const cboeSymbol = symbol.trim().toUpperCase().replace('/', '.');
  try {
    return parseCboeChain(await http.json(`https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`));
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}
