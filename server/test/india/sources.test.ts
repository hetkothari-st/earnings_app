import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { equityTokens, filterOptionInstruments, optionExpiries, parseKiteInstruments } from '../../src/india/sources/foList.js';
import { parseKiteCandles, parseKiteQuotes } from '../../src/india/sources/kiteApi.js';
import { tokenExpiry } from '../../src/india/sources/kiteLogin.js';
import { parseKiteFrame } from '../../src/india/sources/kiteStream.js';
import { parseYahooInSummary } from '../../src/india/sources/yahooIn.js';

const fixture = (f: string) => readFileSync(new URL(`../fixtures/india/${f}`, import.meta.url), 'utf8');

describe('Kite instruments CSV', () => {
  const list = parseKiteInstruments(fixture('kite_instruments_sample.csv'));

  it('strips the quotes around names so options match their underlying', () => {
    expect(optionExpiries(list, 'RELIANCE')).toContain('2026-10-27');
    const chain = filterOptionInstruments(list, 'RELIANCE', '2026-10-27');
    expect(chain.map((o) => `${o.strike}${o.instrumentType}`)).toContain('1180CE');
  });

  it('equity tokens only from the NSE cash segment (not indices)', () => {
    const csv = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n'
      + '738561,2885,RELIANCE,"RELIANCE INDUSTRIES",0,,0,0.1,1,EQ,NSE,NSE\n256265,1001,NIFTY 50,"NIFTY 50",0,,0,0,0,EQ,INDICES,NSE\n';
    expect([...equityTokens(parseKiteInstruments(csv))]).toEqual([['RELIANCE', 738561]]);
  });
});

describe('Kite REST parsing', () => {
  it('quotes: best bid/ask, empty levels count as 0', () => {
    const m = parseKiteQuotes({ status: 'success', data: { 'NFO:X': {
      instrument_token: 1, last_price: 30, ohlc: { close: 28 }, timestamp: '2026-10-16 15:25:00',
      depth: { buy: [{ price: 29.5, quantity: 500 }], sell: [{ price: 0, quantity: 0 }] },
    } } });
    expect(m.get('NFO:X')).toMatchObject({ lastPrice: 30, prevClose: 28, bid: 29.5, ask: 0 });
  });

  it('rejects an error body', () => {
    expect(() => parseKiteQuotes({ status: 'error', message: 'TokenException' })).toThrow();
    expect(() => parseKiteCandles({ status: 'success', data: {} })).toThrow();
  });

  it('candles keep the IST date', () => {
    expect(parseKiteCandles({ status: 'success', data: { candles: [['2026-10-14T00:00:00+0530', 1, 2, 0.5, 1.5, 10]] } })[0])
      .toMatchObject({ date: '2026-10-14', close: 1.5 });
  });
});

describe('Kite ticker frames', () => {
  const frame = (packets: ArrayBuffer[]) => {
    const total = 2 + packets.reduce((n, p) => n + 2 + p.byteLength, 0);
    const buf = new ArrayBuffer(total);
    const v = new DataView(buf);
    v.setInt16(0, packets.length);
    let o = 2;
    for (const p of packets) {
      v.setInt16(o, p.byteLength);
      new Uint8Array(buf, o + 2).set(new Uint8Array(p));
      o += 2 + p.byteLength;
    }
    return buf;
  };
  const packet = (len: number, fields: [number, number][]) => {
    const b = new ArrayBuffer(len);
    const v = new DataView(b);
    for (const [off, val] of fields) v.setInt32(off, val);
    return b;
  };

  it('stock (quote mode) and index packets, prices in paise', () => {
    const ticks = parseKiteFrame(frame([
      packet(44, [[0, 738561], [4, 121550], [40, 117460]]),
      packet(28, [[0, 256265], [4, 2500000], [20, 2480000]]),
    ]));
    expect(ticks).toEqual([
      { token: 738561, ltp: 1215.5, close: 1174.6, isIndex: false, bid: null, ask: null },
      { token: 256265, ltp: 25000, close: 24800, isIndex: true, bid: null, ask: null },
    ]);
  });

  it('full packet: bid 29.50 ask 31.00 parsed from depth', () => {
    // 184 bytes; depth from byte 64: five 12-byte bids (quantity, price, orders, pad), then five offers.
    const [t] = parseKiteFrame(frame([packet(184, [[0, 11111], [4, 3000], [40, 2900], [64, 75], [68, 2950], [124, 50], [128, 3100]])]));
    expect(t).toEqual({ token: 11111, ltp: 30, close: 29, isIndex: false, bid: 29.5, ask: 31 });
  });

  it('full packet with an empty side: 0 means no order', () => {
    const [t] = parseKiteFrame(frame([packet(184, [[0, 11111], [4, 3000], [40, 2900], [128, 3100]])]));
    expect(t).toMatchObject({ bid: 0, ask: 31 });
  });

  it('heartbeats and LTP-only packets give nothing', () => {
    expect(parseKiteFrame(new ArrayBuffer(1))).toEqual([]);
    expect(parseKiteFrame(frame([packet(8, [[0, 738561], [4, 100]])]))).toEqual([]);
  });
});

describe('Kite token expiry', () => {
  it('06:00 IST the next morning', () => {
    expect(new Date(tokenExpiry(Date.parse('2026-10-16T02:15:00Z'))).toISOString()).toBe('2026-10-17T00:30:00.000Z');
    expect(new Date(tokenExpiry(Date.parse('2026-10-16T00:00:00Z'))).toISOString()).toBe('2026-10-16T00:30:00.000Z');
  });
});

describe('Yahoo .NS quoteSummary', () => {
  it('RELIANCE: sector, market cap, quarterly consensus only', () => {
    const y = parseYahooInSummary(JSON.parse(fixture('yqs_RELIANCE.NS.json')));
    expect(y).toMatchObject({ sector: 'Energy', marketCap: 16_360_759_361_536, nextDate: '2026-10-23' });
    expect(y.quarters.map((q) => q.periodEnd)).toEqual(['2026-09-30', '2026-12-31']);
    expect(y.quarters[0]).toEqual({ periodEnd: '2026-09-30', eps: 17.30714, epsAnalysts: 7, revenue: 3_207_094_545_450, revenueAnalysts: 11 });
  });

  it('HDFCBANK: the annual estimate ending 2027-03-31 is never used as the March quarter', () => {
    const y = parseYahooInSummary(JSON.parse(fixture('yqs_HDFCBANK.NS.json')));
    expect(y.quarters.find((q) => q.periodEnd === '2027-03-31')).toMatchObject({ eps: null, epsAnalysts: null });
  });
});
