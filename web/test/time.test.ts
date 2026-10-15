import { describe, expect, test } from 'vitest';
import { describeTiming, zoneLabel } from '../src/lib/time';

describe('describeTiming', () => {
  test('BMO in IST during US daylight time', () => {
    expect(describeTiming('2026-10-15', 'BMO', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'BMO · before 9:30 AM', local: 'before 7:00 PM', nextDay: false });
  });
  test('AMC in IST crosses midnight (+1), EDT vs EST', () => {
    expect(describeTiming('2026-10-15', 'AMC', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'AMC · after 4:00 PM', local: 'after 1:30 AM', nextDay: true });
    expect(describeTiming('2026-12-10', 'AMC', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'AMC · after 4:00 PM', local: 'after 2:30 AM', nextDay: true });
  });
  test('early close day', () => {
    expect(describeTiming('2026-11-27', 'AMC', '13:00', 'Asia/Kolkata'))
      .toEqual({ et: 'AMC · after 1:00 PM', local: 'after 11:30 PM', nextDay: false });
  });
  test('London in the week US is on EDT but UK is on GMT', () => {
    expect(describeTiming('2026-10-29', 'AMC', '16:00', 'Europe/London').local).toBe('after 8:00 PM');
    expect(describeTiming('2026-10-15', 'AMC', '16:00', 'Europe/London').local).toBe('after 9:00 PM');
  });
  test('user in New York sees the same clock', () => {
    expect(describeTiming('2026-10-15', 'AMC', '16:00', 'America/New_York').local).toBe('after 4:00 PM');
  });
  test('during market and unknown', () => {
    expect(describeTiming('2026-10-15', 'DMH', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'During market · 9:30 AM–4:00 PM', local: '7:00 PM–1:30 AM', nextDay: true });
    expect(describeTiming('2026-10-15', 'UNKNOWN', '16:00', 'Asia/Kolkata'))
      .toEqual({ et: 'Time not announced', local: '—', nextDay: false });
  });
});

describe('zoneLabel', () => {
  test('IST is named; others use the short offset name', () => {
    expect(zoneLabel('Asia/Kolkata', '2026-10-15')).toBe('IST');
    expect(zoneLabel('America/New_York', '2026-10-15')).toBe('EDT');
    expect(zoneLabel('America/New_York', '2026-12-10')).toBe('EST');
  });
});
