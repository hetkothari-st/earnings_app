/**
 * Reads EPS and revenue from a US earnings press release (8-K EX-99.1, HTML).
 *
 * Rule of thumb: uncertain means blank. A value is returned only when its row
 * label, its column header (the quarter ending `quarterEnd`, never year-to-date)
 * and — for revenue — the table's stated unit all check out, and every
 * candidate found in the document agrees. This reads document text only; block
 * detection (looksBlocked) is the fetcher's job.
 */

export interface ReleaseValues {
  epsAdjusted: number | null;
  epsGaap: number | null;
  revenue: number | null;
  unit: number | null; /* multiplier applied to revenue */
  notes: string[];
}

// ---------------------------------------------------------------- HTML → tables

interface Cell { text: string; start: number; span: number }
interface Table { rows: Cell[][]; before: string }

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

function parseTables(html: string): Table[] {
  const out: Table[] = [];
  let prevEnd = 0;
  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const before = decode(html.slice(Math.max(prevEnd, t.index - 4000), t.index)).slice(-400);
    prevEnd = t.index + t[0].length;
    const rows: Cell[][] = [];
    for (const tr of t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const cells: Cell[] = [];
      let col = 0;
      for (const td of tr[0].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
        const span = Math.max(1, Number(td[1]!.match(/colspan\s*=\s*["']?(\d+)/i)?.[1] ?? 1));
        cells.push({ text: decode(td[2]!), start: col, span });
        col += span;
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

/** Does this column header name the quarter ending `qe`? */
function isQuarterColumn(h: string, qe: Date): boolean {
  if (!h || NOT_QUARTER.test(h)) return false;
  const dates: Array<[number, number, number]> = [];
  for (const m of h.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})\\s*,?\\s*(\\d{4})\\b`, 'gi'))) dates.push([Number(m[3]), month(m[1]!), Number(m[2])]);
  for (const m of h.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) dates.push([fullYear(m[3]!), Number(m[1]), Number(m[2])]);
  for (const m of h.matchAll(new RegExp(`\\b(\\d{1,2})-${MONTH_RE}-(\\d{4}|\\d{2})\\b`, 'gi'))) dates.push([fullYear(m[3]!), month(m[2]!), Number(m[1])]);
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

type Field = 'epsAdjusted' | 'epsGaap' | 'revenue';

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
const CAPTION_RE = /\(\s*(?:\$|us\$|usd|u\.s\. dollars|dollars|amounts)?\s*(?:in\s+)?(thousands|millions|billions)\b|\([^()]{0,60}?\bin\s+(thousands|millions|billions)\b|\$\s*(?:in\s+)?(thousands|millions|billions)\b|\$\s?(000)'?s\b|\(\s*(000)'?s\s*\)/gi;
const MULT: Record<string, number> = { thousands: 1e3, '000': 1e3, millions: 1e6, billions: 1e9 };

function units(text: string, re: RegExp = UNIT_RE): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(re)) {
    const w = m.slice(1).find((g) => g !== undefined)!.toLowerCase();
    out.add(MULT[w]!);
  }
  return out;
}

// ---------------------------------------------------------------- reader

interface Candidate { value: number; unit: number | null }

export function readUsRelease(html: string, quarterEnd: string): ReleaseValues {
  const notes: string[] = [];
  const qe = new Date(`${quarterEnd}T00:00:00Z`);
  const found: Record<Field, Candidate[]> = { epsAdjusted: [], epsGaap: [], revenue: [] };
  if (Number.isNaN(qe.getTime())) return { epsAdjusted: null, epsGaap: null, revenue: null, unit: null, notes: ['bad quarterEnd'] };

  for (const table of parseTables(html)) {
    // Table unit: stated in its non-data rows, else just above the table.
    const nonData: string[] = [];
    const hasEpsRow = table.rows.some((r) => /per (diluted |common |basic )?share|\beps\b|earnings per/i.test(r.find((c) => c.text)?.text ?? ''));
    let headers: Cell[][] = [];
    let lastWasData = false;
    let section = '';
    let titles: Cell[][] = []; // label-only rows since the last data row
    const rowsOut: Array<{ field: Field; nums: Num[]; headers: Cell[][]; label: string; section: string }> = [];

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
        if (/^(diluted|basic|assuming dilution)$/.test(label) && section) label = `${section} ${label}`;
        const field = REVENUE_LABELS.has(label) ? 'revenue' : epsField(label);
        const vals = nums.filter((n) => !n.pct);
        if (field && vals.length) rowsOut.push({ field, nums: vals, headers, label, section });
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
      if (lastWasData) headers = titles; // a new header block, with the titles just above it
      headers = [...headers, cells];
      lastWasData = false;
      section = '';
    }
    if (!rowsOut.length) continue;

    const inTable = units(nonData.join(' '));
    // Caption: the last sentence above the table ("… Reconciliation of Non-GAAP Measures (in millions)").
    const caption = table.before.split(/[.!?;]\s+(?=[A-Z0-9(])/).pop() ?? '';
    const near = units(table.before, CAPTION_RE);
    let unit: number | null = null;
    if (inTable.size === 1) unit = [...inTable][0]!;
    else if (inTable.size === 0 && near.size === 1) unit = [...near][0]!;

    for (const { field, nums, headers: hs, label, section: sec } of rowsOut) {
      const picked: Num[] = [];
      const blockText = hs.flat().map((c) => c.text).join(' ');
      const scope = blockScope(blockText);
      // Under a caption, header block or section that says non-GAAP / adjusted / reconciliation, a plain
      // "Diluted EPS" row may be the adjusted figure: GAAP only from rows or columns that say GAAP / reported.
      const adjContext = ADJ_CONTEXT.test(`${caption} ${blockText} ${sec}`);
      if (scope === 'ytd') continue;
      const labelCol = hs.map((row) => row.filter((c) => c.text && c.start === 0 && c.span === 1).map((c) => c.text).join(' ')).join(' ');
      for (const n of nums) {
        const over = hs.map((row) => row.filter((c) => c.text && c.start < n.end && c.start + c.span > n.start).map((c) => c.text).join(' ')).join(' ').trim();
        // A block that only speaks of the quarter may name it once, in the label column ("Q3", "Three Months Ended June 30, 2026").
        const head = scope === 'quarter' ? `${labelCol} ${over}`.trim() : over;
        if (!isQuarterColumn(head, qe) || ADJUSTMENT_COL.test(head)) continue;
        if (scope === 'mixed' && !QUARTER_PHRASE.test(head)) continue;
        let f: Field = field;
        const adjCol = /\b(adjusted|non[\s-]?gaap|core)\b/i.test(head);
        if (adjCol && f === 'epsGaap') f = 'epsAdjusted';
        if (!adjCol && f === 'epsAdjusted' && /\bgaap\b|as reported/i.test(head)) continue;
        if (f !== 'revenue' && (n.decimals < 2 || n.decimals > 3 || Math.abs(n.value) >= 1000)) continue;
        if (f === 'revenue' && (n.value <= 0 || n.decimals > 2)) continue;
        if (f === 'epsGaap' && adjContext && !EXPLICIT_GAAP.test(`${label} ${head}`)) continue;
        if (f !== field) { found[f].push({ value: n.value, unit: null }); continue; }
        picked.push(n);
      }
      if (!picked.length) continue;
      if (field === 'revenue') {
        if (!hasEpsRow) continue; // segment / KPI tables: no per-share line, not the income statement
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
  return {
    epsAdjusted: adj?.value ?? null,
    epsGaap: gaap?.value ?? null,
    revenue: rev ? Math.round(rev.value) : null,
    unit: rev?.unit ?? null,
    notes,
  };
}
