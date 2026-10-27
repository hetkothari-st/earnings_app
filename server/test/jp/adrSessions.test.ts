import { describe, it, expect } from 'vitest';
import { firstUsSessionAfterRelease, lastUsCloseBefore } from '../../src/domain/adrSessions.js';

describe('adrSessions', () => {
  it('first US session after a local release', () => {
    expect(firstUsSessionAfterRelease('2026-11-20', 'AMC', null)).toBe('2026-11-20');
    expect(firstUsSessionAfterRelease('2026-11-20', 'UNKNOWN', null)).toBe('2026-11-23');
    expect(firstUsSessionAfterRelease('2026-11-26', 'BMO', null)).toBe('2026-11-27');
    expect(firstUsSessionAfterRelease('2026-11-20', 'AMC', '2026-11-20T15:00:00Z')).toBe('2026-11-23');
    expect(firstUsSessionAfterRelease('2026-11-26', 'AMC', null)).toBe('2026-11-27'); // Thanksgiving
  });
  it('last US close before', () => {
    expect(lastUsCloseBefore('2026-11-20')).toBe('2026-11-19');
  });
});
