import { classifySixK, parseDateNoticeFor, pickReleaseDoc } from '../../sources/sixKClassify.js';
import type { HkTiming } from '../domain/hkCalendar.js';

/** The HK names of the shared 6-K classifier (`sources/sixKClassify.ts`), profile `'hk'`. */
export { pickReleaseDoc };

export type HkSpan = 'quarter' | 'half' | 'year';

export type HkExhibit =
  | { kind: 'results'; periodEnd: string; span: HkSpan }
  | { kind: 'date-notice'; date: string; timing: HkTiming }
  | { kind: 'other' };

/** Release date and timing from a date notice (Ruling 4). Dates are HK dates. */
export function parseDateNotice(text: string): { date: string; timing: HkTiming } | null {
  return parseDateNoticeFor(text, 'hk');
}

/** Classify an exhibit (or 6-K main document) as an earnings release, a results-date notice, or something else. */
export function classifyHkExhibit(html: string, opts: { filedOn?: string } = {}): HkExhibit {
  // The 'hk' profile never returns span 'nine'.
  return classifySixK(html, { ...opts, profile: 'hk' }) as HkExhibit;
}
