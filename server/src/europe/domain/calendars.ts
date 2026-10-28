import { makeExchangeCalendar, type ExchangeCalendar, type LocalTiming } from '../../domain/exchangeCalendar.js';
import { reactionWindow, localDateFromUs } from '../../domain/adrSessions.js';
import { EXCHANGES, type EuropeMarket, type ExchangeId } from '../exchanges.js';
import { LSE_HOLIDAYS_SEED } from './bankHolidays.js';

/**
 * Per-exchange trading calendars (weekday closures only, Ruling 16: half days and early closes are not modelled).
 *
 * Holiday sources:
 * - LSE: gov.uk England and Wales (bankHolidays.ts), confirmed live; the stored JSON is unioned in at run time.
 * - Every other list below is the plan's starting value, typed from the Source-facts table. Easter dates are
 *   consistent with the calendar (Easter 2026-04-05, 2027-03-28; Ascension 2026-05-14, 2027-05-06; Whit Monday
 *   2026-05-25, 2027-05-17), but NONE was checked against the exchange's own published list in this task (no network
 *   was allowed), so all are UNCONFIRMED:
 *   - UNCONFIRMED (banned site): Euronext PAR/AMS/BRU/LIS/DUB, Milan (MIL), Oslo (OSL), Stockholm (STO),
 *     Copenhagen (CPH), Helsinki (HEL). Euronext Dublin in particular may also close on Irish public holidays
 *     (e.g. the Mondays 2026-05-04 and 2026-08-03 are not in the list).
 *   - UNCONFIRMED (allowed site, not yet checked): Xetra (XET), SIX, BME Madrid (MAD), Tradegate.
 * - From 2028-01-01 calendars count weekends only and `holidaysUnknown` is true.
 */
const set = (...d: string[]): ReadonlySet<string> => new Set(d);

const EURONEXT_CORE: Record<number, ReadonlySet<string>> = {
  2026: set('2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25'),
  2027: set('2027-01-01', '2027-03-26', '2027-03-29'),
};

const MILAN: Record<number, ReadonlySet<string>> = {
  2026: set('2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-24', '2026-12-25', '2026-12-31'),
  2027: set('2027-01-01', '2027-03-26', '2027-03-29', '2027-12-24', '2027-12-31'),
};

