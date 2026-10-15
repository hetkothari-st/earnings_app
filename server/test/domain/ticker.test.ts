import { describe, expect, test } from 'vitest';
import { normalizeTicker } from '../../src/domain/ticker.js';

describe('normalizeTicker', () => {
  test('class-share spellings from every source collapse to one key', () => {
    expect(normalizeTicker('BRK/B')).toBe('BRK-B');
    expect(normalizeTicker('BRK.B')).toBe('BRK-B');
    expect(normalizeTicker('BRK-B')).toBe('BRK-B');
  });
  test('trims and upper-cases', () => {
    expect(normalizeTicker(' jpm ')).toBe('JPM');
  });
});
