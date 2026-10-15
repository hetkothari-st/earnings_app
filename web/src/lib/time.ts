import { DateTime, IANAZone } from 'luxon';
import type { Timing } from '../../../server/src/api/types';

export const ET = 'America/New_York';
export const FALLBACK_ZONE = 'Asia/Kolkata';

export function detectZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && IANAZone.isValidZone(z) ? z : FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE;
  }
}

export function todayEt(): string {
  return DateTime.now().setZone(ET).toISODate()!;
}

/** "IST" for India (en-US would say GMT+5:30); otherwise the en-US short name, e.g. EDT, GMT+4. */
export function zoneLabel(zone: string, date: string): string {
  if (zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta') return 'IST';
  return DateTime.fromISO(`${date}T12:00`, { zone }).setLocale('en-US').offsetNameShort ?? zone;
}

const clock = (d: DateTime) => d.setLocale('en-US').toFormat('h:mm a');

export function describeTiming(
  reportDate: string, timing: Timing, sessionClose: string, zone: string,
): { et: string; local: string; nextDay: boolean } {
  const at = (hhmm: string) => DateTime.fromISO(`${reportDate}T${hhmm}`, { zone: ET });
  const open = at('09:30');
  const close = at(sessionClose);
  const local = (d: DateTime) => d.setZone(zone);
  const shifted = (d: DateTime) => local(d).toISODate()! > reportDate;

  switch (timing) {
    case 'BMO':
      return { et: 'BMO · before 9:30 AM', local: `before ${clock(local(open))}`, nextDay: shifted(open) };
    case 'AMC':
      return { et: `AMC · after ${clock(close)}`, local: `after ${clock(local(close))}`, nextDay: shifted(close) };
    case 'DMH':
      return {
        et: `During market · 9:30 AM–${clock(close)}`,
        local: `${clock(local(open))}–${clock(local(close))}`,
        nextDay: shifted(close),
      };
    default:
      return { et: 'Time not announced', local: '—', nextDay: false };
  }
}
