import { describe, expect, test, vi } from 'vitest';
import { fetchCboeChain, parseCboeChain } from '../../src/sources/cboe.js';
import { HttpError, SourceFormatError } from '../../src/sources/http.js';

// Shape copied from live JPM response on 2026-10-15 (trimmed).
const body = {
  timestamp: '2026-10-15 02:18:14',
  data: {
    symbol: 'JPM', current_price: 335.9,
    options: [
      { option: 'JPM261016C00180000', bid: 153.3, ask: 157.25, iv: 0 },
      { option: 'JPM261016P00180000', bid: 0, ask: 0.01, iv: 2.5 },
      { option: 'WEIRD', bid: 1, ask: 2 },
    ],
  },
};

describe('cboe', () => {
  test('parses chain and skips unparseable symbols', () => {
    expect(parseCboeChain(body)).toEqual({
      underlying: 335.9,
      quotes: [
        { expiry: '2026-10-16', type: 'C', strike: 180, bid: 153.3, ask: 157.25 },
        { expiry: '2026-10-16', type: 'P', strike: 180, bid: 0, ask: 0.01 },
      ],
    });
  });
  test('missing price -> null', () => {
    expect(parseCboeChain({ data: { current_price: null, options: [] } })).toBeNull();
  });
  test('bad shape throws', () => {
    expect(() => parseCboeChain({ nope: 1 })).toThrow(SourceFormatError);
  });
  test('403/404 means no options listed -> null', async () => {
    const http = { json: vi.fn().mockRejectedValue(new HttpError(403, 'u')), text: vi.fn() };
    await expect(fetchCboeChain(http, 'ZZZZ')).resolves.toBeNull();
  });
  test('class shares use a dot for Cboe', async () => {
    const http = { json: vi.fn().mockResolvedValue(body), text: vi.fn() };
    await fetchCboeChain(http, 'BRK/B');
    expect(http.json).toHaveBeenCalledWith('https://cdn.cboe.com/api/global/delayed_quotes/options/BRK.B.json');
  });
});
