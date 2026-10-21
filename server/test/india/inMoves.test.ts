import { describe, expect, it } from 'vitest';
import { chooseInExpiry, computeInExpectedMove, finalSnapshotDay, reactionMovePct, reactionWindow } from '../../src/india/domain/inMoves.js';
import { timingForRelease } from '../../src/india/domain/nseCalendar.js';
import { DateTime } from 'luxon';

const q = (strike: number, type: 'CE' | 'PE', bid: number, ask: number) => ({ strike, type, bid, ask });

describe('computeInExpectedMove', () => {
  it('uses bid/ask mids at the nearest strike quoted on both sides', () => {
    const em = computeInExpectedMove([
      q(1180, 'CE', 30, 31), q(1180, 'PE', 25, 26),
      q(1200, 'CE', 20, 0), q(1200, 'PE', 35, 36), // call has no ask: not usable
    ], 1195, '2026-10-27', 'RELIANCE');
    expect(em).toMatchObject({ strike: 1180, callMid: 30.5, putMid: 25.5, movePct: 4.69, illiquid: false });
  });

  it('null when the only quoted strike is more than 10% from the price', () => {
    expect(computeInExpectedMove([q(1000, 'CE', 5, 6), q(1000, 'PE', 5, 6)], 1200, '2026-10-27', 'X')).toBeNull();
  });

  it('flags a missing bid or a wide spread as illiquid', () => {
    expect(computeInExpectedMove([q(100, 'CE', 0, 4), q(100, 'PE', 3, 4)], 100, 'e', 'X')!.illiquid).toBe(true);
    expect(computeInExpectedMove([q(100, 'CE', 2, 4), q(100, 'PE', 3, 3.1)], 100, 'e', 'X')!.illiquid).toBe(true);
  });
});

describe('expiry and snapshot days', () => {
  it('after-close results on expiry day need the next expiry', () => {
    expect(chooseInExpiry(['2026-10-27', '2026-11-23'], '2026-10-27', 'AMC')).toBe('2026-11-23');
    expect(chooseInExpiry(['2026-10-27', '2026-11-23'], '2026-10-27', 'BMO')).toBe('2026-10-27');
  });

  it('final snapshot: same day for after close, the trading day before otherwise (skipping holidays)', () => {
    expect(finalSnapshotDay('2026-10-23', 'AMC')).toBe('2026-10-23');
    expect(finalSnapshotDay('2026-10-23', 'BMO')).toBe('2026-10-22');
    expect(finalSnapshotDay('2026-10-21', 'UNKNOWN')).toBe('2026-10-19'); // 10-20 is Diwali
    expect(finalSnapshotDay('2026-10-24', 'AMC')).toBe('2026-10-23');     // Saturday
  });
});

describe('reaction move windows', () => {
  const closes = new Map([['2026-10-15', 100], ['2026-10-16', 104], ['2026-10-19', 95]]);
  it('during market: previous close to that day\'s close', () => {
    expect(reactionMovePct(closes, reactionWindow('2026-10-16', 'DMH'))).toBe(4);
  });
  it('after close: that close to the next session\'s close', () => {
    expect(reactionWindow('2026-10-16', 'AMC')).toEqual({ before: '2026-10-16', after: '2026-10-19' });
    expect(reactionMovePct(closes, reactionWindow('2026-10-16', 'AMC'))).toBe(-8.65);
  });
  it('a Saturday result reacts on Monday', () => {
    expect(reactionWindow('2026-10-17', 'DMH')).toEqual({ before: '2026-10-16', after: '2026-10-19' });
  });
  it('a missing close gives null', () => {
    expect(reactionMovePct(closes, { before: '2026-10-14', after: '2026-10-15' })).toBeNull();
  });
});

describe('timingForRelease', () => {
  const at = (iso: string) => DateTime.fromISO(iso, { zone: 'Asia/Kolkata' });
  it('by the IST clock on the day', () => {
    expect(timingForRelease('2026-10-16', at('2026-10-16T08:59'))).toBe('BMO');
    expect(timingForRelease('2026-10-16', at('2026-10-16T15:30'))).toBe('DMH');
    expect(timingForRelease('2026-10-16', at('2026-10-16T15:31'))).toBe('AMC');
  });
  it('a Saturday release is like after close', () => {
    expect(timingForRelease('2026-10-17', at('2026-10-17T12:00'))).toBe('AMC');
  });
  it('after the next open, or before the day: not this report', () => {
    expect(timingForRelease('2026-10-16', at('2026-10-19T09:20'))).toBeNull();
    expect(timingForRelease('2026-10-16', at('2026-10-15T20:00'))).toBeNull();
  });
});
