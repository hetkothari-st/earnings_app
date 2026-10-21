import { beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../../src/config.js';
import { openDb } from '../../src/db/repo.js';
import type { JobContext, Sources } from '../../src/jobs/context.js';

const calls = vi.hoisted(() => ({ http: [] as { minIntervalMs: number; ua?: string }[], shares: [] as unknown[] }));
vi.mock('../../src/sources/http.js', async (orig) => {
  const real = await orig<typeof import('../../src/sources/http.js')>();
  return {
    ...real,
    makeHttp: (opts: { minIntervalMs: number; headers?: Record<string, string> }) => {
      calls.http.push({ minIntervalMs: opts.minIntervalMs, ua: opts.headers?.['User-Agent'] });
      return real.makeHttp(opts);
    },
  };
});
vi.mock('../../src/jobs/shares.js', () => ({ refreshUsShares: vi.fn(async (_ctx: unknown, http: unknown) => { calls.shares.push(http); }) }));

const { createSources } = await import('../../src/sources/index.js');
const { usSharesJob } = await import('../../src/jobs/scheduler.js');

const cfg = (secUserAgent: string) => ({ ...config, secUserAgent });

describe('one shared SEC client (<= 10 requests/s in total)', () => {
  beforeEach(() => { calls.http.length = 0; calls.shares.length = 0; });

  test('createSources builds exactly one SEC client, 120 ms apart, and exposes it', () => {
    const sources = createSources(cfg('Test Agent test@example.com'));
    const sec = calls.http.filter((c) => c.ua === 'Test Agent test@example.com');
    expect(sec).toEqual([{ minIntervalMs: 120, ua: 'Test Agent test@example.com' }]);
    expect(sources.secHttp).toBeDefined();
  });

  test('without SEC_USER_AGENT there is no SEC client to share', () => {
    expect(createSources(cfg('')).secHttp).toBeUndefined();
  });

  test('the shares job runs on the same client that the 8-K watcher gets', async () => {
    const sources = createSources(cfg('Test Agent test@example.com'));
    const ctx: JobContext = { db: openDb(':memory:'), sources, now: () => '2026-10-15T20:30:00.000Z', today: () => '2026-10-15' };
    await usSharesJob(ctx)!();
    expect(calls.shares).toEqual([sources.secHttp]);
    expect(calls.shares[0]).toBe(sources.secHttp);
    expect(usSharesJob({ ...ctx, sources: {} as Sources })).toBeNull();
  });
});
