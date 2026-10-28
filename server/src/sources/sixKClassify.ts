import { DateTime } from 'luxon';
import type { LocalTiming } from '../domain/exchangeCalendar.js';
import { isFigure, parseTables, type Cell } from './releaseReader.js';
import type { FilingDoc } from './secFeed.js';

/**
 * Shared 6-K classifier for the foreign markets. Profile `'hk'` is the Hong Kong classifier exactly as built (every
 * regex and branch); profile `'jp'` adds the Japanese results phrases, month-range headers, the nine-month span,
 * Tokyo clock / exchange phrases in date notices, and treats EDINET report translations as `other`. Profiles `'uk'`
 * and `'eu'` (one rule set; clock times are judged against the caller's per-stock session) add the UK / European results phrases,
 * "months / half year / year to" periods, "Q3 2026" quarter labels, "period 1 January to 30 September" ranges, the
 * nine-month span, London / CET clocks and session phrases in date notices, and treat RNS housekeeping notices
 * (own shares, voting rights, PDMR dealings, dividends, Form 20-F filings) as `other`.
 */
export type SixKProfile = 'hk' | 'jp' | 'uk' | 'eu';

/** The UK and European profiles share every rule. */
const isEurope = (profile: SixKProfile): profile is 'uk' | 'eu' => profile === 'uk' || profile === 'eu';

/** `'nine'` only for `'jp'`, `'uk'` and `'eu'`; the HK output never contains it. */
export type SixKSpan = 'quarter' | 'half' | 'nine' | 'year';

/** Release timing against the local exchange session (the exchange calendar's type). */
export type { LocalTiming };

export type SixKExhibit =
  | { kind: 'results'; periodEnd: string; span: SixKSpan }
  | { kind: 'date-notice'; date: string; timing: LocalTiming }
  | { kind: 'other' };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const WEEKDAY_RE = '(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\\s+)?';

const NAMED: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', middot: '.' };

