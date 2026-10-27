import { DateTime } from 'luxon';
import type { LocalTiming } from '../domain/exchangeCalendar.js';
import { isFigure, parseTables, type Cell } from './releaseReader.js';
import type { FilingDoc } from './secFeed.js';

/**
 * Shared 6-K classifier for the foreign markets. Profile `'hk'` is the Hong Kong classifier exactly as built (every
 * regex and branch); profile `'jp'` adds the Japanese results phrases, month-range headers, the nine-month span,
 * Tokyo clock / exchange phrases in date notices, and treats EDINET report translations as `other`.
 */
export type SixKProfile = 'hk' | 'jp';

/** `'nine'` only for `'jp'`; the HK output never contains it. */
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

/** One local clock time found in a sentence: minutes after midnight and where it ends. */
type ClockHit = { index: number; length: number; mins: number };

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

/** HK: BMO before 09:30, DMH to 16:00. JP: BMO before 09:00, DMH 09:00–15:29 (lunch counts), AMC from 15:30 (the close). */
function clockTiming(mins: number, profile: SixKProfile): LocalTiming {
  if (profile === 'jp') return mins < 9 * 60 ? 'BMO' : mins < 15 * 60 + 30 ? 'DMH' : 'AMC';
  return mins < 9 * 60 + 30 ? 'BMO' : mins <= 16 * 60 ? 'DMH' : 'AMC';
}
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
 * - "before the U.S. market opens [on D]" / "before the opening of the U.S. market": D, AMC.
 * - "after the U.S. market closes [on D]": D+1, BMO.
 * - An explicit local clock time (Hong Kong; for `'jp'` Japan / Tokyo time or JST): by the local thresholds.
 * - "before the opening / trading hours of the HKEX" (`'jp'`: the Tokyo Stock Exchange / TSE): BMO;
 *   "after the close / trading hours of …": AMC.
 * - Otherwise UNKNOWN. Returns null when no such statement is found.
 */
export function parseDateNoticeFor(text: string, profile: SixKProfile): { date: string; timing: LocalTiming } | null {
  const best: { rank: number; date: string; timing: LocalTiming }[] = [];
  const exchange = profile === 'jp' ? JP_EXCHANGE : HK_EXCHANGE;
  const clocks = profile === 'jp' ? jpClocks : hkClocks;
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
    if (!EARNINGS_WORDS.test(text.slice(Math.max(0, c.index! - 300), c.index! + 400))) continue;

    // A dividend's payment / record / book-closure date is never the results date.
    const nearest = datesAfter(window, '\\bon\\s+').find((d) => !DIVIDEND_DATE.test(window.slice(Math.max(0, d.index - 40), d.index)))?.date;
    let found: { date: string; timing: LocalTiming } | null = null;

    const open = datesAfter(window, 'before the U\\.?S\\.? market opens?\\s+on\\s+')[0]?.date;
    if (open) found = { date: open, timing: 'AMC' };
    else if (nearest && /before\s+(?:the\s+)?(?:U\.?S\.?\s+market\s+opens?|opening\s+of\s+the\s+U\.?S\.?\s+market)/i.test(window)) found = { date: nearest, timing: 'AMC' };
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
        const timing = clockTiming(t.mins, profile);
        const date = dateAt(window, t.index + t.length)?.date ?? nearest; // "on D at 4:30 p.m. Hong Kong time"
        if (date) { found = { date, timing }; break; }
      }
    }

    if (!found && nearest) {
      if (new RegExp(`before\\s+(?:the\\s+)?(?:opening|trading\\s+hours)\\s+of\\s+${exchange}`, 'i').test(window)) found = { date: nearest, timing: 'BMO' };
      else if (new RegExp(`after\\s+(?:the\\s+)?(?:close|trading\\s+hours)\\s+of\\s+${exchange}`, 'i').test(window)) found = { date: nearest, timing: 'AMC' };
      // JP Ruling 7: "before the opening of trading on the Tokyo Stock Exchange" / "after the close of trading on …".
      else if (profile === 'jp' && new RegExp(`before\\s+(?:the\\s+)?(?:opening|start)\\s+of\\s+trading\\s+on\\s+${exchange}`, 'i').test(window)) found = { date: nearest, timing: 'BMO' };
      else if (profile === 'jp' && new RegExp(`after\\s+(?:the\\s+)?(?:close|end)\\s+of\\s+trading\\s+on\\s+${exchange}`, 'i').test(window)) found = { date: nearest, timing: 'AMC' };
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
 * where the prose states it (absent for table headers).
 */
type PeriodMention = { end: string; span: SixKSpan; range?: true; index?: number };

/** All period ends the document states, as (end date, span). */
function periodMentions(text: string, profile: SixKProfile): PeriodMention[] {
  const out: PeriodMention[] = [];
  const words = '(?:three|six|nine|twelve)';
  for (const m of text.matchAll(new RegExp(`\\b(${words}(?:\\s+and\\s+${words})?)\\s+months\\s+ended\\s+`, 'gi'))) {
    const d = dateAt(text, m.index! + m[0].length);
    if (!d) continue;
    const w = m[1]!.toLowerCase();
    const span: SixKSpan | null = profile === 'jp'
      ? (w.includes('three') ? 'quarter' : w.includes('six') ? 'half' : w.includes('nine') ? 'nine' : w.includes('twelve') ? 'year' : null)
      : (w.includes('three') ? 'quarter' : w.includes('six') ? 'half' : w.includes('twelve') ? 'year' : null);
    if (span) out.push({ end: d.date, span, index: m.index! });
  }
  for (const m of text.matchAll(/\bquarter\s+ended\s+/gi)) {
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: 'quarter', index: m.index! });
  }
  for (const m of text.matchAll(/\byear\s+ended\s+/gi)) {
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
  return out;
}

