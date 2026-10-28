/**
 * Reads EPS and revenue from an earnings press release (HTML): US 8-K EX-99.1
 * (profile 'us', `readUsRelease`), a foreign issuer's 6-K (profile 'hk':
 * RMB / US$ / HK$ columns, per-ADS rows, half-year and full-year columns) or a
 * Japanese issuer's 6-K (profile 'jp': yen only, basic and diluted EPS, quarter
 * or year-to-date columns; see `readJp`) or a UK / European issuer's 6-K or 8-K
 * (profiles 'uk' / 'eu': allowlisted currency units, pence vs pounds, basic and
 * diluted EPS, quarter or year-to-date columns; see `readEu`).
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

/**
 * 'JPY' is only ever produced by profile 'jp'; 'EUR' / 'GBP' / 'GBp' (pence) / 'CHF' / 'DKK' / 'SEK' / 'NOK' only by
 * profiles 'uk' / 'eu'. The 'us' / 'hk' currency detection never names them.
 */
export type Currency = 'CNY' | 'USD' | 'HKD' | 'JPY' | 'EUR' | 'GBP' | 'GBp' | 'CHF' | 'DKK' | 'SEK' | 'NOK';

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
  /** 'nine' (nine months year-to-date) is used by profiles 'jp', 'uk' and 'eu'. */
  span: 'quarter' | 'half' | 'nine' | 'year';
  profile: 'us' | 'hk' | 'jp' | 'uk' | 'eu';
  /** Profile 'hk': only columns in this currency are read. */
  currency?: Currency;
  /** Profile 'hk': one ADS is one share (ADR ratio 1), so a combined "per share/ADS" row is per share. */
  shareIsAds?: boolean;
  /** Profiles 'jp' / 'uk' / 'eu': the release's fiscal quarter; a "2Q" / "Q2" column is read only when it names this quarter. */
  fiscalQuarter?: 1 | 2 | 3 | 4;
  /** Profiles 'jp' / 'uk' / 'eu': the fiscal-year label (calendar year the fiscal year ends in); an "FY2027" column must match it. */
  fiscalYear?: number;
  /**
   * Profile 'jp': the issuer as the universe knows it (English name variants, ADR ticker). Besides generic words these
   * are the only names a group heading may carry; without it, a heading naming any company is not the group.
   * Profiles 'uk' / 'eu': the ticker names a bank, whose "Total income" line is its revenue.
   */
  issuer?: JpIssuer;
}

/** A Japanese issuer's identity from the universe: English name variants and the ADR ticker. */
export interface JpIssuer { names: readonly string[]; ticker: string }

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
  /** Basic EPS per share (profiles 'jp' / 'uk' / 'eu' only; null for 'us' / 'hk'). */
  epsBasic: number | null;
  revenue: number | null;
  unit: number | null; /* multiplier applied to revenue */
  /** Profiles 'uk' / 'eu': the currency of `revenue` as the release states it (null for the other profiles). */
  revenueCurrency: Currency | null;
  /** Profiles 'uk' / 'eu': the currency of `epsBasic` / `epsGaap` ('GBp' for pence; null for the other profiles). */
  epsCurrency: Currency | null;
  /**
   * Profiles 'uk' / 'eu', span 'quarter': some table states a figure in the release's own three-month column (any
   * labelled, non-percent row, read or not). Unset for the other profiles and spans.
   */
  quarterStated?: boolean;
  notes: string[];
}

interface Candidate { value: number; unit: number | null }

export function readUsRelease(html: string, quarterEnd: string): ReleaseValues {
  const r = readRelease(html, { periodEnd: quarterEnd, span: 'quarter', profile: 'us' });
  return { epsAdjusted: r.epsAdjusted, epsGaap: r.epsGaap, revenue: r.revenue, unit: r.unit, notes: r.notes };
}