/** Visible text of an HTML document: tags dropped, entities decoded, whitespace collapsed. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m)
    .replace(/[\s ]+/g, ' ')
    .trim();
}

const iso = (y: number, m: number, d: number): string | null => {
  const dt = DateTime.utc(y, m, d);
  return dt.isValid ? dt.toISODate() : null;
};

/** A date written "August 13, 2026" (optionally with a weekday) or "13 August 2026", matched exactly at `pos`. */
function dateAt(text: string, pos: number): { date: string; end: number } | null {
  const mdy = new RegExp(`${WEEKDAY_RE}(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'iy');
  const dmy = new RegExp(`${WEEKDAY_RE}(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE}),?\\s+(\\d{4})`, 'iy');
  mdy.lastIndex = pos;
  const a = mdy.exec(text);
  if (a) {
    const d = iso(Number(a[3]), MONTHS.indexOf(a[1]!.toLowerCase()) + 1, Number(a[2]));
    return d ? { date: d, end: mdy.lastIndex } : null;
  }
  dmy.lastIndex = pos;
  const b = dmy.exec(text);
  if (b) {
    const d = iso(Number(b[3]), MONTHS.indexOf(b[2]!.toLowerCase()) + 1, Number(b[1]));
    return d ? { date: d, end: dmy.lastIndex } : null;
  }
  return null;
}

/** Every date in `text` that follows `prefix` (a regex source); yields the ISO date. */
function datesAfter(text: string, prefix: string): { date: string; index: number }[] {
  const out: { date: string; index: number }[] = [];
  for (const m of text.matchAll(new RegExp(prefix, 'gi'))) {
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ date: d.date, index: m.index! });
  }
  return out;
}

const EARNINGS_WORDS = /financial|earnings|quarter|interim|annual|unaudited|half|full[- ]year|fiscal/i;
const CALL_WORDS = /conference call|webcast|webinar|dial-in|teleconference/i;

const HK_EXCHANGE = '(?:the\\s+)?(?:HKEX|Hong Kong Stock Exchange|Hong Kong market|Stock Exchange of Hong Kong)';
const JP_EXCHANGE = '(?:the\\s+)?(?:Tokyo Stock Exchange|TSE)';
const EU_EXCHANGE = '(?:the\\s+)?(?:London Stock Exchange|LSE)';

/**
 * One local clock time found in a sentence: minutes after midnight and where it ends. `zone`: the IANA zone the
 * clock is stated in (`'uk'` / `'eu'` only; hk / jp clocks are local by construction).
 */
type ClockHit = { index: number; length: number; mins: number; zone?: string };

/**
 * A stock's trading session as `europe/exchanges.ts` rows give it: IANA zone, open and close in minutes after local
 * midnight. `'uk'` / `'eu'` clock times are judged against it; without one their timing is UNKNOWN.
 */
export interface SixKSession {
  zone: string;
  openMin: number;
  closeMin: number;
}

/** Explicit Hong Kong clock times ("at 4:30 p.m. Hong Kong time [on]"). */
function hkClocks(window: string): ClockHit[] {
  const clock = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?,?\s*\(?(?:Beijing\s*\/\s*)?Hong Kong(?:\s+time)?\)?(?:\s+on\s+)?/gi;
  return [...window.matchAll(clock)].map((t) => ({
    index: t.index!, length: t[0].length, mins: ((Number(t[1]) % 12) + (t[3]!.toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(t[2] ?? 0),
  }));
}

/**
 * Explicit Tokyo clock times: "at 3:00 p.m. Japan time [on]", "3:00 p.m. (JST)", "15:00 Tokyo standard time",
 * "at 15:30 in Tokyo on" (Nomura's notices).
 */
function jpClocks(window: string): ClockHit[] {
  const clock = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\.?)?,?\s*\(?(?:(?:Japan|Tokyo)(?:\s+standard)?\s+time|JST|in\s+Tokyo\b)\)?(?:\s+on\s+)?/gi;
  const out: ClockHit[] = [];
  for (const t of window.matchAll(clock)) {
    const h = Number(t[1]);
    if (!t[3] && t[2] == null) continue; // a bare number before "Japan time" is not a clock
    if (t[3] ? h < 1 || h > 12 : h > 23) continue;
    const hour = t[3] ? (h % 12) + (t[3].toLowerCase() === 'p' ? 12 : 0) : h;
    out.push({ index: t.index!, length: t[0].length, mins: hour * 60 + Number(t[2] ?? 0) });
  }
  return out;
}

/**
 * UK and European clock times: "at 7.00am (UK time)", "07:00 CET", "4.30pm BST", "08:00 Central European Summer
 * Time". A UK zone (`UK|London time`, `BST`, `GMT`) is Europe/London wall time, a CET zone (`CET`, `CEST`, `Central
 * European (Summer) Time`) Europe/Paris wall time; `zone` says which.
 */
function euClocks(window: string): ClockHit[] {
  const clock = /(?:\bat\s+)?\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:([ap])\.?\s?m\.?)?,?\s*\(?((?:UK|London)\s+time|BST|GMT|CES?T|Central\s+European\s+(?:Summer\s+)?Time)\b\)?(?:\s+on\s+)?/gi;
  const out: ClockHit[] = [];
  for (const t of window.matchAll(clock)) {
    const h = Number(t[1]);
    if (!t[3] && t[2] == null) continue; // a bare number before "UK time" is not a clock
    if (t[3] ? h < 1 || h > 12 : h > 23) continue;
    if (Number(t[2] ?? 0) > 59) continue;
    const hour = t[3] ? (h % 12) + (t[3].toLowerCase() === 'p' ? 12 : 0) : h;
    const zone = /^(?:UK|London|BST|GMT)/i.test(t[4]!) ? 'Europe/London' : 'Europe/Paris';
    out.push({ index: t.index!, length: t[0].length, mins: hour * 60 + Number(t[2] ?? 0), zone });
  }
  return out;
}

/** HK: BMO before 09:30, DMH to 16:00. JP: BMO before 09:00, DMH 09:00–15:29 (lunch counts), AMC from 15:30 (the close). */
function clockTiming(mins: number, profile: SixKProfile): LocalTiming {
  if (profile === 'jp') return mins < 9 * 60 ? 'BMO' : mins < 15 * 60 + 30 ? 'DMH' : 'AMC';
  return mins < 9 * 60 + 30 ? 'BMO' : mins <= 16 * 60 ? 'DMH' : 'AMC';
}

/**
 * `'uk'` / `'eu'`: a clock stated on `date` in `hit.zone`, read in the stock's session zone. BMO before the open, DMH
 * open..close-1, AMC from the close (`europe/exchanges.ts`). No session: UNKNOWN (the date still stands).
 */
function sessionTiming(date: string, hit: ClockHit, session: SixKSession | undefined): LocalTiming {
  if (!session) return 'UNKNOWN';
  const [year, month, day] = date.split('-').map(Number);
  const local = DateTime.fromObject({ year, month, day, hour: Math.floor(hit.mins / 60), minute: hit.mins % 60 }, { zone: hit.zone })
    .setZone(session.zone);
  if (!local.isValid) return 'UNKNOWN';
  const mins = local.hour * 60 + local.minute;
  return mins < session.openMin ? 'BMO' : mins < session.closeMin ? 'DMH' : 'AMC';
}

/**
 * `'uk'` / `'eu'` session phrase naming the exchange: "before the London Stock Exchange / LSE opens" (08:00 London,
 * the same instant as every continental open in `exchanges.ts`). A bare "before the market opens" / "after the close"
 * names no exchange (a dual-listed filer's market may be the US one), so it gives no timing.
 */
const EU_BEFORE_OPEN = /\bbefore\s+(?:the\s+)?(?:London\s+Stock\s+Exchange|LSE)\s+opens?\b/i;
/** Words just before "on D" that make D a dividend date ("payable on", "holders of record on", "register … closed on"). */
const DIVIDEND_DATE = /\b(?:payable|paid|payment|record|register|closed|closure|ex-dividend|ex-entitlement)\b[^.]{0,30}$/i;
/** HKEX Rule 13.43 notice: "a meeting of [a committee of] the Board … will be held on D … to consider|approve … results|earnings release". */
const BOARD_MEETING = /\bmeeting\s+of\s+(?:a\s+committee\s+of\s+)?the\s+Board\b[^.]{0,120}?\bwill\s+be\s+held\s+on\s+/gi;

/** Abbreviations whose period does not end a sentence ("U.S. Market", "4:30 p.m. Hong Kong time"). */
const NOT_SENTENCE_END = /\b(?:U\.S|U\.K|[ap]\.m|Inc|Ltd|Co|Corp|No)$/i;

/** `text` up to the end of its first sentence: the first `[.!?;]` followed by whitespace and a capital. */
function ownSentence(text: string): string {
  for (const m of text.matchAll(/[.!?;]\s+(?=[A-Z])/g)) {
    if (m[0][0] === '.' && NOT_SENTENCE_END.test(text.slice(0, m.index!))) continue;
    return text.slice(0, m.index!);
  }
  return text;
}

/**
 * Release date and timing from a date notice (HK Ruling 4; JP Ruling 7). Dates are local (HK / Tokyo) dates.
 * Clause: "[to|will] announce|report|release|upload|publish … results … on D", or the passive
 * "results … will be announced|released|published on D". The nearest date after the verb, in the verb's own
 * sentence (timing phrases too), is D, skipping
 * dividend payment / record dates. Failing those, an HKEX board-meeting notice ("a meeting of the Board will be
 * held on D to consider … results") gives D.
 * Timing, first match wins:
 * - "before the U.S. market opens [on D]" / "before the opening of the U.S. market": D, AMC (`'uk'` / `'eu'`: D,
 *   UNKNOWN; the US pre-open falls inside the European session).
 * - "after the U.S. market closes [on D]": D+1, BMO.
 * - An explicit local clock time (Hong Kong; for `'jp'` Japan / Tokyo time or JST): by the local thresholds.
 *   `'uk'` / `'eu'`: a UK or CET clock, read in `session`'s zone against its open / close; no session: UNKNOWN.
 * - "before the opening / trading hours of the HKEX" (`'jp'`: the Tokyo Stock Exchange / TSE): BMO;
 *   "after the close / trading hours of …": AMC. (`'uk'` / `'eu'`: the London Stock Exchange / LSE.)
 * - `'uk'` / `'eu'`: "before the London Stock Exchange / LSE opens": BMO. A bare "before the market opens" / "after
 *   the close" gives UNKNOWN.
 * - Otherwise UNKNOWN. Returns null when no such statement is found.
 * `'uk'` / `'eu'` also take a UK / European results phrase ("will publish Q3 2026 results on D") as the earnings word.
 */
export function parseDateNoticeFor(text: string, profile: SixKProfile, session?: SixKSession): { date: string; timing: LocalTiming } | null {
  const best: { rank: number; date: string; timing: LocalTiming }[] = [];
  const exchange = profile === 'jp' ? JP_EXCHANGE : isEurope(profile) ? EU_EXCHANGE : HK_EXCHANGE;
  const clocks = profile === 'jp' ? jpClocks : isEurope(profile) ? euClocks : hkClocks;
  // 'uk' / 'eu': the US pre-open is inside the European session, so it says nothing about local timing.
  const usOpen: LocalTiming = isEurope(profile) ? 'UNKNOWN' : 'AMC';
  // Each verb is tried on its own ("earnings release. Acme will report its results on D": the "release" with no
  // "results" in its sentence must not swallow the "report" clause after it).
  const verbs = /\b(?:(?:to|will(?:\s+further)?)\s+)?(?:announce|report|release|upload|publish)\b/gi;
  const passive = /\bresults?\b[\s\S]{0,200}?\b(?:will(?:\s+further)?\s+be|be)\s+[a-z ,]{0,80}?(?:announced|released|published)\s+on\s+/gi;

  for (const c of text.matchAll(verbs)) {
    // Date and timing come only from the verb's own sentence (an AGM / EGM date in the next sentence is not it).
    const window = ownSentence(text.slice(c.index!, c.index! + 400));
    const results = /\bresults?\b/i.exec(window.slice(0, c[0].length + 160 + 7));
    if (!results) continue;
    // "announce the results of the poll / voting / general meeting" is a meeting notice, not earnings.
    const own = text.slice(c.index!, c.index! + results.index + results[0].length + 80);
    if (/poll|vot(?:e|ing)|results\s+of\s+(?:the\s+)?(?:annual|extraordinary|general)\b|meeting\s+results/i.test(own)) continue;
    const around = text.slice(Math.max(0, c.index! - 300), c.index! + 400);
    if (!EARNINGS_WORDS.test(around) && !(isEurope(profile) && EU_RESULTS_RE.test(around))) continue;

    // A dividend's payment / record / book-closure date is never the results date.
    const nearest = datesAfter(window, '\\bon\\s+').find((d) => !DIVIDEND_DATE.test(window.slice(Math.max(0, d.index - 40), d.index)))?.date;
    let found: { date: string; timing: LocalTiming } | null = null;

    const open = datesAfter(window, 'before the U\\.?S\\.? market opens?\\s+on\\s+')[0]?.date;
    if (open) found = { date: open, timing: usOpen };
    else if (nearest && /before\s+(?:the\s+)?(?:U\.?S\.?\s+market\s+opens?|opening\s+of\s+the\s+U\.?S\.?\s+market)/i.test(window)) found = { date: nearest, timing: usOpen };
    if (!found) {
      const close = datesAfter(window, 'after the U\\.?S\\.? market closes?\\s+on\\s+')[0]?.date
        ?? (nearest && /after\s+the\s+U\.?S\.?\s+market\s+closes?/i.test(window) ? nearest : undefined);
      if (close) found = { date: DateTime.fromISO(close, { zone: 'utc' }).plus({ days: 1 }).toISODate()!, timing: 'BMO' };
    }

    // Explicit local clock time (a conference-call time is not a release time).
    if (!found) {
      for (const t of clocks(window)) {
        const around = window.slice(Math.max(0, t.index - 120), t.index + 40);
        if (CALL_WORDS.test(around)) continue;
        const date = dateAt(window, t.index + t.length)?.date ?? nearest; // "on D at 4:30 p.m. Hong Kong time"
        if (date) { found = { date, timing: isEurope(profile) ? sessionTiming(date, t, session) : clockTiming(t.mins, profile) }; break; }
      }
    }

    if (!found && nearest) {
      if (new RegExp(`before\\s+(?:the\\s+)?(?:opening|trading\\s+hours)\\s+of\\s+${exchange}`, 'i').test(window)) found = { date: nearest, timing: 'BMO' };
      else if (new RegExp(`after\\s+(?:the\\s+)?(?:close|trading\\s+hours)\\s+of\\s+${exchange}`, 'i').test(window)) found = { date: nearest, timing: 'AMC' };
      // JP Ruling 7: "before the opening of trading on the Tokyo Stock Exchange" / "after the close of trading on …".
      else if (profile === 'jp' && new RegExp(`before\\s+(?:the\\s+)?(?:opening|start)\\s+of\\s+trading\\s+on\\s+${exchange}`, 'i').test(window)) found = { date: nearest, timing: 'BMO' };
      else if (profile === 'jp' && new RegExp(`after\\s+(?:the\\s+)?(?:close|end)\\s+of\\s+trading\\s+on\\s+${exchange}`, 'i').test(window)) found = { date: nearest, timing: 'AMC' };
      else if (isEurope(profile) && EU_BEFORE_OPEN.test(window)) found = { date: nearest, timing: 'BMO' };
    }
    if (found) best.push({ rank: 3, ...found });
    else if (nearest) best.push({ rank: 1, date: nearest, timing: 'UNKNOWN' });
  }

  for (const c of text.matchAll(passive)) {
    if (!EARNINGS_WORDS.test(text.slice(Math.max(0, c.index! - 300), c.index! + c[0].length + 100))) continue;
    if (/poll|vot(?:e|ing)|general\s+meeting|meeting\s+results/i.test(c[0])) continue;
    const d = dateAt(text, c.index! + c[0].length);
    if (d) best.push({ rank: 1, date: d.date, timing: 'UNKNOWN' });
  }

  // Lowest rank: the board meeting that approves the results (results are published that day); any announce clause wins.
  for (const c of text.matchAll(BOARD_MEETING)) {
    const d = dateAt(text, c.index! + c[0].length);
    if (d && /^[^.]{0,200}?\b(?:consider|approve)\b[^.]{0,200}?\b(?:results|earnings\s+release)\b/i.test(text.slice(d.end))) {
      best.push({ rank: 0, date: d.date, timing: 'UNKNOWN' });
    }
  }

  best.sort((a, b) => b.rank - a.rank);
  return best[0] ? { date: best[0].date, timing: best[0].timing } : null;
}

const SPAN_ORDER: Record<SixKSpan, number> = { quarter: 0, half: 1, nine: 2, year: 3 };

/**
 * A period named for a dividend ("second interim dividend … in respect of the financial year ended 31 December
 * 2025", paid mid-year) is not the period the release reports, and may even end after it.
 */
function dividendContext(text: string, at: number): boolean {
  // Only "… dividend … for / in respect of the (financial) year ended <the mention>", within one sentence.
  const before = text.slice(Math.max(0, at - 300), at);
  const sentence = before.split(/[.!?;:]\s+(?=[A-Z0-9(])/).pop() ?? '';
  return /\bdividends?\b[\s\S]*\b(?:for|in respect of)\s+the\s+(?:financial\s+)?$/i.test(sentence); // "$0.10" may sit in between
}

/**
 * A stated period end. `range`: from a `'jp'` month-range header, which may also head a forecast column. `index`:
 * where the prose states it (absent for table headers). `label`: a `'uk'` / `'eu'` quarter label ("Q3 2026"), which
 * names an end but never outranks a stated span at that end (a nine-month report also says "Q3 2026").
 */
type PeriodMention = { end: string; span: SixKSpan; range?: true; index?: number; label?: true };

/** All period ends the document states, as (end date, span). `fyEndMonth` places `'uk'` / `'eu'` quarter labels. */
function periodMentions(text: string, profile: SixKProfile, fyEndMonth?: number): PeriodMention[] {
  const out: PeriodMention[] = [];
  const words = '(?:three|six|nine|twelve)';
  for (const m of text.matchAll(new RegExp(`\\b(${words}(?:\\s+and\\s+${words})?)\\s+months\\s+ended\\s+`, 'gi'))) {
    const d = dateAt(text, m.index! + m[0].length);
    if (!d) continue;
    const w = m[1]!.toLowerCase();
    const span: SixKSpan | null = profile === 'jp' || isEurope(profile)
      ? (w.includes('three') ? 'quarter' : w.includes('six') ? 'half' : w.includes('nine') ? 'nine' : w.includes('twelve') ? 'year' : null)
      : (w.includes('three') ? 'quarter' : w.includes('six') ? 'half' : w.includes('twelve') ? 'year' : null);
    if (span) out.push({ end: d.date, span, index: m.index! });
  }
  for (const m of text.matchAll(/\bquarter\s+ended\s+/gi)) {
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: 'quarter', index: m.index! });
  }
  for (const m of text.matchAll(/\byear\s+ended\s+/gi)) {
    if (isEurope(profile) && HALF_BEFORE.test(text.slice(Math.max(0, m.index! - 5), m.index!))) continue; // the half (europeMentions)
    const d = dividendContext(text, m.index!) ? null : dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: 'year', index: m.index! });
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\s+quarter\\s+(\\d{4})\\b`, 'gi'))) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
    const end = DateTime.utc(Number(m[2]), month, 1).endOf('month').toISODate();
    if (end) out.push({ end, span: 'quarter', index: m.index! });
  }
  if (profile === 'jp') {
    // Takeda: "Three-month Period Ended June 30, 2026", "Nine-month Period Ended December 31, 2025".
    for (const m of text.matchAll(/\b(three|six|nine|twelve)[- ]month\s+period\s+ended\s+/gi)) {
      const d = dateAt(text, m.index! + m[0].length);
      if (d) out.push({ end: d.date, span: JP_MONTH_WORD_SPAN[m[1]!.toLowerCase()]!, index: m.index! });
    }
    // Nomura: "results for the first quarter of the fiscal year ending March 31, 2027" — that quarter's own end.
    for (const m of text.matchAll(/\b(first|second|third|fourth)\s+quarter\s+of\s+(?:the\s+)?fiscal\s+year\s+ending\s+/gi)) {
      const d = dateAt(text, m.index! + m[0].length);
      const back = 3 * (4 - ['first', 'second', 'third', 'fourth'].indexOf(m[1]!.toLowerCase()) - 1);
      const end = d && DateTime.fromISO(d.date, { zone: 'utc' }).minus({ months: back }).endOf('month').toISODate();
      if (end) out.push({ end, span: 'quarter', index: m.index! });
    }
    out.push(...monthRangeMentions(text), ...dateRangeMentions(text));
  }
  if (isEurope(profile)) out.push(...europeMentions(text, fyEndMonth ?? 12));
  return out;
}

