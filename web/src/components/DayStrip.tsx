import { DateTime } from 'luxon';
import type { DaySummary } from '../lib/session';

/** One column per reporting day; bar heights show before-open vs after-close load. Click opens the day. */
export function DayStrip({ days, onPick }: { days: DaySummary[]; onPick: (date: string) => void }) {
  if (days.length === 0) return null;
  const max = Math.max(...days.map((d) => d.bmo + d.amc + d.other));
  return (
    <nav className="strip" aria-label="Reporting days">
      {days.map((d) => {
        const dt = DateTime.fromISO(d.date).setLocale('en-US');
        const total = d.bmo + d.amc + d.other;
        return (
          <button key={d.date} className="strip-day" onClick={() => onPick(d.date)}
            aria-label={`${dt.toFormat('cccc d LLLL')}: ${d.bmo} before open, ${d.amc} after close, ${d.other} other`}>
            <span className="strip-bars" aria-hidden="true">
              <span className="bar bar-bmo" style={{ height: `${(d.bmo / max) * 100}%` }} />
              <span className="bar bar-amc" style={{ height: `${(d.amc / max) * 100}%` }} />
            </span>
            <span className="strip-date">{dt.toFormat('ccc d')}</span>
            <span className="strip-total">{total}</span>
          </button>
        );
      })}
    </nav>
  );
}