export function readRelease(html: string, opts: ReaderOptions): ReaderResult {
  if (opts.profile === 'jp') return readJp(html, opts);
  if (opts.profile === 'uk' || opts.profile === 'eu') return readEu(html, opts);
  const notes: string[] = [];
  const hk = opts.profile === 'hk';
  const qe = new Date(`${opts.periodEnd}T00:00:00Z`);
  const found: Record<Field, Candidate[]> = { epsAdjusted: [], epsGaap: [], epsAds: [], revenue: [] };
  if (Number.isNaN(qe.getTime())) {
    return { epsShare: null, epsShareStated: false, epsAds: null, epsAdjusted: null, epsGaap: null, epsBasic: null, revenue: null, unit: null, revenueCurrency: null, epsCurrency: null, notes: [hk ? 'bad periodEnd' : 'bad quarterEnd'] };
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
    revenueCurrency: null,
    epsCurrency: null,
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
 * Tanshin "Million yen"), "Yen (millions)", "JPY (millions)", "JPY millions", "Million JPY", "Billion JPY", each
 * with an optional ", except per share amounts / EPS". Nothing else counts as a unit.
 */
const JP_UNIT_STATEMENT = /^(?:(?:amounts\s+)?in\s+(millions|billions)\s+of\s+(?:yen|jpy)|(millions?|billions?)\s+(?:of\s+)?(?:yen|jpy)|(?:yen|jpy)\s+in\s+(millions|billions)|¥\s*(?:in\s+)?(millions?|billions?)|(?:yen|jpy|¥)\s*\(\s*(millions?|billions?)\s*\)|jpy\s+(millions?|billions?))$/i;

function jpUnit(text: string): number | null {
  let core = text.trim();
  // Outer parentheses only when they wrap the whole text ("(Millions of yen)", not "Yen (millions)").
  if (/^\(/.test(core)) core = core.replace(/^\(\s*/, '').replace(/\s*\)$/, '');
  // "JPY (millions, except per share data)": an "except" clause inside the unit's own parentheses.
  core = core.replace(/\s*,?\s*except\b[^()]*\)$/i, ')').replace(EXCEPT_CLAUSE, '').trim();
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
const JP_EPS_EXCLUDE = /\bads\b|american depositary|adjusted|forecast|non[\s-]?gaap|dividend|book value|net assets|equity per share|weighted|outstanding|number of shares|continuing|discontinued|\bcore\b|underlying|cash flow|non[\s-]?recurring|one[\s-]?time|excluding/;

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
const JP_QUARTER_TOKENS = /\bq([1-4])\b|\b([1-4])q\b/gi;
const JP_HALF_TOKEN = /\b(1h|h1|2h|h2)\b/i;
/** Span words that name a period by themselves (not tokens). */
const JP_EXPLICIT_SPAN = /\b(three|six|nine|twelve|3|6|9|12)[\s-]*months?\b|\b(first|1st) quarter\b|\bfiscal years? ended\b|\byears? ended\b|\bfirst half\b|\bhalf[\s-]*year\b/i;
/** The release's fiscal quarter (1–4) and fiscal-year label (the calendar year the fiscal year ends in). */
interface JpFiscal { quarter?: number; year?: number }
/**
 * Text naming the parent company alone, not the group ("Summary of Non-consolidated Financial Results", "… (Parent
 * Company)", 単体, 非連結, 個別).
 */
const JP_NON_CONSOLIDATED = /non[\s-]?consolidated|unconsolidated|parent[\s-]only|(?<!owners of (?:the )?)parent company\b|単体|非連結|個別/i;
/**
 * Anchored allowlist of group-results headings, after `JP_HEADING_PREFIX` is stripped: "Consolidated Financial
 * Results / Statements / Highlights", "Consolidated Results", "Consolidated Operating Results", "Consolidated
 * Statement(s) of …", "Consolidated Balance Sheet(s)", "Consolidated Earnings", "Consolidated Summary Report", or a
 * bare "<CO> Consolidated" heading (one all-caps token of 2–6 letters: MUFG). "Statement(s) of" names Income /
 * Operations / Comprehensive Income / Financial Position / Profit or Loss only. The English heading is end-anchored:
 * only a closing bracket, a colon, a parenthetical unit / date phrase or a full stop may follow. A statement title may
 * be qualified ("Unaudited / Condensed / Quarterly / Interim Consolidated Statement of Income", "… Balance Sheet",
 * "… Financial Statements"). 連結業績 / 連結財務諸表 / 連結経営成績 / 連結損益計算書 / 連結貸借対照表 / 連結決算.
 */
const JP_CONSOLIDATED_HEADING = new RegExp(
  String.raw`^(?:[A-Z]{2,6}\s)?Consolidated` +
  String.raw`(?:\s(?:Financial (?:Results|Statements|Highlights)|Results|Operating Results|Balance Sheets?|Earnings|Summary Report` +
  String.raw`|Statements? of (?:Income|Operations|Comprehensive Income|Financial Position|Profit or Loss)))?` +
  String.raw`(?:\s*(?:[\]】）)］:：]|[(（][^()（）]{0,80}[)）]))*\s*[.．]?\s*$` +
  // A statement title may carry Unaudited / Audited / Condensed / Quarterly / Interim before "Consolidated"
  // ("Unaudited Consolidated Statement of Income"); then the statement name itself is required.
  String.raw`|^(?:(?:Unaudited|Audited|Condensed|Quarterly|Interim)\s+)+Consolidated\s` +
  String.raw`(?:Financial Statements|Balance Sheets?|Statements? of (?:Income|Operations|Comprehensive Income|Financial Position|Profit or Loss))` +
  String.raw`(?:\s*(?:[\]】）)］:：]|[(（][^()（）]{0,80}[)）]))*\s*[.．]?\s*$` +
  String.raw`|^連結(?:業績|財務諸表|経営成績|損益計算書|貸借対照表|決算)`,
);
/** Leading numbering / brackets of a heading: "1.", "(2)", "[", "【", "Ⅱ", "Attachment 1:". */
const JP_HEADING_PREFIX = /^(?:\s*(?:\d{1,2}\s*[.)．]|[(（]\s*\d{1,2}\s*[)）]|[\[【［(（]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\s*[.．]?|Attachment\s*\d*\s*[:.]?)\s*)+/;
/**
 * Words that make a "Consolidated …" block a remark, not a heading; also "parent" and a parenthetical naming an entity
 * ("(Parent Company)", "(Toyota Motor Corporation)", "(… Co., Ltd.)").
 */
const JP_NOT_HEADING = /subsidiar|basis|compar|note|子会社|\bvs\b|\bversus\b|\bto\b|\bof consolidated\b|\bnot\b|ratio|share|compared|comparison|\bparent\b|\([^()]*\b(?:corporation|company|co\.,?\s*ltd|inc|limited|k\.\s?k)\b[^()]*\)/i;
/** Blocks of the text between two tables: paragraphs, divs, headings, line breaks, rows, list items. */
const JP_BLOCK_END = /<\/p\s*>|<\/div\s*>|<\/h[1-6]\s*>|<br\s*\/?>|<\/tr\s*>|<\/li\s*>/i;

/**
 * Document sections, in order: for each table, whether it sits in a non-consolidated (parent-only) section. The text
 * between tables is split into blocks and read in order:
 * - ON (fail-safe): any block mentioning non-consolidated / parent-only / 単体 / 非連結 / 個別.
 * - OFF: only a block that, after leading numbering / brackets, STARTS with a group-results heading
 *   (`JP_CONSOLIDATED_HEADING`), is at most 120 characters and names no subsidiaries / basis / comparison / note /
 *   子会社. Everything else ("Consolidated subsidiaries", 連結子会社数, prose) never ends a non-consolidated section.
 *   A bare "<TOKEN> Consolidated" heading ends it only when the token is the caller's issuer ticker ("MUFG
 *   Consolidated" for MUFG): a subsidiary's own "BK Consolidated" / "SMBC Consolidated" never does.
 * Tables are found with the same pattern as `parseTables`, so the flags line up with its tables.
 */
function jpNonConsolidatedSections(html: string, issuer: JpIssuer | undefined): boolean[] {
  const between = html.split(/<table\b[\s\S]*?<\/table>/gi);
  const out: boolean[] = [];
  let state = false;
  for (const seg of between.slice(0, -1)) {
    for (const block of seg.split(JP_BLOCK_END)) {
      const text = decode(block);
      if (!text) continue;
      if (JP_NON_CONSOLIDATED.test(text)) state = true;
      else if (text.length <= 120 && !JP_NOT_HEADING.test(text)) {
        const heading = text.replace(JP_HEADING_PREFIX, '');
        const prefix = /^([A-Z]{2,6})\s+Consolidated\b/.exec(heading)?.[1];
        if (JP_CONSOLIDATED_HEADING.test(heading) && (prefix == null || prefix === issuer?.ticker)) state = false;
      }
    }
    out.push(state);
  }
  return out;
}
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
 * name `span` ending `pe`? A dated column must be within 15 days of `pe`.
 *
 * The column must be dated (its own header, else the label column); an undated column is never read.
 *
 * Quarter / half / fiscal-year tokens ("2Q", "Q2", "1H", "FY2027", "FY27") only ever narrow: issuers name fiscal years
 * differently (Toyota by the year it ends in, Sony by the year it starts in), so a token never selects a column.
 * - A token that disagrees with `fiscal.quarter` / `fiscal.year` (the year it ends in) rules the column out; unknown
 *   fiscal values rule out every token column.
 * - A token column is read only when its `exclusive` header cells (the cells over this column alone, not shared
 *   with another figure column) state an explicit date, or an explicit span word ("three months", "year ended")
 *   inside a dated block. A date shared by several columns ("Year ended March 31, 2026" over "FY2025 | FY2026") is
 *   not the column's own.
 */
function jpColumn(own: string, labelCol: string, block: string, pe: Date, span: JpSpan, fiscal: JpFiscal, exclusive: string): boolean {
  if (!own && !labelCol) return false;
  if (NOT_PERIOD.test(own) || ADJUSTMENT_COL.test(own) || JP_ADJUSTED_CONTEXT.test(own) || JP_FORECAST.test(`${labelCol} ${own}`)) return false;
  let kinds = jpKinds(own);
  if (!kinds.size) kinds = jpKinds(labelCol);
  if (!kinds.size) kinds = jpKinds(block);
  if (kinds.size !== 1 || !kinds.has(span)) return false;
  const qTokens = [...own.matchAll(JP_QUARTER_TOKENS)].map((m) => Number(m[1] ?? m[2]));
  const fyTokens = [...own.matchAll(JP_FY)].map((m) => fullYear(m[1]!));
  if (qTokens.length && (fiscal.quarter === undefined || qTokens.some((q) => q !== fiscal.quarter))) return false;
  if (fyTokens.length && (fiscal.year === undefined || fyTokens.some((y) => y !== fiscal.year))) return false;
  const near = ([y, m, d]: [number, number, number]) => m > 0 && daysApart(y, m, d, pe) <= 15;
  let dates = jpDates(own);
  if (!dates.length) dates = jpDates(labelCol);
  if (!dates.length || !dates.every(near)) return false;
  if (!qTokens.length && !fyTokens.length && !JP_HALF_TOKEN.test(own)) return true;
  const exDates = jpDates(exclusive);
  if (exDates.length) return exDates.every(near);
  return JP_EXPLICIT_SPAN.test(exclusive);
}

/**
 * A period label that the document itself defines: "Third Quarter of Fiscal 2025 (for the nine months ended
 * December 31, 2025)", "Financial Highlights for Fiscal 2025 (for the fiscal year ended March 31, 2026)". The
 * parenthesis must state the span and an "ended" date (a forecast's "ending" defines nothing).
 */
const JP_PERIOD_DEFINITION = new RegExp(
  String.raw`(?:\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\s+of\s+)?\b(?:fiscal\s+(?:year\s+)?|fy\s?)(\d{4})\s*` +
  String.raw`\(\s*(?:for\s+)?the\s+((?:three|six|nine|twelve)\s+months|fiscal\s+year)\s+ended\s+(${MONTH_RE}\.?\s+\d{1,2}\s*,?\s*\d{4})\s*\)`,
  'gi',
);
const JP_ORDINAL: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
/** A row label that is only a fiscal-period token: "1Q F2026", "3Q FY2025", "Q3 FY2025", "Fiscal 2025", "FY2025". */
const JP_TOKEN_LABEL = /^(?:([1-4])q\s*|q([1-4])\s+)?(?:f|fy|fiscal)\s?'?(\d{4})$/i;

/**
 * The document's own definitions of fiscal-period labels, keyed "quarter:fiscal-year label" (quarter 0 = the whole
 * fiscal year), as the defining phrase ("nine months ended December 31, 2025"); null when two definitions disagree.
 */
function jpPeriodDefinitions(text: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const m of text.matchAll(JP_PERIOD_DEFINITION)) {
    const key = `${m[1] ? JP_ORDINAL[m[1].toLowerCase()] : 0}:${m[2]}`;
    const phrase = `${m[3]!.replace(/\s+/g, ' ')} ended ${m[4]!.replace(/\s+/g, ' ')}`.toLowerCase();
    out.set(key, out.has(key) && out.get(key) !== phrase ? null : phrase);
  }
  return out;
}

/**
 * A token row label resolved through definitions: the defining phrase, null if undefined / ambiguous, undefined if
 * not a token label. The definition must stand in the table's own heading block (`local`) and agree with every
 * definition of that label in the document (`doc`).
 */
function jpTokenPeriod(label: string, local: Map<string, string | null>, doc: Map<string, string | null>): string | null | undefined {
  const m = label.trim().match(JP_TOKEN_LABEL);
  if (!m) return undefined;
  const key = `${m[1] ?? m[2] ?? 0}:${m[3]}`;
  const phrase = local.get(key);
  return phrase && doc.get(key) === phrase ? phrase : null;
}

/** Span words of a text, with "quarterly" / "trend" and yearless month ranges ("Oct-Dec") counted too. */
function jpSpanWords(text: string): Set<JpSpan | 'ambiguous'> {
  const out = jpKinds(text);
  if (/\bquarterly\b|\btrends?\b/i.test(text)) out.add('quarter');
  for (const m of text.matchAll(new RegExp(String.raw`\b${MONTH_RE}\.?\s*[-–—~]\s*${MONTH_RE}\b`, 'gi'))) {
    out.add(MONTHS_SPAN[((month(m[2]!) - month(m[1]!) + 12) % 12) + 1] ?? 'ambiguous');
  }
  return out;
}

/** The span a definition phrase names ("nine months ended …" → 'nine'). */
const jpPhraseSpan = (phrase: string): JpSpan =>
  /^three/.test(phrase) ? 'quarter' : /^six/.test(phrase) ? 'half' : /^nine/.test(phrase) ? 'nine' : 'year';

/** A table title naming the group's figures: "Consolidated" (not non- / un-consolidated) or 連結. */
const JP_GROUP_TITLE = /(?<!non[\s-]?|un)\bconsolidated\b|連結/i;

/** A title naming another entity's figures: a subsidiary, the parent company, a "Co., Ltd." / "K.K." / securities arm. */
const JP_ENTITY_TITLE = /subsidiar|子会社|(?<!owners of (?:the )?)\bparent company\b|\bco\.,?\s*ltd\b|\bk\.\s?k\.|\bsecurities\b/i;

/** The first cell of a note row inside a table: "Note:", "Notes:", a bare "1." / "2)", or "(a) …". */
const JP_NOTE_ROW = /^(?:notes?\s*:?|\d{1,2}\s*[.)]|\([a-z]\)\s.*)$/i;

/**
 * Titles / heads of figures that are not the reported (IFRS / GAAP) ones: Core, non-GAAP / non-IFRS, adjusted,
 * underlying, reconciliations, "excluding …", one-time / non-recurring items.
 */
const JP_ADJUSTED_CONTEXT = /\bcore\b|non[\s-]?(?:gaap|ifrs)|\badjusted\b|\bunderlying\b|reconcil|\bexcluding\b|one[\s-]?time|non[\s-]?recurring/i;
/** A title that positively names the reported figures. */
const JP_REPORTED_TITLE = /\breported\b|\bifrs\b/i;
/** A page-number cell next to a heading ("12", "A- 5"). */
const JP_PAGE_NUMBER = /^(?:[A-Z]{1,2}\s?-\s?)?\d{1,3}$/;

/**
 * A heading-only table (a title printed as a table: "FY2024 Q4 (Jan-Mar) Core Results with CER % Change", possibly
 * over several rows and next to a page number): every row holds at most one text cell plus page numbers, no figures,
 * at most 300 characters in all. Its text, else null.
 */
function jpHeadingTableText(t: Table): string | null {
  if (!t.rows.length || t.rows.length > 6) return null;
  const texts: string[] = [];
  for (const r of t.rows) {
    const cells = r.filter((c) => c.text);
    const words = cells.filter((c) => !JP_PAGE_NUMBER.test(c.text));
    if (words.length !== 1 || cells.length > 2 || isFigure(words[0]!.text) || !/[a-z]/i.test(words[0]!.text)) return null;
    texts.push(words[0]!.text);
  }
  const text = texts.join(' ');
  return text.length <= 300 ? text : null;
}

/**
 * Each table's heading block: the text between it and the table before it, or — when nothing stands between them —
 * the heading block of that run of adjacent tables (the text before the run's first table) plus the heading-only
 * tables of the run above it. Splits with the same pattern as `parseTables`, so the indexes line up.
 * `group`: the table's own title names the issuer's group (`jpGroupTitle`). `lead`: the table stands in the document's
 * lead region, before the first later top-level section ("2.", "II.", "Attachment", "Appendix", "Supplementary",
 * "Reference") — subsidiary sections of bank releases come after it.
 */
function jpHeadingBlocks(html: string, tables: Table[], issuer: JpIssuer | undefined): { block: string[]; heading: string[]; group: boolean[]; lead: boolean[] } {
  // Title-like blocks of the text between tables: short (<= 200 characters) and not a footnote ("*1 Please refer …",
  // "※", "Note:"). Long prose and footnotes title nothing.
  const segs = html.split(/<table\b[\s\S]*?<\/table>/gi).slice(0, tables.length);
  const between = segs.map((seg) => seg.split(JP_BLOCK_END).map((b) => decode(b)).filter((t) => t && t.length <= 200 && !JP_FOOTNOTE.test(t)));
  const empty = segs.map((seg) => !decode(seg));
  const lists: string[][] = [];
  const heading: string[] = [];
  const lead: boolean[] = [];
  let inLead = true;
  for (let i = 0; i < tables.length; i++) {
    // `heading`: the heading-only table right above, with nothing between the two.
    const head = i > 0 && empty[i] ? jpHeadingTableText(tables[i - 1]!) ?? '' : '';
    heading.push(head);
    // A heading table's rows are blocks of their own (footnote rows such as "Note: Amounts … rounded down." dropped).
    const headRows = head ? tables[i - 1]!.rows.map((r) => r.filter((c) => c.text && !JP_PAGE_NUMBER.test(c.text)).map((c) => c.text).join(' ')).filter((t) => t && !JP_FOOTNOTE.test(t)) : [];
    const own = i > 0 && empty[i] ? headRows : between[i] ?? [];
    if (own.some((b) => JP_LATER_SECTION.test(b))) inLead = false;
    lead.push(inLead);
    lists.push(i > 0 && empty[i] ? [...lists[i - 1]!, ...headRows] : own);
  }
  return { block: lists.map((l) => l.join(' ')), heading, group: lists.map((l) => jpGroupTitle(l, issuer)), lead };
}

/** A later top-level section: "2." … "19.", "II." …, "Attachment", "Appendix", "Supplementary", "Reference", 【参考】. */
const JP_LATER_SECTION = /^\s*(?:(?:[2-9]|1\d|[２-９])\s*[.．)）]\s*\S|(?:II|III|IV|V|VI|VII|VIII|IX|X|Ⅱ|Ⅲ|Ⅳ|Ⅴ|Ⅵ|Ⅶ|Ⅷ|Ⅸ|Ⅹ)\s*[.．]\s*\S|[(（【［\[]?\s*(?:attachments?|appendix|appendices|supplementary|reference)\b|[【［〔（(]\s*参考)/i;

/**
 * Words a unit / notes parenthetical may consist of: "(Yen)", "(Millions of yen, except per share data and
 * percentages)", "(Note: amounts rounded down)", "(% represents the change from the same period in the previous fiscal
 * year)", "(Percentage figures represent changes over the previous fiscal year)", "(Rounded to nearest million)".
 */
const JP_NOTE_WORDS = new Set(['yen', 'jpy', 'million', 'millions', 'billion', 'billions', 'thousand', 'thousands', 'of', 'in',
  'except', 'per', 'share', 'shares', 'data', 'amount', 'amounts', 'and', 'percentage', 'percentages', 'percent', 'figures',
  'note', 'notes', 'rounded', 'down', 'up', 'to', 'the', 'nearest', 'represents', 'represent', 'change', 'changes', 'from',
  'over', 'same', 'period', 'previous', 'prior', 'corresponding', 'fiscal', 'year', 'unit', 'units', 'are', 'is', 'less',
  'than', 'one', 'a', 'an']);

/** A parenthetical made wholly of unit / notes words (anchored), never "(Units of Mizuho Bank)". */
function jpNoteParen(text: string): boolean {
  const m = text.trim().match(/^[(（]([^()（）]*)[)）]$/);
  if (!m) return false;
  const inner = m[1]!.replace(/[%¥:：,，.\d\s-]/g, ' ');
  const words = inner.match(/[a-z]+/gi) ?? [];
  return !inner.replace(/[a-z]+/gi, '').trim() && (words.length === 0 ? /[%¥]/.test(m[1]!) : words.every((w) => JP_NOTE_WORDS.has(w.toLowerCase())));
}
const jpUnitOrNote = (t: string) => jpUnit(t) !== null || jpNoteParen(t);
/** Sub-heading numbering: "(1)", "（２）", "(a)", "(ii)". */
const JP_SUB_NUMBER = /^\s*[(（]\s*(?:\d{1,2}|[０-９]{1,2}|[a-z]|[ivx]+)\s*[)）]\s*/i;
/** Heading numbering of any level: a sub-heading's, or "1." / "2)". */
const JP_ANY_NUMBER = /^\s*(?:[(（]\s*(?:\d{1,2}|[０-９]{1,2}|[a-z]|[ivx]+)\s*[)）]|[\d０-９]{1,2}\s*[.．)）])\s*/i;
/** Words of a generic (entity-free) heading: "Operating results", "Financial position", "Earnings per share", … */
const JP_GENERIC_WORDS = new Set(['operating', 'results', 'result', 'of', 'operations', 'financial', 'position', 'condition',
  'cash', 'flows', 'flow', 'dividends', 'dividend', 'earnings', 'per', 'share', 'data', 'summary', 'highlights', 'overview',
  'key', 'figures', 'consolidated', 'and']);
/** Period words a generic heading may carry: "(for the three months ended June 30, 2026)", "(Accumulated Period)". */
const JP_PERIOD_WORDS = new Set(['for', 'the', 'fy', 'three', 'six', 'nine', 'twelve', 'months', 'month', 'ended', 'fiscal', 'year',
  'quarter', 'first', 'second', 'third', 'fourth', 'accumulated', 'period', 'under', 'japanese', 'gaap', 'ifrs',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
const JP_GENERIC_JA = /経営成績|業績|財政状態|キャッシュ・フロー|キャッシュフロー|配当|１株当たり|1株当たり|概要|連結|の|及び|[・、\s]/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is a heading generic — after its numbering, unit / note parentheticals and a trailing colon or full stop, nothing
 * but the allowlisted words (English or Japanese) and the issuer's own names / ADR ticker (from the universe)? Any
 * other name ("Mizuho Bank", "SMBC", "Ltd.", みずほ銀行) makes it specific.
 */
function jpGenericHeading(text: string, issuer?: JpIssuer): boolean {
  let t = text.replace(JP_ANY_NUMBER, '').replace(/[(（][^()（）]*[)）]/g, (p) => (jpUnitOrNote(p) ? ' ' : p)).replace(/[\s.:：。]+$/, '').trim();
  for (const name of [...(issuer?.names ?? [])].sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`(?<![A-Za-z])${escapeRe(name)}(?![A-Za-z])`, 'gi'), ' ');
  }
  if (issuer?.ticker) t = t.replace(new RegExp(`(?<![A-Za-z])${escapeRe(issuer.ticker)}(?![A-Za-z])`, 'g'), ' ');
  t = t.trim();
  if (!t) return false;
  const words = t.match(/[a-z]+/gi) ?? [];
  if (!words.every((w) => JP_GENERIC_WORDS.has(w.toLowerCase()) || JP_PERIOD_WORDS.has(w.toLowerCase()))) return false;
  // Left after the words: only brackets, commas, digits and date-range dashes ("(April 1, 2025 - March 31, 2026)").
  t = t.replace(/[a-z]+/gi, '').replace(/[()（）,，\d~～]|\s[-–—]\s/g, ' ').replace(JP_GENERIC_JA, '');
  return t === '' && (words.length > 0 || text.replace(JP_ANY_NUMBER, '').trim().length > 0);
}

/**
 * Does the table's own title name the group? From the nearest title-like block upwards (unit / notes blocks skipped),
 * through numbered sub-headings ("(1) …") up to the first heading that is not one (the top-level section): every
 * heading of that chain must be generic (`jpGenericHeading`), and one of them must say "Consolidated" / 連結.
 * "2. Mizuho Bank" above "(1) Consolidated results" is another entity's section.
 */
function jpGroupTitle(blocks: string[], issuer: JpIssuer | undefined): boolean {
  let group = false;
  let any = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!.trim();
    if (jpUnitOrNote(b)) continue;
    any = true;
    if (!jpGenericHeading(b, issuer)) return false;
    if (JP_GROUP_TITLE.test(b)) group = true;
    if (JP_SUB_NUMBER.test(b)) continue;
    // An unnumbered top heading ("Consolidated Results", 連結): the block right above it (unit / notes skipped) must
    // not be a bare entity name ("Mizuho Bank", "MUFG Bank"). Numbered, the issuer's own name / ticker, or itself
    // generic → the chain is complete; anything else → not the group.
    if (!JP_ANY_NUMBER.test(b)) {
      for (let j = i - 1; j >= 0; j--) {
        const a = blocks[j]!.trim();
        if (jpUnitOrNote(a)) continue;
        const bare = (s: string) => s.replace(/[\s.:：。]+$/, '').toLowerCase();
        const own = [...(issuer?.names ?? []), ...(issuer?.ticker ? [issuer.ticker] : [])].some((n) => bare(n) === bare(a));
        if (!(JP_ANY_NUMBER.test(a) || own || jpGenericHeading(a, issuer))) return false;
        break;
      }
    }
    break;
  }
  return any && group;
}
/** A footnote block: "*1 …", "※ …", "† …", "Note: …", "(Note) …". */
const JP_FOOTNOTE = /^\s*(?:[*※†]|\(?notes?\)?\s*[:.)]?\s)/i;

