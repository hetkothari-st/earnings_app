import type { EuropeMarket } from '../europe/exchanges.js';

/**
 * The one Yahoo date sweep at a time: JP, UK and EU calendar sweeps share the Yahoo budget, so each takes a turn
 * (first come, first served) instead of running side by side.
 */
export interface SweepTurns {
  run<T>(who: 'jp' | 'uk' | 'eu', fn: () => Promise<T>): Promise<T>;
  /** Who holds the turn now, or null. */
  active(): string | null;
}

export function createSweepTurns(): SweepTurns {
  let tail: Promise<unknown> = Promise.resolve();
  let current: string | null = null;
  return {
    run<T>(who: 'jp' | 'uk' | 'eu', fn: () => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        current = who;
        try {
          return await fn();
        } finally {
          current = null;
        }
      });
      // The next turn waits for this one to settle, failed or not.
      tail = result.catch(() => {});
      return result;
    },
    active: () => current,
  };
}

export const sweepTurns: SweepTurns = createSweepTurns();

/**
 * Symbols per 10-minute Europe date-sweep run. In the reporting seasons (`peakWindows`, [from, to] as MM-DD,
 * inclusive) more symbols are near-term, so each run takes more; with JP's 90 the peak total stays at 300.
 */
export const EUROPE_DATE_SWEEP = {
  UK: { perRun: 20, peakPerRun: 60 },
  EU: { perRun: 50, peakPerRun: 150 },
  peakWindows: [['01-20', '03-10'], ['04-20', '05-31'], ['07-20', '08-31'], ['10-20', '11-30']],
} as const;

/** Symbols per date-sweep run for `market` on the local date `today` (YYYY-MM-DD). */
export function europeDateSweepPerRun(market: EuropeMarket, today: string): number {
  const md = today.slice(5);
  const peak = EUROPE_DATE_SWEEP.peakWindows.some(([from, to]) => md >= from && md <= to);
  return peak ? EUROPE_DATE_SWEEP[market].peakPerRun : EUROPE_DATE_SWEEP[market].perRun;
}
