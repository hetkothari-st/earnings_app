/**
 * Quick reader for an Indian company's results PDF (the attachment of the NSE "Outcome of Board Meeting" /
 * "Financial Results" announcement). Reads basic EPS, revenue from operations (banks: total income) and
 * net profit for the quarter from the consolidated statement if there is one, else the standalone one.
 *
 * Text comes from pdfjs (legacy Node build, no worker). Items are grouped into lines by y and into cells by
 * x; a table is recognised by its header of column dates. Only the column whose header is a quarter ending
 * on `quarterEnd` is read; half year / nine months / year columns never are. When anything is unclear the
 * field is null: a blank is better than a wrong number.
 */
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface InPdfValues {
  basis: 'Consolidated' | 'Standalone' | null;
  eps: number | null;
  revenue: number | null;
  revenueKind: 'revenue-from-ops' | 'total-income' | null;
  profit: number | null;
  notes: string[];
}

interface Cell { text: string; x0: number; x1: number; y: number; h: number }
interface Line { y: number; cells: Cell[]; text: string }
interface Page { lines: Line[]; chars: number }

// ---------- text extraction ----------

interface RawItem { str: string; x: number; y: number; w: number; h: number; angle: number }

export async function extractPages(bytes: Uint8Array): Promise<Page[]> {
  const task = getDocument({
    data: bytes.slice(), // pdfjs takes ownership of the buffer it is given
    verbosity: 0, disableFontFace: true, useSystemFonts: false, stopAtErrors: false,
  });
  try {
    const doc = await task.promise;
    const pages: Page[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const raw: RawItem[] = [];
      for (const it of tc.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        const m = Util.transform(viewport.transform, it.transform) as number[];
        const angle = Math.round((Math.atan2(m[1]!, m[0]!) * 180) / Math.PI / 90) * 90;
        raw.push({ str: it.str, x: m[4]!, y: m[5]!, w: it.width, h: Math.hypot(m[2]!, m[3]!) || it.height, angle: ((angle % 360) + 360) % 360 });
      }
      pages.push(buildPage(raw));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** Keeps the page's dominant text direction, turned so that text runs left to right with y growing downward. */
function buildPage(raw: RawItem[]): Page {
  const count = new Map<number, number>();
  for (const r of raw) count.set(r.angle, (count.get(r.angle) ?? 0) + r.str.length);
  const angle = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const t = (angle * Math.PI) / 180;
  const cos = Math.round(Math.cos(t));
  const sin = Math.round(Math.sin(t));
  const items = raw.filter((r) => r.angle === angle).map((r) => ({
    ...r, x: r.x * cos + r.y * sin, y: -r.x * sin + r.y * cos,
  }));
  const chars = items.reduce((a, r) => a + r.str.trim().length, 0);

  // Split items that hold several values separated by wide gaps, giving each part an x by its share of characters.
  const parts: Cell[] = [];
  for (const it of items) {
    const s = it.str;
    const chunks: { text: string; at: number }[] = [];
    for (const m of s.matchAll(/\S+(?: (?! )\S+)*/g)) chunks.push({ text: m[0], at: m.index });
    const split: { text: string; at: number }[] = [];
    for (const c of chunks) {
      // Inside a chunk, split between two numbers separated by one space ("1,234.00 1,111.00").
      const words = [...c.text.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: c.at + m.index }));
      let cur = words[0]!;
      for (const w of words.slice(1)) {
        if (NUMERIC.test(lastWord(cur.text)) && NUMERIC.test(w.text)) { split.push(cur); cur = w; }
        else cur = { text: `${cur.text} ${w.text}`, at: cur.at };
      }
      split.push(cur);
    }
    const per = s.length ? it.w / s.length : 0;
    for (const c of split) parts.push({ text: c.text, x0: it.x + c.at * per, x1: it.x + (c.at + c.text.length) * per, y: it.y, h: it.h });
  }

  // Lines by y.
  parts.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const groups: Cell[][] = [];
  for (const c of parts) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(c.y - g[0]!.y) <= Math.max(2.5, 0.45 * Math.min(c.h || 8, g[0]!.h || 8))) g.push(c);
    else groups.push([c]);
  }
  const lines: Line[] = groups.map((g) => {
    g.sort((a, b) => a.x0 - b.x0);
    const cells: Cell[] = [];
    for (const c of g) {
      const prev = cells[cells.length - 1];
      const gap = prev ? c.x0 - prev.x1 : Infinity;
      const h = Math.min(prev?.h || 8, c.h || 8);
      const bothNum = prev && NUMERIC.test(lastWord(prev.text)) && NUMERIC.test(c.text.split(' ')[0]!);
      // "19 148.99": a thousands group set apart by a thin space belongs to the figure before it.
      const group = bothNum && /^\d{1,3}$/.test(prev.text) && /^\d{3}(?:\.\d+)?$/.test(c.text) && gap <= 0.7 * h;
      if (prev && (group || gap <= (bothNum ? 0.12 * h : 0.4 * h))) {
        prev.text = gap > 0.12 * h && !group ? `${prev.text} ${c.text}` : `${prev.text}${c.text}`;
        prev.x1 = Math.max(prev.x1, c.x1);
      } else cells.push({ ...c });
    }
    const y = g.reduce((a, c) => a + c.y, 0) / g.length;
    const split = cells.flatMap(splitDates);
    return { y, cells: split, text: split.map((c) => c.text).join(' ') };
  });
  return { lines, chars };
}

