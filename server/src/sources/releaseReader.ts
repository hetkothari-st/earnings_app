/**
 * Reads EPS and revenue from an earnings press release (HTML): US 8-K EX-99.1
 * (profile 'us', `readUsRelease`), a foreign issuer's 6-K (profile 'hk':
 * RMB / US$ / HK$ columns, per-ADS rows, half-year and full-year columns) or a
 * Japanese issuer's 6-K (profile 'jp': yen only, basic and diluted EPS, quarter
 * or year-to-date columns; see `readJp`).
 *
 * Rule of thumb: uncertain means blank. A value is returned only when its row
 * label, its column header (the period ending `periodEnd` with the expected span,
 * never year-to-date) and — for revenue — the table's stated unit all check out,
 * and every candidate found in the document agrees. This reads document text
 * only; block detection (looksBlocked) is the fetcher's job.
 */

export interface ReleaseValues {
  epsAdjusted: number | null;
  epsGaap: number | null;
  revenue: number | null;
  unit: number | null; /* multiplier applied to revenue */
  notes: string[];
}

// ---------------------------------------------------------------- HTML → tables

export interface Cell { text: string; start: number; span: number }
export interface Table { rows: Cell[][]; before: string }

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '–', mdash: '—', minus: '−' };

function decode(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m)
    .replace(/[​‌‍﻿]/g, '')
    .replace(/[‘’′]/g, "'")
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/**
 * Tables of a document, each cell placed at its grid column. With `rowspan` (profile 'hk'), a cell spanning
 * several rows keeps its columns occupied in the rows below, so their cells start after it (as a browser lays
 * them out); without it, every row starts at column 0 (the US reader's long-standing behaviour).
 */
