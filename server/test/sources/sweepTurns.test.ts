import { describe, expect, it } from 'vitest';
import { jpDateSweepPerRun } from '../../src/jp/jobs/scheduler.js';
import { createSweepTurns, europeDateSweepPerRun } from '../../src/sources/sweepTurns.js';

describe('sweepTurns', () => {
  it('jp, uk and eu runs never overlap and run in arrival order', async () => {
    const t = createSweepTurns();
    const log: string[] = [];
    let running = 0;
    const job = (name: string, ms: number) => async () => {
      running++;
      expect(running).toBe(1);
      expect(t.active()).toBe(name);
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      running--;
      return name;
    };
    const out = await Promise.all([t.run('jp', job('jp', 20)), t.run('uk', job('uk', 5)), t.run('eu', job('eu', 1))]);
    expect(out).toEqual(['jp', 'uk', 'eu']);
    expect(log).toEqual(['start jp', 'end jp', 'start uk', 'end uk', 'start eu', 'end eu']);
    expect(t.active()).toBeNull();
  });

  it('a throwing run releases the turn', async () => {
    const t = createSweepTurns();
    const bad = t.run('uk', async () => { throw new Error('boom'); });
    const good = t.run('eu', async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
    expect(t.active()).toBeNull();
  });

  it('perRun: UK 20 on 2026-09-15, 60 on 2026-10-28; EU 150 on 2026-02-01', () => {
    expect(europeDateSweepPerRun('UK', '2026-09-15')).toBe(20);
    expect(europeDateSweepPerRun('UK', '2026-10-28')).toBe(60);
    expect(europeDateSweepPerRun('EU', '2026-02-01')).toBe(150);
    expect(europeDateSweepPerRun('EU', '2026-09-15')).toBe(50);
  });

  it('peak total with JP stays ≤ 300 per 10 min', () => {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) {
        const date = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const total = europeDateSweepPerRun('UK', date) + europeDateSweepPerRun('EU', date) + jpDateSweepPerRun(date);
        expect(total, date).toBeLessThanOrEqual(300);
      }
    }
  });
});
