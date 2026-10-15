import { describe, expect, test, vi } from 'vitest';
import { fetchCboeChain, parseCboeChain } from '../../src/sources/cboe.js';
import { HttpError, SourceFormatError } from '../../src/sources/http.js';

// Shape copied from live JPM response on 2026-10-15 (trimmed).
const body = {
  timestamp: '2026-10-15 02:18:14',
  data: {
    symbol: 'JPM', current_price: 335.9, close: 335.28,
    options: [
      { option: 'JPM261016C00180000', bid: 153.3, ask: 157.25, iv: 0 },
      { option: 'JPM261016P00180000', bid: 0, ask: 0.01, iv: 2.5 },
      { option: 'WEIRD', bid: 1, ask: 2 },
    ],
  },
};

describe('cboe', () => {
  test('parses chain and skips unparseable symbols', () => {
    expect(parseCboeChain(body, 'JPM')).toEqual({
      underlying: 335.28,
      asOfDate: null,
      quotes: [
        { expiry: '2026-10-16', type: 'C', strike: 180, bid: 153.3, ask: 157.25 },
        { expiry: '2026-10-16', type: 'P', strike: 180, bid: 0, ask: 0.01 },
      ],
    });
  });
  test('drops adjusted (non-standard) option roots', () => {
    const chain = parseCboeChain({ data: { close: 100, last_trade_time: '2026-10-15T16:00:00', options: [
      { option: 'XYZ261016C00100000', bid: 3, ask: 3.2 },
      { option: 'XYZ1261016C00100000', bid: 9, ask: 9.5 },
    ] } }, 'XYZ');
    expect(chain?.quotes).toEqual([{ expiry: '2026-10-16', type: 'C', strike: 100, bid: 3, ask: 3.2 }]);
    expect(chain?.asOfDate).toBe('2026-10-15');
  });
  test('class-share root has no dot', () => {
    const chain = parseCboeChain({ data: { close: 400, options: [{ option: 'BRKB261016C00400000', bid: 3, ask: 3.2 }] } }, 'BRK/B');
    expect(chain?.quotes).toHaveLength(1);
  });
  test('uses the regular-session close, not an extended-hours price', () => {
    // Live TSM 2026-10-15 02:50 ET: overnight trade 422.55 after results; options quoted at the 430.00 close.
    const chain = parseCboeChain({ data: { current_price: 422.5537, close: 430.0, options: [] } }, 'TSM');
    expect(chain?.underlying).toBe(430.0);
  });
  test('missing price -> null', () => {
    expect(parseCboeChain({ data: { current_price: null, close: null, options: [] } }, 'X')).toBeNull();
  });
  test('bad shape throws', () => {
    expect(() => parseCboeChain({ nope: 1 }, 'X')).toThrow(SourceFormatError);
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