export function parseTables(html: string, opts: { rowspan?: boolean } = {}): Table[] {
  const out: Table[] = [];
  let prevEnd = 0;
  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const before = decode(html.slice(Math.max(prevEnd, t.index - 4000), t.index)).slice(-400);
    prevEnd = t.index + t[0].length;
    const rows: Cell[][] = [];
    let held: number[] = []; // column → rows still covered by a rowspan cell from above
    for (const tr of t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const cells: Cell[] = [];
      const next: number[] = [];
      let col = 0;
      const skipHeld = () => { while ((held[col] ?? 0) > 0) { next[col] = held[col]! - 1; col++; } };
      for (const td of tr[0].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
        const span = Math.max(1, Number(td[1]!.match(/colspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1));
        if (opts.rowspan) skipHeld();
        cells.push({ text: decode(td[2]!), start: col, span });
        const down = opts.rowspan ? Math.max(1, Number(td[1]!.match(/rowspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1)) : 1;
        for (let c = col; c < col + span; c++) if (down > 1) next[c] = down - 1;
        col += span;
      }
      if (opts.rowspan) {
        for (let c = col; c < held.length; c++) if ((held[c] ?? 0) > 0) next[c] = held[c]! - 1;
        held = next;
      }
      if (cells.some((c) => c.text)) rows.push(cells);
    }
    out.push({ rows, before });
  }
  return out;
}

// ---------------------------------------------------------------- numbers

interface Num { value: number; decimals: number; start: number; end: number; pct: boolean; dollar: boolean }

/** Numeric cells of a row; percentages are flagged. "(0.15)" → −0.15. */
function rowNumbers(cells: Cell[], from: number): Num[] {
  const out: Num[] = [];
  for (let i = from; i < cells.length; i++) {
    const c = cells[i]!;
    const raw = c.text.replace(/\$/g, '').replace(/\s+/g, '');
    const m = raw.match(/^(\(?)([-–−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%?\)?%?)$/);
    if (!m) continue;
    const next = cells.slice(i + 1).find((x) => x.text)?.text ?? '';
    const pct = m[5]!.includes('%') || /^\)?\s*%\s*\)?$/.test(next);
    const prev = [...cells.slice(from, i)].reverse().find((x) => x.text)?.text ?? '';
    const neg = m[1] === '(' || m[2] !== '' || /\($/.test(prev.replace(/[\s$]/g, ''));
    const value = Number(m[3]!.replace(/,/g, '') + (m[4] ?? ''));
    out.push({ value: neg ? -value : value, decimals: m[4] ? m[4].length - 1 : 0, start: c.start, end: c.start + c.span, pct, dollar: c.text.includes('$') || prev === '$' });
  }
  return out;
}

const isYear = (n: Num) => n.decimals === 0 && n.value >= 1990 && n.value <= 2100;

// ---------------------------------------------------------------- column headers

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const month = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** Header words that mean "not just this quarter". */
const NOT_QUARTER = new RegExp([
  String.raw`\b(nine|six|twelve|9|6|12)[\s-]*months?\b`,
  String.raw`\byears?\b`, String.raw`\bytd\b`, String.raw`year[\s-]*to[\s-]*date`, 'full[\\s-]*year',
  String.raw`\b(24|26|28|36|39|40|52|53)[\s-]*weeks?\b`,
  String.raw`(twenty[\s-]*(four|six|eight)|thirty[\s-]*(six|nine)|forty|fifty[\s-]*(two|three))[\s-]*weeks`,
  String.raw`(two|three) (fiscal )?quarters`, String.raw`\bchange\b`, '%', String.raw`\bvs\b`, 'versus', 'compared',
  'growth', 'guidance', 'outlook', 'prior', 'constant currency', String.raw`\bas of\b`, 'increase', 'decrease',
  'month(?!s)', 'trailing', 'annual', 'average',
].join('|'), 'i');

const YTD_PHRASE = /\b(nine|six|twelve|9|6|12)[\s-]*months?\b|year[\s-]*to[\s-]*date|\bytd\b|fiscal years?|years? ended|full[\s-]*year|\b(two|three) (fiscal )?quarters|\b(24|26|28|36|39|40|52|53)[\s-]*weeks?\b|(twenty[\s-]*(four|six|eight)|thirty[\s-]*(six|nine)|forty|fifty[\s-]*(two|three))[\s-]*weeks/gi;
const QUARTER_PHRASE = /\b(three|3)[\s-]*months?\b|quarter|\bqtr|\b(12|13|14|16|17)[\s-]*weeks?\b|(twelve|thirteen|fourteen|sixteen|seventeen)[\s-]*weeks|\bq[1-4]\b|\b[1-4]q/i;

/**
 * Period scope of a header block (all its text, label column included):
 * 'ytd' — only year-to-date phrases (e.g. "Six Months Ended" stated once, off to the side);
 * 'mixed' — both; columns must then carry their own period words.
 */
function blockScope(text: string): 'ytd' | 'quarter' | 'mixed' | 'none' {
  const ytd = text.match(YTD_PHRASE) !== null;
  const q = QUARTER_PHRASE.test(text.replace(YTD_PHRASE, ' '));
  return ytd && q ? 'mixed' : ytd ? 'ytd' : q ? 'quarter' : 'none';
}

/** A column that holds an adjustment, not a total. */
const ADJUSTMENT_COL = /adjustments?\b|optimization|special items|impact|excluded|reconcil|charges?\b/i;

function daysApart(y: number, m: number, d: number, qe: Date): number {
  return Math.abs(Date.UTC(y, m - 1, d) - qe.getTime()) / 86_400_000;
}

/** Dates named in a header, as [year, month, day]. `hk` also reads "30 Jun 2026" and "2026-06-30". */
function headDates(h: string, hk: boolean): Array<[number, number, number]> {
  const dates: Array<[number, number, number]> = [];
  for (const m of h.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})\\b`, 'gi'))) dates.push([Number(m[3]), month(m[1]!), Number(m[2])]);
  for (const m of h.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) dates.push([fullYear(m[3]!), Number(m[1]), Number(m[2])]);
  for (const m of h.matchAll(new RegExp(`\\b(\\d{1,2})-${MONTH_RE}-(\\d{4}|\\d{2})\\b`, 'gi'))) dates.push([fullYear(m[3]!), month(m[2]!), Number(m[1])]);
  if (hk) {
    for (const m of h.matchAll(new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi'))) dates.push([Number(m[3]), month(m[2]!), Number(m[1])]);
    for (const m of h.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) dates.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  return dates;
}

/** Does this column header name the quarter ending `qe`? */
function isQuarterColumn(h: string, qe: Date, hk = false): boolean {
  if (!h || NOT_QUARTER.test(h)) return false;
  const dates = headDates(h, hk);
  if (dates.length) return dates.every(([y, m, d]) => m > 0 && daysApart(y, m, d, qe) <= 15);

  // "Q3 2026", "3Q26", "3Q'26", "Third Quarter 2026": calendar quarters only.
  const qm = qe.getUTCMonth() + 1;
  if (qm % 3 !== 0 || /\bf(y|q)|fiscal/i.test(h)) return false;
  const quarters = new Set<number>();
  const years = new Set<number>();
  const WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4 };
  for (const m of h.matchAll(/\bQ([1-4])\b(?:\s*'?\s*(\d{4}|\d{2})\b)?/gi)) { quarters.add(Number(m[1])); if (m[2]) years.add(fullYear(m[2])); }
  for (const m of h.matchAll(/\b([1-4])Q\s*'?\s*(\d{4}|\d{2})?\b/gi)) { quarters.add(Number(m[1])); if (m[2]) years.add(fullYear(m[2])); }
  for (const m of h.matchAll(/\b(first|second|third|fourth) quarter\b/gi)) quarters.add(WORDS[m[1]!.toLowerCase()]!);
  for (const m of h.matchAll(/\b(19|20)(\d{2})\b/g)) years.add(Number(m[1]! + m[2]!));
  return quarters.size === 1 && years.size === 1 && quarters.has(qm / 3) && years.has(qe.getUTCFullYear());
}

// ---------------------------------------------------------------- labels

function normLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*\/?\s*\(loss\)|\(loss\)\s*\/?/g, ' ')
    .replace(/\(\s*(\d{1,2}|[a-z]|[ivx]+)\s*\)/g, ' ')
    .replace(/[*†‡¹²³⁴⁵⁶⁷⁸⁹]/g, ' ')
    .replace(/(\s+\d{1,2})+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:,.]+$/, '')
    .trim();
}

const EXCLUDE = /weighted|shares outstanding|dividend|book value|growth|change|constant[\s-]*currency|guidance|outlook|impact|effect of|calculation|used in|numerator|denominator|per share data|%|\bvs\b|increase|decrease|excluding|range|midpoint|accretion|noncontrolling|contribution|per basic share|ffo|funds from/i;
/** Brief rule, plus "per common share" / "per diluted share" spellings. */
const ADJ_LABEL = /(adjusted|non-gaap|core)\b.*\b(diluted )?(eps|earnings per (diluted |common )?share)|(adjusted|non-gaap|core)\b.*\b(earnings|net income) per diluted (common )?share/i;
const ADJ_WORDS = /\b(adjusted|non[\s-]?gaap|core|normalized|comparable|operating|pro forma|excluding)\b/i;
const GAAP_LABEL = /diluted (net )?(income|earnings) per (common )?share|diluted eps|(net )?(income|earnings) per (common )?share[\s,:\-–—]*(diluted|assuming dilution)|(net )?(income|earnings) per diluted (common )?share|\beps[\s(\-–—]*diluted/i;
const ADJ_CONTEXT = /non[\s-]?gaap|\badjusted\b|reconcil/i;
const EXPLICIT_GAAP = /(?<!non[\s-]?)\bgaap\b|\breported\b/i;
const REVENUE_LABELS = new Set([
  'total revenues', 'total revenue', 'revenues', 'revenue', 'net revenues', 'net revenue',
  'total net revenue', 'total net revenues', 'net sales', 'total net sales',
]);

type Field = 'epsAdjusted' | 'epsGaap' | 'epsAds' | 'revenue';

function epsField(label: string): Field | null {
  if (EXCLUDE.test(label) || /discontinued/.test(label)) return null;
  if (/basic/.test(label) && !/diluted|dilution/.test(label)) return null;
  if (ADJ_LABEL.test(label)) return 'epsAdjusted';
  if (GAAP_LABEL.test(label) && !ADJ_WORDS.test(label)) return 'epsGaap';
  return null;
}

// ---------------------------------------------------------------- units

/** Units stated inside a table (its header / title rows). */
const UNIT_RE = /\bin\s+(thousands|millions|billions)\b|\(\s*(?:\$|us\$|usd|u\.s\. dollars|dollars)?\s*(?:in\s+)?(thousands|millions|billions)\b|\$\s*(?:in\s+)?(thousands|millions|billions)\b|(thousands|millions|billions) of (?:u\.s\. )?dollars|\$\s?(000)'?s\b/gi;
/**
 * Units stated just above a table: caption forms only — "(in millions…)", "(Dollars in thousands…)",
 * "(unaudited, in millions…)",
 * "$ in millions", "$000s", "(000s)". Prose such as "tens of millions of customers" does not count.
 */
const CAPTION_RE = /\(\s*(?:\$|us\$|usd|u\.s\. dollars|dollars|amounts)?\s*in\s+(thousands|millions|billions)\b|\([^()]{0,60}?\bin\s+(thousands|millions|billions)\b|\$\s*(?:in\s+)?(thousands|millions|billions)\b|\$\s?(000)'?s\b|\(\s*(000)'?s\s*\)/gi;
/**
 * Foreign-issuer unit forms (profile 'hk'): "RMB'000", "US$m", "$m", "$bn", "RMB in millions",
 * "in millions of RMB / Renminbi / US dollars / HK dollars", "in US$ million", "RMB (million)".
 */
const HK_UNIT_RE = /(?:rmb|renminbi|us\$|hk\$|\$)\s*'\s*(000)\b|(?:rmb|us\$|hk\$|\$)\s?(m|mn|bn)\b|\b(?:rmb|renminbi|usd|hkd)\s+(?:in\s+)?(thousands|millions|billions)\b|(?:us\$|hk\$)\s*(?:in\s+)?(thousands|millions|billions)\b|\bin\s+(thousands|millions|billions)\s+of\s+(?:rmb|renminbi|u\.?\s?s\.?\s*dollars|us\$|hk\$|hk dollars|hong kong dollars)|\bin\s+(?:rmb|renminbi|us\$|hk\$|usd|hkd)\s*(thousand|million|billion)s?\b|(?:\brmb|renminbi|us\$|hk\$|\busd|\bhkd)\s*\(\s*(thousand|million|billion)s?\s*\)/gi;
/** A "$m" / "US$bn" unit: the HSBC-style tables whose revenue lines are read without a per-share row. */
const DOLLAR_M = /\$\s?(m|mn|bn)\b/i;
const MULT: Record<string, number> = {
  thousands: 1e3, '000': 1e3, millions: 1e6, billions: 1e9, m: 1e6, mn: 1e6, bn: 1e9, thousand: 1e3, million: 1e6, billion: 1e9,
};
/**
 * Profile 'hk': a caption that is an income-statement title and nothing else — "Unaudited Condensed Consolidated
 * Statements of Comprehensive Profit/(Loss) (Continued) (All amounts in thousands…)", "Income Statements
 * (in millions)". Prose that mentions a statement, and highlight / segment / key-figure tables, are not titles.
 */
/** A parenthesised group, one level of nesting allowed: "(Amounts in …, American Depositary Shares (ADSs), …)". */
const PAREN_GROUP = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const STATEMENT_TITLE = new RegExp(
  String.raw`^\s*(?:\d{1,3}\s+)?(?:(?:unaudited|condensed|consolidated|interim)\s+)*` +
  String.raw`(?:statements?\s+of\s+(?:comprehensive\s+)?(?:income|operations|earnings|profit|loss|\(loss\))` +
  String.raw`(?:\s*(?:\/|and|or)\s*(?:comprehensive\s+)?\(?(?:income|loss|profit)\)?)*|income\s+statements?)` +
  String.raw`\s*(?:\(\s*continued\s*\)\s*)?(?:${PAREN_GROUP}\s*)*$`,
  'i',
);
const NOT_STATEMENT = /highlight|summary|selected|\bkey\b|segment|pro forma|outlook|guidance/i;

/** The income-statement title of a caption, normalised for comparison ("(continued)" and units dropped), else null. */
function statementTitle(caption: string): string | null {
  if (NOT_STATEMENT.test(caption) || !STATEMENT_TITLE.test(caption)) return null;
  return caption.toLowerCase().replace(new RegExp(PAREN_GROUP, 'g'), ' ').replace(/^\s*\d+\s+/, '').replace(/\s+/g, ' ').trim();
}

/** Currencies of a unit statement ("in thousands of U.S. dollars", "RMB in millions", "in US$ million"). */
const UNIT_CUR = String.raw`(?:rmb|renminbi|u\.?\s?s\.?\s*dollars|us\$|usd|hk\$|hkd|hk dollars|hong kong dollars)`;
/** "RMB and US$", "RMB/US$": every currency of a list is kept, so a two-currency unit phrase stays ambiguous. */
const UNIT_CURS = String.raw`${UNIT_CUR}(?:\s*(?:and|or|\/|,)\s*${UNIT_CUR})*`;
const UNIT_WORD = String.raw`(?:thousands?|millions?|billions?)`;
/** The unit statement itself: "in thousands of U.S. dollars", "in US$ million", "RMB in millions", "RMB (million)", "RMB'000", "in RMB". */
const UNIT_CORE = String.raw`(?:in\s+${UNIT_WORD}\s+of\s+${UNIT_CURS}|in\s+${UNIT_CURS}(?:\s*(?:${UNIT_WORD}|'\s*000))?|${UNIT_CURS}\s*(?:in\s+)?(?:${UNIT_WORD}|'\s*000|m|mn|bn)|${UNIT_CURS}\s*\(\s*${UNIT_WORD}\s*\))`;
/** "except per share data" / ", except for US$ amounts": a trailing clause that is not part of the unit statement. */
const EXCEPT_CLAUSE = /\s*,?\s*except\b[\s\S]*$/i;
/**
 * A text that is wholly a unit statement (allowlist): optional parentheses, optional "(All) amounts (are)
 * (stated / expressed)", the unit statement, an optional trailing "except …" clause — and nothing else.
 */
const UNIT_STATEMENT = new RegExp(
  String.raw`^\(?\s*(?:(?:all\s+)?amounts?\s+(?:are\s+)?(?:stated\s+|expressed\s+)?)?${UNIT_CORE}\s*\)?\s*$`,
  'i',
);
const unitStatement = (text: string): string | null => {
  const core = text.trim().replace(/^\(|\)$/g, '').replace(EXCEPT_CLAUSE, '').trim();
  return UNIT_STATEMENT.test(core) ? core : null;
};

/**
 * Profile 'hk': the unit statement through which a table caption names the table's currency, or '' when it names
 * none. Allowlist only: (1) the caption is an income-statement title, and one of its parenthesised groups is a unit
 * statement ("… Statements of Operations (in thousands of RMB, except for US$ amounts)" → "in thousands of RMB");
 * or (2) the whole caption is a unit statement ("Amounts in thousands of U.S. dollars", "(RMB in millions)").
 * Prose of any kind ("Our revenue in US$ millions grew strongly", notes, convenience remarks) names nothing.
 */
export function captionCurrencyText(caption: string): string {
  if (statementTitle(caption) != null) {
    return [...caption.matchAll(new RegExp(PAREN_GROUP, 'g'))].map((m) => unitStatement(m[0].slice(1, -1))).filter((x): x is string => x != null).join(' ; ');
  }
  return unitStatement(caption) ?? '';
}

/** A figure cell: "1,234", "(0.29)", "$ 0.87", "12%". A lone footnote mark "(2)" and header text are not. */
const FIGURE_RE = /^\(?[-–−]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?\)?%?\)?$/;
export function isFigure(text: string): boolean {
  const s = text.replace(/[\s$]/g, '');
  return FIGURE_RE.test(s) && !/^\(\d{1,2}\)$/.test(s);
}

/**
 * The caption of a table: the last sentence above it ("… Statements of Income (in millions)"). Profile 'hk' does not
 * end a sentence at "U.S." / "U.K." ("Statements of Operations (U.S. GAAP) (Amounts in thousands of U.S. dollars …)").
 */
export function tableCaption(table: Table, hk = false): string {
  const end = hk ? /(?<!\bU\.[SK])[.!?;]\s+(?=[A-Z0-9(])/ : /[.!?;]\s+(?=[A-Z0-9(])/;
  return table.before.split(end).pop() ?? '';
}

function units(text: string, re: RegExp = UNIT_RE): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(re)) {
    const w = m.slice(1).find((g) => g !== undefined)!.toLowerCase();
    out.add(MULT[w]!);
  }
  return out;
}

// ---------------------------------------------------------------- currencies (profile 'hk')

/** 'JPY' is only ever produced by profile 'jp'; the 'us' / 'hk' currency detection never names yen. */
export type Currency = 'CNY' | 'USD' | 'HKD' | 'JPY';

const CNY_RE = /\brmb\b|renminbi/i;
const HKD_RE = /hk\$|\bhkd\b|\bhk dollars?\b|hong kong dollars?/i;
const USD_RE = /us\$|\busd\b|\bu\.\s?s\.\s?dollars?\b|\bus dollars?\b/i;

/** Currencies named in a text. '$' is a plain dollar sign, whose currency depends on the document. */
export function currenciesIn(text: string): Set<Currency | '$'> {
  const out = new Set<Currency | '$'>();
  if (CNY_RE.test(text)) out.add('CNY');
  if (HKD_RE.test(text)) out.add('HKD');
  if (USD_RE.test(text)) out.add('USD');
  if (/\$/.test(text.replace(/(?:hk|us|[a-z])\$/gi, ' '))) out.add('$');
  return out;
}

/** The one currency a text names, '$' for a plain dollar sign only, null for none or several. */
function oneCurrency(text: string, dollarIsUsd: boolean): Currency | null | undefined {
  const s = currenciesIn(text);
  const named = [...s].filter((c): c is Currency => c !== '$');
  if (named.length > 1) return null;
  if (named.length === 1) return named[0]!;
  if (s.has('$')) return dollarIsUsd ? 'USD' : null;
  return undefined; // nothing stated here: look further out
}

// ---------------------------------------------------------------- period spans (profile 'hk')

const HALF_PHRASE = /\b(six|6)[\s-]*months?\b|half[\s-]*year|\b(first|second) half\b|\b[12]h\b|\bh[12]\b|\binterim\b|\b(24|26|28)[\s-]*weeks?\b/gi;
const NINE_PHRASE = /\b(nine|9)[\s-]*months?\b|\b(36|39|40)[\s-]*weeks?\b/i;
const YEAR_PHRASE = /\b(twelve|12)[\s-]*months?\b|\byears?\b|\bfy\b|full[\s-]*year|\bannual\b|\b(52|53)[\s-]*weeks?\b/i;
/** Header words that rule a column out whatever its span. */
const NOT_PERIOD = /\bchange\b|%|\bvs\b|versus|compared|growth|guidance|outlook|prior|constant currency|\bas (of|at)\b|\bat\s+\d|increase|decrease|trailing|average|annuali[sz]ed|pro forma/i;

type Span = ReaderOptions['span'];

function spanKinds(text: string): Set<Span | 'nine'> {
  const out = new Set<Span | 'nine'>();
  if (text.match(HALF_PHRASE)) out.add('half');
  const rest = text.replace(HALF_PHRASE, ' ');
  if (NINE_PHRASE.test(rest)) out.add('nine');
  if (QUARTER_PHRASE.test(rest)) out.add('quarter');
  if (YEAR_PHRASE.test(rest)) out.add('year');
  return out;
}

/**
 * Does this column name the half / year ending `pe`? Its own header must name that span and nothing else, or
 * name no span while the whole header block names only that span. A dated column must be within 15 days of
 * `pe`; an undated half needs "1H" / "interim" with the period-end year.
 */
function isSpanColumn(over: string, block: string, labelCol: string, pe: Date, span: 'half' | 'nine' | 'year'): boolean {
  if (!over || NOT_PERIOD.test(over) || ADJUSTMENT_COL.test(over)) return false;
  const own = spanKinds(over);
  const kinds = own.size ? own : spanKinds(block);
  if (kinds.size !== 1 || !kinds.has(span)) return false;
  const dates = headDates(over, true);
  if (!dates.length) dates.push(...headDates(labelCol, true));
  if (dates.length) return dates.every(([y, m, d]) => m > 0 && daysApart(y, m, d, pe) <= 15);
  if (span !== 'half' || /\bf(y|q)|fiscal/i.test(over)) return false;
  const years = new Set([...over.matchAll(/\b(19|20)(\d{2})\b|\b[12]h\s*'?(\d{2})\b/gi)].map((m) => (m[3] ? 2000 + Number(m[3]) : Number(m[1]! + m[2]!))));
  return /\b(1h|h1|interim|first half)/i.test(over) && years.size === 1 && years.has(pe.getUTCFullYear());
}

// ---------------------------------------------------------------- labels (profile 'hk')

const HK_EXCLUDE = /asset value|cash flow|distribution|book value|dividend/i;
/** "($)", "(RMB)", "(US$m)", "(HK$'000)" after a label. */
const LABEL_CURRENCY = /\(\s*(?:in\s+)?(?:rmb|renminbi|us\$|hk\$|\$|usd|hkd)\s*(?:'?000|m|mn|bn|millions?|thousands?)?\s*\)/gi;
/** Sections whose figures are not the reported ones. */
const SKIP_SECTION = /constant currency|adjusted|non[\s-]?gaap|notable|excluding|underlying|pro forma/i;

function hkLabel(label: string): string {
  return label.replace(LABEL_CURRENCY, ' ').replace(/(\s+\d{1,2}(\s*,\s*\d{1,2})+)\s*$/, '').replace(/\s+/g, ' ').replace(/[\s:,.]+$/, '').trim();
}

/**
 * Diluted EPS per (ordinary / Class A / common) share → epsGaap, per ADS → epsAds; adjusted rows → epsAdjusted
 * (then dropped). A combined "per share/ADS" row is read as per share only when `shareIsAds` (one ADS is one
 * share, so both figures are the same number); otherwise it is ambiguous and skipped.
 */
function hkEpsField(label: string, shareIsAds: boolean): Field | null {
  if (EXCLUDE.test(label) || HK_EXCLUDE.test(label) || /discontinued/.test(label)) return null;
  if (!/dilut/.test(label)) return null;
  if (/\bshares?\s*(\/|or|and)\s*ads\b|\bads\s*(\/|or|and)\s*(ordinary )?shares?\b/.test(label)) {
    if (!shareIsAds || !/\bper\s+((ordinary )?shares?\s*(\/|or|and)\s*ads|ads\s*(\/|or|and)\s*(ordinary )?shares?)\b/.test(label)) return null;
    return ADJ_WORDS.test(label) || /non[\s-]?gaap/.test(label) ? 'epsAdjusted' : 'epsGaap';
  }
  const ads = /\bper\s+(ads|american depositary shares?)\b/.test(label);
  const share = /\bper\s+(class [a-z] )?(ordinary |common )?share\b|\beps\b/.test(label);
  if (ads === share) return null;
  if (ADJ_WORDS.test(label) || /non[\s-]?gaap/.test(label)) return 'epsAdjusted';
  return ads ? 'epsAds' : 'epsGaap';
}

/** A row of only currency / unit marks ("$ | $", "RMB | US$") inside a table. */
const UNIT_ROW_CELL = /^\(?\s*(?:rmb|renminbi|us\$|hk\$|\$|usd|hkd)?\s*(?:'?000|m|mn|bn|millions?|thousands?)?\s*\)?$/i;

// ---------------------------------------------------------------- reader

export interface ReaderOptions {
  periodEnd: string;
  /** 'nine' (nine months year-to-date) is used by profile 'jp'. */
  span: 'quarter' | 'half' | 'nine' | 'year';
  profile: 'us' | 'hk' | 'jp';
  /** Profile 'hk': only columns in this currency are read. */
  currency?: Currency;
  /** Profile 'hk': one ADS is one share (ADR ratio 1), so a combined "per share/ADS" row is per share. */
  shareIsAds?: boolean;
}

export interface ReaderResult {
  /** Diluted GAAP EPS per share (US: per common share; HK: per ordinary share). Same as `epsGaap`. */
  epsShare: number | null;
  /** A per-share GAAP candidate was found, even when candidates disagreed and `epsShare` is null. */
  epsShareStated: boolean;
  /** Diluted GAAP EPS per ADS (profile 'hk' only). */
  epsAds: number | null;
  /** Adjusted / non-GAAP EPS (profile 'us' only; never read for 'hk'). */
  epsAdjusted: number | null;
  epsGaap: number | null;
  /** Basic EPS per share (profile 'jp' only; null for 'us' / 'hk'). */
  epsBasic: number | null;
  revenue: number | null;
  unit: number | null; /* multiplier applied to revenue */
  notes: string[];
}

interface Candidate { value: number; unit: number | null }

export function readUsRelease(html: string, quarterEnd: string): ReleaseValues {
  const r = readRelease(html, { periodEnd: quarterEnd, span: 'quarter', profile: 'us' });
  return { epsAdjusted: r.epsAdjusted, epsGaap: r.epsGaap, revenue: r.revenue, unit: r.unit, notes: r.notes };
}

export function readRelease(html: string, opts: ReaderOptions): ReaderResult {
  if (opts.profile === 'jp') return readJp(html, opts);
  const notes: string[] = [];
  const hk = opts.profile === 'hk';
  const qe = new Date(`${opts.periodEnd}T00:00:00Z`);
  const found: Record<Field, Candidate[]> = { epsAdjusted: [], epsGaap: [], epsAds: [], revenue: [] };
  if (Number.isNaN(qe.getTime())) {
    return { epsShare: null, epsShareStated: false, epsAds: null, epsAdjusted: null, epsGaap: null, epsBasic: null, revenue: null, unit: null, notes: [hk ? 'bad periodEnd' : 'bad quarterEnd'] };
  }

  const tables = parseTables(html, { rowspan: hk });
  // A plain "$" is US$ when no table names another currency (or the caption says US dollars).
  const docCurrencies = hk ? currenciesIn(tables.flatMap((t) => t.rows.flat().map((c) => c.text)).join(' ')) : new Set();
  const dollarIsUsdInDoc = !docCurrencies.has('CNY') && !docCurrencies.has('HKD');

  const epsRow = hk
    ? /per (diluted |common |basic )?share|\beps\b|earnings per|per (class [a-z] )?ordinary share|per ads\b|per american depositary/i
    : /per (diluted |common |basic )?share|\beps\b|earnings per/i;

  const epsTables = tables.map((t) => t.rows.some((r) => epsRow.test(r.find((c) => c.text)?.text ?? '')));
  const statementTitles = hk ? tables.map((t) => statementTitle(tableCaption(t, true))) : [];

  for (const [ti, table] of tables.entries()) {
    // Table unit: stated in its non-data rows, else just above the table.
    const nonData: string[] = [];
    const hasEpsRow = epsTables[ti]!;
    // Profile 'hk': an income statement split over consecutive tables (XPeng, KE Holdings) — the tables that follow
    // carry the same statement title ("(continued)"), and one of them holds the per-share lines.
    let splitStatement = false;
    if (hk && statementTitles[ti] != null) {
      for (let j = ti + 1; j < tables.length; j++) {
        if (!tables[j]!.rows.some((r) => r.some((c) => /[a-z]/i.test(c.text)))) continue; // a page-number / layout table
        if (statementTitles[j] !== statementTitles[ti]) break;
        if (epsTables[j]) splitStatement = true;
      }
    }
    let headers: Cell[][] = [];
    let lastWasData = false;
    let section = '';
    let titles: Cell[][] = []; // label-only rows since the last data row
    const rowsOut: Array<{ field: Field; nums: Num[]; headers: Cell[][]; label: string; rawLabel: string; section: string }> = [];

    for (const cells of table.rows) {
      const li = cells.findIndex((c) => c.text);
      const first = cells[li]!;
      const hasLabel = /[a-z]/i.test(first.text) && !/^\(?\s*\d/.test(first.text);
      const nums = rowNumbers(cells, hasLabel ? li + 1 : li);
      const yearRow = nums.length > 0 && nums.every((n) => isYear(n) && !n.dollar && !n.pct);
      const otherText = cells.slice(li + 1).some((c) => c.text);

      if (hasLabel && nums.length && !yearRow) {
        lastWasData = true;
        titles = [];
        let label = normLabel(first.text);
        if (hk) label = hkLabel(label);
        if (/^(diluted|basic|assuming dilution)$/.test(label) && section) label = `${section} ${label}`;
        // "Per ordinary share" | "Diluted earnings": the section names the per-share basis.
        else if (hk && /\bper\b/.test(section) && !/\bper\b/.test(label) && /\b(diluted|basic)\b/.test(label)) label = `${label} ${section}`;
        const field = REVENUE_LABELS.has(label) ? 'revenue' : hk ? hkEpsField(label, opts.shareIsAds === true) : epsField(label);
        const vals = nums.filter((n) => !n.pct);
        if (field && vals.length && !(hk && SKIP_SECTION.test(section))) rowsOut.push({ field, nums: vals, headers, label, rawLabel: first.text, section });
        // "As Adjusted(2): | Institutional: | $ 17" — a heading that shares its row with a side panel.
        if (/:\s*$/.test(first.text)) section = normLabel(first.text);
        continue;
      }
      nonData.push(cells.map((c) => c.text).join(' '));
      if (!otherText) {
        // Label-only row: a section ("Net income per share:") or, above the
        // column headers, a title such as "Six Months Ended July 3, 2026".
        section = normLabel(first.text);
        if (lastWasData) titles = [...titles, cells];
        else headers = [...headers, cells];
        continue;
      }
      // A "$ | $" row between data rows restates the unit of the columns below; it does not start a new block.
      if (hk && lastWasData && cells.every((c) => !c.text || UNIT_ROW_CELL.test(c.text))) {
        headers = [...headers, cells];
        section = '';
        continue;
      }
      if (lastWasData) headers = titles; // a new header block, with the titles just above it
      headers = [...headers, cells];
      lastWasData = false;
      section = '';
    }
    if (!rowsOut.length) continue;

    const nonDataText = nonData.join(' ');
    const inTable = units(nonDataText);
    // Caption: the last sentence above the table ("… Reconciliation of Non-GAAP Measures (in millions)").
    const caption = tableCaption(table, hk);
    const near = units(caption, CAPTION_RE);
    if (hk) {
      for (const u of units(nonDataText, HK_UNIT_RE)) inTable.add(u);
      for (const u of units(caption, HK_UNIT_RE)) near.add(u);
    }
    let unit: number | null = null;
    if (inTable.size === 1) unit = [...inTable][0]!;
    else if (inTable.size === 0 && near.size === 1) unit = [...near][0]!;
    const dollarM = hk && DOLLAR_M.test(nonDataText);
    // Profile 'hk': the caption names a currency only through a unit phrase ("in thousands of U.S. dollars").
    // A caption whose unit disagrees with the table's own ("thousands" above, "(in millions)" inside) belongs to
    // something else: its currency is not this table's.
    const captionElsewhere = hk && inTable.size > 0 && near.size > 0 && ![...near].some((u) => inTable.has(u));
    const capCurText = hk ? (captionElsewhere ? '' : captionCurrencyText(caption)) : caption;
    const capCur = currenciesIn(capCurText);
    const dollarIsUsd = dollarIsUsdInDoc || (capCur.has('USD') && !capCur.has('CNY') && !capCur.has('HKD'));

    for (const { field, nums, headers: hs, label, rawLabel, section: sec } of rowsOut) {
      const picked: Num[] = [];
      const blockText = hs.flat().map((c) => c.text).join(' ');
      const scope = blockScope(blockText);
      // Under a caption, header block or section that says non-GAAP / adjusted / reconciliation, a plain
      // "Diluted EPS" row may be the adjusted figure: GAAP only from rows or columns that say GAAP / reported.
      const adjContext = ADJ_CONTEXT.test(`${caption} ${blockText} ${sec}`);
      if (scope === 'ytd' && opts.span === 'quarter') continue;
      const labelCol = hs.map((row) => row.filter((c) => c.text && c.start === 0 && c.span === 1).map((c) => c.text).join(' ')).join(' ');
      for (const n of nums) {
        const over = hs.map((row) => row.filter((c) => c.text && c.start < n.end && c.start + c.span > n.start).map((c) => c.text).join(' ')).join(' ').trim();
        let head: string;
        if (opts.span === 'quarter') {
          // A block that only speaks of the quarter may name it once, in the label column ("Q3", "Three Months Ended June 30, 2026").
          head = scope === 'quarter' ? `${labelCol} ${over}`.trim() : over;
          if (!isQuarterColumn(head, qe, hk) || ADJUSTMENT_COL.test(head)) continue;
          if (scope === 'mixed' && !QUARTER_PHRASE.test(head)) continue;
        } else {
          head = over;
          if (!isSpanColumn(over, `${labelCol} ${blockText}`, labelCol, qe, opts.span)) continue;
        }
        if (hk && opts.currency) {
          // The column's currency: its own header, else the row label, else the table's titles and caption.
          // A header and a row label naming different currencies ("RMB" column, "… (USD)" row) is ambiguous.
          let cur: Currency | null | undefined;
          for (const t of [over, rawLabel, `${nonDataText} ${capCurText}`]) if ((cur = oneCurrency(t, dollarIsUsd)) !== undefined) break;
          const rowCur = oneCurrency(rawLabel, dollarIsUsd);
          if (cur !== undefined && rowCur !== undefined && rowCur !== cur) cur = null;
          if (cur === undefined && n.dollar && dollarIsUsd) cur = 'USD';
          if (cur !== opts.currency) continue;
        }
        let f: Field = field;
        const adjCol = /\b(adjusted|non[\s-]?gaap|core)\b/i.test(head);
        if (adjCol && f === 'epsGaap') f = 'epsAdjusted';
        if (hk && adjCol && f === 'epsAds') continue;
        if (!adjCol && f === 'epsAdjusted' && /\bgaap\b|as reported/i.test(head)) continue;
        if (f !== 'revenue' && (n.decimals < 2 || n.decimals > 3 || Math.abs(n.value) >= 1000)) continue;
        if (f === 'revenue' && (n.value <= 0 || n.decimals > 2)) continue;
        if ((f === 'epsGaap' || f === 'epsAds') && adjContext && !EXPLICIT_GAAP.test(`${label} ${head}`)) continue;
        if (hk && f === 'epsAdjusted') continue; // adjusted / non-GAAP is never read for foreign issuers
        if (f !== field) { found[f].push({ value: n.value, unit: null }); continue; }
        picked.push(n);
      }
      if (!picked.length) continue;
      if (field === 'revenue') {
        // Segment / KPI tables have no per-share line and are not the income statement. A "$m" table
        // (HSBC's highlights) states revenue without one; so does an income statement whose caption names it
        // and whose per-share lines continue in the next table (XPeng).
        if (!hasEpsRow && !dollarM && !splitStatement) continue;
        if (unit === null) { notes.push('revenue: no unit stated for table'); continue; }
        for (const n of picked) found.revenue.push({ value: n.value * unit, unit });
      } else {
        for (const n of picked) found[field].push({ value: n.value, unit: null });
      }
    }
  }

  const settle = (field: Field): Candidate | null => {
    const c = found[field];
    if (!c.length) return null;
    const same = (a: number, b: number) => (field === 'revenue' ? Math.abs(a - b) <= 0.001 * Math.abs(b) : Math.abs(a - b) < 1e-6);
    const distinct = c.filter((x, i) => c.findIndex((y) => same(x.value, y.value)) === i);
    if (distinct.length > 1) {
      notes.push(`${field}: candidates disagree (${distinct.map((d) => d.value).join(', ')})`);
      return null;
    }
    // Agreeing revenue candidates: keep the finest unit (most digits).
    return c.reduce((a, b) => ((b.unit ?? Infinity) < (a.unit ?? Infinity) ? b : a));
  };

  const adj = settle('epsAdjusted');
  const gaap = settle('epsGaap');
  const rev = settle('revenue');
  const ads = settle('epsAds');
  return {
    epsShare: gaap?.value ?? null,
    epsShareStated: found.epsGaap.length > 0,
    epsAds: ads?.value ?? null,
    epsAdjusted: adj?.value ?? null,
    epsGaap: gaap?.value ?? null,
    epsBasic: null,
    revenue: rev ? Math.round(rev.value) : null,
    unit: rev?.unit ?? null,
    notes,
  };
}

// ---------------------------------------------------------------- profile 'jp'
//
// A separate pass, so the 'us' / 'hk' paths above are untouched. Japanese 6-Ks (Tanshin translations, IFRS / J-GAAP
// statements) state yen figures "in millions of yen", give basic EPS as the headline per-share figure, and from the
// 2nd quarter on often print only year-to-date (six / nine / twelve months) columns. One span is read per call; a
// quarter is never derived from year-to-date figures.

type JpSpan = 'quarter' | 'half' | 'nine' | 'year';
type JpField = 'revenue' | 'basic' | 'diluted' | 'both';

const JP_YEN = /¥|\byen\b|\bjpy\b/i;
const JP_USD = /us\$|\busd\b|\bu\.\s?s\.\s?dollars?\b|\bus dollars?\b|\$/i;

/** The currency a text names: 'JPY', 'USD', null for both, undefined for none. */
function jpCurrency(text: string): 'JPY' | 'USD' | null | undefined {
  const y = JP_YEN.test(text);
  const u = JP_USD.test(text);
  return y && u ? null : y ? 'JPY' : u ? 'USD' : undefined;
}

/**
 * Allowlisted yen unit statements: "Millions of yen", "(Millions of yen)", "Yen in millions", "(¥ in millions)",
 * "¥ million(s)", "in millions of yen", "Amounts in millions of yen", "Billions of yen", "Yen in billions" (and the
 * Tanshin "Million yen"), each with an optional ", except per share amounts". Nothing else counts as a unit.
 */
const JP_UNIT_STATEMENT = /^(?:(?:amounts\s+)?in\s+(millions|billions)\s+of\s+yen|(millions?|billions?)\s+(?:of\s+)?yen|yen\s+in\s+(millions|billions)|¥\s*(?:in\s+)?(millions?|billions?))$/i;

function jpUnit(text: string): number | null {
  const core = text.trim().replace(/^\(\s*/, '').replace(/\s*\)$/, '').replace(EXCEPT_CLAUSE, '').trim();
  const m = core.match(JP_UNIT_STATEMENT);
  if (!m) return null;
  return m.slice(1).find((g) => g !== undefined)!.toLowerCase().startsWith('million') ? 1e6 : 1e9;
}

/** A header cell that only states a unit or currency ("Yen", "Millions of yen", "Millions of U.S. dollars", "%"). */
const JP_UNIT_CELL = /^\(?\s*(?:yen|¥|jpy|%|u\.?\s?s\.?\s*dollars?|us\$|\$|(?:thousands?|millions?|billions?)\s+of\s+u\.?\s?s\.?\s*dollars)\s*\)?$/i;
const jpUnitCell = (t: string) => !t || jpUnit(t) !== null || JP_UNIT_CELL.test(t);

/** An income-statement title ("- 3 - Condensed Quarterly Consolidated Statements of Income (Millions of yen)"). */
const JP_TITLE = new RegExp(
  String.raw`^(?:(?:unaudited|condensed|quarterly|interim|semi-annual|consolidated)\s+)*` +
  String.raw`(?:statements?\s+of\s+(?:income|operations|earnings|profit\s+or\s+loss)|income\s+statements?)\s*(?:${PAREN_GROUP}\s*)*$`,
  'i',
);
function jpStatementCaption(caption: string): boolean {
  const c = caption.replace(/^\s*(?:-\s*\d{1,3}\s*-|\(\d{1,2}\)|\d{1,2}\.)\s*/, '').trim();
  return !NOT_STATEMENT.test(c) && JP_TITLE.test(c);
}

/** Units a caption states: wholly a unit statement, or an income-statement title with a parenthesised one. */
function jpCaptionUnits(caption: string): Set<number> {
  const out = new Set<number>();
  const whole = jpUnit(caption);
  if (whole !== null) out.add(whole);
  else if (jpStatementCaption(caption)) {
    for (const m of caption.matchAll(new RegExp(PAREN_GROUP, 'g'))) {
      const u = jpUnit(m[0]);
      if (u !== null) out.add(u);
    }
  }
  return out;
}

const JP_REVENUE = /^(?:total\s+)?(?:net\s+)?(?:sales|revenues?|sales\s+revenues?|operating\s+revenues?|sales\s+and\s+financial\s+services\s+revenues?)$/;
const JP_EPS_WORDS = /per (?:common |ordinary )?share|earnings per|\beps\b/;
const JP_EPS_EXCLUDE = /\bads\b|american depositary|adjusted|forecast|non[\s-]?gaap|dividend|book value|net assets|equity per share|weighted|outstanding|number of shares|continuing|discontinued|\bcore\b|underlying|cash flow/;

function jpLabel(raw: string): string {
  return normLabel(raw)
    .replace(/\(\s*(?:in\s+)?(?:yen|¥|jpy)\s*\)/g, ' ')
    .replace(/^[-–—•・·\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:,.]+$/, '')
    .trim();
}

/**
 * Revenue: "(Total) (net) sales / revenue(s)", "sales revenues", "operating revenues", "net revenue", "sales and
 * financial services revenues" — never ordinary income, operating income, gross profit, interest income or fees.
 * EPS: "diluted" → diluted; "basic", "net income per share", "profit attributable to owners of parent per share"
 * → basic. Per ADS, adjusted and forecast rows are never read. `perShare`: the row sits in a per-share block.
 */
function jpField(label: string, perShare: boolean): JpField | null {
  if (JP_REVENUE.test(label)) return 'revenue';
  if (JP_EPS_EXCLUDE.test(label)) return null;
  const epsWords = JP_EPS_WORDS.test(label);
  if (!epsWords && !perShare) return null;
  const dil = /dilut/.test(label);
  const basic = /\bbasic\b/.test(label);
  if (dil && basic) return 'both';
  if (dil) return 'diluted';
  if (basic) return 'basic';
  if (epsWords && /\b(net income|earnings|profits?|income)\b/.test(label)) return 'basic';
  return null;
}

// Month ranges: "Jul.-Sep. 2026", "July–September 2026", "April 1, 2026 through June 30, 2026", "(2026/4-6)", "('25/4-'26/3)".
const JP_NAMED_RANGE = new RegExp(
  String.raw`\b${MONTH_RE}\.?\s*(?:(\d{1,2})(?!\d))?\s*,?\s*(\d{4})?\s*(?:-|–|—|~|through|to)\s*${MONTH_RE}\.?\s*(?:(\d{1,2})(?!\d))?\s*,?\s*(\d{4})\b`,
  'gi',
);
const JP_NUMERIC_RANGE = /'?(\d{4}|\d{2})\/(\d{1,2})\s*[-–~]\s*(?:'?(\d{4}|\d{2})\/)?(\d{1,2})\b/g;

interface JpRange { span: JpSpan | null; end: [number, number, number] }

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS_SPAN: Record<number, JpSpan> = { 3: 'quarter', 6: 'half', 9: 'nine', 12: 'year' };

function jpRanges(text: string): { ranges: JpRange[]; rest: string } {
  const ranges: JpRange[] = [];
  const range = (sy: number | null, sm: number, ey: number, em: number, ed: number | null) => {
    const y0 = sy ?? (em >= sm ? ey : ey - 1);
    const n = ey * 12 + em - (y0 * 12 + sm) + 1;
    ranges.push({ span: MONTHS_SPAN[n] ?? null, end: [ey, em, ed ?? lastDay(ey, em)] });
  };
  let rest = text.replace(JP_NAMED_RANGE, (_m, m1: string, _d1: string | undefined, y1: string | undefined, m2: string, d2: string | undefined, y2: string) => {
    range(y1 ? Number(y1) : null, month(m1), Number(y2), month(m2), d2 ? Number(d2) : null);
    return ' ';
  });
  rest = rest.replace(JP_NUMERIC_RANGE, (all: string, y1: string, m1: string, y2: string | undefined, m2: string) => {
    const sm = Number(m1);
    const em = Number(m2);
    if (sm < 1 || sm > 12 || em < 1 || em > 12) return all;
    const sy = fullYear(y1);
    range(sy, sm, y2 ? fullYear(y2) : em >= sm ? sy : sy + 1, em, null);
    return ' ';
  });
  return { ranges, rest };
}

const JP_HALF = /\b(six|6)[\s-]*months?\b|\bfirst half\b|\bhalf[\s-]*year\b|\b(1h|h1)\b|\binterim\b/i;
const JP_NINE = /\b(nine|9)[\s-]*months?\b/i;
const JP_QUARTER = /\b(three|3)[\s-]*months?\b|\b(first|1st) quarter\b|\bq[1-4]\b|\b[1-4]q\b/i;
/** "Second quarter ended …" may mean the quarter or the six months to date: never read. */
const JP_AMBIGUOUS_QUARTER = /\b(second|third|fourth|2nd|3rd|4th) quarter\b(?!\s*-?\s*end)/i;
const JP_YEAR = /\b(twelve|12)[\s-]*months?\b|\bfiscal years?\b|\byears? ended\b|\bfull[\s-]*year\b|\bannual\b/i;
const JP_FY = /\bfy\s?'?(\d{4}|\d{2})\b/gi;
const JP_QUARTER_TOKEN = /\bq[1-4]\b|\b[1-4]q\b/i;
const JP_FORECAST = /forecast|outlook|guidance|projection|estimate|\bplan(ned)?\b|target|prospect/i;

function jpKinds(text: string): Set<JpSpan | 'ambiguous'> {
  const { ranges, rest } = jpRanges(text);
  const out = new Set<JpSpan | 'ambiguous'>();
  for (const r of ranges) out.add(r.span ?? 'ambiguous');
  if (JP_HALF.test(rest)) out.add('half');
  if (JP_NINE.test(rest)) out.add('nine');
  if (JP_QUARTER.test(rest)) out.add('quarter');
  if (JP_AMBIGUOUS_QUARTER.test(rest)) out.add('ambiguous');
  if (JP_YEAR.test(rest)) out.add('year');
  if (!out.size && rest.match(JP_FY)) out.add('year');
  return out;
}

function jpDates(text: string): Array<[number, number, number]> {
  const { ranges, rest } = jpRanges(text);
  return [...ranges.map((r) => r.end), ...headDates(rest, true)];
}

/**
 * Does a column (its own header `own`; the label column and the whole header block as fallbacks for the span)
 * name `span` ending `pe`? A dated column must be within 15 days of `pe`. An undated "2Q" / "Q2" (quarter) or
 * "FY2027" (year, named by the calendar year it ends in) column counts only inside a block dated `pe`.
 */
function jpColumn(own: string, labelCol: string, block: string, pe: Date, span: JpSpan): boolean {
  if (!own && !labelCol) return false;
  if (NOT_PERIOD.test(own) || ADJUSTMENT_COL.test(own) || JP_FORECAST.test(`${labelCol} ${own}`)) return false;
  let kinds = jpKinds(own);
  if (!kinds.size) kinds = jpKinds(labelCol);
  if (!kinds.size) kinds = jpKinds(block);
  if (kinds.size !== 1 || !kinds.has(span)) return false;
  const near = ([y, m, d]: [number, number, number]) => m > 0 && daysApart(y, m, d, pe) <= 15;
  let dates = jpDates(own);
  if (!dates.length) dates = jpDates(labelCol);
  if (dates.length) return dates.every(near);
  const token = span === 'quarter'
    ? JP_QUARTER_TOKEN.test(own)
    : span === 'year' && [...own.matchAll(JP_FY)].some((m) => fullYear(m[1]!) === pe.getUTCFullYear());
  return token && jpDates(block).some(near);
}

interface JpRow {
  /** 'row': the label names the field, the columns the period; 'cross': the label names the period, the columns the field. */
  kind: 'row' | 'cross';
  field: JpField | null;
  nums: Num[];
  headers: Cell[][];
  label: string;
  rawLabel: string;
  /** 'cross' rows: the period text (section title above + row label). */
  period: string;
}

interface JpCandidate { value: number; unit: number | null; net?: boolean }

function readJp(html: string, opts: ReaderOptions): ReaderResult {
  const notes: string[] = [];
  const pe = new Date(`${opts.periodEnd}T00:00:00Z`);
  if (Number.isNaN(pe.getTime())) {
    return { epsShare: null, epsShareStated: false, epsAds: null, epsAdjusted: null, epsGaap: null, epsBasic: null, revenue: null, unit: null, notes: ['bad periodEnd'] };
  }
  const span = opts.span;
  const found: Record<'revenue' | 'basic' | 'diluted', JpCandidate[]> = { revenue: [], basic: [], diluted: [] };
  const isEpsField = (f: JpField | null) => f === 'basic' || f === 'diluted' || f === 'both';

  for (const table of parseTables(html, { rowspan: true })) {
    const caption = tableCaption(table, true);
    if (JP_FORECAST.test(caption)) continue;
    const nonData: string[] = [];
    let headers: Cell[][] = [];
    let titles: Cell[][] = [];
    let lastWasData = false;
    let section = '';
    let sectionRaw = '';
    let perShare = false;
    let hasEps = false;
    const rowsOut: JpRow[] = [];

    for (const cells of table.rows) {
      const li = cells.findIndex((c) => c.text);
      const first = cells[li]!;
      const hasLabel = /[a-z]/i.test(first.text) && !/^\(?\s*\d/.test(first.text);
      const nums = rowNumbers(cells, hasLabel ? li + 1 : li);
      const yearRow = nums.length > 0 && nums.every((n) => isYear(n) && !n.dollar && !n.pct);
      const otherText = cells.slice(li + 1).some((c) => c.text);

      if (hasLabel && nums.length && !yearRow) {
        lastWasData = true;
        titles = [];
        let label = jpLabel(first.text);
        // "Basic" / "Diluted" under "Earnings per share attributable to …" takes the parent's label.
        if (/^(basic|diluted|basic and diluted|diluted and basic)$/.test(label) && section) label = `${section} ${label}`;
        const field = jpField(label, perShare);
        if (isEpsField(field)) hasEps = true;
        const vals = nums.filter((n) => !n.pct);
        if (vals.length) {
          if (field) rowsOut.push({ kind: 'row', field, nums: vals, headers, label, rawLabel: first.text, period: '' });
          else rowsOut.push({ kind: 'cross', field: null, nums: vals, headers, label, rawLabel: first.text, period: `${sectionRaw} ${first.text}`.trim() });
        }
        if (/:\s*$/.test(first.text)) { section = jpLabel(first.text); sectionRaw = first.text; }
        continue;
      }
      nonData.push(cells.map((c) => c.text).join(' '));
      if (cells.some((c) => c.text && isEpsField(jpField(jpLabel(c.text), false)))) hasEps = true;
      if (!otherText) {
        // Label-only row: a section ("Earnings per share attributable to …", "For the three months ended") or a title.
        section = jpLabel(first.text);
        sectionRaw = first.text;
        if (JP_EPS_WORDS.test(section) && !JP_EPS_EXCLUDE.test(section)) perShare = true;
        if (lastWasData) titles = [...titles, cells];
        else headers = [...headers, cells];
        continue;
      }
      // A "Yen | Yen | U.S. dollars" row between data rows restates the columns' units: it does not start a new block.
      if (lastWasData && cells.every((c) => jpUnitCell(c.text))) {
        headers = [...headers.filter((r) => !r.every((c) => jpUnitCell(c.text))), cells];
        continue;
      }
      if (lastWasData) headers = titles;
      headers = [...headers, cells];
      lastWasData = false;
      section = '';
      sectionRaw = '';
    }
    if (!rowsOut.length) continue;

    const tableText = `${nonData.join(' ')} ${caption}`;
    const inTable = new Set<number>();
    for (const r of table.rows) for (const c of r) { const u = jpUnit(c.text); if (u !== null) inTable.add(u); }
    const near = jpCaptionUnits(caption);
    const tableUnit = inTable.size === 1 ? [...inTable][0]! : inTable.size === 0 && near.size === 1 ? [...near][0]! : null;
    // Revenue only from an income statement: a table with a per-share line, or one captioned as the statement
    // (Sony prints its per-share lines in the next table). Segment / KPI tables are neither.
    const statement = hasEps || jpStatementCaption(caption);

    for (const row of rowsOut) {
      const blockText = row.headers.flat().map((c) => c.text).join(' ');
      const labelCol = row.headers.map((r) => r.filter((c) => c.text && c.start === 0 && c.span === 1).map((c) => c.text).join(' ')).join(' ').trim();
      for (const n of row.nums) {
        const overCells = row.headers.flatMap((r) => r.filter((c) => c.text && c.start < n.end && c.start + c.span > n.start && !(c.start === 0 && c.span === 1)));
        const over = overCells.map((c) => c.text).join(' ').trim();
        let field = row.field;
        if (row.kind === 'row') {
          if (!jpColumn(over, labelCol, blockText, pe, span)) continue;
        } else {
          // Summary layout: the column header names the field ("Basic earnings per share | yen"), the row the period
          // ("For the three months ended" | "June 30, 2026").
          if (overCells.some((c) => /%/.test(c.text) && jpUnitCell(c.text))) continue;
          const fieldText = overCells.filter((c) => !jpUnitCell(c.text) && !/%/.test(c.text)).map((c) => c.text).join(' ');
          field = fieldText ? jpField(jpLabel(fieldText), false) : null;
          if (!field || NOT_PERIOD.test(fieldText) || JP_FORECAST.test(fieldText)) continue;
          if (!jpColumn(row.period, labelCol, `${labelCol} ${row.period}`, pe, span)) continue;
        }
        if (!field) continue;
        // Currency: the column's own header, else the row label, else the table's text and caption. US$ is skipped.
        const curOwn = jpCurrency(over);
        const curLabel = jpCurrency(row.rawLabel);
        if (curOwn === 'USD' || curOwn === null || curLabel === 'USD' || curLabel === null) continue;
        if ((curOwn ?? curLabel ?? jpCurrency(tableText)) !== 'JPY') continue;

        if (field === 'revenue') {
          if (n.value <= 0 || n.decimals > 2 || !statement) continue;
          const colUnits = new Set(overCells.map((c) => jpUnit(c.text)).filter((u): u is number => u !== null));
          const unit = colUnits.size === 1 ? [...colUnits][0]! : colUnits.size === 0 ? tableUnit : null;
          if (unit === null) { notes.push('revenue: no unit stated for table'); continue; }
          found.revenue.push({ value: n.value * unit, unit, net: row.kind === 'row' && /\bnet revenues?\b/.test(row.label) });
        } else {
          // EPS is in yen and never scaled.
          if (n.decimals < 2 || n.decimals > 3 || Math.abs(n.value) >= 100_000) continue;
          if (field === 'basic' || field === 'both') found.basic.push({ value: n.value, unit: null });
          if (field === 'diluted' || field === 'both') found.diluted.push({ value: n.value, unit: null });
        }
      }
    }
  }

  const settle = (field: 'revenue' | 'basic' | 'diluted'): JpCandidate | null => {
    let c = found[field];
    // Brokers (Nomura) print both "Total revenues" and "Net revenue": net revenue is the one read.
    if (field === 'revenue' && c.some((x) => x.net)) c = c.filter((x) => x.net);
    if (!c.length) return null;
    const same = (a: number, b: number) => (field === 'revenue' ? Math.abs(a - b) <= 0.001 * Math.abs(b) : Math.abs(a - b) < 1e-6);
    const distinct = c.filter((x, i) => c.findIndex((y) => same(x.value, y.value)) === i);
    if (distinct.length > 1) {
      notes.push(`${field}: candidates disagree (${distinct.map((d) => d.value).join(', ')})`);
      return null;
    }
    return c.reduce((a, b) => ((b.unit ?? Infinity) < (a.unit ?? Infinity) ? b : a));
  };
  const rev = settle('revenue');
  const basic = settle('basic');
  const diluted = settle('diluted');
  return {
    epsShare: diluted?.value ?? null,
    epsShareStated: found.diluted.length > 0,
    epsAds: null,
    epsAdjusted: null,
    epsGaap: diluted?.value ?? null,
    epsBasic: basic?.value ?? null,
    revenue: rev ? Math.round(rev.value) : null,
    unit: rev?.unit ?? null,
    notes,
  };
}