/** "half-" / "half " just before "year ended / to": a half year, not a year. */
const HALF_BEFORE = /half[- ]$/i;

/**
 * `'uk'` / `'eu'` periods: "(three|six|nine|twelve) months to D", "half year / six months to D", "half-year ended D",
 * "year to D" (not a dividend's year), "period [from] 1 January 2026 to 30 September 2026" (Novo Nordisk's title; span
 * by its length, as `'jp'` date ranges), and "Q3 2026" labels: quarter n of the fiscal year ending in that calendar
 * year (`fyEndMonth`; December gives calendar quarters).
 */
function europeMentions(text: string, fyEndMonth: number): PeriodMention[] {
  const out: PeriodMention[] = [];
  // AB InBev "three-month period ended 31 March 2025", STMicroelectronics "Six-month period ended June 27, 2026".
  for (const m of text.matchAll(/\b(three|six|nine|twelve|3|6|9|12)[- ]month\s+periods?\s+ended\s+/gi)) {
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: EU_MONTH_SPAN[m[1]!.toLowerCase()]!, index: m.index! });
  }
  for (const m of text.matchAll(/\b(three|six|nine|twelve)\s+months\s+to\s+/gi)) {
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: JP_MONTH_WORD_SPAN[m[1]!.toLowerCase()]!, index: m.index! });
  }
  for (const m of text.matchAll(/\b(?:half[- ]year\s+(?:to|ended)|six\s+months\s+to)\s+/gi)) {
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: 'half', index: m.index! });
  }
  for (const m of text.matchAll(/\byear\s+to\s+/gi)) {
    if (HALF_BEFORE.test(text.slice(Math.max(0, m.index! - 5), m.index!)) || dividendContext(text, m.index!)) continue;
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: 'year', index: m.index! });
  }
  for (const m of text.matchAll(/\bperiod\s+(?:from\s+)?/gi)) {
    const from = dateAt(text, m.index! + m[0].length);
    const sep = from ? /^\s*(?:to|through|until|[-–])\s*/i.exec(text.slice(from.end)) : null;
    const to = from && sep ? dateAt(text, from.end + sep[0].length) : null;
    if (!from || !to || !from.date.endsWith('-01')) continue;
    const a = DateTime.fromISO(from.date, { zone: 'utc' });
    const b = DateTime.fromISO(to.date, { zone: 'utc' });
    if (b.toISODate() !== b.endOf('month').toISODate()) continue;
    const span = RANGE_SPAN[(b.year * 12 + b.month) - (a.year * 12 + a.month) + 1];
    if (span) out.push({ end: to.date, span, index: m.index! });
  }
  for (const m of text.matchAll(/\bQ([1-4])\s+(\d{4})\b/g)) {
    const end = DateTime.utc(Number(m[2]), fyEndMonth, 1).minus({ months: 3 * (4 - Number(m[1])) }).endOf('month').toISODate();
    if (end) out.push({ end, span: 'quarter', index: m.index!, label: true });
  }
  return out;
}

