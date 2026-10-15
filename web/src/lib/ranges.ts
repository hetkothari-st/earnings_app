import { DateTime } from 'luxon';

export type View = 'day' | 'week' | 'month' | 'quarter' | 'custom';

const iso = (d: DateTime) => d.toISODate()!;

export function rangeFor(view: Exclude<View, 'custom'>, anchor: string): { from: string; to: string } {
  const a = DateTime.fromISO(anchor);
  switch (view) {
    case 'day':
      return { from: anchor, to: anchor };
    case 'week': {
      const monday = a.startOf('week');
      return { from: iso(monday), to: iso(monday.plus({ days: 4 })) };
    }
    case 'month':
      return { from: iso(a.startOf('month')), to: iso(a.endOf('month')) };
    case 'quarter':
      return { from: iso(a.startOf('quarter')), to: iso(a.endOf('quarter')) };
  }
}

export function shiftAnchor(view: View, anchor: string, dir: 1 | -1): string {
  const a = DateTime.fromISO(anchor);
  switch (view) {
    case 'day': {
      let n = a.plus({ days: dir });
      while (n.weekday > 5) n = n.plus({ days: dir });
      return iso(n);
    }
    case 'week':
      return iso(a.plus({ weeks: dir }));
    case 'month':
      return iso(a.plus({ months: dir }));
    case 'quarter':
      return iso(a.plus({ months: 3 * dir }));
    case 'custom':
      return anchor;
  }
}
