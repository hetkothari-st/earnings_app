import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/repo.js';
import type { EuropeLivePriceDto } from '../../src/europe/api/types.js';
import { syncEuropeUniverse } from '../../src/europe/db/europeRepo.js';
import { EuropePrices } from '../../src/europe/live/europePrices.js';
import type { TradegateQuote, TradegateState } from '../../src/europe/sources/tradegate.js';
import type { EuropeQuote } from '../../src/europe/sources/yahooEurope.js';
import type { EuropeUniverseEntry } from '../../src/europe/universeBuild.js';

// Wednesday 2026-10-28 10:00 London (GMT) = 11:00 Berlin: in the LSE and Tradegate sessions.
const NOW = Date.parse('2026-10-28T10:00:00.000Z');

const entry = (market: 'UK' | 'EU', symbol: string, isin: string, exchange: 'LSE' | 'XET'): EuropeUniverseEntry => ({
  market, symbol, isin, lei: null, name: symbol, exchange, mic: exchange === 'LSE' ? 'XLON' : 'XETA', country: isin.slice(0, 2),
  currency: exchange === 'LSE' ? 'GBp' : 'EUR', adr: null, adrRatio: null, adrRatioVerified: false, cik: null, secForm: null,
});

const yq = (symbol: string, price: number, prevClose: number, currency: string): EuropeQuote => ({
  symbol, price, prevClose, time: NOW - 15 * 60_000, currency, marketCap: null, marketCapCurrency: null, name: null,
});

const tq = (isin: string, last: number | null, close: number | null, at: number): TradegateQuote => ({
  isin, last, close, bid: null, ask: null, changePct: last != null && close != null ? ((last - close) / close) * 100 : null, at: new Date(at).toISOString(),
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function setup(o: { state?: TradegateState; tg?: Record<string, TradegateQuote>; now?: number } = {}) {
  const db = openDb(':memory:');
  syncEuropeUniverse(db, 'UK', [entry('UK', 'AZN.L', 'GB0009895292', 'LSE'), entry('UK', 'BT-A.L', 'GB0030913577', 'LSE')], '2026-10-28T00:00:00.000Z');
  syncEuropeUniverse(db, 'EU', [entry('EU', 'SAP.DE', 'DE0007164600', 'XET')], '2026-10-28T00:00:00.000Z');
  const state = { value: o.state ?? 'on' as TradegateState };
  const tg = { snapshot: () => o.tg ?? {}, state: () => state.value };
  const published: Record<string, EuropeLivePriceDto>[] = [];
  const quotes = new Map([
    ['AZN.L', yq('AZN.L', 12_000, 11_900, 'GBp')],
    ['BT-A.L', yq('BT-A.L', 1234.5, 1240, 'GBp')],
    ['SAP.DE', yq('SAP.DE', 212.5, 210, 'EUR')],
  ]);
  const deps = {
    quotes: async (symbols: string[]) => new Map(symbols.flatMap((s) => (quotes.has(s) ? [[s, quotes.get(s)!] as const] : []))),
    index: async () => { throw new Error('no index in this test'); },
  };
  const now = o.now ?? NOW;
  const uk = new EuropePrices('UK', db, deps, tg, (p) => published.push(p), () => {}, () => now);
  const eu = new EuropePrices('EU', db, deps, tg, (p) => published.push(p), () => {}, () => now);
  uk.setVisible('u1', ['AZN.L', 'BT-A.L']);
  eu.setVisible('u1', ['SAP.DE']);
  return { db, uk, eu, state, published };
}

describe('EuropePrices', () => {
  it('Tradegate quote wins with venue tradegate and EUR; change from Tradegate close only', async () => {
    const tg = { 'AZN.L': tq('GB0009895292', 152.4, 153.9, NOW - 5_000) };
    const s = setup({ tg });
    await s.uk.tick();
    const azn = s.uk.snapshot()['AZN.L']!;
    expect(azn).toEqual({
      price: 152.4, prevClose: 153.9, changePct: -0.97, at: new Date(NOW - 5_000).toISOString(), currency: 'EUR', venue: 'tradegate',
    });
    // Never Tradegate's 152.4 EUR against Yahoo's 11,900p previous close.
    expect(azn.changePct).toBe(Math.round(((152.4 - 153.9) / 153.9) * 10000) / 100);
    // The Yahoo poll does not push AZN.L (Tradegate serves it); BT-A.L goes out as Yahoo.
    expect(s.published.flatMap((p) => Object.keys(p))).toEqual(['BT-A.L']);
    // A fresh Tradegate quote is pushed for this market's symbols only.
    s.published.length = 0;
    s.uk.onTradegate({ ...tg, 'SAP.DE': tq('DE0007164600', 213, 212, NOW) });
    expect(s.published).toEqual([{ 'AZN.L': azn }]);
    expect(Object.keys(s.uk.snapshot()).sort()).toEqual(['AZN.L', 'BT-A.L']);
    // Wanted by the poller, by ISIN.
    expect(s.uk.tradegateWanted()).toEqual([{ isin: 'GB0009895292', symbol: 'AZN.L' }, { isin: 'GB0030913577', symbol: 'BT-A.L' }]);
  });

  it('state backoff/off-env/off-robots → Yahoo price with Yahoo currency', async () => {
    for (const state of ['backoff', 'off-env', 'off-robots'] as const) {
      const s = setup({ state, tg: { 'AZN.L': tq('GB0009895292', 152.4, 153.9, NOW - 5_000), 'SAP.DE': tq('DE0007164600', 213, 212, NOW) } });
      await s.uk.tick();
      await s.eu.tick();
      expect(s.uk.snapshot()['AZN.L']).toMatchObject({ price: 12_000, prevClose: 11_900, changePct: 0.84, currency: 'GBp', venue: 'yahoo' });
      expect(s.eu.snapshot()['SAP.DE']).toMatchObject({ price: 212.5, prevClose: 210, currency: 'EUR', venue: 'yahoo' });
    }
    // A Tradegate quote older than 24 h falls back to Yahoo too.
    const stale = setup({ tg: { 'AZN.L': tq('GB0009895292', 152.4, 153.9, NOW - 25 * 3_600_000) } });
    await stale.uk.tick();
    expect(stale.uk.snapshot()['AZN.L']!.venue).toBe('yahoo');
  });

  it('GBp Yahoo price keeps GBp', async () => {
    const s = setup();
    await s.uk.tick();
    expect(s.uk.snapshot()['BT-A.L']).toEqual({
      price: 1234.5, prevClose: 1240, changePct: -0.44, at: new Date(NOW - 15 * 60_000).toISOString(), currency: 'GBp', venue: 'yahoo',
    });
  });

  it('outside 08:00–22:00 Berlin the last Tradegate close is served with its time', async () => {
    // 22:30 Berlin (21:30Z): the answer carries the session's last trade; its time is the 22:00 close.
    const late = Date.parse('2026-10-28T21:30:00.000Z');
    const s = setup({ now: late + 60_000, tg: { 'AZN.L': tq('GB0009895292', 152.8, 152.7, late) } });
    expect(s.uk.snapshot()['AZN.L']).toEqual({
      price: 152.8, prevClose: 152.7, changePct: 0.07, at: '2026-10-28T21:00:00.000Z', currency: 'EUR', venue: 'tradegate',
    });
  });
});