const OSLO: Record<number, ReadonlySet<string>> = {
  2026: set('2026-01-01', '2026-04-02', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-12-24', '2026-12-25', '2026-12-31'),
  2027: set('2027-01-01', '2027-03-25', '2027-03-26', '2027-03-29', '2027-05-06', '2027-05-17', '2027-12-24', '2027-12-31'),
};

const XETRA: Record<number, ReadonlySet<string>> = {
  2026: set('2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-24', '2026-12-25', '2026-12-31'),
  2027: set('2027-01-01', '2027-03-26', '2027-03-29', '2027-12-24', '2027-12-31'),
};

const SIX_HOLIDAYS: Record<number, ReadonlySet<string>> = {
  2026: set('2026-01-01', '2026-01-02', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-12-24', '2026-12-25', '2026-12-31'),
  2027: set('2027-01-01', '2027-03-26', '2027-03-29', '2027-05-06', '2027-05-17', '2027-12-24', '2027-12-31'),
};

const STOCKHOLM: Record<number, ReadonlySet<string>> = {
  2026: set('2026-01-01', '2026-01-06', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-06-19', '2026-12-24', '2026-12-25', '2026-12-31'),
  2027: set('2027-01-01', '2027-01-06', '2027-03-26', '2027-03-29', '2027-05-06', '2027-06-25', '2027-12-24', '2027-12-31'),
};

const COPENHAGEN: Record<number, ReadonlySet<string>> = {
  2026: set('2026-01-01', '2026-04-02', '2026-04-03', '2026-04-06', '2026-05-14', '2026-05-15', '2026-05-25', '2026-06-05', '2026-12-24', '2026-12-25', '2026-12-31'),
  2027: set('2027-01-01', '2027-03-25', '2027-03-26', '2027-03-29', '2027-05-06', '2027-05-07', '2027-05-17', '2027-12-24', '2027-12-31'),
};

const HELSINKI: Record<number, ReadonlySet<string>> = {
  2026: set('2026-01-01', '2026-01-06', '2026-04-03', '2026-04-06', '2026-05-01', '2026-06-19', '2026-12-24', '2026-12-25', '2026-12-31'),
  2027: set('2027-01-01', '2027-01-06', '2027-03-26', '2027-03-29', '2027-06-25', '2027-12-06', '2027-12-24', '2027-12-31'),
};

const BASE_HOLIDAYS: Record<ExchangeId, Record<number, ReadonlySet<string>>> = {
  LSE: LSE_HOLIDAYS_SEED,
  PAR: EURONEXT_CORE, AMS: EURONEXT_CORE, BRU: EURONEXT_CORE, LIS: EURONEXT_CORE, DUB: EURONEXT_CORE,
  MIL: MILAN, OSL: OSLO, XET: XETRA, SIX: SIX_HOLIDAYS, STO: STOCKHOLM, CPH: COPENHAGEN, HEL: HELSINKI,
  MAD: EURONEXT_CORE,
};

const UNKNOWN_FROM = '2028-01-01';

function union(base: Record<number, ReadonlySet<string>>, extra?: ReadonlySet<string>): Record<number, ReadonlySet<string>> {
  if (!extra || extra.size === 0) return base;
  const out: Record<number, Set<string>> = {};
  for (const [y, s] of Object.entries(base)) out[Number(y)] = new Set(s);
  for (const d of extra) (out[Number(d.slice(0, 4))] ??= new Set()).add(d);
  return out;
}

const plain = new Map<ExchangeId, ExchangeCalendar>();

/** The calendar of one exchange. `extraHolidays` (LSE: the stored gov.uk dates) are unioned with the built-in list. */
export function calendarFor(ex: ExchangeId, extraHolidays?: ReadonlySet<string>): ExchangeCalendar {
  const cacheable = !extraHolidays || extraHolidays.size === 0;
  if (cacheable) {
    const hit = plain.get(ex);
    if (hit) return hit;
  }
  const info = EXCHANGES[ex];
  const cal = makeExchangeCalendar({
    zone: info.zone,
    holidays: union(BASE_HOLIDAYS[ex], extraHolidays),
    openMin: info.openMin,
    closeMin: info.closeMin,
    amcAtClose: true,
    unknownFrom: UNKNOWN_FROM,
  });
  if (cacheable) plain.set(ex, cal);
  return cal;
}

/** Tradegate trades 08:00-22:00 Berlin time on Xetra-style trading days. */
export const TRADEGATE_CAL: ExchangeCalendar = makeExchangeCalendar({
  zone: 'Europe/Berlin',
  holidays: XETRA,
  openMin: 8 * 60,
  closeMin: 22 * 60,
  amcAtClose: true,
  unknownFrom: UNKNOWN_FROM,
});

/** Today's date for a market: London for UK, Paris for EU. */
export const marketToday = (market: EuropeMarket): string => calendarFor(market === 'UK' ? 'LSE' : 'PAR').today();

/** An ADR's US report row as a local date of the exchange (US AMC rolls to the next day). */
export const europeDateFromUs = (ex: ExchangeId, usDate: string, usTiming: LocalTiming): string =>
  localDateFromUs(calendarFor(ex), usDate, usTiming);

/** Close-to-close days around a local report, on the exchange's calendar. */
export const europeReactionWindow = (
  ex: ExchangeId, reportDate: string, timing: Exclude<LocalTiming, 'UNKNOWN'>,
): { before: string; after: string } => reactionWindow(calendarFor(ex), reportDate, timing);

/** True for 2028 and later, whose holiday lists are not in the app (weekends only). */
export const holidaysUnknown = (ex: ExchangeId, d: string): boolean => calendarFor(ex).holidaysUnknown(d);
