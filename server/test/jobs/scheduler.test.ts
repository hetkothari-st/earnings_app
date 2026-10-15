import { describe, expect, test, vi } from 'vitest';
import { listSourceStatus, openDb } from '../../src/db/repo.js';
import { isTradingDay } from '../../src/domain/marketCalendar.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';
import { createJobRunner } from '../../src/jobs/scheduler.js';

const NOW = '2026-10-15T20:30:00.000Z';

function makeCtx(): JobContext {
  return { db: openDb(':memory:'), sources: {} as Sources, now: () => NOW, today: () => '2026-10-15' };
}

describe('job runner', () => {
  test('a market-calendar RangeError inside a job is recorded as a calendar source error', async () => {
    const ctx = makeCtx();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await createJobRunner(ctx)('calendar', async () => { isTradingDay('2031-01-02'); })();
    expect(listSourceStatus(ctx.db)).toContainEqual(expect.objectContaining({
      source: 'calendar', lastError: 'Market calendar does not cover 2031-01-02; add 2031 to marketCalendar.ts', lastErrorAt: NOW,
    }));
  });
  test('other job errors are not recorded as calendar errors', async () => {
    const ctx = makeCtx();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await createJobRunner(ctx)('calendar', async () => { throw new Error('boom'); })();
    expect(listSourceStatus(ctx.db).find((s) => s.source === 'calendar')).toBeUndefined();
  });
});