/** Month names and the short forms Japanese releases use in column headers ("Apr.-Sep. 2026", "July–September 2026"). */
const MONTH_ANY_RE = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)';
const MONTH_RANGE = new RegExp(`\\b${MONTH_ANY_RE}\\.?\\s*[-–~～]\\s*${MONTH_ANY_RE}\\.?,?\\s*(\\d{4})\\b`, 'gi');
const RANGE_SPAN: Record<number, SixKSpan> = { 3: 'quarter', 6: 'half', 9: 'nine', 12: 'year' };
const JP_MONTH_WORD_SPAN: Record<string, SixKSpan> = { three: 'quarter', six: 'half', nine: 'nine', twelve: 'year' };
const EU_MONTH_SPAN: Record<string, SixKSpan> = { ...JP_MONTH_WORD_SPAN, 3: 'quarter', 6: 'half', 9: 'nine', 12: 'year' };

/** `'jp'` month-range headers: the range's end month, span by its length (3, 6, 9 or 12 months; any other is skipped). */
function monthRangeMentions(text: string): PeriodMention[] {
  const out: PeriodMention[] = [];
  const monthNo = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3))) + 1;
  for (const m of text.matchAll(MONTH_RANGE)) {
    const from = monthNo(m[1]!);
    const to = monthNo(m[2]!);
    const span = RANGE_SPAN[((to - from + 12) % 12) + 1];
    const end = DateTime.utc(Number(m[3]), to, 1).endOf('month').toISODate();
    if (span && end) out.push({ end, span, range: true, index: m.index! });
  }
  return out;
}

