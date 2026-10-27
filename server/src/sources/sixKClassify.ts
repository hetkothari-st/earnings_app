import { DateTime } from 'luxon';
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

/** Release timing against the local exchange session. */
export type LocalTiming = 'BMO' | 'DMH' | 'AMC' | 'UNKNOWN';

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

/** HK: BMO before 09:30, DMH to 16:00. JP: BMO before 09:00, DMH 09:00–15:30 inclusive (lunch counts), AMC after. */
function clockTiming(mins: number, profile: SixKProfile): LocalTiming {
  if (profile === 'jp') return mins < 9 * 60 ? 'BMO' : mins <= 15 * 60 + 30 ? 'DMH' : 'AMC';
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

/** A stated period end. `range`: from a `'jp'` month-range header, which may also head a forecast column. */
type PeriodMention = { end: string; span: SixKSpan; range?: true };

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
    if (span) out.push({ end: d.date, span });
  }
  for (const m of text.matchAll(/\bquarter\s+ended\s+/gi)) {
    const d = dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: 'quarter' });
  }
  for (const m of text.matchAll(/\byear\s+ended\s+/gi)) {
    const d = dividendContext(text, m.index!) ? null : dateAt(text, m.index! + m[0].length);
    if (d) out.push({ end: d.date, span: 'year' });
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\s+quarter\\s+(\\d{4})\\b`, 'gi'))) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
    const end = DateTime.utc(Number(m[2]), month, 1).endOf('month').toISODate();
    if (end) out.push({ end, span: 'quarter' });
  }
  if (profile === 'jp') out.push(...monthRangeMentions(text));
  return out;
}

/** Month names and the short forms Japanese releases use in column headers ("Apr.-Sep. 2026", "July–September 2026"). */
const MONTH_ANY_RE = '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)';
const MONTH_RANGE = new RegExp(`\\b${MONTH_ANY_RE}\\.?\\s*[-–~～]\\s*${MONTH_ANY_RE}\\.?,?\\s*(\\d{4})\\b`, 'gi');
const RANGE_SPAN: Record<number, SixKSpan> = { 3: 'quarter', 6: 'half', 9: 'nine', 12: 'year' };

/** `'jp'` month-range headers: the range's end month, span by its length (3, 6, 9 or 12 months; any other is skipped). */
function monthRangeMentions(text: string): PeriodMention[] {
  const out: PeriodMention[] = [];
  const monthNo = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3))) + 1;
  for (const m of text.matchAll(MONTH_RANGE)) {
    const from = monthNo(m[1]!);
    const to = monthNo(m[2]!);
    const span = RANGE_SPAN[((to - from + 12) % 12) + 1];
    const end = DateTime.utc(Number(m[3]), to, 1).endOf('month').toISODate();
    if (span && end) out.push({ end, span, range: true });
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
 * ended …" (MUFG), "Consolidated Financial Summary for the First Quarter Ended …" (Sony), "Q1 FY2026".
 */
const JP_RESULTS_PHRASES = [
  String.raw`\bconsolidated financial results for the (?:three|six|nine) months ended\b`,
  String.raw`\b(?:first|second|third) quarter (?:of )?(?:the )?(?:fiscal year|FY) ?\d{2,4}\b`,
  String.raw`\bFY\s?\d{4} (?:first|second|third|fourth) quarter\b`,
  String.raw`\bFY\d{4} Q[1-4]\b`,
  String.raw`\bconsolidated summary report\b`,
  String.raw`\bfinancial summary\b`,
  String.raw`\b(?:annual|full[- ]year) (?:consolidated )?financial results\b`,
];

const RESULTS_PHRASE: Record<SixKProfile, RegExp> = {
  hk: new RegExp(HK_RESULTS_PHRASES.join('|'), 'i'),
  jp: new RegExp([...HK_RESULTS_PHRASES, ...JP_RESULTS_PHRASES].join('|'), 'i'),
};

/**
 * `'jp'`: an EDINET report translation ("Annual Securities Report", "Semi-Annual Securities Report", "Share
 * Buyback Report") named as the document itself near the top. A tanshin's own "Scheduled date to file the annual
 * securities report: …" line is not this (it is a filing schedule, not the title).
 */
const JP_EDINET_REPORT = /\b(?:semi-?annual|annual|quarterly|extraordinary)\s+securities\s+report\b/gi;
const JP_FILING_SCHEDULE = /\b(?:fil(?:e|ed|ing)|submi(?:t|ssion|tting)|date)\b[^.:]{0,40}$/i;

function isJpEdinetReport(opening: string): boolean {
  for (const m of opening.matchAll(JP_EDINET_REPORT)) {
    if (!JP_FILING_SCHEDULE.test(opening.slice(Math.max(0, m.index! - 60), m.index!))) return true;
  }
  return false;
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

  if (RESULTS_PHRASE[profile].test(text.slice(0, 5000))) {
    // A results release cannot report a period ending after it was filed (`filedOn`: the acceptance date).
    const all = [...periodMentions(text, profile), ...tableHeaderMentions(html, profile)];
    const periods = all.filter((p) => !opts.filedOn || p.end <= opts.filedOn);
    // 'jp': a period stated as already ended ("three months ended D") after the filing means the document cannot be
    // a release filed then; an earlier comparative period is never taken instead. (Month ranges may be forecasts.)
    const endsAfterFiling = profile === 'jp' && all.some((p) => !p.range && opts.filedOn != null && p.end > opts.filedOn);
    if (!endsAfterFiling && periods.length > 0 && hasResultsTable(html)) {
      // The latest period end is this release's; at that end the most specific span wins.
      const latest = periods.reduce((a, b) => (b.end > a ? b.end : a), '');
      const span = periods.filter((p) => p.end === latest).reduce<SixKSpan>((a, p) => (SPAN_ORDER[p.span] < SPAN_ORDER[a] ? p.span : a), 'year');
      return { kind: 'results', periodEnd: latest, span };
    }
  }

  const notice = parseDateNoticeFor(text, profile);
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