/**
 * Fiscal-year naming stated by the document itself, as the offset (year the fiscal year ends in) − (its FY label):
 * "FY2026 (April 1, 2025 through March 31, 2026)" → 0, "fiscal year ended March 31, 2025 (FY2024)" → 1. Null when the
 * document states none, or disagreeing ones.
 */
function jpFiscalNaming(text: string): number | null {
  const DATE = String.raw`${MONTH_RE}\.?\s+\d{1,2}\s*,?\s*(\d{4})`;
  const offsets = new Set<number>();
  // "FY2026 (April 1, 2025 through March 31, 2026)": a twelve-month range in parentheses right after the label.
  const RANGE = new RegExp(String.raw`\bFY\s?'?(\d{4})\s*\(\s*(?:from\s+)?${DATE}\s*(?:-|–|—|~|through|to)\s*${DATE}\s*\)`, 'gi');
  for (const m of text.matchAll(RANGE)) {
    const [label, sm, sy, em, ey] = [Number(m[1]), month(m[2]!), Number(m[3]), month(m[4]!), Number(m[5])];
    if (ey * 12 + em - (sy * 12 + sm) + 1 === 12) offsets.add(ey - label);
  }
  // "fiscal year ended / ending March 31, 2025 (FY2024)".
  const NAMED = new RegExp(String.raw`\bfiscal\s+year\s+end(?:ed|ing)\s+${DATE}\s*\(\s*FY\s?'?(\d{4})\s*\)`, 'gi');
  for (const m of text.matchAll(NAMED)) offsets.add(Number(m[2]) - Number(m[3]));
  return offsets.size === 1 ? [...offsets][0]! : null;
}

/**
 * An appendix column head and nothing else: "FY2024 Q4 (Jan-Mar)", "FY2024 Q3 (Oct-Dec)", "FY2024 (Apr-Mar)" — a
 * fiscal-year label, an optional quarter token and a month range with no year.
 */
const JP_APPENDIX_HEAD = new RegExp(String.raw`^FY\s?'?(\d{4})\s+(?:Q([1-4])\s+)?\(\s*${MONTH_RE}\.?\s*[-–—~]\s*${MONTH_RE}\.?\s*\)$`, 'i');

interface JpAppendixHead { fy: number; q: number | null; sm: number; em: number }
function jpAppendixHead(own: string): JpAppendixHead | null {
  const m = own.replace(/\s+/g, ' ').trim().match(JP_APPENDIX_HEAD);
  return m ? { fy: Number(m[1]), q: m[2] ? Number(m[2]) : null, sm: month(m[3]!), em: month(m[4]!) } : null;
}

/**
 * Is an appendix column ("FY2024 Q4 (Jan-Mar)") the requested span ending `pe`? Its month range is the explicit span
 * and ends on the period end's month-end; its quarter token (if any) is the release's quarter. Its year is not
 * stated and issuers name fiscal years by the year they start or end in, so the column is read only when the same
 * document states its fiscal-year naming (`naming`, from `jpFiscalNaming`) and the label maps onto `fiscal.year`.
 * Also: the table pairs it with the prior fiscal year's column of the same quarter and months, no column of those has
 * a later label, and no other column carries the very same head (a change column).
 */
function jpAppendixColumn(own: string, siblings: string[], pe: Date, span: JpSpan, fiscal: JpFiscal, naming: number | null): boolean {
  const h = jpAppendixHead(own);
  if (!h || fiscal.year === undefined || naming === null) return false;
  if (MONTHS_SPAN[((h.em - h.sm + 12) % 12) + 1] !== span) return false;
  if (h.em !== pe.getUTCMonth() + 1 || pe.getUTCDate() !== lastDay(pe.getUTCFullYear(), h.em)) return false;
  if (h.q !== null && h.q !== fiscal.quarter) return false;
  if (h.fy + naming !== fiscal.year) return false;
  const same = siblings.map(jpAppendixHead).filter((s): s is JpAppendixHead => s !== null && s.q === h.q && s.sm === h.sm && s.em === h.em);
  return same.some((s) => s.fy === h.fy - 1) && !same.some((s) => s.fy > h.fy) && same.filter((s) => s.fy === h.fy).length === 1;
}

/** A dangling label fragment: one or two words ending in a dash ("Basic-", "Diluted –"). */
const JP_LABEL_FRAGMENT = /^[a-z]+(?:\s[a-z]+)?\s*[-–—]$/i;
/** A change-column head restated next to the units ("% Change", "Change (%)"). */
const JP_CHANGE_CELL = /^(?:%\s*change|change\s*\(\s*%\s*\))$/i;

