import { describe, expect, test } from 'vitest';
import { PriceBook } from '../../src/domain/priceBook.js';

describe('PriceBook', () => {
  test('latest trade per symbol with change vs previous close', () => {
    const book = new PriceBook();
    book.setPrevClose('TSM', 430);
    const changed = book.applyTrades([
      { s: 'TSM', p: 421.1, t: 1792070000000 },
      { s: 'TSM', p: 422.55, t: 1792070001000 },
    ]);
    expect(changed).toEqual(['TSM']);
    expect(book.get('TSM')).toEqual({ price: 422.55, prevClose: 430, changePct: -1.73, time: 1792070001000 });
  });
  test('out-of-order older trades never overwrite a newer one', () => {
    const book = new PriceBook();
    book.applyTrades([{ s: 'A', p: 10, t: 2000 }]);
    expect(book.applyTrades([{ s: 'A', p: 9, t: 1000 }])).toEqual([]);
    expect(book.get('A')!.price).toBe(10);
  });
  test('without a previous close the change is unknown, not zero', () => {
    const book = new PriceBook();
    book.applyTrades([{ s: 'A', p: 10, t: 1 }]);
    expect(book.get('A')!.changePct).toBeNull();
  });
  test('a quote snapshot seeds price and close; trades then take over', () => {
    const book = new PriceBook();
    book.setQuote('PLD', { price: 130.46, prevClose: 128.0, time: 500 });
    expect(book.get('PLD')).toEqual({ price: 130.46, prevClose: 128, changePct: 1.92, time: 500 });
    book.applyTrades([{ s: 'PLD', p: 131, t: 600 }]);
    expect(book.get('PLD')!.price).toBe(131);
  });
  test('snapshot of only the requested symbols', () => {
    const book = new PriceBook();
    book.applyTrades([{ s: 'A', p: 1, t: 1 }, { s: 'B', p: 2, t: 1 }]);
    expect(Object.keys(book.snapshot(['B', 'Z']))).toEqual(['B']);
  });
});
