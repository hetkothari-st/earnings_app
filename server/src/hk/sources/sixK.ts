import { DateTime } from 'luxon';
import { isFigure, parseTables, type Cell } from '../../sources/releaseReader.js';
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

const HK_EXCHANGE = '(?:the\\s+)?(?:HKEX|Hong Kong Stock Exchange|Hong Kong market|Stock Exchange of Hong Kong)';

/**
 * Release date and timing from a date notice (Ruling 4). Dates are HK dates.
 * Clause: "[to|will] announce|report|release|upload|publish … results … on D", or the passive
 * "results … will be announced|released|published on D". The nearest date after the verb is D.
 * Timing, first match wins:
 * - "before the U.S. market opens [on D]" / "before the opening of the U.S. market": D, AMC.
 * - "after the U.S. market closes [on D]": D+1, BMO.
 * - An explicit Hong Kong clock time: by the clock.
 * - "before the opening / trading hours of the HKEX": BMO; "after the close / trading hours of the HKEX": AMC.
 * - Otherwise UNKNOWN. Returns null when no such statement is found.
 */
export function parseDateNotice(text: string): { date: string; timing: HkTiming } | null {
  const best: { rank: number; date: string; timing: HkTiming }[] = [];
  const active = /\b(?:(?:to|will(?:\s+further)?)\s+)?(?:announce|report|release|upload|publish)\b[\s\S]{0,160}?\bresults?\b/gi;
  const passive = /\bresults?\b[\s\S]{0,200}?\b(?:will(?:\s+further)?\s+be|be)\s+[a-z ,]{0,80}?(?:announced|released|published)\s+on\s+/gi;

  for (const c of text.matchAll(active)) {
    // "announce the results of the poll / voting / general meeting" is a meeting notice, not earnings.
    const own = text.slice(c.index!, c.index! + c[0].length + 80);
    if (/poll|vot(?:e|ing)|results\s+of\s+(?:the\s+)?(?:annual|extraordinary|general)\b|meeting\s+results/i.test(own)) continue;
    if (!EARNINGS_WORDS.test(text.slice(Math.max(0, c.index! - 300), c.index! + 400))) continue;
    const window = text.slice(c.index!, c.index! + 400);

    const nearest = datesAfter(window, '\\bon\\s+')[0]?.date;
    let found: { date: string; timing: HkTiming } | null = null;

    const open = datesAfter(window, 'before the U\\.?S\\.? market opens?\\s+on\\s+')[0]?.date;
    if (open) found = { date: open, timing: 'AMC' };
    else if (nearest && /before\s+(?:the\s+)?(?:U\.?S\.?\s+market\s+opens?|opening\s+of\s+the\s+U\.?S\.?\s+market)/i.test(window)) found = { date: nearest, timing: 'AMC' };
    if (!found) {
      const close = datesAfter(window, 'after the U\\.?S\\.? market closes?\\s+on\\s+')[0]?.date
        ?? (nearest && /after\s+the\s+U\.?S\.?\s+market\s+closes?/i.test(window) ? nearest : undefined);
      if (close) found = { date: DateTime.fromISO(close, { zone: 'utc' }).plus({ days: 1 }).toISODate()!, timing: 'BMO' };
    }

    // Explicit Hong Kong clock time (a conference-call time is not a release time).
    if (!found) {
      const clock = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?,?\s*\(?(?:Beijing\s*\/\s*)?Hong Kong(?:\s+time)?\)?(?:\s+on\s+)?/gi;
      for (const t of window.matchAll(clock)) {
        const around = window.slice(Math.max(0, t.index! - 120), t.index! + 40);
        if (CALL_WORDS.test(around)) continue;
        const mins = ((Number(t[1]) % 12) + (t[3]!.toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(t[2] ?? 0);
        const timing: HkTiming = mins < 9 * 60 + 30 ? 'BMO' : mins <= 16 * 60 ? 'DMH' : 'AMC';
        const date = dateAt(window, t.index! + t[0].length)?.date ?? nearest; // "on D at 4:30 p.m. Hong Kong time"
        if (date) { found = { date, timing }; break; }
      }
    }

    if (!found && nearest) {
      if (new RegExp(`before\\s+(?:the\\s+)?(?:opening|trading\\s+hours)\\s+of\\s+${HK_EXCHANGE}`, 'i').test(window)) found = { date: nearest, timing: 'BMO' };
      else if (new RegExp(`after\\s+(?:the\\s+)?(?:close|trading\\s+hours)\\s+of\\s+${HK_EXCHANGE}`, 'i').test(window)) found = { date: nearest, timing: 'AMC' };
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

  best.sort((a, b) => b.rank - a.rank);
  return best[0] ? { date: best[0].date, timing: best[0].timing } : null;
}

const SPAN_ORDER: Record<HkSpan, number> = { quarter: 0, half: 1, year: 2 };

/**
 * A period named for a dividend ("second interim dividend … in respect of the financial year ended 31 December
 * 2025", paid mid-year) is not the period the release reports, and may even end after it.
 */
const dividendContext = (text: string, at: number) => /\bin respect of\b|\bdividends?\b/i.test(text.slice(Math.max(0, at - 60), at));

/** All period ends the document states, as (end date, span). */
function periodMentions(text: string): { end: string; span: HkSpan }[] {
  const out: { end: string; span: HkSpan }[] = [];
  const words = '(?:three|six|nine|twelve)';
  for (const m of text.matchAll(new RegExp(`\\b(${words}(?:\\s+and\\s+${words})?)\\s+months\\s+ended\\s+`, 'gi'))) {
    const d = dividendContext(text, m.index!) ? null : dateAt(text, m.index! + m[0].length);
    if (!d) continue;
    const w = m[1]!.toLowerCase();
    const span: HkSpan | null = w.includes('three') ? 'quarter' : w.includes('six') ? 'half' : w.includes('twelve') ? 'year' : null;
    if (span) out.push({ end: d.date, span });
  }
  for (const m of text.matchAll(/\bquarter\s+ended\s+/gi)) {
    const d = dividendContext(text, m.index!) ? null : dateAt(text, m.index! + m[0].length);
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
  return out;
}


/**
 * Period ends named by table column headers whose words are split across cells, e.g. "Three Months Ended" over
 * "June 30, 2026 / RMB (million)" (Trip.com, NetEase, BeOne). Each header cell's text is joined with the text of
 * the header cells above and below it that share its columns, and that column text is read like prose.
 */
function tableHeaderMentions(html: string): { end: string; span: HkSpan }[] {
  const out: { end: string; span: HkSpan }[] = [];
  for (const t of parseTables(html, { rowspan: true })) {
    let block: Cell[][] = [];
    const flush = () => {
      for (const row of block) {
        for (const cell of row) {
          if (!cell.text) continue;
          const column = block
            .map((r) => r.filter((c) => c.text && c.start < cell.start + cell.span && c.start + c.span > cell.start).map((c) => c.text).join(' '))
            .join(' ');
          out.push(...periodMentions(column));
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
const RESULTS_PHRASE = new RegExp(
  [
    String.raw`\b(?:announces?|reports?)\b[^.]{0,120}?\bresults\b`,
    String.raw`\binterim results\b`,
    String.raw`\bannual results\b`,
    String.raw`\b${MONTH_RE}\s+quarter\s+\d{4}\s+results\b`,
    String.raw`\bearnings release\b`,
    String.raw`\b[1-4]q\s?'?(?:\d{4}|\d{2})\s+(?:earnings|results)\b`,
    String.raw`\b(?:full|half)[\s-]year\s+\d{4}\s+results\b`,
    String.raw`\b\d{4}\s+(?:interim|half[\s-]year|full[\s-]year|annual)\s+results\b`,
    String.raw`\b(?:fy|hy|h[12])\s?'?(?:\d{4}|\d{2})\s+results\b`,
  ].join('|'),
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
    const periods = [...periodMentions(text), ...tableHeaderMentions(html)];
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
