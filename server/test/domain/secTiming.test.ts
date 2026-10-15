import { describe, expect, test } from 'vitest';
import { checkTiming, deriveFromAcceptance } from '../../src/domain/secTiming.js';

describe('deriveFromAcceptance', () => {
  test('real JPM case: 06:30:38 ET on report day is before the open', () => {
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T06:30:38')).toBe('BMO');
  });
  test('boundaries', () => {
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T09:29:59')).toBe('BMO');
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T09:30:00')).toBe('BEFORE_CLOSE');
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T15:59:59')).toBe('BEFORE_CLOSE');
    expect(deriveFromAcceptance('2026-10-13', '2026-10-13T16:00:00')).toBe('AMC');
  });
  test('early close day uses 13:00', () => {
    expect(deriveFromAcceptance('2026-11-27', '2026-11-27T13:05:00')).toBe('AMC');
    expect(deriveFromAcceptance('2026-11-27', '2026-11-27T12:59:00')).toBe('BEFORE_CLOSE');
  });
  test('filing on another day proves nothing', () => {
    expect(deriveFromAcceptance('2026-10-13', '2026-10-12T17:00:00')).toBeNull();
  });
});

describe('checkTiming (spec 6.6 table)', () => {
  const cases: [Parameters<typeof checkTiming>[0], Parameters<typeof checkTiming>[1], string, string][] = [
    ['BMO', 'BMO', 'verified', 'BMO'],
    ['BMO', 'BEFORE_CLOSE', 'unverifiable', 'BMO'],
    ['BMO', 'AMC', 'unverifiable', 'BMO'],
    ['AMC', 'BMO', 'contradicted', 'AMC'],
    ['AMC', 'BEFORE_CLOSE', 'contradicted', 'AMC'],
    ['AMC', 'AMC', 'consistent', 'AMC'],
    ['DMH', 'BMO', 'contradicted', 'DMH'],
    ['DMH', 'BEFORE_CLOSE', 'consistent', 'DMH'],
    ['DMH', 'AMC', 'unverifiable', 'DMH'],
    ['UNKNOWN', 'BMO', 'derived', 'BMO'],
    ['UNKNOWN', 'BEFORE_CLOSE', 'unverifiable', 'UNKNOWN'],
    ['UNKNOWN', 'AMC', 'unverifiable', 'UNKNOWN'],
    ['AMC', null, 'unverifiable', 'AMC'],
    ['UNKNOWN', null, 'unverifiable', 'UNKNOWN'],
  ];
  test.each(cases)('label %s + derived %s -> %s (%s)', (label, derived, check, timing) => {
    expect(checkTiming(label, derived)).toEqual({ check, timing });
  });
});
