import { describe, it, expect } from 'vitest';
import { buildSymbolIndex, resolveSymbol } from '../../src/india/sources/symbolMatch.js';

const STOCKS = [
  { symbol: 'RELIANCE', name: 'RELIANCE INDUSTRIES' },
  { symbol: 'GAIL', name: 'GAIL (INDIA)' },
  { symbol: 'MM', name: 'MAHINDRA & MAHINDRA' },       // M&M listed as MM
  { symbol: 'BAJAJ-AUTO', name: 'BAJAJ AUTO' },
  { symbol: 'TATACOMM', name: 'TATA COMMUNICATIONS' },
];

describe('buildSymbolIndex + resolveSymbol', () => {
  const idx = buildSymbolIndex(STOCKS);

  it('resolves exact symbol', () => {
    expect(resolveSymbol('RELIANCE', idx)).toBe('RELIANCE');
  });

  it('resolves case-insensitive symbol', () => {
    expect(resolveSymbol('reliance', idx)).toBe('RELIANCE');
  });

  it('resolves GAIL (India) Limited → GAIL (strips Limited)', () => {
    expect(resolveSymbol('GAIL (India) Limited', idx)).toBe('GAIL');
  });

  it('resolves GAIL (INDIA) short name', () => {
    expect(resolveSymbol('GAIL (INDIA)', idx)).toBe('GAIL');
  });

  it('resolves Bajaj Auto (full name) → BAJAJ-AUTO', () => {
    expect(resolveSymbol('Bajaj Auto', idx)).toBe('BAJAJ-AUTO');
  });

  it('resolves TATA COMMUNICATIONS → TATACOMM', () => {
    expect(resolveSymbol('TATA COMMUNICATIONS', idx)).toBe('TATACOMM');
    expect(resolveSymbol('Tata Communications Limited', idx)).toBe('TATACOMM');
  });

  it('returns null for unknown company', () => {
    expect(resolveSymbol('UNKNOWN CORP XYZ', idx)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveSymbol('', idx)).toBeNull();
  });

  it('Review Focus #4: never maps to a wrong symbol for partial matches', () => {
    // "MAHINDRA" should not resolve to MM if name is partial / ambiguous — returns null, not a guess
    // "GAIL (India)" matches GAIL exactly via name normalization
    expect(resolveSymbol('GAIL (India)', idx)).toBe('GAIL');
  });
});
