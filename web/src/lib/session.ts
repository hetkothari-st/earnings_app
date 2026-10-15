import { DateTime } from 'luxon';
import type { Timing } from '../../../server/src/api/types';
import { ET } from './time';

// Axis spans the full US trading day: pre-market 4:00 ET to end of after-hours 20:00 ET.
const AXIS_START = '04:00';
const AXIS_HOURS = 16;

export interface SessionBand {
  open: number;        // 0..1 position of the 9:30 ET open
  close: number;       // 0..1 position of the session close
  openLabel: string;   // local clock, e.g. "7:00 PM"
  closeLabel: string;
  ticks: { at: number; label: string }[]; // every 3 local hours
}

const clock = (d: DateTime) => d.setLocale('en-US').toFormat('h:mm a');

export function sessionBand(date: string, sessionClose: string, zone: string): SessionBand {
  const at = (hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: ET });
  const start = at(AXIS_START);
  const end = start.plus({ hours: AXIS_HOURS });
  const pos = (d: DateTime) => d.diff(start, 'minutes').minutes / (AXIS_HOURS * 60);
  const open = at('09:30');
  const close = at(sessionClose);

  const ticks: SessionBand['ticks'] = [];
  let t = start.setZone(zone).startOf('hour');
  while (t <= end) {
    if (t >= start && t.hour % 3 === 0) ticks.push({ at: pos(t), label: t.setLocale('en-US').toFormat('h a') });
    t = t.plus({ hours: 1 });
  }

  return {
    open: pos(open),
    close: pos(close),
    openLabel: clock(open.setZone(zone)),
    closeLabel: clock(close.setZone(zone)),
    ticks,
  };
}

export interface DaySummary {
  date: string;
  bmo: number;
  amc: number;
  other: number;
}

export function daySummary(
  rows: { symbol: string; reportDate: string; timing: Timing }[],
  hidden: Set<string>,
): DaySummary[] {
  const byDate = new Map<string, DaySummary>();
  for (const r of rows) {
    if (hidden.has(r.symbol)) continue;
    const d = byDate.get(r.reportDate) ?? { date: r.reportDate, bmo: 0, amc: 0, other: 0 };
    if (r.timing === 'BMO') d.bmo++;
    else if (r.timing === 'AMC') d.amc++;
    else d.other++;
    byDate.set(r.reportDate, d);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
