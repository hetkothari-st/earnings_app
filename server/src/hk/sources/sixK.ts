import { DateTime } from 'luxon';
import type { FilingDoc } from '../../sources/secFeed.js';
import type { HkTiming } from '../domain/hkCalendar.js';

export type HkSpan = 'quarter' | 'half' | 'year';

export type HkExhibit =
  | { kind: 'results'; periodEnd: string; span: HkSpan }
  | { kind: 'date-notice'; date: string; timing: HkTiming }
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

/**
 * Release date and timing from a date notice (Ruling 4). Dates are HK dates.
 * - "before the U.S. market opens on D" is D, AMC (HK evening).
 * - "after the U.S. market closes on D" is D+1, BMO.
 * - An explicit Hong Kong clock time gives the timing by the clock.
 * - A bare date after "(to|will) announce/report/release … results … on" is UNKNOWN.
 * Returns null when no such statement is found.
 */
export function parseDateNotice(text: string): { date: string; timing: HkTiming } | null {
  const best: { rank: number; date: string; timing: HkTiming }[] = [];
  const clause = /\b(?:to|will(?:\s+further)?)\s+(?:announce|report|release)\b[\s\S]{0,160}?\bresults\b/gi;
  for (const c of text.matchAll(clause)) {
    const window = text.slice(c.index!, c.index! + 600);
    // "announce the results of the poll / voting" is a meeting notice, not earnings.
    if (/poll|vot(?:e|ing)/i.test(text.slice(c.index!, c.index! + c[0].length + 60))) continue;
    if (!EARNINGS_WORDS.test(text.slice(Math.max(0, c.index! - 300), c.index! + 400))) continue;
    const before = datesAfter(window, 'before the U\\.?S\\.? market opens?\\s+on\\s+')[0];
    if (before) { best.push({ rank: 3, date: before.date, timing: 'AMC' }); continue; }
    const after = datesAfter(window, 'after the U\\.?S\\.? market closes?\\s+on\\s+')[0];
    if (after) { best.push({ rank: 3, date: DateTime.fromISO(after.date, { zone: 'utc' }).plus({ days: 1 }).toISODate()!, timing: 'BMO' }); continue; }

    // Explicit Hong Kong clock time, in the announcing sentence (a conference-call time is not a release time).
    const clock = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?,?\s*\(?(?:Beijing\s*\/\s*)?Hong Kong(?:\s+time)?\)?(?:\s+on\s+)?/gi;
    let byClock: { date: string; timing: HkTiming } | null = null;
    for (const t of window.matchAll(clock)) {
      const around = window.slice(Math.max(0, t.index! - 120), t.index! + 40);
      if (CALL_WORDS.test(around)) continue;
      const mins = ((Number(t[1]) % 12) + (t[3]!.toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(t[2] ?? 0);
      const timing: HkTiming = mins < 9 * 60 + 30 ? 'BMO' : mins <= 16 * 60 ? 'DMH' : 'AMC';
      const after = dateAt(window, t.index! + t[0].length);
      const sameDay = after ?? (() => { // "on August 13, 2026 at 4:30 p.m. Hong Kong time"
        const lead = [...window.slice(0, t.index!).matchAll(new RegExp(`on\\s+(?=${WEEKDAY_RE}(?:${MONTH_RE}|\\d))`, 'gi'))].pop();
        return lead ? dateAt(window, lead.index! + lead[0].length) : null;
      })();
      if (sameDay) { byClock = { date: sameDay.date, timing }; break; }
    }
    if (byClock) { best.push({ rank: 2, ...byClock }); continue; }

    const plain = datesAfter(window, '\\bon\\s+')[0];
    if (plain) best.push({ rank: 1, date: plain.date, timing: 'UNKNOWN' });
  }
  best.sort((a, b) => b.rank - a.rank);
  return best[0] ? { date: best[0].date, timing: best[0].timing } : null;
}

const SPAN_ORDER: Record<HkSpan, number> = { quarter: 0, half: 1, year: 2 };

/** All period ends the document states, as (end date, span). */
function periodMentions(text: string): { end: string; span: HkSpan }[] {
  const out: { end: string; span: HkSpan }[] = [];
  const words = '(?:three|six|nine|twelve)';
  for (const m of text.matchAll(new RegExp(`\\b(${words}(?:\\s+and\\s+${words})?)\\s+months\\s+ended\\s+`, 'gi'))) {
    const d = dateAt(text, m.index! + m[0].length);
    if (!d) continue;
    const w = m[1]!.toLowerCase();
    const span: HkSpan | null = w.includes('three') ? 'quarter' : w.includes('six') ? 'half' : w.includes('twelve') ? 'year' : null;
    if (span) out.push({ end: d.date, span });
  }
  for (const m of text.matchAll(/\bquarter\s+ended\s+/gi)) {
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: 'quarter' });
  }
  for (const m of text.matchAll(/\byear\s+ended\s+/gi)) {
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: 'year' });
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\s+quarter\\s+(\\d{4})\\b`, 'gi'))) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
    const end = DateTime.utc(Number(m[2]), month, 1).endOf('month').toISODate();
    if (end) out.push({ end, span: 'quarter' });
  }
  return out;
}

const RESULTS_PHRASE = new RegExp(
  `\\b(?:announces?|reports?)\\b[^.]{0,120}?\\bresults\\b|\\binterim results\\b|\\bannual results\\b|\\b${MONTH_RE}\\s+quarter\\s+\\d{4}\\s+results\\b`,
  'i',
);

/** True when some table row is labelled revenue / per share / per ADS (results releases carry one, notices do not). */
function hasResultsTable(html: string): boolean {
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (/per (ordinary )?share|per ads|revenue/i.test(htmlToText(row[1]!))) return true;
  }
  return false;
}

/** Classify an exhibit (or 6-K main document) as an earnings release, a results-date notice, or something else. */
export function classifyHkExhibit(html: string): HkExhibit {
  const text = htmlToText(html);

  if (RESULTS_PHRASE.test(text.slice(0, 5000))) {
    const periods = periodMentions(text);
    if (periods.length > 0 && hasResultsTable(html)) {
      // The latest period end is this release's; at that end the most specific span wins.
      const latest = periods.reduce((a, b) => (b.end > a ? b.end : a), '');
      const span = periods.filter((p) => p.end === latest).reduce<HkSpan>((a, p) => (SPAN_ORDER[p.span] < SPAN_ORDER[a] ? p.span : a), 'year');
      return { kind: 'results', periodEnd: latest, span };
    }
  }

  const notice = parseDateNotice(text);
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
