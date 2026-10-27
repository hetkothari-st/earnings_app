import {
  firstUsSessionAfterRelease, lastUsCloseBefore, reactionWindow, localDateFromUs,
} from '../../domain/adrSessions.js';
import { HK_CAL, type HkTiming } from './hkCalendar.js';

/** First US session that can react to an HK release (Ruling 6); see `firstUsSessionAfterRelease`. */
export function firstUsSessionAfterHkRelease(reportDate: string, timing: HkTiming, releasedAt: string | null): string {
  return firstUsSessionAfterRelease(reportDate, timing, releasedAt);
}

/** The US close the options quotes are final at: last US close before the HK date. */
export function lastUsCloseBeforeHk(reportDate: string): string {
  return lastUsCloseBefore(reportDate);
}

/** Close-to-close days around an HK report, on the HK calendar (same rule as India). */
export function hkReactionWindow(reportDate: string, timing: Exclude<HkTiming, 'UNKNOWN'>): { before: string; after: string } {
  return reactionWindow(HK_CAL, reportDate, timing);
}

/** An ADR's US report row as an HK date: US after-close rolls to the next calendar day, anything else is the same day (Ruling 5). */
export function hkDateFromUs(usDate: string, usTiming: 'BMO' | 'AMC' | 'DMH' | 'UNKNOWN'): string {
  return localDateFromUs(HK_CAL, usDate, usTiming);
}