/** "April 1, 2024 through September 30, 2024" / "July 1, 2024 to September 30, 2024" (Toyota's semi-annual summary). */
const DATE_RANGE = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2}),?\\s+(\\d{4})\\s*(?:through|to|[-–~～])\\s*`, 'gi');

/**
 * `'jp'` date-range headers: a range from a month's first day through a month's last day of 3, 6, 9 or 12 months
 * names its end with the span of its length; any other range is skipped. Like month ranges, a range may head a
 * forecast column, so it is `range` (usable only within the filing-date window).
 */
function dateRangeMentions(text: string): PeriodMention[] {
  const out: PeriodMention[] = [];
  for (const m of text.matchAll(DATE_RANGE)) {
    const to = dateAt(text, m.index! + m[0].length);
    if (!to || Number(m[2]) !== 1) continue;
    const from = DateTime.utc(Number(m[3]), MONTHS.indexOf(m[1]!.toLowerCase()) + 1, 1);
    const end = DateTime.fromISO(to.date, { zone: 'utc' });
    if (!from.isValid || end.toISODate() !== end.endOf('month').toISODate()) continue;
    const span = RANGE_SPAN[(end.year * 12 + end.month) - (from.year * 12 + from.month) + 1];
    if (span) out.push({ end: to.date, span, range: true, index: m.index! });
  }
  return out;
}

/**
 * Period ends named by table column headers whose words are split across cells, e.g. "Three Months Ended" over
 * "June 30, 2026 / RMB (million)" (Trip.com, NetEase, BeOne). Each header cell's text is joined with the text of
 * the header cells above and below it that share its columns, and that column text is read like prose.
 */
function tableHeaderMentions(html: string, profile: SixKProfile, fyEndMonth?: number): PeriodMention[] {
  const out: PeriodMention[] = [];
  for (const t of parseTables(html, { rowspan: true })) {
    let block: Cell[][] = [];
    const flush = () => {
      for (const row of block) {
        for (const cell of row) {
          if (!cell.text) continue;
          const column = block
            .map((r) => r.filter((c) => c.text && c.start < cell.start + cell.span && c.start + c.span > cell.start).map((c) => c.text).join(' '))
            .join(' ');
          out.push(...periodMentions(column, profile, fyEndMonth));
        }
      }
      block = [];
    };
    for (const row of t.rows) {
      const li = row.findIndex((c) => c.text);
      const isData = /[a-z]/i.test(row[li]?.text ?? '') && row.slice(li + 1).some((c) => isFigure(c.text));
      if (isData) flush();
      else block.push(row);
    }
    flush();
  }
  return out;
}

/**
 * Results-release titles: "X announces … results", "interim / annual results", "March Quarter 2026 Results",
 * "Earnings Release 3Q25" (HSBC), "3Q25 results", "Full Year 2025 Results" / "2026 Half Year Results" /
 * "FY25 Results" (Prudential).
 */
const HK_RESULTS_PHRASES = [
  String.raw`\b(?:announces?|reports?)\b[^.]{0,120}?\bresults\b`,
  String.raw`\binterim results\b`,
  String.raw`\bannual results\b`,
  String.raw`\b${MONTH_RE}\s+quarter\s+\d{4}\s+results\b`,
  String.raw`\bearnings release\b`,
  String.raw`\b[1-4]q\s?'?(?:\d{4}|\d{2})\s+(?:earnings|results)\b`,
  String.raw`\b(?:full|half)[\s-]year\s+\d{4}\s+results\b`,
  String.raw`\b\d{4}\s+(?:interim|half[\s-]year|full[\s-]year|annual)\s+results\b`,
  String.raw`\b(?:fy|hy|h[12])\s?'?(?:\d{4}|\d{2})\s+results\b`,
];

