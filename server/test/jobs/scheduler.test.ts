import { beforeEach, describe, expect, test, vi } from 'vitest';
import { listSourceStatus, openDb } from '../../src/db/repo.js';
import { isTradingDay } from '../../src/domain/marketCalendar.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';
import { refreshCalendar } from '../../src/jobs/refreshCalendar.js';
import { createJobRunner, warmUp } from '../../src/jobs/scheduler.js';

const log = vi.hoisted(() => [] as string[]);
vi.mock('../../src/jobs/refreshResults.js', () => ({ refreshResults: vi.fn(async () => { log.push('results'); }) }));
vi.mock('../../src/jobs/refreshCalendar.js', () => ({ refreshCalendar: vi.fn(async () => { log.push('calendar'); }) }));
vi.mock('../../src/jobs/sectors.js', () => ({ refreshSectors: vi.fn(async () => { log.push('sectors'); }) }));
vi.mock('../../src/jobs/snapshotMoves.js', () => ({ snapshotMoves: vi.fn(async () => { log.push('moves'); }) }));
vi.mock('../../src/jobs/prevMoves.js', () => ({ computePrevMoves: vi.fn(async () => { log.push('prevMoves'); }) }));

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

describe('startup warm-up', () => {
  beforeEach(() => { log.length = 0; vi.clearAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  test('runs results, calendar, sectors, moves, previous moves in that order', async () => {
    await warmUp(makeCtx(), createJobRunner(makeCtx()));
    expect(log).toEqual(['results', 'calendar', 'sectors', 'moves', 'prevMoves']);
  });
  test('does not refresh the calendar while the scheduled calendar job is still running', async () => {
    const ctx = makeCtx();
    const job = createJobRunner(ctx);
    let release!: () => void;
    const scheduled = job('calendar', () => new Promise<void>((r) => { release = r; }))();
    await warmUp(ctx, job);
    expect(refreshCalendar).not.toHaveBeenCalled();
    expect(log).toEqual(['results', 'sectors', 'moves', 'prevMoves']);
    release();
    await scheduled;
  });
});
