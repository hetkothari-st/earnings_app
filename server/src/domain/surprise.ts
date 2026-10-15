import type { BeatMiss } from '../api/types.js';

export function surprisePct(actual: number | null, estimate: number | null): number | null {
  if (actual == null || estimate == null || estimate === 0) return null;
  return Math.round(((actual - estimate) / Math.abs(estimate)) * 1000) / 10;
}

export function beatMiss(actual: number | null, estimate: number | null): BeatMiss | null {
  if (actual == null || estimate == null) return null;
  if (actual > estimate) return 'beat';
  if (actual < estimate) return 'miss';
  return 'inline';
}