/**
 * Japanese results titles (tanshin translations): "Consolidated Financial Results for the Three Months Ended …"
 * (Honda), "FY2027 First Quarter Financial Summary" (Toyota), "Consolidated Summary Report … for the three months
 * ended …" (MUFG), "Consolidated Financial Summary for the First Quarter Ended …" (Sony), "Q1 FY2026", "Consolidated
 * Financial Statements for the First Quarter of Fiscal 2026" (Mizuho), "Earnings Report (Kessan Tanshin) for …"
 * (Takeda).
 */
const JP_RESULTS_PHRASES = [
  String.raw`\bconsolidated financial results for the (?:three|six|nine) months ended\b`,
  String.raw`\bconsolidated financial results\s*\(?for the (?:fiscal|first|second|third)\b`,
  String.raw`\b(?:first|second|third) quarter (?:of )?(?:the )?(?:fiscal year|fiscal|FY) ?\d{2,4}\b`,
  String.raw`\bFY\s?\d{4} (?:first|second|third|fourth) quarter\b`,
  String.raw`\bFY\d{4} Q[1-4]\b`,
  String.raw`\bconsolidated summary report\b`,
  String.raw`\bfinancial summary\b`,
  String.raw`\b(?:annual|full[- ]year) (?:consolidated )?financial results\b`,
  String.raw`\bconsolidated financial statements for (?:the )?(?:(?:first|second|third) quarter of )?fiscal \d{4}\b`,
  String.raw`\bkessan tanshin\b`,
  String.raw`\bearnings report\b`,
];

/**
 * UK / European results titles: "Half year 2026 results", "Q3 2026 financial results", "Q4 trading update", "results
 * for the nine months ended", "Interim Management Statement". The last three are live titles the list misses: AZN
 * "1st Quarter Results", ASML "2026 third-quarter results", Novo Nordisk "Financial report for the period 1 January
 * 2026 to 30 June 2026", Santander "January - September 2026 Financial Report" (Task 21 live spot-check).
 */
const EU_RESULTS_PHRASES = [
  String.raw`\b(?:half[- ]year|interim|full[- ]year|preliminary|annual|first quarter|third quarter|second quarter|fourth quarter|Q[1-4]|H[12]|[1-4]Q) (?:\d{4} )?(?:financial )?(?:results|report|trading (?:update|statement))\b`,
  String.raw`\bresults for the (?:three|six|nine|twelve) months ended\b`,
  String.raw`\b(?:half|full)[- ]year \d{4} results\b`,
  String.raw`\binterim management statement\b`,
  String.raw`\b(?:1st|2nd|3rd|4th) quarter results\b`,
  String.raw`\b\d{4} (?:first|second|third|fourth)-quarter results\b`,
  String.raw`\bfinancial report for the period\b`,
  // Santander "January - September 2026 Financial Report" / "… 2026 Results" (a month-range title; hyphen, en or em
  // dash, "to", "through"). Only "results" or "financial report": "January - September 2026 Report on traffic" is not.
  String.raw`\b${MONTH_RE}(?:\s*[-–—]\s*|\s+(?:to|through)\s+)${MONTH_RE}\s+\d{4}\s+(?:(?:financial\s+)?results|financial\s+report)\b`,
];
const EU_RESULTS_RE = new RegExp(EU_RESULTS_PHRASES.join('|'), 'i');

const RESULTS_PHRASE: Record<SixKProfile, RegExp> = {
  hk: new RegExp(HK_RESULTS_PHRASES.join('|'), 'i'),
  jp: new RegExp([...HK_RESULTS_PHRASES, ...JP_RESULTS_PHRASES].join('|'), 'gi'),
  uk: new RegExp([...HK_RESULTS_PHRASES, ...EU_RESULTS_PHRASES].join('|'), 'i'),
  eu: new RegExp([...HK_RESULTS_PHRASES, ...EU_RESULTS_PHRASES].join('|'), 'i'),
};