/** A "¥" sign on a figure ("¥ 131.62", or a "¥" cell just before it): the figure is in yen. */
const JP_YEN_FIGURE = /^¥\s*(?=[(\-–−]?\d)/;

/** Cells with "&yen;" decoded and a leading "¥" taken off figures; `yen` holds the starts of figures signed "¥". */
function jpCells(cells: Cell[]): { cells: Cell[]; yen: Set<number> } {
  const yen = new Set<number>();
  const out = cells.map((c) => {
    const text = c.text.replace(/&yen;/gi, '¥');
    if (JP_YEN_FIGURE.test(text)) { yen.add(c.start); return { ...c, text: text.replace(JP_YEN_FIGURE, '') }; }
    return text === c.text ? c : { ...c, text };
  });
  out.forEach((c, i) => {
    if (c.text !== '¥') return;
    const next = out.slice(i + 1).find((x) => x.text);
    if (next && isFigure(next.text)) yen.add(next.start);
  });
  return { cells: out, yen };
}

interface JpRow {
  /** 'row': the label names the field, the columns the period; 'cross': the label names the period, the columns the field. */
  kind: 'row' | 'cross';
  /** Starts of the figures signed "¥". */
  yen: Set<number>;
  field: JpField | null;
  nums: Num[];
  headers: Cell[][];
  label: string;
  rawLabel: string;
  /** 'cross' rows: the period text (section title above + row label). */
  period: string;
  /** A token row ("3Q F2025") dated by a definition phrase. */
  token?: boolean;
}

interface JpCandidate { value: number; unit: number | null; net?: boolean }

function readJp(html: string, opts: ReaderOptions): ReaderResult {
  const notes: string[] = [];
  const pe = new Date(`${opts.periodEnd}T00:00:00Z`);
  if (Number.isNaN(pe.getTime())) {
    return { epsShare: null, epsShareStated: false, epsAds: null, epsAdjusted: null, epsGaap: null, epsBasic: null, revenue: null, unit: null, revenueCurrency: null, epsCurrency: null, notes: ['bad periodEnd'] };
  }
  const span = opts.span;
  const fiscal: JpFiscal = { quarter: opts.fiscalQuarter, year: opts.fiscalYear };
  const found: Record<'revenue' | 'basic' | 'diluted', JpCandidate[]> = { revenue: [], basic: [], diluted: [] };
  const isEpsField = (f: JpField | null) => f === 'basic' || f === 'diluted' || f === 'both';

  const nonConsolidated = jpNonConsolidatedSections(html, opts.issuer);
  const docText = decode(html);
  const docDefs = jpPeriodDefinitions(docText);
  const naming = jpFiscalNaming(docText);
  const tables = parseTables(html, { rowspan: true });
  const heads = jpHeadingBlocks(html, tables, opts.issuer);
  for (const [ti, table] of tables.entries()) {
    const caption = tableCaption(table, true);
    const title = `${heads.heading[ti]} ${caption}`;
    // The table's heading block: the text since the table before it (or its run of adjacent tables), and the caption.
    const context = `${heads.block[ti]} ${caption}`;
    // Forecast tables, Core / non-GAAP / adjusted tables and tables in the parent company's own (non-consolidated)
    // sections are never read.
    if (JP_FORECAST.test(title) || JP_ADJUSTED_CONTEXT.test(context) || nonConsolidated[ti]) continue;
    // Summary (period-in-rows) layouts and "¥" signs count only when the table's own title names the group's figures
    // (`jpGroupTitle`: the nearest heading, or a generic numbered sub-heading under it); a document-level title never
    // vouches for a table. The table's own spanning title rows above its figures must be generic, group or unit / note
    // rows too ("Mizuho Bank" over the figures is another entity's table).
    let titleRowsOk = true;
    for (const r of table.rows) {
      const cells = r.filter((c) => c.text);
      if (cells.some((c) => isFigure(c.text.replace(/&yen;|¥/g, '').trim()))) break;
      if (cells.length === 1 && cells[0]!.span > 1) {
        const t = cells[0]!.text;
        if (!(jpUnitOrNote(t) || jpGenericHeading(t, opts.issuer))) titleRowsOk = false;
      }
    }
    const groupTitled = !JP_ENTITY_TITLE.test(context) && !JP_NON_CONSOLIDATED.test(context) && heads.group[ti]! && titleRowsOk;
    // Appendix columns ("FY2024 Q4 (Jan-Mar)") count only under a title naming the reported figures.
    const reportedTitled = JP_REPORTED_TITLE.test(context);
    // Token rows ("3Q F2025") are dated only by a definition in the table's own heading block.
    const localDefs = jpPeriodDefinitions(context);
    const contextRest = context.replace(JP_PERIOD_DEFINITION, ' ');
    const nonData: string[] = [];
    let headers: Cell[][] = [];
    let titles: Cell[][] = [];
    let lastWasData = false;
    let section = '';
    let sectionRaw = '';
    let perShare = false;
    let hasEps = false;
    let pendingFragment = '';
    const rowsOut: JpRow[] = [];

    for (const rawCells of table.rows) {
      const { cells, yen } = jpCells(rawCells);
      const li = cells.findIndex((c) => c.text);
      const first = cells[li]!;
      // A row label: text that does not start with a figure, or a fiscal-period token ("3Q F2025").
      const hasLabel = (/[a-z]/i.test(first.text) && !/^\(?\s*\d/.test(first.text)) || JP_TOKEN_LABEL.test(first.text.trim());
      const nums = rowNumbers(cells, hasLabel ? li + 1 : li);
      const yearRow = nums.length > 0 && nums.every((n) => isYear(n) && !n.dollar && !n.pct);
      const otherText = cells.slice(li + 1).some((c) => c.text);

      const fragment = pendingFragment;
      pendingFragment = '';
      if (hasLabel && nums.length && !yearRow) {
        lastWasData = true;
        titles = [];
        // A dangling fragment on the row just above is the start of this row's label: "Basic-" / "Diluted-" only
        // before a per-share / earnings label that names neither basic nor diluted itself; any other fragment
        // ("Non-" + "recurring …") always, so that its words still exclude the row.
        const joins = !fragment ? false
          : /^(?:basic|diluted)\b/i.test(fragment)
            ? !/\bbasic\b|dilut/i.test(first.text) && /per (?:common |ordinary )?share|earnings/i.test(first.text)
            : true;
        let label = jpLabel(joins ? `${fragment}${first.text}`.replace(/([-–—])\s+/, '$1') : first.text);
        // "Basic" / "Diluted" under "Earnings per share attributable to …" takes the parent's label.
        if (/^(basic|diluted|basic and diluted|diluted and basic)$/.test(label) && section) label = `${section} ${label}`;
        const field = jpField(label, perShare);
        if (isEpsField(field)) hasEps = true;
        const vals = nums.filter((n) => !n.pct);
        const token = jpTokenPeriod(first.text, localDefs, docDefs);
        if (vals.length) {
          if (field) rowsOut.push({ kind: 'row', yen, field, nums: vals, headers, label, rawLabel: first.text, period: '' });
          // Summary layout: a token label ("3Q F2025") is dated only by the definition of it in the table's heading block.
          else if (token !== undefined) { if (token) rowsOut.push({ kind: 'cross', yen, field: null, nums: vals, headers, label, rawLabel: first.text, period: token, token: true }); }
          // Otherwise the row label itself must name the period ("June 30, 2026", "Six months ended …").
          else if (jpDates(first.text).length || jpKinds(first.text).size) rowsOut.push({ kind: 'cross', yen, field: null, nums: vals, headers, label, rawLabel: first.text, period: `${sectionRaw} ${first.text}`.trim() });
        }
        if (/:\s*$/.test(first.text)) { section = jpLabel(first.text); sectionRaw = first.text; }
        continue;
      }
      nonData.push(cells.map((c) => c.text).join(' '));
      // A note row ("Notes: | 1. | Comprehensive income:", "2. | Percentages shown …", "(a) for the three months …")
      // heads no column: it ends the header block above it and is not part of the next one.
      if (JP_NOTE_ROW.test(first.text)) {
        headers = [];
        titles = [];
        lastWasData = false;
        section = '';
        sectionRaw = '';
        continue;
      }
      if (cells.some((c) => c.text && isEpsField(jpField(jpLabel(c.text), false)))) hasEps = true;
      if (!otherText) {
        // A label fragment ending in a dash ("Basic-", "Diluted–"): joined to the next row only when that row has figures.
        if (JP_LABEL_FRAGMENT.test(first.text)) { pendingFragment = first.text; continue; }
        // Label-only row: a section ("Earnings per share attributable to …", "For the three months ended") or a title.
        section = jpLabel(first.text);
        sectionRaw = first.text;
        if (JP_EPS_WORDS.test(section) && !JP_EPS_EXCLUDE.test(section)) perShare = true;
        if (lastWasData) titles = [...titles, cells];
        else headers = [...headers, cells];
        continue;
      }
      // A "Yen | Yen | U.S. dollars" (or "Yen | % Change") row between data rows restates the columns' units: it
      // does not start a new block.
      const restates = (r: Cell[]) => r.every((c) => jpUnitCell(c.text) || JP_CHANGE_CELL.test(c.text));
      if (lastWasData && restates(cells)) {
        headers = [...headers.filter((r) => !restates(r)), cells];
        continue;
      }
      if (lastWasData) headers = titles;
      headers = [...headers, cells];
      lastWasData = false;
      section = '';
      sectionRaw = '';
    }
    // A table whose own heading rows name non-consolidated / parent-only figures; "(Reference)" alone does not.
    if (!rowsOut.length || JP_NON_CONSOLIDATED.test(nonData.join(' '))) continue;

    const tableText = `${nonData.join(' ')} ${caption}`;
    const inTable = new Set<number>();
    for (const r of table.rows) for (const c of r) { const u = jpUnit(c.text); if (u !== null) inTable.add(u); }
    const near = jpCaptionUnits(caption);
    const tableUnit = inTable.size === 1 ? [...inTable][0]! : inTable.size === 0 && near.size === 1 ? [...near][0]! : null;
    // Revenue only from an income statement: a table with a per-share line, or one captioned as the statement
    // (Sony prints its per-share lines in the next table). Segment / KPI tables are neither.
    const statement = hasEps || jpStatementCaption(caption);

    // Figure columns of the table: a header cell over more than one of them is shared, not a column's own.
    const figureCols = new Set(rowsOut.flatMap((r) => r.nums.map((n) => n.start)));
    const firstFigure = Math.min(...figureCols);
    for (const row of rowsOut) {
      const blockText = row.headers.flat().map((c) => c.text).join(' ');
      const labelCol = row.headers.map((r) => r.filter((c) => c.text && c.start === 0 && c.span === 1).map((c) => c.text).join(' ')).join(' ').trim();
      // The label column's head ("(Billion JPY, except EPS)" over the row labels): the table's own unit / currency.
      const labelHead = row.headers.flat().filter((c) => c.text && c.start + c.span <= firstFigure).map((c) => c.text).join(' ');
      const overCellsOf = (n: Num) => row.headers.flatMap((r) => r.filter((c) => c.text && c.start < n.end && c.start + c.span > n.start && !(c.start === 0 && c.span === 1)));
      const siblings = row.nums.map((m) => overCellsOf(m).map((c) => c.text).join(' ').trim());
      // Header rows or the label column's head naming Core / adjusted / non-GAAP figures: the row is never read.
      if (JP_ADJUSTED_CONTEXT.test(blockText) || JP_ADJUSTED_CONTEXT.test(labelHead)) continue;
      // Summary layout only under a heading naming the group; a token row's table must name no other span.
      if (row.kind === 'cross' && (!groupTitled || !heads.lead[ti])) continue;
      if (row.token && [...jpSpanWords(`${contextRest} ${blockText}`)].some((k) => k !== jpPhraseSpan(row.period))) continue;
      for (const n of row.nums) {
        if (n.dollar) continue; // "$7": a dollar figure, never yen
        const overCells = overCellsOf(n);
        const over = overCells.map((c) => c.text).join(' ').trim();
        const exclusive = overCells.filter((c) => ![...figureCols].some((s) => s !== n.start && s >= c.start && s < c.start + c.span)).map((c) => c.text).join(' ');
        let field = row.field;
        if (row.kind === 'row') {
          const appendix = reportedTitled && !JP_FORECAST.test(labelCol) && jpAppendixColumn(over, siblings, pe, span, fiscal, naming);
          if (!appendix && !jpColumn(over, labelCol, blockText, pe, span, fiscal, exclusive)) continue;
        } else {
          // Summary layout: the column header names the field ("Basic earnings per share | yen"), the row the period
          // ("For the three months ended" | "June 30, 2026").
          if (overCells.some((c) => /%/.test(c.text) && jpUnitCell(c.text))) continue;
          const fieldText = overCells.filter((c) => !jpUnitCell(c.text) && !/%/.test(c.text)).map((c) => c.text).join(' ');
          field = fieldText ? jpField(jpLabel(fieldText), false) : null;
          if (!field || NOT_PERIOD.test(fieldText) || JP_FORECAST.test(fieldText)) continue;
          // The column's own head may name no other span ("EPS (three months)" under a nine-month row).
          if ([...jpSpanWords(fieldText)].some((k) => k !== span)) continue;
          // Its dates come from the row (section title + label) only, never from the label-column header alone;
          // an undated span there ("Three months ended" | "June 30, 2026", Sony) may still name the span.
          if (!jpDates(row.period).length) continue;
          if (!jpColumn(row.period, labelCol, `${labelCol} ${row.period}`, pe, span, fiscal, row.period)) continue;
        }
        if (!field) continue;
        // Currency: the column's own header, else the row label, else the table's text and caption. US$ is skipped.
        // In the summary layout the field header names no currency ("Earnings per share"): there the figure's own
        // "¥" sign ("¥ 131.62", SMFG) also states it. Statement / note layouts keep the header / caption rule.
        // The label column's head ("(Billion JPY, except EPS)") comes before the table text; a row label naming both
        // currencies ("Basic EPS (JPY or USD)") leaves it to the column's own header or that head.
        const curOwn = jpCurrency(over);
        const curLabel = jpCurrency(row.rawLabel);
        const curHead = jpCurrency(labelHead);
        if (curOwn === 'USD' || curOwn === null || curLabel === 'USD') continue;
        // A "¥" sign against a table / caption that names US$ (or both) is conflicting evidence: not read.
        if (row.yen.has(n.start) && (jpCurrency(tableText) === 'USD' || jpCurrency(tableText) === null)) continue;
        const curSign = row.kind === 'cross' && row.yen.has(n.start) ? 'JPY' : undefined;
        const cur = curLabel === null ? curOwn ?? curHead : curSign ?? curOwn ?? curLabel ?? curHead ?? jpCurrency(tableText);
        if (cur !== 'JPY') continue;

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
    revenueCurrency: null,
    epsCurrency: null,
    notes,
  };
}

// ---------------------------------------------------------------- profiles 'uk' / 'eu'
//
// A separate pass, so the 'us' / 'hk' / 'jp' paths above are untouched. UK and continental releases state figures in
// "£m", "€ million", "DKK million", "(in millions of euros)"…, EPS in pence or in the reporting currency, and print a
// quarter, half-year, nine-month or full-year column. One span is read per call; nothing is ever computed from
// another span. Uncertain means blank: no allowlisted unit, two currencies, disagreeing candidates → null.

type EuSpan = 'quarter' | 'half' | 'nine' | 'year';
type EuField = 'revenue' | 'basic' | 'diluted' | 'both';
type EuCurrency = 'EUR' | 'GBP' | 'GBp' | 'USD' | 'CHF' | 'DKK' | 'SEK' | 'NOK';

/**
 * Banks (US tickers of UK_FULL / EU_FULL issuers) whose top line is "Total income", or HSBC's "net operating income
 * before … credit losses". No other issuer's total income / net operating income is ever revenue.
 */
export const EUROPE_BANK_TICKERS: ReadonlySet<string> = new Set(['HSBC', 'BCS', 'LYG', 'NWG', 'ING', 'SAN', 'BBVA', 'UBS', 'DB']);

/** Currency words of an "(in millions of …)" statement. */
const EU_CUR_WORDS: Array<[EuCurrency, RegExp]> = [
  ['EUR', /^(?:euros?|eur|€)$/],
  ['GBP', /^(?:pounds?(?:\s+sterling)?|sterling|gbp|£)$/],
  ['USD', /^(?:u\.?\s?s\.?\s*dollars?|us\s+dollars?|dollars?|usd|us\$|\$)$/],
  ['CHF', /^(?:swiss\s+francs?|chf)$/],
  ['DKK', /^(?:danish\s+kron(?:er|e)|dkk)$/],
  ['SEK', /^(?:swedish\s+kron(?:or|a)|sek)$/],
  ['NOK', /^(?:norwegian\s+kron(?:er|e)|nok)$/],
];

/** Currency signs / codes of a unit statement, by currency. */
const EU_UNIT_CUR: Array<[EuCurrency, string]> = [
  ['GBP', String.raw`£|gbp`],
  ['USD', String.raw`us\$|\$|usd`],
  ['EUR', String.raw`€|eur`],
  ['CHF', 'chf'],
  ['DKK', 'dkk'],
  ['SEK', 'sek'],
  ['NOK', 'nok'],
];
/** Scale words of a unit statement (closed allowlist, English forms). */
const EU_SCALE: Array<[number, string]> = [
  [1e6, String.raw`m|mn|millions?`],
  [1e9, String.raw`bn|b\.?|billions?`],
  [1e3, String.raw`['’]?\s?000s?|k|thousands?`],
];
const EU_SCALE_WORDS: Array<[number, RegExp]> = [[1e6, /^millions$/], [1e9, /^billions$/], [1e3, /^thousands$/]];
/** Scale-prefixed currency codes: "TEUR", "kEUR", "KSEK", "MSEK", "MNOK", "mEUR", "bSEK". */
const EU_SCALE_CODE = /^([tkmb])(eur|sek|nok|dkk|chf|usd|gbp)$/;
const EU_CODE_CUR: Record<string, EuCurrency> = { eur: 'EUR', sek: 'SEK', nok: 'NOK', dkk: 'DKK', chf: 'CHF', usd: 'USD', gbp: 'GBP' };

/**
 * Unit statements (the closed allowlist): a currency sign / code and a scale — "£m", "£ million(s)", "£bn", "$m",
 * "US$m", "US$ million(s)", "€m", "€ million(s)", "EUR million(s)", "EUR m", "CHF million(s)", "DKK million(s)", "SEK m",
 * "SEK b.", "€ thousands", "€000", "£'000", "€bn" …; a scale-prefixed code — "TEUR", "kEUR", "KSEK", "MSEK", "MNOK"; or
 * "(in) millions / thousands / billions of <currency>" — with an optional "(Figures / Amounts) (are) (in)" lead,
 * ", except per share …" and "unless otherwise indicated". Nothing else is a unit.
 */
/** `cur` null: a bare millions scale ("m", "(in m)", "in millions"), whose currency must come from another unit. */
interface EuUnit { mult: number; cur: EuCurrency | null }

function euUnit(text: string): EuUnit | null {
  let core = text.trim().toLowerCase();
  if (/^\(/.test(core) && /\)$/.test(core)) core = core.slice(1, -1).trim();
  core = core
    .replace(/\s*,?\s*unless\s+otherwise\s+(?:indicated|stated|noted)\s*$/, '')
    .replace(EXCEPT_CLAUSE, '')
    .replace(/^(?:(?:all\s+)?(?:figures|amounts)\s+(?:are\s+)?(?:stated\s+|expressed\s+|shown\s+)?)?(?:in\s+)?/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(?:m|mn|millions?)$/.test(core)) return { mult: 1e6, cur: null };
  const code = core.match(EU_SCALE_CODE);
  if (code) return { mult: code[1] === 'm' ? 1e6 : code[1] === 'b' ? 1e9 : 1e3, cur: EU_CODE_CUR[code[2]!]! };
  for (const [cur, c] of EU_UNIT_CUR) {
    for (const [mult, s] of EU_SCALE) if (new RegExp(`^(?:${c})\\s?(?:${s})$`).test(core)) return { mult, cur };
  }
  const m = core.match(/^(millions|billions|thousands)\s+of\s+(.+)$/);
  if (m) {
    const mult = EU_SCALE_WORDS.find(([, re]) => re.test(m[1]!))![0];
    for (const [cur, re] of EU_CUR_WORDS) if (re.test(m[2]!.trim())) return { mult, cur };
  }
  return null;
}

/**
 * Unit-like tokens (fail closed): any scale word, "'000", a scale-prefixed code, a currency with a one-letter scale,
 * or the non-English "mio", "mln", "mrd", "tsd" … A text carrying one that is not wholly an allowlisted unit statement
 * names an unknown unit, and the figure it governs is blank (the caption never stands in for it).
 */
const EU_UNIT_LIKE = /^\(?\s*(?:in\s+)?mn?\s*\)?$|\b(?:thousands?|millions?|billions?|mio|mill|mln|mn|bn|bln|mrd|mia|md|tsd|tkr|mkr|mdkr|mdr)\b|['’]\s?000|(?:^|[^\d.,])000s?\b|\b[tkmb](?:eur|sek|nok|dkk|chf|usd|gbp)\b|(?:\$|€|£|\b(?:eur|sek|nok|dkk|chf|usd|gbp))\s?(?:[tkmb]|bn|mn)(?![a-z])/i;

/** Period words a column head cell may carry next to its unit ("Q3 2026 €m", "2026 $m"). */
const EU_PERIOD_WORDS = /\b(?:19|20)\d{2}\b|\b(?:q[1-4]|[1-4]q|h[12]|[12]h|fy|9m)\b/gi;

/** A header cell's unit: recognised, unknown (unit-like but off the allowlist) or none. */
function euCellUnitInfo(text: string): { unit: EuUnit | null; unknown: boolean } {
  if (!text || !EU_UNIT_LIKE.test(text)) return { unit: null, unknown: false };
  const unit = euUnit(text) ?? euUnit(text.replace(EU_PERIOD_WORDS, ' '));
  return { unit, unknown: unit === null };
}

/** A header cell that is only a currency or minor-unit mark ("$", "£", "€", "p", "pence", "(DKK)", "cents", "¢", "US c"). */
const EU_CURRENCY_MARK = /^\(?\s*(?:£|€|\$|us\$|p|pence|eur|euros?|usd|gbp|dkk|sek|chf|nok|cents?|¢|c|cts?|(?:us\$?|usd|us|euro|eur|€)\s*(?:cents?|c|cts?)|c\s?€)\s*\)?$/i;

/** An amount in a nominal / par value: "US$0.50", "€0.10", "CHF 0.10", "10 pence", "25p", "25 US cents", "0.10 euros". */
const EU_AMOUNT = String.raw`(?:(?:us\$|\$|€|£|eur|usd|gbp|chf|sek|nok|dkk)\s?\d[\d.,]*(?:\s*(?:us\s+cents?|euro\s+cents?|cents?|pence|p\b|¢|cts?\b|c\b))?` +
  String.raw`|\d[\d.,]*\s*(?:us\s+cents?|euro\s+cents?|cents?|pence|p\b|¢|cts?\b|c\b|euros?\b|eur\b|chf\b|usd\b|gbp\b|sek\b|nok\b|dkk\b|swiss\s+francs?|pounds?))`;
const EU_NOMINAL: Array<[RegExp, string]> = [
  [new RegExp(String.raw`\bshares?\s+(?:with\s+an?\s+(?:nominal|par)\s+value\s+)?of\s+${EU_AMOUNT}(?:\s+each)?`, 'gi'), 'share'],
  [new RegExp(String.raw`\bper\s+${EU_AMOUNT}\s+(?:ordinary\s+)?shares?\b`, 'gi'), 'per share'],
  [new RegExp(String.raw`\b(?:nominal|par)\s+value(?:\s+of)?(?:\s+per\s+share)?\s*:?\s*${EU_AMOUNT}(?:\s+each)?`, 'gi'), ' '],
];
/** Nominal / par share values are dropped before any unit or currency is looked for: they state neither. */
const euStripNominal = (text: string) => EU_NOMINAL.reduce((t, [re, to]) => t.replace(re, to), text);

/**
 * What one text (a row label or a head cell) says about an EPS figure's currency: its major currencies, explicit cents
 * forms (US / euro cents), a bare minor-unit marker ("c", "(c)", "ct", "¢", "cents") and pence. A bare marker or pence
 * beside a major currency in the same text ("(€)(c)", "€ c", "(£ p)") may be a footnote letter or a minor unit: the
 * text is `ambiguous`.
 */
interface EuEpsMarks {
  majors: Set<EuCurrency>;
  explicitCents: Set<'USD' | 'EUR'>;
  bareCents: boolean;
  pence: boolean;
  /** A lone letter "c" / "(c)": cents only as a whole column-mark cell; in a label it may be a footnote letter. */
  letterC: boolean;
  /** A lone letter "p" / "(p)" (not "pence"). */
  letterP: boolean;
  ambiguous: boolean;
}

/** Explicit cents forms (positive allowlist): "US cents", "US$ cents", "US$c", "USD cents", "euro cents", "EUR cents", "€c", "c€", "€ ct". */
const EU_US_CENTS = /\bu\.?\s?s\.?\s*\$?\s*cents?\b|\busd\s*cents?\b|\bus\$\s?c\b|\busc\b|\bus\s+cts?\b/gi;
const EU_EURO_CENTS = /\beuros?\s*(?:cents?|cts?)\b|\beur\s*(?:cents?|cts?)\b|€c\b|\bc€|€\s?(?:cents?|cts?)\b/gi;
/** A bare minor-unit marker, once the explicit forms are taken out: a word form ("cents", "¢", "ct") or a lone letter. */
const EU_CENTS_WORD = /\bcents?\b|¢|\bcts?\b/i;
const EU_LETTER_C = /(?:^|[\s(])c(?=[\s)]|$)/i;
const EU_PENCE_WORD = /\bpence\b/i;
const EU_LETTER_P = /(?:^|[\s(])p(?=[\s)]|$)/i;

function euEpsMarks(text: string): EuEpsMarks {
  let t = euStripNominal(text);
  const explicitCents = new Set<'USD' | 'EUR'>();
  t = t.replace(EU_US_CENTS, () => { explicitCents.add('USD'); return ' '; });
  t = t.replace(EU_EURO_CENTS, () => { explicitCents.add('EUR'); return ' '; });
  const majors = new Set<EuCurrency>();
  if (/£|\bgbp\b|\bpounds?\b|\bsterling\b/i.test(t)) majors.add('GBP');
  if (/€|\beur\b|\beuros?\b/i.test(t)) majors.add('EUR');
  if (/\$|\busd\b|\bu\.\s?s\.\s?dollars?\b|\bus dollars?\b/i.test(t)) majors.add('USD');
  if (/\bchf\b|swiss francs?/i.test(t)) majors.add('CHF');
  if (/\bdkk\b|danish kron/i.test(t)) majors.add('DKK');
  if (/\bsek\b|\bmsek\b|swedish kron/i.test(t)) majors.add('SEK');
  if (/\bnok\b|\bmnok\b|norwegian kron/i.test(t)) majors.add('NOK');
  const letterC = EU_LETTER_C.test(t);
  const letterP = EU_LETTER_P.test(t);
  const bareCents = letterC || EU_CENTS_WORD.test(t);
  const pence = letterP || EU_PENCE_WORD.test(t);
  return { majors, explicitCents, bareCents, pence, letterC, letterP, ambiguous: (bareCents || pence) && (majors.size > 0 || explicitCents.size > 0) };
}

/**
 * An EPS figure's currency from every source that states one (row label, column marks, the figure's own sign), or
 * null. Positive pairings only:
 * - US / euro cents (converted /100): an explicit form, or a bare marker that is the only unit indication of its text
 *   and pairs with exactly one currency (US$ or €) stated elsewhere.
 * - Pence ('GBp', not converted): only when no major currency is stated anywhere (a "(£)" label under a "p" mark
 *   conflicts).
 * - Otherwise exactly one major currency.
 * An ambiguous text, cents and pence together, or a minor unit on a figure signed in the major unit → null.
 */
function euEpsCurrency(marks: EuEpsMarks[], sign: EuCurrency | undefined): { cur: EuCurrency; div: number } | null {
  if (marks.some((m) => m.ambiguous)) return null;
  const majors = new Set<EuCurrency>(marks.flatMap((m) => [...m.majors]));
  const explicit = new Set<EuCurrency>(marks.flatMap((m) => [...m.explicitCents]));
  const signedMajor = sign !== undefined && sign !== 'GBp';
  if (signedMajor) majors.add(sign);
  const cents = explicit.size > 0 || marks.some((m) => m.bareCents);
  const pence = sign === 'GBp' || marks.some((m) => m.pence);
  if (cents && pence) return null;
  if (pence) return majors.size === 0 ? { cur: 'GBp', div: 1 } : null;
  if (cents) {
    if (signedMajor) return null;
    const curs = new Set([...explicit, ...majors]);
    if (curs.size !== 1) return null;
    const cur = [...curs][0]!;
    return cur === 'USD' || cur === 'EUR' ? { cur, div: 100 } : null;
  }
  return majors.size === 1 ? { cur: [...majors][0]!, div: 1 } : null;
}

/** The currency family a column mark names, for the convenience-column check (pence → GBP, explicit cents → theirs). */
function euMarkFamily(m: EuEpsMarks): Set<EuCurrency> {
  const out = new Set<EuCurrency>([...m.majors, ...m.explicitCents]);
  if (m.pence) out.add('GBP');
  return out;
}

/** Figures signed "£1.23", "€12.95", "US$1.45", "12.3p": the sign is taken off and remembered by the cell start. */
function euCells(cells: Cell[]): { cells: Cell[]; signs: Map<number, EuCurrency> } {
  const signs = new Map<number, EuCurrency>();
  const out = cells.map((c) => {
    if (EU_UNIT_LIKE.test(c.text)) return c; // "€000" is a unit, not a signed figure
    let m = c.text.match(/^(£|€|us\$)\s*(\(?[-–−]?\d[\d,]*(?:\.\d+)?\)?)$/i);
    if (m) { signs.set(c.start, m[1] === '£' ? 'GBP' : m[1] === '€' ? 'EUR' : 'USD'); return { ...c, text: m[2]! }; }
    m = c.text.match(/^(\(?[-–−]?\d[\d,]*(?:\.\d+)?\)?)\s*p$/i);
    if (m) { signs.set(c.start, 'GBp'); return { ...c, text: m[1]! }; }
    return c;
  });
  return { cells: out, signs };
}

/** A row label for matching: footnotes and every parenthetical ("(pence)", "('revenue')", "($m)") dropped. */
function euLabel(raw: string): string {
  return normLabel(raw)
    .replace(/\([^()]*\)/g, ' ')
    .replace(/['"]/g, ' ')
    .replace(/^[-–—•·\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:,.]+$/, '')
    .trim();
}

const EU_REVENUE = /^(?:group\s+)?(?:total\s+)?(?:group\s+)?(?:revenues?|turnover)$|^(?:total\s+)?(?:net\s+)?sales$/;
const EU_TOTAL_INCOME = /^total income$/;
/** HSBC's "Net operating income before change in expected credit losses and other credit impairment charges". */
const EU_NOI_BEFORE = /^net operating income before\b.*\b(?:credit losses|impairments?|provisions?)\b/;
const EU_EPS_WORDS = /\beps\b|earnings per\b|per (?:ordinary |common )?share\b/;
/** EPS rows never read: underlying, adjusted, core, headline, normalised, pre-exceptional, per ADS / ADR, … */
const EU_EPS_EXCLUDE = /underlying|adjusted|\bcore\b|headline|normali[sz]ed|pre[\s-]?exceptional|before exceptional|excluding|\bexcl\b|notable|non[\s-]?(?:gaap|ifrs)|constant currency|\bads\b|\badrs?\b|american depositary|dividend|weighted|number of|book value|cash|forecast|guidance|outlook|pro forma|discontinued|consensus|target/;
const EU_CONTINUING = /continuing operations/;
/** Captions, sections and column heads of figures that are not the reported ones. */
const EU_ADJUSTED = /constant currency|\bcer\b|at constant|organic|pro forma|non[\s-]?(?:gaap|ifrs)|alternative performance|\bunderlying\b|\badjusted\b|\bcore\b|reconcil|excluding|notable items|like[\s-]for[\s-]like/i;
/** A caption naming another breakdown than the group's: a segment, division, region or business. */
const EU_SEGMENT = /segment|division|region|business|by\s+(?:product|geograph|market|country)/i;
/** 'eu': "non-U.S. GAAP" (STMicroelectronics) is an adjusted measure like "non-GAAP". */
const EU_NON_US_GAAP = /non[\s-]?u\.?\s?s\.?\s*gaap/i;
/**
 * 'eu': rows that show an earlier revenue-labelled row of the same table is not the revenue line — a sales figure gross
 * of excise taxes ("Sales" → "Excise taxes" → "Revenues from sales", TotalEnergies) or a component of a later total
 * ("Net sales" → "Other revenues" → "Net revenues", STMicroelectronics). That label is then never revenue anywhere in
 * the document (the key-figures table repeats "Sales" without the excise line).
 */
const EU_REVENUE_RIVAL = /excise|^(?:total\s+)?net\s+revenues?$|^revenues?\s+from\s+(?:sales|contracts)\b/;

/**
 * Revenue: "(Group) (total) revenue(s)", "turnover", "(total) (net) sales"; for banks only
 * (`EUROPE_BANK_TICKERS`) also "total income" and "net operating income before … credit losses / impairment" (HSBC's revenue). Plain "net operating
 * income" is never read (after impairments at HSBC, pre-provision profit at Santander, operating profit elsewhere).
 * Never net interest income, operating / gross profit, profit before tax, adjusted / underlying / constant-currency /
 * organic revenue (the anchored list). EPS: "basic" / "diluted" with an EPS word; never the excluded kinds.
 */
function euField(label: string, bank: boolean): { field: EuField; continuing: boolean } | null {
  // Revenue labels are matched without their parentheticals; EPS labels with them ("EPS (basic; in euros)").
  const bare = euLabel(label);
  if (EU_REVENUE.test(bare)) return { field: 'revenue', continuing: false };
  if (EU_TOTAL_INCOME.test(bare)) return bank ? { field: 'revenue', continuing: false } : null;
  if (EU_NOI_BEFORE.test(bare)) return bank ? { field: 'revenue', continuing: false } : null;
  label = normLabel(label);
  if (!EU_EPS_WORDS.test(label) || EU_EPS_EXCLUDE.test(label)) return null;
  const continuing = EU_CONTINUING.test(label);
  const dil = /dilut/.test(label);
  const basic = /\bbasic\b/.test(label);
  if (dil && basic) return { field: 'both', continuing };
  if (dil) return { field: 'diluted', continuing };
  if (basic) return { field: 'basic', continuing };
  return null;
}

const EU_H2 = /\bh2\b|\b2h\b|\bsecond[\s-]half\b/i;
const EU_HALF = /\b(?:six|6)[\s-]*months?\b|\bh1\b|\b1h\b|\bhalf[\s-]*year\b|\bfirst[\s-]half\b/i;
const EU_NINE = /\b(?:nine|9)[\s-]*months?\b|\b9m\b/i;
const EU_QUARTER = /\b(?:three|3)[\s-]*months?\b|\b3m\b|\bquarter\b|\bq[1-4](?![a-z])|\b[1-4]q(?![a-z])/i;
const EU_YEAR = /\bfy(?![a-z])|\bfull[\s-]*year\b|\byears?\s+ended\b|\byears?\s+to\b(?![\s-]+date)|\b(?:twelve|12)[\s-]*months?\b/i;
/** "Year to date" / "YTD" states no months of its own. */
const EU_YTD = /\byear[\s-]+to[\s-]+date\b|\bytd\b|\bcumulative\b/i;
/** Words that rule a column out as a quarter: it is year-to-date, cumulative, six or nine months. */
/**
 * A quarter head, positive allowlist: it starts with "Qn yyyy" / "nQ yy", "nth quarter (yyyy)", "three months ended / to
 * <date>", "3M", "quarter ended / to <date>" (optionally after "For the"), or is a three-month range ("July–September
 * 2026"). Anything else is no quarter.
 */
const EU_QUARTER_HEAD = /^(?:for\s+the\s+)?(?:q[1-4]\s*'?\s*(?:\d{4}|\d{2})\b|[1-4]q\s*'?\s*(?:\d{4}|\d{2})\b|(?:first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\b|(?:three|3)[\s-]*months?\s+(?:ended|ending|to)\b|3m\b|quarter\s+(?:ended|ending|to)\b)/i;
/**
 * Words that rule a head out as a quarter: quarter ranges ("Q1-Q3", "1-3Q"), accumulated / accum. / cum(.) / cumulative /
 * cumul / YTD / year to date / to date, six or nine months, 6M / 9M, H1 / H2, half.
 */
const EU_NOT_QUARTER = /\bq[1-4]\s*[-–—~]\s*q?[1-4]\b|\b[1-4]\s*[-–—~]\s*[1-4]\s*q\b|\baccum|\bcum\b|\bcumul|\bytd\b|\byear[\s-]+to[\s-]+date\b|\bto[\s-]+date\b|\b(?:nine|six|9|6)[\s-]*months?\b|\b[69]m\b|\bh[12]\b|\b[12]h\b|\bhalf\b|\bfirst[\s-]half\b/i;

/** A range / cumulative token, or a month range ("Jan-Sep", with or without a year) other than three months. */
function euNotQuarter(text: string): boolean {
  if (EU_NOT_QUARTER.test(text)) return true;
  for (const m of text.matchAll(new RegExp(String.raw`\b${MONTH_RE}\.?\s*[-–—~]\s*${MONTH_RE}\b`, 'gi'))) {
    if (((month(m[2]!) - month(m[1]!) + 12) % 12) + 1 !== 3) return true;
  }
  return false;
}

/** A quarter head by the positive allowlist, with no range / cumulative token. */
function euQuarterHead(text: string): boolean {
  if (euNotQuarter(text)) return false;
  if (EU_QUARTER_HEAD.test(text.trim())) return true;
  const { ranges } = jpRanges(text);
  return ranges.length > 0 && ranges.every((r) => r.span === 'quarter') && new RegExp(String.raw`^${MONTH_RE}`, 'i').test(text.trim());
}

/** `uk`: "half-year to / ended" is the half-year's own wording, not also a "year to / ended" (profile 'uk'). */
function euKinds(text: string, uk = false): Set<EuSpan | 'h2' | 'ambiguous'> {
  const { ranges, rest } = jpRanges(text);
  const out = new Set<EuSpan | 'h2' | 'ambiguous'>();
  for (const r of ranges) out.add(r.span ?? 'ambiguous');
  if (EU_H2.test(rest)) out.add('h2');
  const r2 = rest.replace(new RegExp(EU_H2.source, 'gi'), ' ');
  if (EU_HALF.test(r2)) out.add('half');
  if (EU_NINE.test(r2)) out.add('nine');
  if (EU_QUARTER.test(r2)) out.add('quarter');
  if (EU_YEAR.test(uk ? r2.replace(/\bhalf[\s-]*years?\b/gi, ' ') : r2)) out.add('year');
  // "Year to date" / "cumulative" without stated months (six / nine) is no span: never a full year, and a quarter token
  // beside it ("Q3 2026 YTD") names the quarter the period runs to, not a three-month span.
  if (EU_YTD.test(r2) && !out.has('half') && !out.has('nine')) { out.delete('year'); out.delete('quarter'); out.add('ambiguous'); }
  return out;
}

/** Period tokens with a year: "Q3 2026", "Q3 26", "3Q26", "H1 2026", "Half year 2026", "9M 2026", "FY 2026", "Full year 2026". */
function euTokens(text: string): Array<{ span: EuSpan; q?: number; year: number }> {
  const out: Array<{ span: EuSpan; q?: number; year: number }> = [];
  const Y = String.raw`\s*'?\s*(\d{4}|\d{2})\b`;
  for (const m of text.matchAll(new RegExp(String.raw`\bq([1-4])${Y}`, 'gi'))) out.push({ span: 'quarter', q: Number(m[1]), year: fullYear(m[2]!) });
  for (const m of text.matchAll(new RegExp(String.raw`\b([1-4])q${Y}`, 'gi'))) out.push({ span: 'quarter', q: Number(m[1]), year: fullYear(m[2]!) });
  const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
  for (const m of text.matchAll(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\s+(?:of\s+)?(\d{4})\b/gi)) out.push({ span: 'quarter', q: ORD[m[1]!.toLowerCase()]!, year: Number(m[2]) });
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:h1|1h|half[\s-]*year|first[\s-]half)${Y}`, 'gi'))) out.push({ span: 'half', year: fullYear(m[1]!) });
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:9m|nine[\s-]*months)${Y}`, 'gi'))) out.push({ span: 'nine', year: fullYear(m[1]!) });
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:fy|full[\s-]*year)${Y}`, 'gi'))) out.push({ span: 'year', year: fullYear(m[1]!) });
  return out;
}

/** "31 March" / "March 31" with no year after it, as [month, day]. */
function euDayMonth(text: string): [number, number] | null {
  const a = text.match(new RegExp(String.raw`\b(\d{1,2})\s+${MONTH_RE}\b(?!\.?\s*,?\s*\d{4})`, 'i'));
  if (a) return [month(a[2]!), Number(a[1])];
  const b = text.match(new RegExp(String.raw`\b${MONTH_RE}\.?\s+(\d{1,2})\b(?!\s*,?\s*\d{4})`, 'i'));
  return b ? [month(b[1]!), Number(b[2])] : null;
}

/**
 * Does a column (its own head `own`; the label column's head and the header block as fallbacks for the span) name
 * `span` ending `pe`? Exactly one span may be named (an H2 / second-half head is never read). A dated column must be
 * within 15 days of `pe` ("31 March" in the label column takes the year of the column's own head). Undated, the
 * column's own tokens must carry a year: "Q3 2026" is read only for a calendar-aligned fiscal year (the period end
 * falls in the year the fiscal year ends) and the release's own quarter. Comparative years never match.
 */
function euColumn(own: string, labelCol: string, block: string, pe: Date, span: EuSpan, fiscal: JpFiscal, ownHead = own, uk = false): boolean {
  if (!own) return false;
  if (NOT_PERIOD.test(own) || ADJUSTMENT_COL.test(own) || EU_ADJUSTED.test(own) || JP_FORECAST.test(own)) return false;
  let kinds = euKinds(own, uk);
  if (!kinds.size) kinds = euKinds(labelCol, uk);
  if (!kinds.size) kinds = euKinds(block, uk);
  if (kinds.size !== 1 || !kinds.has(span)) return false;
  // A quarter only by the positive allowlist (`euQuarterHead`): the column's own head (`ownHead`: without table-wide
  // title rows such as "PRELIMINARY RESULTS*"), or — when that head is only a year and units ("2026 $m") — the label
  // column's head ("For the three months ended 31 March"). No range / cumulative token anywhere over the column.
  // `uk` (profile 'uk'): the whole head with its title cells may also be the allowlisted form — a "Quarter
  // ended" title alone on its row, spanning "31 Mar 2026 | 31 Dec 2025 | 31 Mar 2025" (HSBC 1Q).
  if (span === 'quarter') {
    if (euNotQuarter(own) || euNotQuarter(labelCol)) return false;
    const bare = ownHead
      .replace(/(?:us\$|\$|€|£|eur|usd|gbp|chf|dkk|sek|nok)\s?(?:m|mn|bn|million|millions|thousands?|'?000)(?![a-z])/gi, ' ')
      .replace(/(?:^|\s)(?:us\$|\$|€|£|p|pence|cents?)(?=\s|$)/gi, ' ')
      .replace(/\b(?:19|20)\d{2}\b/g, ' ')
      .trim();
    if (!(euQuarterHead(ownHead) || (uk && euQuarterHead(own)) || (bare === '' && euQuarterHead(labelCol)))) return false;
  }
  const near = ([y, m, d]: [number, number, number]) => m > 0 && daysApart(y, m, d, pe) <= 15;
  let dates = jpDates(own);
  if (!dates.length) dates = jpDates(labelCol);
  if (dates.length) return dates.every(near);
  const years = new Set([...own.matchAll(/\b(19|20)(\d{2})\b/g)].map((m) => Number(m[1]! + m[2]!)));
  const dm = euDayMonth(own) ?? euDayMonth(labelCol);
  if (dm && years.size === 1) return near([[...years][0]!, dm[0], dm[1]]);
  const tokens = euTokens(own);
  const peYear = pe.getUTCFullYear();
  if (!tokens.length || fiscal.year !== peYear) return false;
  return tokens.every((t) => t.span === span && t.year === peYear && (t.q === undefined || t.q === fiscal.quarter));
}

/** `step`: a revenue figure's rounding unit (scale / 10^decimals); `label`: its row label (`euLabel`). */
interface EuCandidate { value: number; cur: EuCurrency; continuing: boolean; step?: number; label?: string }

interface EuRow { field: EuField; continuing: boolean; nums: Num[]; signs: Map<number, EuCurrency>; headers: Cell[][]; rawLabel: string; sectionRaw: string }

function readEu(html: string, opts: ReaderOptions): ReaderResult {
  const notes: string[] = [];
  const pe = new Date(`${opts.periodEnd}T00:00:00Z`);
  if (Number.isNaN(pe.getTime())) {
    return { epsShare: null, epsShareStated: false, epsAds: null, epsAdjusted: null, epsGaap: null, epsBasic: null, revenue: null, unit: null, revenueCurrency: null, epsCurrency: null, notes: ['bad periodEnd'] };
  }
  // Profile 'eu' only (Task 18, found on the EU release corpus; 'uk' reads as before): self-closing cells, non-U.S.
  // GAAP measures, a quarter title over the whole table, revenue rivals and the most precise of agreeing revenues.
  const eu = opts.profile === 'eu';
  // A self-closing cell ("<td/>", "<td colspan=\"3\"/>", Sanofi) is an empty cell; as written it would swallow the next
  // cell and shift every figure after it one column to the left (onto the comparative column).
  if (eu) html = html.replace(/<(td|th)\b([^>]*?)\s*\/>/gi, '<$1$2></$1>');
  const adjusted = (text: string) => EU_ADJUSTED.test(text) || (eu && EU_NON_US_GAAP.test(text));
  /** Revenue row labels ruled out by a rival row (`EU_REVENUE_RIVAL`), for the whole document. */
  const rivalled = new Set<string>();
  /** The finest rounding unit any revenue row of a label is stated in, anywhere in the document (placed or not). */
  const finest = new Map<string, number>();
  const span = opts.span;
  const fiscal: JpFiscal = { quarter: opts.fiscalQuarter, year: opts.fiscalYear };
  const bank = opts.issuer !== undefined && EUROPE_BANK_TICKERS.has(opts.issuer.ticker);
  const found: Record<'revenue' | 'basic' | 'diluted', EuCandidate[]> = { revenue: [], basic: [], diluted: [] };

  const tables = parseTables(html, { rowspan: true });
  // A table's caption: the last block of text right above it (empty when another table stands right above). Split
  // with the same pattern as `parseTables`, so the indexes line up.
  const segs = html.split(/<table\b[\s\S]*?<\/table>/gi);
  const captions = tables.map((_, i) => segs[i]!.split(JP_BLOCK_END).map((b) => decode(b)).filter(Boolean).pop() ?? '');
  const epsRow = (t: Table) => t.rows.some((r) => r.some((c) => c.text && EU_EPS_WORDS.test(normLabel(c.text))));
  const docHasEps = tables.some(epsRow);
  // Every currency the document's tables (and their captions) name: units, marks, labels, signed figures. Pence are
  // read only when none of them is another currency than GBP. A per-ADS / ADR row (never read; a US-dollar translation
  // by nature) does not count.
  const docCurs = new Set<EuCurrency>();
  const addCurs = (text: string) => {
    if (!text) return;
    const u = euCellUnitInfo(text).unit ?? euUnit(text);
    if (u?.cur) docCurs.add(u.cur);
    for (const c of euMarkFamily(euEpsMarks(text))) docCurs.add(c);
  };
  for (const [ti, t] of tables.entries()) {
    addCurs(captions[ti]!);
    for (const r of t.rows) {
      if (r.some((c) => /\bads\b|\badrs?\b|american depositary/i.test(c.text))) continue;
      for (const c of r) addCurs(c.text);
    }
  }
  const docOtherCur = [...docCurs].some((c) => c !== 'GBP');
  // A unit cell: an allowlisted or unit-like unit ("€m", "€000", "EUR mio"), a currency / minor-unit mark, or "%".
  const unitCell = (t: string) => EU_UNIT_LIKE.test(t) || EU_CURRENCY_MARK.test(t) || t === '%';
  const unitRow = (r: Cell[]) => r.some((c) => c.text) && r.every((c) => !c.text || unitCell(c.text));

  let quarterStated = false;
  for (const [ti, table] of tables.entries()) {
    const caption = captions[ti]!;
    if (JP_FORECAST.test(caption)) continue;
    // An adjusted / non-GAAP caption: nothing in the table is read, but (profile 'uk') a three-month column in it still
    // shows that the release states quarter figures (`quarterStated`).
    const adjustedCaption = adjusted(caption);
    if (adjustedCaption && (span !== 'quarter' || eu)) continue;
    // Period words in the caption ("Nine months to 30 September", "Six months ended", "Year to date", "H1"): no column
    // of the table is the quarter.
    if (span === 'quarter' && euNotQuarter(caption)) continue;
    // Revenue only from a table with a per-share line (the income statement or the results summary); a release with
    // no per-share line anywhere (a trading update) may give it from a table that is not a segment breakdown.
    const revenueOk = epsRow(table) || (!docHasEps && !EU_SEGMENT.test(caption));

    let headers: Cell[][] = [];
    let titles: Cell[][] = [];
    let lastWasData = false;
    let section = '';
    let sectionRaw = '';
    const nonData: Cell[][] = [];
    const rowsOut: EuRow[] = [];
    // Every labelled data row with a figure that is no percentage, for `quarterStated`.
    const dataRows: Array<{ nums: Num[]; headers: Cell[][] }> = [];
    const revenueLabels: string[] = [];

    for (const rawCells of table.rows) {
      // A row of unit cells only ("€000 | €000", "$ | $") is a unit row under the period heads, never data.
      if (unitRow(rawCells)) {
        nonData.push(rawCells);
        headers = lastWasData ? [...headers.filter((r) => !unitRow(r)), rawCells] : [...headers, rawCells];
        continue;
      }
      const { cells, signs } = euCells(rawCells);
      const li = cells.findIndex((c) => c.text);
      const first = cells[li]!;
      const hasLabel = /[a-z]/i.test(first.text) && !/^\(?\s*\d/.test(first.text);
      const nums = rowNumbers(cells, hasLabel ? li + 1 : li);
      const yearRow = nums.length > 0 && nums.every((n) => isYear(n) && !n.dollar && !n.pct);
      const otherText = cells.slice(li + 1).some((c) => c.text);
      if (nums.length && !yearRow) {
        // A subtotal row without a label is data too: it does not start a new header block.
        lastWasData = true;
        titles = [];
        if (!hasLabel) continue;
        let rawLabel = first.text;
        // "Basic" / "Diluted" under "Earnings per share (pence)" takes the parent's label and its currency.
        if (/^(basic|diluted|basic and diluted)$/.test(euLabel(first.text)) && section) rawLabel = `${sectionRaw} ${first.text}`;
        const f = euField(rawLabel, bank);
        const vals = nums.filter((n) => !n.pct);
        if (vals.length) dataRows.push({ nums: vals, headers });
        if (eu && EU_REVENUE_RIVAL.test(euLabel(first.text))) for (const l of revenueLabels) rivalled.add(l);
        if (eu && f?.field === 'revenue') revenueLabels.push(euLabel(rawLabel));
        if (f && vals.length && !adjusted(section) && !(eu && EU_NON_US_GAAP.test(rawLabel))) rowsOut.push({ ...f, nums: vals, signs, headers, rawLabel, sectionRaw });
        if (/:\s*$/.test(first.text)) { section = euLabel(first.text); sectionRaw = first.text; }
        continue;
      }
      nonData.push(cells);
      if (!otherText) {
        // Label-only row: a section ("Earnings per share (pence)", "Alternative performance measures") or a title.
        section = euLabel(first.text);
        sectionRaw = first.text;
        if (lastWasData) titles = [...titles, cells];
        else headers = [...headers, cells];
        continue;
      }
      // A "$ | $" / "£m | £m" row between data rows restates the columns' units: it does not start a new block.
      if (lastWasData && unitRow(cells)) {
        headers = [...headers.filter((r) => !unitRow(r)), cells];
        continue;
      }
      if (lastWasData) headers = titles;
      headers = [...headers, cells];
      lastWasData = false;
      section = '';
      sectionRaw = '';
    }
    if (span === 'quarter' && !quarterStated) quarterStated = euStatesQuarter(dataRows, pe, fiscal);
    if (adjustedCaption || !rowsOut.length) continue;

    const figureCols = new Set(rowsOut.flatMap((r) => r.nums.map((n) => n.start)));
    const firstFigure = Math.min(...figureCols);
    // Title cells: alone on their head row, and starting in the label column or spanning every figure column.
    const titleCells = new Set<Cell>();
    for (const r of nonData) {
      const texts = r.filter((c) => c.text);
      const t = texts[0];
      if (texts.length === 1 && t && (t.start < firstFigure || [...figureCols].every((f) => f >= t.start && f < t.start + t.span))) titleCells.add(t);
    }
    // The table's own head units: whole-unit cells left of the figures (the label column's head) or alone on their row.
    // A head cell with a scale word that is no unit statement ("(In thousands, except per share amounts)") names no
    // unit, and the caption never stands in for it. The caption counts only when the table states no unit itself:
    // wholly a unit statement, or an income-statement title with one in parentheses.
    const headUnits = new Map<string, EuUnit>();
    let headUnknown = false;
    for (const r of nonData) {
      const texts = r.filter((c) => c.text);
      for (const c of texts) {
        if (!(c.start + c.span <= firstFigure || texts.length === 1)) continue;
        const u = euUnit(c.text);
        if (u) headUnits.set(`${u.cur}:${u.mult}`, u);
        else if (EU_UNIT_LIKE.test(c.text)) headUnknown = true;
      }
    }
    const captionUnits = new Map<string, EuUnit>();
    const addCaption = (u: EuUnit | null) => { if (u) captionUnits.set(`${u.cur}:${u.mult}`, u); };
    addCaption(euUnit(caption));
    if (statementTitle(caption) != null) for (const m of caption.matchAll(new RegExp(PAREN_GROUP, 'g'))) addCaption(euUnit(m[0]));
    const tableLevel = headUnits.size || headUnknown ? headUnits : captionUnits;
    const tableCur = new Set([...tableLevel.values()].map((u) => u.cur).filter((c): c is EuCurrency => c !== null));
    const noUnit = () => { if (!notes.includes('revenue: no unit stated for table')) notes.push('revenue: no unit stated for table'); };

    for (const row of rowsOut) {
      const field = row.field;
      if (field === 'revenue' && !revenueOk) continue;
      const blockText = row.headers.flat().map((c) => c.text).join(' ');
      const labelCol = row.headers.map((r) => r.filter((c) => c.text && c.start === 0 && c.span === 1).map((c) => c.text).join(' ')).join(' ').trim();
      // The row label's units: its parentheticals ("($m)"), nominal share values dropped first; any other unit-like
      // token in the label is unknown.
      const label = euStripNominal(row.rawLabel);
      const labelParens = [...label.matchAll(new RegExp(PAREN_GROUP, 'g'))].map((m) => m[0]);
      const rowUnits = labelParens.map((p) => euUnit(p)).filter((u): u is EuUnit => u !== null);
      const rowUnknown = EU_UNIT_LIKE.test(label.replace(new RegExp(PAREN_GROUP, 'g'), (p) => (euUnit(p) ? ' ' : p)));
      const labelMarks = euEpsMarks(row.rawLabel);
      const sectionMarks = euEpsMarks(row.sectionRaw);
      if (eu && field === 'revenue' && !headUnknown && !rowUnknown) {
        const mults = new Set([...rowUnits, ...tableLevel.values()].map((u) => u.mult));
        if (mults.size === 1) {
          const step = [...mults][0]! / 10 ** Math.max(...row.nums.map((n) => n.decimals));
          const l = euLabel(row.rawLabel);
          finest.set(l, Math.min(finest.get(l) ?? Infinity, step));
        }
      }
      for (const n of row.nums) {
        const overCells = row.headers.flatMap((r) => r.filter((c) => c.text && c.start < n.end && c.start + c.span > n.start && !(c.start === 0 && c.span === 1)));
        const own = overCells.map((c) => c.text).join(' ').trim();
        // The column's own head for the quarter allowlist, without the table's title cells.
        // ('eu': a title cell naming a quarter — "Three months ended", "Q1" over every figure column — stays; the
        // allowlist below still decides on the whole head, "Q1 2025".)
        const ownHead = overCells.filter((c) => !titleCells.has(c) || (eu && EU_QUARTER.test(c.text) && !euNotQuarter(c.text))).map((c) => c.text).join(' ').trim();
        if (!euColumn(own, labelCol, blockText, pe, span, fiscal, ownHead, opts.profile === 'uk')) continue;
        // The column's currency: its unit cells ("€m", "US$m") and currency marks ("$", "pence", "cents").
        const infos = overCells.map((c) => euCellUnitInfo(c.text));
        const colUnits = infos.map((i) => i.unit).filter((u): u is EuUnit => u !== null);
        const colUnknown = infos.some((i) => i.unknown);
        const marks = overCells.filter((c) => EU_CURRENCY_MARK.test(c.text)).map((c) => euEpsMarks(c.text));
        const colCurs = new Set([...colUnits.map((u) => u.cur).filter((c): c is EuCurrency => c !== null), ...marks.flatMap((m) => [...euMarkFamily(m)])]);
        if (colCurs.size > 1) continue;
        // A column in another currency than the table's (a convenience translation) is skipped.
        if (colCurs.size === 1 && tableCur.size === 1 && [...colCurs][0] !== [...tableCur][0]) continue;
        const sign = row.signs.get(n.start) ?? (n.dollar ? 'USD' : undefined);

        if (field === 'revenue') {
          if (n.value <= 0 || n.decimals > 2) continue;
          // Scale precedence: the table's own units (row label, column head, table head) beat the caption; in-table
          // units that disagree, or an in-table scale that is no unit statement, leave the figure blank.
          if (headUnknown || rowUnknown || colUnknown) { noUnit(); continue; }
          // The scale: the in-table units' (all must agree), else the caption's. The currency: the in-table units'
          // (all that name one must agree), else — for a bare in-table "m" — the caption's; it must be exactly one.
          const inTable = [...rowUnits, ...colUnits, ...headUnits.values()];
          const caps = [...captionUnits.values()];
          const scaleFrom = inTable.length ? inTable : caps;
          const mults = new Set(scaleFrom.map((u) => u.mult));
          const inCurs = new Set(inTable.map((u) => u.cur).filter((c): c is EuCurrency => c !== null));
          const curs = inCurs.size ? inCurs : new Set(caps.map((u) => u.cur).filter((c): c is EuCurrency => c !== null));
          if (!mults.size || !curs.size) { noUnit(); continue; }
          if (mults.size > 1 || curs.size > 1) {
            if (!notes.includes('revenue: units disagree')) notes.push('revenue: units disagree');
            continue;
          }
          const unit = { mult: [...mults][0]!, cur: [...curs][0]! };
          if (sign && (sign === 'GBp' ? 'GBP' : sign) !== unit.cur) continue;
          found.revenue.push({ value: Math.round(n.value * unit.mult), cur: unit.cur, continuing: row.continuing, step: unit.mult / 10 ** n.decimals, label: euLabel(row.rawLabel) });
        } else {
          // EPS is never scaled by a table unit, and an unknown unit in its label or column head blanks it. Its
          // currency comes from the figure's sign, the row label and the column's marks (`euEpsCurrency`: one major
          // currency; US / euro cents converted /100; pence stay 'GBp'; any other pairing or conflict → not read).
          if (n.decimals < 1 || n.decimals > 3 || Math.abs(n.value) >= 100_000) continue;
          if (rowUnknown || colUnknown) continue;
          // A lone letter "c" / "(c)" in the row or section label may be a footnote letter or cents: never read. Cents
          // come only from "cents" / "¢" / "ct", the explicit forms, or a whole column-mark cell "c" / "(c)".
          if (labelMarks.letterC || sectionMarks.letterC) continue;
          // A lone "c" / "(c)" mark cell is cents only when no major-currency mark or unit stands over the same column
          // ("$" over a footnote "(c)" cell contradicts it); the currency then comes from the row label or the table.
          if (marks.some((m) => m.letterC) && overCells.some((c) => {
            const m = euEpsMarks(c.text);
            return m.majors.size > 0 || m.explicitCents.size > 0 || !!euCellUnitInfo(c.text).unit?.cur;
          })) continue;
          // A minor unit in a head cell over the column that is not a whole mark ("Q3 2026 (c)"): never read.
          if (overCells.some((c) => {
            if (EU_CURRENCY_MARK.test(c.text)) return false;
            const m = euEpsMarks(c.text);
            return m.bareCents || m.pence || m.explicitCents.size > 0;
          })) continue;
          const res = euEpsCurrency([labelMarks, ...marks], sign);
          if (!res) continue;
          const cur = res.cur;
          // Pence ("(p)", "(pence)", a "p" mark, "12.3p") only when the document names no other currency than GBP.
          if (cur === 'GBp' && docOtherCur) continue;
          const value = res.div === 100 ? Number((n.value / 100).toFixed(n.decimals + 2)) : n.value;
          if (field === 'basic' || field === 'both') found.basic.push({ value, cur, continuing: row.continuing });
          if (field === 'diluted' || field === 'both') found.diluted.push({ value, cur, continuing: row.continuing });
        }
      }
    }
  }

  const settle = (field: 'revenue' | 'basic' | 'diluted'): EuCandidate | null => {
    let c = found[field];
    // A continuing-operations row is read only when no total row is.
    if (c.some((x) => !x.continuing)) c = c.filter((x) => !x.continuing);
    if (!c.length) return null;
    const same = (a: EuCandidate, b: EuCandidate) =>
      a.cur === b.cur && (field === 'revenue' ? Math.abs(a.value - b.value) <= 0.001 * Math.abs(b.value) : Math.abs(a.value - b.value) < 1e-6);
    const distinct = c.filter((x, i) => c.findIndex((y) => same(x, y)) === i);
    if (distinct.length > 1) {
      notes.push(`${field}: candidates disagree (${distinct.map((d) => `${d.value} ${d.cur}`).join(', ')})`);
      return null;
    }
    // 'eu', only once every candidate agrees (the filters below can never turn a disagreement into another line's
    // figure): a rival-ruled label is never revenue; a figure rounded coarser than the same line elsewhere in the
    // document ("Net sales" 55.0 SEK b. in the summary, 55,025 SEK million in a statement whose column cannot be placed)
    // is not the exact revenue; of the rest, the most precise one.
    if (eu && field === 'revenue') {
      c = c.filter((x) => !rivalled.has(x.label!) && x.step! <= (finest.get(x.label!) ?? Infinity));
      if (!c.length) {
        notes.push('revenue: only rounded or rivalled figures');
        return null;
      }
      return c.reduce((a, b) => (b.step! < a.step! ? b : a));
    }
    return c[0]!;
  };
  const rev = settle('revenue');
  let basic = settle('basic');
  let diluted = settle('diluted');
  if (basic && diluted && basic.cur !== diluted.cur) {
    notes.push(`eps: basic in ${basic.cur}, diluted in ${diluted.cur}`);
    basic = diluted = null;
  }
  return {
    epsShare: diluted?.value ?? null,
    epsShareStated: found.diluted.length > 0,
    epsAds: null,
    epsAdjusted: null,
    epsGaap: diluted?.value ?? null,
    epsBasic: basic?.value ?? null,
    revenue: rev?.value ?? null,
    unit: null,
    revenueCurrency: rev?.cur ?? null,
    epsCurrency: basic?.cur ?? diluted?.cur ?? null,
    ...(span === 'quarter' ? { quarterStated } : {}),
    notes,
  };
}

/**
 * Does a table state a figure in the release's own three-month column, whatever the row's label? Looser than reading
 * (it only ever blanks a release): a column counts when its head names the quarter and nothing else (`euKinds`), with
 * no range / cumulative token, and is dated within 15 days of the period end — the date from its own head or from the
 * head cells left of the figures ("Quarter ended 30 September 2025" over "Q2 FY26 | Q2 FY25") — or, undated, carries
 * the release's own "Qn yyyy" token.
 */
function euStatesQuarter(rows: Array<{ nums: Num[]; headers: Cell[][] }>, pe: Date, fiscal: JpFiscal): boolean {
  if (!rows.length) return false;
  const firstFigure = Math.min(...rows.flatMap((r) => r.nums.map((n) => n.start)));
  const peYear = pe.getUTCFullYear();
  return rows.some((row) => {
    const left = row.headers.flatMap((r) => r.filter((c) => c.text && c.start + c.span <= firstFigure)).map((c) => c.text).join(' ').trim();
    return row.nums.some((n) => {
      const own = row.headers.flatMap((r) => r.filter((c) => c.text && c.start < n.end && c.start + c.span > n.start && c.start + c.span > firstFigure)).map((c) => c.text).join(' ').trim();
      if (euNotQuarter(own) || euNotQuarter(left)) return false;
      const kinds = euKinds(own).size ? euKinds(own) : euKinds(left);
      if (kinds.size !== 1 || !kinds.has('quarter')) return false;
      const dates = jpDates(own).length ? jpDates(own) : jpDates(left);
      if (dates.length) return dates.every(([y, m, d]) => m > 0 && daysApart(y, m, d, pe) <= 15);
      const tokens = euTokens(own);
      return fiscal.year === peYear && tokens.length > 0 && tokens.every((t) => t.span === 'quarter' && t.year === peYear && t.q === fiscal.quarter);
    });
  });
}
