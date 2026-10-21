import { validate } from 'node-cron';
import { describe, expect, test } from 'vitest';
import { IN_CRONS } from '../../src/india/jobs/scheduler.js';
import { US_CRONS } from '../../src/jobs/scheduler.js';

describe('schedules', () => {
  test('cron strings match the spec', () => {
    // US (America/New_York)
    expect(US_CRONS.calendarNear).toBe('*/5 * * * *');        // calendar for the next 14 days every 5 min
    expect(US_CRONS.calendarFull).toBe('0 */2 * * *');        // the 90-day refresh stays every 2 h
    expect(US_CRONS.results).toBe('* 6-20 * * 1-5');          // every minute 06:00-20:59 weekdays, no midday gap
    expect(US_CRONS.yahooNear).toBe('0 * * * *');             // Yahoo estimates hourly for the next 7 days
    expect(US_CRONS.yahooFar).toBe('5 */6 * * *');            // every 6 h otherwise
    expect([...US_CRONS.live]).toEqual(['30-59 9 * * 1-5', '* 10-15 * * 1-5', '0-15 16 * * 1-5']); // 09:30-16:15
    // India (Asia/Kolkata)
    expect(IN_CRONS.calendar).toBe('* * * * *');
    expect(IN_CRONS.estimatesNear).toBe('0 * * * *');
    expect(IN_CRONS.estimatesFar).toBe('5 */6 * * *');
  });

  test('every expression is valid cron', () => {
    for (const expr of [...Object.values(US_CRONS).flat(), ...Object.values(IN_CRONS)]) expect(validate(expr), expr).toBe(true);
  });
});