/**
 * `'uk'` / `'eu'` housekeeping notices (RNS titles): own-share transactions and buyback programmes, total voting
 * rights, director / PDMR dealings, dividend declarations, Form 20-F filing notices, and the DTR "Annual Financial
 * Report" publication (the annual report is not a results release). One counts only when it comes no later than any
 * results phrase in the opening: a results release names its results first and may then mention its dividend or
 * buyback. The 6-K cover's "annual reports under cover of Form 20-F" is not a filing notice.
 */
const EU_NOTICE_TITLE = new RegExp([
  String.raw`\btransactions?\s+in\s+own\s+shares\b`,
  String.raw`\bshare\s+buy-?backs?\s+programmes?\b`,
  String.raw`\btotal\s+voting\s+rights\b`,
  String.raw`\b(?:director\s*\/\s*PDMR|PDMR|directors?'?)\s+(?:shareholdings?|dealings?)\b`,
  String.raw`\bdeclaration\s+of\s+(?:an?\s+|the\s+)?(?:[a-z]+\s+){0,2}dividends?\b`,
  String.raw`\bdividend\s+declaration\b`,
  String.raw`\b(?:filing|publication|availability|submission)\s+of\s+(?:the\s+|its\s+|our\s+)?(?:\d{4}\s+)?(?:annual\s+report\s+(?:on|and)\s+)?Form\s+20-F\b`,
  String.raw`\bannual\s+report\s+and\s+Form\s+20-F\b`,
  String.raw`\bannual\s+financial\s+report\b`,
  String.raw`\bForm\s+20-F\b[^.]{0,40}\b(?:filed|published|now\s+available)\b`,
].join('|'), 'i');

/** `'uk'` / `'eu'`: the opening names a housekeeping notice before any results phrase. */
function isEuropeNotice(opening: string, profile: 'uk' | 'eu'): boolean {
  const notice = opening.search(EU_NOTICE_TITLE);
  if (notice < 0) return false;
  const results = opening.search(RESULTS_PHRASE[profile]);
  return results < 0 || notice <= results; // "Annual Financial Report" is both: the notice wins
}

/**
 * Words that make a results phrase's own title / sentence about something else than this release's results. A TSE
 * "Notice regarding / concerning …" is a notice, never the release itself.
 */
const JP_NOT_RELEASE = /\b(?:forecasts?|revisions?|revised?|dividends?|outlook|differences?|notice\s+(?:regarding|concerning|on|of))\b/i;

/**
 * `'jp'`: where the first results title in the opening is, or -1. A phrase whose own sentence (up to 250 characters
 * before it and 100 after, cut at a sentence end) names a forecast, revision, dividend, outlook, difference or a TSE
 * notice does not count: "Revision on Forecast for Consolidated Financial Results", "Notice regarding difference in
 * consolidated financial results … Mizuho hereby announces that … its consolidated financial results …".
 */
function jpResultsTitleAt(opening: string): number {
  for (const m of opening.matchAll(RESULTS_PHRASE.jp)) {
    const start = m.index!;
    const end = start + m[0].length;
    const before = opening.slice(Math.max(0, start - 250), start).split(/[.!?]\s+(?=[A-Z])/).pop()!;
    const after = opening.slice(end, end + 100).split(/[.!?]\s+(?=[A-Z])/)[0]!;
    if (!JP_NOT_RELEASE.test(before + m[0] + after)) return start;
  }
  return -1;
}

/**
 * `'jp'`: an EDINET report translation ("Annual Securities Report", "(English Translation) Semi-annual Securities
 * Report For The Six-month Period …") named as the document itself: at the start of the text, or right after an
 * exhibit number, a "Translation (of the)" label or a bracket. A cover line that names the report with a date —
 * "Annual securities report (Yukashoken hokokusho) issuing date: June 19, 2026" (SMFG), "Scheduled date to file the
 * annual securities report" — is not a title.
 */
const JP_EDINET_REPORT = /\b(?:semi-?annual|annual|quarterly|extraordinary)\s+securities\s+report\b/gi;
const JP_TITLE_LEAD = /(?:^|\bexhibit(?:\s+number)?\s+\d+\.?|\btranslation(?:\s+of(?:\s+the)?)?\)?|[[(])\s*$/i;
const JP_SCHEDULE_AFTER = /^\s*(?:\([^)]{0,60}\)\s*)?(?:issu|fil|submi|dat|schedul|due)/i;

function isJpEdinetReport(opening: string): boolean {
  for (const m of opening.matchAll(JP_EDINET_REPORT)) {
    const lead = opening.slice(Math.max(0, m.index! - 40), m.index!);
    const tail = opening.slice(m.index! + m[0].length, m.index! + m[0].length + 80);
    if (JP_TITLE_LEAD.test(m.index! === 0 ? '' : lead) && !JP_SCHEDULE_AFTER.test(tail)) return true;
  }
  return false;
}

/** `'jp'`: a release reports a period that ended at most this many days before it was filed. */
const JP_RECENT_DAYS = 100;
/** `'jp'`: a period named within this many characters of the results title is the title's own. */
const JP_TITLE_SPAN = 600;

/**
 * `'jp'`: this release's period among the stated ones. Only periods ending in [filedOn − 100 days, filedOn] count
 * (an appendix whose only dated mention is a prior-year footnote, a dividend table's next-year column, a forecast
 * month range are not it); without `filedOn` month ranges are unusable (they may head forecast columns) and no
 * window applies. Periods named with the title (from 100 characters before it to 600 after) win over the rest; among
 * the winners the latest end, and at that end the most specific span.
 */
