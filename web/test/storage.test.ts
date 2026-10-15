import { describe, expect, test, vi } from 'vitest';
import { readJson, writeJson } from '../src/lib/storage';

describe('storage', () => {
  test('round trip', () => {
    writeJson('k', ['A']);
    expect(readJson('k', [])).toEqual(['A']);
  });
  test('corrupt or blocked storage falls back silently', () => {
    localStorage.setItem('bad', '{not json');
    expect(readJson('bad', ['x'])).toEqual(['x']);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => writeJson('k', 1)).not.toThrow();
    spy.mockRestore();
  });
});
