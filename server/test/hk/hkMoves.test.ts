import { describe, it, expect } from 'vitest';
import {
  firstUsSessionAfterHkRelease, lastUsCloseBeforeHk, hkReactionWindow, hkDateFromUs,
} from '../../src/hk/domain/hkMoves.js';

describe('hkMoves', () => {
  it('first US session after the HK release', () => {
    expect(firstUsSessionAfterHkRelease('2026-11-20', 'AMC', null)).toBe('2026-11-20');
    expect(firstUsSessionAfterHkRelease('2026-11-20', 'UNKNOWN', null)).toBe('2026-11-23');
    expect(firstUsSessionAfterHkRelease('2026-11-26', 'BMO', null)).toBe('2026-11-27');
    expect(firstUsSessionAfterHkRelease('2026-11-20', 'AMC', '2026-11-20T15:00:00Z')).toBe('2026-11-23');
  });
  it('last US close before', () => {
    expect(lastUsCloseBeforeHk('2026-11-20')).toBe('2026-11-19');
  });
  it('reaction window', () => {
    expect(hkReactionWindow('2026-11-20', 'AMC')).toEqual({ before: '2026-11-20', after: '2026-11-23' });
    expect(hkReactionWindow('2026-11-20', 'BMO')).toEqual({ before: '2026-11-19', after: '2026-11-20' });
    expect(hkReactionWindow('2026-10-19', 'AMC')).toEqual({ before: '2026-10-16', after: '2026-10-20' });
  });
  it('US date to HK date', () => {
    expect(hkDateFromUs('2026-11-19', 'AMC')).toBe('2026-11-20');
    expect(hkDateFromUs('2026-11-20', 'BMO')).toBe('2026-11-20');
  });
});