/** Month names and the short forms Japanese releases use in column headers ("Apr.-Sep. 2026", "July–September 2026"). */
const MONTH_ANY_RE = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)';
const MONTH_RANGE = new RegExp(`\\b${MONTH_ANY_RE}\\.?\\s*[-–~～]\\s*${MONTH_ANY_RE}\\.?,?\\s*(\\d{4})\\b`, 'gi');
const RANGE_SPAN: Record<number, SixKSpan> = { 3: 'quarter', 6: 'half', 9: 'nine', 12: 'year' };
const JP_MONTH_WORD_SPAN: Record<string, SixKSpan> = { three: 'quarter', six: 'half', nine: 'nine', twelve: 'year' };

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
function tableHeaderMentions(html: string, profile: SixKProfile): PeriodMention[] {
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
          out.push(...periodMentions(column, profile));
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

const RESULTS_PHRASE: Record<SixKProfile, RegExp> = {
  hk: new RegExp(HK_RESULTS_PHRASES.join('|'), 'i'),
  jp: new RegExp([...HK_RESULTS_PHRASES, ...JP_RESULTS_PHRASES].join('|'), 'gi'),
};

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

/** True when some table row is labelled revenue / per share / per ADS (results releases carry one, notices do not). */
function hasResultsTable(html: string): boolean {
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (/per (ordinary )?share|per ads|revenue/i.test(htmlToText(row[1]!))) return true;
  }
  return false;
}

/**
 * Classify an exhibit (or 6-K main document) as an earnings release, a results-date notice, or something else.
 * `filedOn` is the local acceptance date. Profile `'hk'` is the Hong Kong classifier as built.
 */
export function classifySixK(html: string, opts: { filedOn?: string; profile: SixKProfile }): SixKExhibit {
  const { profile } = opts;
  const text = htmlToText(html);
  if (profile === 'jp' && isJpEdinetReport(text.slice(0, 5000))) return { kind: 'other' };
  // A notice whose opening names a results date after it was filed is a date notice, even with a "Revenue
  // guidance" row. (A release's own "next results on D" line sits deep in the body: HSBC at ~110k chars.)
  const opening = parseDateNoticeFor(text.slice(0, 5000), profile);
  if (opening && opts.filedOn && opening.date > opts.filedOn) return { kind: 'date-notice', ...opening };

  if (profile === 'jp') {
    const titleAt = jpResultsTitleAt(text.slice(0, 5000));
    if (titleAt >= 0 && hasResultsTable(html)) {
      const p = jpReleasePeriod([...periodMentions(text, profile), ...tableHeaderMentions(html, profile)], titleAt, opts.filedOn);
      if (p) return { kind: 'results', periodEnd: p.end, span: p.span };
    }
  } else if (RESULTS_PHRASE[profile].test(text.slice(0, 5000))) {
    // A results release cannot report a period ending after it was filed (`filedOn`: the acceptance date).
    const periods = [...periodMentions(text, profile), ...tableHeaderMentions(html, profile)].filter((p) => !opts.filedOn || p.end <= opts.filedOn);
    if (periods.length > 0 && hasResultsTable(html)) {
      // The latest period end is this release's; at that end the most specific span wins.
      const latest = periods.reduce((a, b) => (b.end > a ? b.end : a), '');
      const span = periods.filter((p) => p.end === latest).reduce<SixKSpan>((a, p) => (SPAN_ORDER[p.span] < SPAN_ORDER[a] ? p.span : a), 'year');
      return { kind: 'results', periodEnd: latest, span };
    }
  }

  const notice = parseDateNoticeFor(text, profile);
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
