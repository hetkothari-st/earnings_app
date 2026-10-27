import { describe, it, expect } from 'vitest';
import { parseRatioPhrase } from '../../src/cli/verifyJpUniverse.js';

describe('parseRatioPhrase', () => {
  it('words, decimals and fractions', () => {
    expect(parseRatioPhrase('ten')).toBe(10);
    expect(parseRatioPhrase('one')).toBe(1);
    expect(parseRatioPhrase('0.2')).toBe(0.2);
    expect(parseRatioPhrase('one-fifth of one')).toBe(0.2);
    expect(parseRatioPhrase('one-half of one')).toBe(0.5);
    expect(parseRatioPhrase('two-tenths')).toBeCloseTo(0.2);
    expect(parseRatioPhrase('1/5')).toBeCloseTo(0.2);
    expect(parseRatioPhrase('gibberish')).toBeNull();
  });
});