function jpReleasePeriod(all: PeriodMention[], titleAt: number, filedOn: string | undefined): { end: string; span: SixKSpan } | null {
  const from = filedOn ? DateTime.fromISO(filedOn, { zone: 'utc' }).minus({ days: JP_RECENT_DAYS }).toISODate()! : null;
  const usable = all.filter((p) => (filedOn ? p.end <= filedOn && p.end >= from! : !p.range));
  if (usable.length === 0) return null;
  const titled = usable.filter((p) => p.index != null && p.index >= titleAt - 100 && p.index <= titleAt + JP_TITLE_SPAN);
  const pool = titled.length > 0 ? titled : usable;
  const latest = pool.reduce((a, b) => (b.end > a ? b.end : a), '');
  const span = pool.filter((p) => p.end === latest).reduce<SixKSpan>((a, p) => (SPAN_ORDER[p.span] < SPAN_ORDER[a] ? p.span : a), 'year');
  return { end: latest, span };
}

/**
 * True when some table row is labelled revenue / per share / per ADS (results releases carry one, notices do not).
 * `'uk'` / `'eu'` also take EPS / net sales / turnover (ASML's summary table: "Total net sales", "EPS (basic; in euros)").
 */
function hasResultsTable(html: string, profile: SixKProfile): boolean {
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const label = htmlToText(row[1]!);
    if (/per (ordinary )?share|per ads|revenue/i.test(label)) return true;
    if (isEurope(profile) && /\bEPS\b|\bnet sales\b|\bturnover\b/i.test(label)) return true;
  }
  return false;
}

/**
 * Classify an exhibit (or 6-K main document) as an earnings release, a results-date notice, or something else.
 * `filedOn` is the local acceptance date. Profile `'hk'` is the Hong Kong classifier as built. `fyEndMonth` (1–12, the
 * issuer's fiscal year end) places `'uk'` / `'eu'` "Q3 2026" labels; without it they are calendar quarters. `session`
 * (the stock's exchange session) times `'uk'` / `'eu'` clock statements; without it their timing is UNKNOWN.
 */
export function classifySixK(
  source: string,
  opts: { filedOn?: string; profile: SixKProfile; fyEndMonth?: number; session?: SixKSession },
): SixKExhibit {
  const { profile } = opts;
  // 'uk' / 'eu': an inline-XBRL document's hidden <ix:header> (contexts, members, dates) is not text: in AZN's H1 2026
  // 6-K it filled the first 5,000 characters, hiding the title. hk / jp read the document as built.
  const html = isEurope(profile) ? source.replace(/<ix:header\b[\s\S]*?<\/ix:header>/gi, '') : source;
  const text = htmlToText(html);
  if (profile === 'jp' && isJpEdinetReport(text.slice(0, 5000))) return { kind: 'other' };
  if (isEurope(profile) && isEuropeNotice(text.slice(0, 5000), profile)) return { kind: 'other' };
  // A notice whose opening names a results date after it was filed is a date notice, even with a "Revenue
  // guidance" row. (A release's own "next results on D" line sits deep in the body: HSBC at ~110k chars.)
  const opening = parseDateNoticeFor(text.slice(0, 5000), profile, opts.session);
  if (opening && opts.filedOn && opening.date > opts.filedOn) return { kind: 'date-notice', ...opening };

  if (profile === 'jp') {
    const titleAt = jpResultsTitleAt(text.slice(0, 5000));
    if (titleAt >= 0 && hasResultsTable(html, profile)) {
      const p = jpReleasePeriod([...periodMentions(text, profile), ...tableHeaderMentions(html, profile)], titleAt, opts.filedOn);
      if (p) return { kind: 'results', periodEnd: p.end, span: p.span };
    }
  } else if (RESULTS_PHRASE[profile].test(text.slice(0, 5000))) {
    // A results release cannot report a period ending after it was filed (`filedOn`: the acceptance date). 'uk' / 'eu':
    // nor a full year ending more than 100 days before it (the 'jp' window) — a passing mention of the previous annual
    // report ("our annual report for the year ended 31 December 2025" in an interim report) never dates a release.
    const recentFrom = isEurope(profile) && opts.filedOn
      ? DateTime.fromISO(opts.filedOn, { zone: 'utc' }).minus({ days: JP_RECENT_DAYS }).toISODate()!
      : null;
    const periods = [...periodMentions(text, profile, opts.fyEndMonth), ...tableHeaderMentions(html, profile, opts.fyEndMonth)]
      .filter((p) => (!opts.filedOn || p.end <= opts.filedOn) && (!recentFrom || p.span !== 'year' || p.end >= recentFrom));
    if (periods.length > 0 && hasResultsTable(html, profile)) {
      // The latest period end is this release's; at that end the most specific span wins. A quarter label (only
      // `'uk'` / `'eu'` have them) counts only when no span is stated at that end.
      const latest = periods.reduce((a, b) => (b.end > a ? b.end : a), '');
      const atLatest = periods.filter((p) => p.end === latest);
      const stated = atLatest.filter((p) => !p.label);
      const span = (stated.length > 0 ? stated : atLatest).reduce<SixKSpan>((a, p) => (SPAN_ORDER[p.span] < SPAN_ORDER[a] ? p.span : a), 'year');
      return { kind: 'results', periodEnd: latest, span };
    }
  }

  const notice = parseDateNoticeFor(text, profile, opts.session);
  // 'jp': a "notice" naming a date before the filing is about something past (Takeda's revision of results
  // "announced on May 19"), not a results date.
  if (notice && profile === 'jp' && opts.filedOn && notice.date < opts.filedOn) return { kind: 'other' };
  if (notice) return { kind: 'date-notice', ...notice };
  return { kind: 'other' };
}

/** The document that carries the release: EX-99.1, else the first EX-99*, else the 6-K / 8-K itself. */
export function pickReleaseDoc(docs: FilingDoc[]): string | null {
  const type = (d: FilingDoc) => d.type.toUpperCase();
  return docs.find((d) => type(d) === 'EX-99.1')?.url
    ?? docs.find((d) => type(d).startsWith('EX-99'))?.url
    ?? docs.find((d) => /^[68]-K(\/A)?$/.test(type(d)))?.url
    ?? null;
}
