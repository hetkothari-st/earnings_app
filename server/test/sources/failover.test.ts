import { describe, expect, test } from 'vitest';
import { openDb, listSourceStatus } from '../../src/db/repo.js';
import { BlockedError, createFailover, looksBlocked } from '../../src/sources/failover.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-21T12:00:00Z');

function setup() {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const failover = createFailover(db, () => clock.t);
  const row = (name: string) => listSourceStatus(db).find((s) => s.source === name);
  return { db, clock, failover, row };
}
const ok = <T>(name: string, v: T) => ({ name, run: async () => v });
const blocked = (name: string) => ({ name, run: async (): Promise<string> => { throw new BlockedError(name, 'HTTP 429'); } });

describe('failover', () => {
  test('fast success returns via fast and records ok', async () => {
    const { failover, row } = setup();
    expect(await failover(ok('sec', 'x'), ok('bk', 'y'))).toEqual({ value: 'x', via: 'fast' });
    expect(row('sec')).toMatchObject({ state: 'ok', blockedUntil: null });
    expect(row('sec')?.lastSuccessAt).not.toBeNull();
  });

  test('a BlockedError skips fast for 1 minute, then 2, then 5', async () => {
    const { failover, clock, row } = setup();
    let calls = 0;
    const fast = { name: 'sec', run: async (): Promise<string> => { calls++; throw new BlockedError('sec', 'x'); } };
    await failover(fast, null);
    expect(calls).toBe(1);
    expect(row('sec')?.blockedUntil).toBe(new Date(T0 + 1 * MIN).toISOString());
    clock.t = T0 + 30_000;
    await failover(fast, null);
    expect(calls).toBe(1); // skipped
    clock.t = T0 + 1 * MIN;
    await failover(fast, null);
    expect(calls).toBe(2);
    expect(row('sec')?.blockedUntil).toBe(new Date(T0 + 1 * MIN + 2 * MIN).toISOString());
    clock.t = T0 + 3 * MIN;
    await failover(fast, null);
    expect(row('sec')?.blockedUntil).toBe(new Date(T0 + 3 * MIN + 5 * MIN).toISOString());
    expect(row('sec')?.state).toBe('blocked');
  });

  test('backoff caps at 30 minutes and resets after a fast success', async () => {
    const { failover, clock, row } = setup();
    for (let i = 0; i < 7; i++) {
      await failover(blocked('sec'), null);
      clock.t = Date.parse(row('sec')!.blockedUntil!);
    }
    expect(Date.parse(row('sec')!.blockedUntil!) - clock.t).toBe(0);
    await failover(blocked('sec'), null);
    expect(Date.parse(row('sec')!.blockedUntil!) - clock.t).toBe(30 * MIN);
    clock.t += 30 * MIN;
    await failover(ok('sec', 'x'), null);
    expect(row('sec')).toMatchObject({ state: 'ok', blockedUntil: null });
    await failover(blocked('sec'), null);
    expect(Date.parse(row('sec')!.blockedUntil!) - clock.t).toBe(1 * MIN);
  });

  test('backup is used while fast is blocked and state is backup', async () => {
    const { failover, clock, row } = setup();
    const r1 = await failover(blocked('sec'), ok('bk', 'b'));
    expect(r1).toEqual({ value: 'b', via: 'backup' });
    expect(row('sec')?.state).toBe('backup');
    expect(row('bk')?.lastSuccessAt).not.toBeNull();
    clock.t = T0 + 10_000; // still blocked: fast is not called
    let fastCalls = 0;
    const r2 = await failover({ name: 'sec', run: async () => { fastCalls++; return 'f'; } }, ok('bk', 'b'));
    expect(r2).toEqual({ value: 'b', via: 'backup' });
    expect(fastCalls).toBe(0);
  });

  test('three consecutive non-block errors back off for 1 minute', async () => {
    const { failover, clock, row } = setup();
    const bad = { name: 'sec', run: async (): Promise<string> => { throw new Error('boom'); } };
    await failover(bad, null);
    await failover(bad, null);
    expect(row('sec')).toMatchObject({ state: 'failing', blockedUntil: null, lastError: 'boom' });
    await failover(bad, null);
    expect(row('sec')?.blockedUntil).toBe(new Date(T0 + MIN).toISOString());
    expect(clock.t).toBe(T0);
  });

  test('a 200 HTML "Request Rate Threshold Exceeded" body counts as blocked', () => {
    expect(looksBlocked(200, '<html>Request Rate Threshold Exceeded</html>')).toBe(true);
    expect(looksBlocked(403, '')).toBe(true);
    expect(looksBlocked(429, '')).toBe(true);
    expect(looksBlocked(200, 'Just a moment...')).toBe(true);
    expect(looksBlocked(200, '{"ok":true}')).toBe(false);
    expect(looksBlocked(200, '<html><body>hi</body></html>', true)).toBe(true);
    expect(looksBlocked(200, '<html><body>hi</body></html>')).toBe(false);
  });

  test('both failing returns null and never throws', async () => {
    const { failover, row } = setup();
    const bad = (n: string) => ({ name: n, run: async (): Promise<string> => { throw new Error('down'); } });
    await expect(failover(bad('sec'), bad('bk'))).resolves.toBeNull();
    expect(row('sec')?.state).toBe('failing');
    expect(row('bk')?.lastError).toBe('down');
  });
});