const NUMERIC = /^[(\-−–]?[\d,.]+\)?$/;
const DATE_START = /(?<![\d.\-\/])\d{1,2}(?:st|nd|rd|th)?[\s.\-\/,']*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?<![\d.\-\/])\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}(?!\d)/gi;

/** A header cell holding several dates ("30th September, 30th September,") becomes one cell per date. */
function splitDates(c: Cell): Cell[] {
  const starts = [...c.text.matchAll(DATE_START)].map((m) => m.index);
  if (starts.length < 2) return [c];
  // Only a cell of dates alone is split; words with them ("Quarter ended ... Half year ended ...") could end up
  // labelling the wrong date, so such a cell stays whole (and unreadable as a column).
  const rest = c.text.replace(/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/gi, '').replace(/\d+(?:st|nd|rd|th)?/gi, '');
  if (/[a-z]/i.test(rest)) return [c];
  const per = (c.x1 - c.x0) / c.text.length;
  const cuts = [0, ...starts.filter((s) => s > 0), c.text.length];
  const out: Cell[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const text = c.text.slice(cuts[i], cuts[i + 1]).trim();
    if (text) out.push({ ...c, text, x0: c.x0 + cuts[i]! * per, x1: c.x0 + cuts[i + 1]! * per });
  }
  return out;
}
const lastWord = (s: string) => s.slice(s.lastIndexOf(' ') + 1);

// ---------- numbers, dates, units ----------

/** "1,17,477.65" → 117477.65, "(3,046.24)" → -3046.24. Bad digit grouping (OCR damage) → null. */
export function parseAmount(raw: string): number | null {
  // Footnote marks around a figure ("* 2.46", "2.46#") are dropped; anything else odd makes it unreadable.
  let s = raw.trim().replace(/^[*•#^]+\s*/, '').replace(/\s*[*#^]+$/, '');
  if (/\s/.test(s.replace(/^\(\s+|\s+\)$/g, ''))) return null; // "2 51": a split or misread figure
  s = s.replace(/\s+/g, '').replace(/[−–]/g, '-');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d[\d,]*(\.\d+)?$/.test(s)) return null;
  const [int] = s.split('.');
  if (int!.includes(',')) {
    const groups = int!.split(',');
    if (groups[groups.length - 1]!.length !== 3) return null;
    if (groups.slice(1, -1).some((g) => g.length !== 2 && g.length !== 3)) return null;
    if (groups[0]!.length > 3) return null;
  }
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(?<![a-z])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const SEP = "[\\s.,\\-\\/']*";
/** A year after a month: four digits, or two after "-", "/" or "'" ("30-Sep-26"); never "30 September 30". */
const YEAR = "(?:[\\s.,\\-\\/']*(\\d{4})|\\s?[\\-\\/']\\s?(\\d{2}))(?!\\d)";
const yr = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** A date in a header cell: full ('YYYY-MM-DD'), day and month only, or null. */
export function parseDateCell(text: string): { d: number; m: number; y: number | null } | null {
  const s = text.toLowerCase().replace(/\s+/g, ' ').replace(/(\d)\s?(st|nd|rd|th)(?=[\sa-z.,\-\/']|$)/g, '$1');
  let m = s.match(/(?<![\d.])(\d{1,2})\s?[.\-\/]\s?(\d{1,2})\s?[.\-\/]\s?(\d{4}|\d{2})(?!\d)/);
  if (m) return valid(Number(m[1]), Number(m[2]), yr(m[3]!));
  m = s.match(new RegExp(`(?<!\\d)(\\d{1,2})${SEP}${MON}${YEAR}`));
  if (m) return valid(Number(m[1]), MONTHS.indexOf(m[2]!) + 1, yr((m[3] ?? m[4])!));
  m = s.match(new RegExp(`${MON}${SEP}(\\d{1,2})(?!\\d)(?:${YEAR})?`));
  if (m) return valid(Number(m[2]), MONTHS.indexOf(m[1]!) + 1, m[3] ?? m[4] ? yr((m[3] ?? m[4])!) : null);
  m = s.match(new RegExp(`(?<!\\d)(\\d{1,2})${SEP}${MON}[.,'\\s]*$`));
  if (m) return valid(Number(m[1]), MONTHS.indexOf(m[2]!) + 1, null);
  return null;
}
function valid(d: number, m: number, y: number | null) {
  if (d < 1 || d > 31 || m < 1 || m > 12) return null;
  if (y !== null && (y < 2000 || y > 2100)) return null;
  return { d, m, y };
}

const UNIT_SCALE = { crore: 1e7, lakh: 1e5, million: 1e6, thousand: 1e3 } as const;
type Unit = keyof typeof UNIT_SCALE;

/** The unit a table states ("(₹ in crore)", "Rs. in Lakhs", "(Amount in Rs million)", "(₹ '000)"). */
export function unitOf(line: string): Unit | null {
  const s = line.toLowerCase();
  const m = s.match(/(?:in|rs\.?|inr|rupees|₹)\s*(?:\S{1,3}\s+)?(cror|cr\b|lakh|lac|million|mn\b|thousand)/)
    ?? s.match(/(?:in|rs\.?|inr|₹)\s*'000/)
    // A short line that is only the unit, its rupee sign misread ("₹ lakhs" as "flakhs").
    ?? s.trim().match(/^\(?\W{0,2}\w?\W{0,2}\s*(cror|lakh|lac|million)[a-z]*\W{0,2}\)?$/);
  if (!m) return null;
  const u = m[1] ?? 'thousand';
  if (u.startsWith('cr')) return 'crore';
  if (u.startsWith('la')) return 'lakh';
  if (u.startsWith('m')) return 'million';
  return 'thousand';
}

// ---------- tables ----------

type ColType = 'Q' | 'H' | 'N' | 'Y' | 'P';

function colType(text: string): ColType | null {
  const s = text.toLowerCase();
  if (/year\s*to\s*date|ytd|half|six\s*months|6\s*months|nine|9\s*months|cumulative|period\s*(ended|from)/.test(s)) return 'H';
  if (/[qo]uarter|three\s*months|3\s*months/.test(s)) return 'Q';
  if (/year|twelve|12\s*months/.test(s)) return 'Y';
  return null;
}

interface Column { x0: number; x1: number; date: string | null; type: ColType | null; basis: 'Consolidated' | 'Standalone' | null }
interface Header { y: number; columns: Column[]; spacing: number }

const center = (c: { x0: number; x1: number }) => (c.x0 + c.x1) / 2;
const iso = (d: { d: number; m: number; y: number }) =>
  `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;

type DateCell = Cell & { date: string; line: number };
const fullDate = (text: string): string | null => {
  const d = parseDateCell(text);
  return d && d.y !== null ? iso(d as { d: number; m: number; y: number }) : null;
};
const isShort = (c: Cell) => c.text.replace(/\s+/g, '').length <= 34; // longer is a sentence, not a header cell

/**
 * Every column date on the page. A date may be one cell ("30.09.2026"), several cells on a line ("30," "2026")
 * or stacked cells ("September" over "30, 2026"; "30th September," over "2026").
 */
const dateCache = new WeakMap<Page, DateCell[]>();
function pageDates(page: Page): DateCell[] {
  const hit = dateCache.get(page);
  if (hit) return hit;
  const out: DateCell[] = [];
  const frags: { cell: Cell; line: number }[] = [];
  page.lines.forEach((line, li) => {
    const cells = line.cells.filter(isShort);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const d = fullDate(c.text);
      if (d) { out.push({ ...c, date: d, line: li }); continue; }
      // Join with the next cells on the line while they are close.
      let merged: Cell = c;
      let found = false;
      for (let j = i + 1; j < Math.min(cells.length, i + 4); j++) {
        const n = cells[j]!;
        if (n.x0 - merged.x1 > Math.max(3, 0.9 * (n.h || 8))) break;
        merged = { ...merged, text: `${merged.text} ${n.text}`, x1: n.x1 };
        const md = fullDate(merged.text);
        if (md) { out.push({ ...merged, date: md, line: li }); i = j; found = true; break; }
      }
      if (!found && /\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(c.text)) frags.push({ cell: c, line: li });
    }
  });
  // Stacked: a fragment and the fragments right below it that overlap it.
  for (const f of frags) {
    const below = frags.filter((g) => g.line > f.line && g.cell.y - f.cell.y > 0 && g.cell.y - f.cell.y <= 18
      && g.cell.x1 >= f.cell.x0 - 1 && g.cell.x0 <= f.cell.x1 + 1);
    if (!below.length) continue;
    const nextLine = Math.min(...below.map((g) => g.line));
    const parts = below.filter((g) => g.line === nextLine).sort((a, b) => a.cell.x0 - b.cell.x0);
    const text = `${f.cell.text} ${parts.map((g) => g.cell.text).join(' ')}`;
    const d = fullDate(text);
    if (!d) continue;
    const lower = parts[parts.length - 1]!.cell;
    out.push({ text, x0: Math.min(f.cell.x0, ...parts.map((g) => g.cell.x0)), x1: Math.max(f.cell.x1, ...parts.map((g) => g.cell.x1)),
      y: lower.y, h: lower.h, date: d, line: nextLine });
  }
  dateCache.set(page, out);
  return out;
}

/** The header (row of column dates) nearest above line index `li` on the page, or null. */
function headerAbove(page: Page, li: number): Header | null {
  const y0 = page.lines[li]!.y;
  const dated = pageDates(page).filter((c) => c.line < li && y0 - c.y <= 1200);
  if (dated.length < 2) return null;
  const nearest = Math.max(...dated.map((c) => c.y));
  const band = dated.filter((c) => nearest - c.y <= 30).sort((a, b) => a.x0 - b.x0);
  // One column per x position; a column with two dates ("01 January 2025 to" / "31 March 2026") keeps neither.
  const cols: Column[] = [];
  for (const c of band) {
    const prev = cols[cols.length - 1];
    if (prev && c.x0 < prev.x1 - 1) { prev.date = prev.date === c.date ? prev.date : null; prev.x1 = Math.max(prev.x1, c.x1); continue; }
    cols.push({ x0: c.x0, x1: c.x1, date: c.date, type: colType(c.text), basis: null });
  }
  if (cols.length < 2) return null;
  const spacing = Math.min(...cols.slice(1).map((c, i) => center(c) - center(cols[i]!)));
  if (!(spacing > 4)) return null;
  const top = Math.min(...band.map((c) => c.y));
  const left = cols[0]!.x0 - spacing;
  const right = cols[cols.length - 1]!.x1 + spacing;

  // Column kinds and bases from the labels around the dates ("Quarter ended", "Half year ended", "Consolidated").
  const typed: { x: number; type: ColType }[] = [];
  const based: { x: number; basis: 'Consolidated' | 'Standalone' }[] = [];
  for (const line of page.lines) {
    if (line.y < top - 70 || line.y > nearest + 20 || line.y >= y0) continue;
    for (const c of line.cells) {
      if (c.x1 < left || c.x0 > right) continue;
      const t = colType(c.text);
      if (t && c.text.length <= 60 && !/result|statement|financial/i.test(c.text) && !(/quarter|three months/i.test(c.text) && /half|six months|nine/i.test(c.text))) typed.push({ x: center(c), type: t });
      const s = c.text.toLowerCase();
      if (c.text.length <= 30 && /^\W*(standalone|consolidated)\b/.test(s)) {
        based.push({ x: center(c), basis: s.includes('consolidated') ? 'Consolidated' : 'Standalone' });
      }
    }
  }
  for (const col of cols) {
    if (!col.type) col.type = nearestOf(typed, center(col))?.type ?? null;
    col.basis = nearestOf(based, center(col))?.basis ?? null;
  }
  return { y: nearest, columns: cols, spacing };
}

/** The entry nearest to x; null when two different ones are equally near. */
function nearestOf<T extends { x: number }>(list: T[], x: number): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  let tie = false;
  for (const e of list) {
    const d = Math.abs(e.x - x);
    if (d < bestD - 0.5) { best = e; bestD = d; tie = false; }
    else if (Math.abs(d - bestD) <= 0.5 && JSON.stringify({ ...e, x: 0 }) !== JSON.stringify({ ...best, x: 0 })) tie = true;
  }
  return tie ? null : best;
}

/** The basis stated in the nearest heading above the header on the page. */
function headingBasis(page: Page, headerY: number): 'Consolidated' | 'Standalone' | null {
  for (let i = page.lines.length - 1; i >= 0; i--) {
    const line = page.lines[i]!;
    if (line.y >= headerY) continue;
    const s = line.text.toLowerCase();
    const cons = /consolidated/.test(s);
    const stand = /standalone|stand-alone/.test(s);
    if (cons !== stand) return cons ? 'Consolidated' : 'Standalone';
  }
  return null;
}

/** The unit stated nearest above (or in) the header. */
function tableUnit(page: Page, headerY: number): Unit | null {
  let best: { u: Unit; d: number } | null = null;
  for (const line of page.lines) {
    if (line.y > headerY + 20 || headerY - line.y > 160) continue;
    if (line.text.length > 160) continue;
    const u = unitOf(line.text);
    if (!u) continue;
    const d = Math.abs(headerY - line.y);
    if (!best || d < best.d) best = { u, d };
  }
  return best?.u ?? null;
}

// ---------- rows ----------

type Field = 'revenue' | 'incomeFromOps' | 'totalIncome' | 'profit' | 'eps';

const strip = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')
  .replace(/^(?:\(?(?:[ivx]+|\d{1,2}|[a-h])[).:]?\s+|\(?[a-h]\)\s*|\d{1,2}\.\s*)+/, '').trim();

function rowField(label: string): { field: Field; total: boolean } | null {
  const s = strip(label);
  if (!s) return null;
  // "Income from operations" (older label) counts only where no "Revenue from operations" row exists.
  if (/^income from operations/.test(s) && s.length < 40) return { field: 'incomeFromOps', total: false };
  if (/revenue\s?from\s?opera/.test(s) && !/segment|other|exclud|net of|per share/.test(s) && s.length < 70) {
    return { field: 'revenue', total: /^total/.test(s) };
  }
  if (/^total income\b/.test(s) && !/comprehensive|expense|tax/.test(s)) return { field: 'totalIncome', total: true };
  if (/^(net )?profit|^\(?net\)? ?profit|^profit/.test(s) && /(for the (period|quarter)|after tax|\bpat\b)/.test(s)
    && !/before|continuing|discontinued|attributable|comprehensive|owners|non[- ]?controlling|minority|^share|other/.test(s.replace(/\(after [^)]*\)/g, ''))) {
    return { field: 'profit', total: false };
  }
  if (/\bbasic\b/.test(s) && !/weighted|number of|no\. of/.test(s)) return { field: 'eps', total: false };
  return null;
}

interface Table {
  basis: 'Consolidated' | 'Standalone' | null;
  unit: Unit | null;
  /** The current-quarter column, or null when there is not exactly one. */
  col: Column | null;
  values: Partial<Record<Field, number[]>>;
  totals: Partial<Record<Field, number[]>>;
  bank: boolean;
}

/** Reads every table on every page for the quarter column. */
function readTables(pages: Page[], quarterEnd: string, docBasis: 'Standalone' | null, notes: string[]): Table[] {
  const tables: Table[] = [];
  pages.forEach((page, p) => {
    const byHeader = new Map<number, Table>();
    page.lines.forEach((line, li) => {
      // The label is the text left of the figures.
      const hdr = headerAbove(page, li);
      if (!hdr) return;
      const firstCenter = center(hdr.columns[0]!);
      const labelEdge = firstCenter - 0.6 * hdr.spacing;
      const label = line.cells.filter((c) => c.x1 <= labelEdge + 2).map((c) => c.text).join(' ');
      let table = byHeader.get(hdr.y);
      const isBankRow = /interest earned/i.test(label);
      if (table && isBankRow) table.bank = true;
      const f = rowField(label);
      if (!f) return;
      if (!table) {
        const cand = hdr.columns.filter((c) => c.date === quarterEnd && c.type === 'Q');
        let col: Column | null = null;
        if (cand.length === 1) col = cand[0]!;
        else if (cand.length > 1) {
          const cons = cand.filter((c) => c.basis === 'Consolidated');
          col = cons.length === 1 ? cons[0]! : null;
        }
        const basis = col?.basis ?? headingBasis(page, hdr.y) ?? docBasis;
        table = { basis, unit: tableUnit(page, hdr.y), col, values: {}, totals: {}, bank: isBankRow };
        byHeader.set(hdr.y, table);
        tables.push(table);
        if (!col) notes.push(`p${p + 1}: no single quarter column for ${quarterEnd}`);
      }
      if (!table.col) return;
      const v = valueAt(page, li, hdr, table.col, labelEdge);
      if (v === undefined) return;
      const into = f.total ? table.totals : table.values;
      (into[f.field] ??= []).push(v);
    });
    // A bank table may name "Interest earned" before the header is reached; check the page text too.
    for (const t of byHeader.values()) if (!t.bank && page.lines.some((l) => /^\W*(?:\d+\.?\s*|\(?[a-z]\)\s*)?interest earned/i.test(l.text))) t.bank = true;
  });
  return tables;
}

/**
 * The figure in column `col` on line `li` (or on the next line when the label line has no figures at all).
 * undefined = nothing there; null is never returned (unreadable values are skipped).
 */
function valueAt(page: Page, li: number, hdr: Header, col: Column, labelEdge: number): number | undefined {
  const pick = (line: Line): number | undefined | 'none' => {
    const nums = line.cells.filter((c) => center(c) > labelEdge);
    if (nums.length === 0) return 'none';
    const target = center(col);
    const inCol = nums.filter((c) => {
      const cx = center(c);
      const nearest = hdr.columns.reduce((a, b) => (Math.abs(center(b) - cx) < Math.abs(center(a) - cx) ? b : a));
      return Math.abs(center(nearest) - target) < 1 && Math.abs(cx - target) <= 0.6 * hdr.spacing + (c.x1 - c.x0) / 2;
    });
    if (inCol.length !== 1) return undefined;
    const cell = inCol[0]!;
    const v = parseAmount(cell.text);
    if (v === null) return undefined;
    // The figure must be written like another one on its row: "3.398" among "3,727.01"-style figures is a
    // misread "3,398", not 3.398.
    const others = nums.filter((c) => c !== cell && parseAmount(c.text) !== null);
    if (!others.some((o) => decimals(o.text) === decimals(cell.text))) return undefined;
    return v;
  };
  const here = pick(page.lines[li]!);
  if (here !== 'none') return here;
  const next = page.lines[li + 1];
  if (next && next.y - page.lines[li]!.y <= 10 && next.cells.every((c) => center(c) > labelEdge)) {
    const v = pick(next);
    return v === 'none' ? undefined : v;
  }
  return undefined;
}

const decimals = (t: string) => /\.(\d+)\)?\W*$/.exec(t.trim())?.[1]!.length ?? 0;

/** One value when all readings agree, else null. */
function agreed(list: number[] | undefined): number | null {
  if (!list?.length) return null;
  return list.every((v) => Math.abs(v - list[0]!) < 1e-9) ? list[0]! : null;
}

// ---------- download ----------

const PDF_HOST = 'https://nsearchives.nseindia.com/';
const MAX_PDF_BYTES = 40_000_000;

/**
 * The bytes of a results PDF linked from an NSE announcement. Only nsearchives is fetched. Anything that
 * is not a PDF (an HTML block page, an error page) is refused, so it never reaches the reader.
 */
export async function fetchResultsPdf(link: string, userAgent: string): Promise<Uint8Array> {
  // The feed sometimes drops the path: "https://nsearchives.nseindia.comRAJRATAN_..._UFR.PDF".
  const url = /^https:\/\/nsearchives\.nseindia\.com[A-Za-z0-9]/.test(link)
    ? link.replace('https://nsearchives.nseindia.com', `${PDF_HOST}corporate/`) : link;
  if (!url.startsWith(PDF_HOST)) throw new Error(`results PDF: host not allowed: ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`results PDF: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_PDF_BYTES) throw new Error(`results PDF: too large (${declared} bytes)`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES) throw new Error(`results PDF: too large (${bytes.length} bytes)`);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== '%PDF') throw new Error('results PDF: not a PDF');
  return bytes;
}

// ---------- entry point ----------

export async function readInResultsPdf(bytes: Uint8Array, quarterEnd: string): Promise<InPdfValues> {
  const out: InPdfValues = { basis: null, eps: null, revenue: null, revenueKind: null, profit: null, notes: [] };
  let pages: Page[];
  try {
    pages = await extractPages(bytes);
  } catch (err) {
    out.notes.push(`unreadable PDF: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  const chars = pages.reduce((a, p) => a + p.chars, 0);
  if (pages.length === 0 || chars < 20 * pages.length) {
    out.notes.push('no text layer');
    return out;
  }
  // A document that never speaks of consolidated results has only standalone ones.
  const mentionsCons = pages.some((p) => p.lines.some((l) => /consolidated/i.test(l.text)));
  const tables = readTables(pages, quarterEnd, mentionsCons ? null : 'Standalone', out.notes);

  const withValues = (b: 'Consolidated' | 'Standalone') =>
    tables.filter((t) => t.basis === b && (t.values.eps || t.values.profit || t.values.revenue || t.totals.revenue || t.values.incomeFromOps || t.values.totalIncome || t.totals.totalIncome));
  const cons = withValues('Consolidated');
  const basis = cons.length ? 'Consolidated' : withValues('Standalone').length ? 'Standalone' : null;
  if (!basis) {
    out.notes.push('no results table with a quarter column');
    return out;
  }
  // Consolidated results exist but could not be read (often scanned pages): standalone figures would be the wrong basis.
  const consResults = /consolidated\s+(?:un-?audited\s+|audited\s+|reviewed\s+)?(?:financial\s+)?(?:results|statement)|statement\s+of\s+(?:un-?audited\s+|audited\s+)?consolidated/i;
  if (basis === 'Standalone' && pages.some((p) => p.lines.some((l) => consResults.test(l.text)))) {
    out.notes.push('consolidated results present but not read');
    return out;
  }
  out.basis = basis;
  const list = withValues(basis);
  // A table continued on a page without its unit line takes the document's unit, if the document states only one.
  const units = new Set(pages.flatMap((p) => p.lines.filter((l) => l.text.length <= 160).map((l) => unitOf(l.text)).filter((u) => u)));
  const docUnit = units.size === 1 ? [...units][0]! : null;
  const unitFor = (t: Table) => t.unit ?? docUnit;

  // Each field from the first table (in document order) that has it.
  const first = (fn: (t: Table) => number | null | undefined): { v: number; t: Table } | null => {
    for (const t of list) {
      const v = fn(t);
      if (v != null) return { v, t };
    }
    return null;
  };
  const eps = first((t) => agreed(t.values.eps));
  if (eps && Math.abs(eps.v) < 1e5) out.eps = eps.v;

  const bank = list.some((t) => t.bank);
  const rev = bank
    ? first((t) => agreed(t.totals.totalIncome ?? t.values.totalIncome))
    : first((t) => (t.totals.revenue?.length ? agreed(t.totals.revenue)
      : t.values.revenue?.length ? agreed(t.values.revenue) : agreed(t.values.incomeFromOps)));
  if (rev) {
    const unit = unitFor(rev.t);
    if (unit) {
      out.revenue = round(rev.v * UNIT_SCALE[unit]);
      out.revenueKind = bank ? 'total-income' : 'revenue-from-ops';
    } else out.notes.push('revenue: no unit');
  }
  const profit = first((t) => agreed(t.values.profit));
  if (profit) {
    const unit = unitFor(profit.t);
    if (unit) out.profit = round(profit.v * UNIT_SCALE[unit]);
    else out.notes.push('profit: no unit');
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
