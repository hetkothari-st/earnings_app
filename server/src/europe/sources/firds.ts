/**
 * ESMA and FCA FIRDS: the weekly equity full set (FULINS_E) as the share universe (Ruling 4).
 *
 * As verified live on 2026-10-28 (Task 1, see `europe/exchanges.ts`): the ESMA solr index and the FCA index list
 * FULINS_E_YYYYMMDD_NNofMM.zip parts (ESMA 2 parts, 8.3 + 3.9 MB zipped; FCA 1 part, 41.9 MB zipped / 0.9 GB of XML).
 * Each part is downloaded whole (small enough to hold zipped) and its XML is streamed through `streamZipEntryText`,
 * record by record: only complete `<RefData>` blocks are read. Every block holds exactly one venue
 * (`TradgVnRltdAttrbts`), so a share on two venues is two records with one ISIN.
 */

import { streamZipEntryText } from '../../sources/zip.js';
import { makeHttp, type Http } from '../../sources/http.js';
import { UNIVERSE_URLS } from '../exchanges.js';
import { EUROPE_UA } from './sourceUrls.js';

export interface FirdsShare {
  isin: string;
  fullName: string;
  cfi: string;
  lei: string | null;
  mic: string;
  issuerRequested: boolean;
  /** The venue's termination date (`TermntnDt`) is in the past. */
  terminated: boolean;
}

/** FIRDS needs the zipped parts as bytes; the index answers are JSON. */
export interface FirdsHttp extends Http {
  bytes(url: string): Promise<Uint8Array>;
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const LEI_RE = /^[A-Z0-9]{20}$/;
const OPEN = '<RefData>';
const CLOSE = '</RefData>';
/** Hosts a download link may point to (the plan's FIRDS hosts). */
const PART_HOSTS = new Set(['firds.esma.europa.eu', 'data.fca.org.uk']);

const decodeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-fA-F]+|#[0-9]+);/g, (m, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'amp') return '&';
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

const section = (block: string, name: string): string | null => {
  const a = block.indexOf(`<${name}>`);
  if (a < 0) return null;
  const b = block.indexOf(`</${name}>`, a);
  return b < 0 ? null : block.slice(a + name.length + 2, b);
};

const tag = (block: string, name: string): string | null => {
  const v = section(block, name);
  return v == null ? null : v.trim();
};

function parseBlock(block: string, now: number): FirdsShare | null {
  // Cheap filter first: most of the 1.6 M records are not shares.
  if (!block.includes('<ClssfctnTp>ES')) return null;
  const gnl = section(block, 'FinInstrmGnlAttrbts');
  const venue = section(block, 'TradgVnRltdAttrbts');
  if (gnl == null || venue == null) return null;
  const isin = tag(gnl, 'Id');
  const cfi = tag(gnl, 'ClssfctnTp');
  const mic = tag(venue, 'Id');
  if (!isin || !ISIN_RE.test(isin) || !cfi?.startsWith('ES') || !mic) return null;
  const lei = tag(block, 'Issr');
  const end = tag(venue, 'TermntnDt');
  const endMs = end ? Date.parse(end) : NaN;
  return {
    isin,
    fullName: decodeXml(tag(gnl, 'FullNm') ?? ''),
    cfi,
    lei: lei && LEI_RE.test(lei) ? lei : null,
    mic,
    issuerRequested: tag(venue, 'IssrReq') === 'true',
    terminated: Number.isFinite(endMs) && endMs <= now,
  };
}

/**
 * Calls `onBlock` for each complete `<RefData>…</RefData>` block in `text` and returns the index after the last
 * complete one. A block whose closing tag is missing, or that another `<RefData>` opens inside (a cut record), is
 * skipped.
 */
function scanRecords(text: string, onBlock: (block: string) => void): number {
  let consumed = 0;
  let i = text.indexOf(OPEN);
  while (i >= 0) {
    const end = text.indexOf(CLOSE, i);
    if (end < 0) break;
    const start = text.lastIndexOf(OPEN, end);
    onBlock(text.slice(start + OPEN.length, end));
    consumed = end + CLOSE.length;
    i = text.indexOf(OPEN, consumed);
  }
  return consumed;
}

/** The share records (CFI `ES*`) among the complete `<RefData>` blocks of `xml`. `now` decides `terminated`. */
export function parseFirdsRecords(xml: string, now: number = Date.now()): FirdsShare[] {
  const out: FirdsShare[] = [];
  scanRecords(xml, (b) => {
    const s = parseBlock(b, now);
    if (s) out.push(s);
  });
  return out;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface IndexFile {
  name: string;
  link: string;
}

/** One page of the index: the files on it and the total count. */
function readIndexPage(source: 'esma' | 'fca', json: unknown): { files: IndexFile[]; total: number } {
  const files: IndexFile[] = [];
  if (source === 'esma') {
    const r = (json as { response?: { numFound?: unknown; docs?: unknown } } | null)?.response;
    const docs = Array.isArray(r?.docs) ? (r.docs as Record<string, unknown>[]) : [];
    for (const d of docs) if (typeof d?.file_name === 'string' && typeof d.download_link === 'string') files.push({ name: d.file_name, link: d.download_link });
    return { files, total: typeof r?.numFound === 'number' ? r.numFound : 0 };
  }
  const h = (json as { hits?: { total?: unknown; hits?: unknown } } | null)?.hits;
  const hits = Array.isArray(h?.hits) ? (h.hits as { _source?: Record<string, unknown> }[]) : [];
  for (const x of hits) {
    const s = x?._source;
    if (typeof s?.file_name === 'string' && typeof s.download_link === 'string') files.push({ name: s.file_name, link: s.download_link });
  }
  const total = typeof h?.total === 'number' ? h.total : typeof (h?.total as { value?: unknown })?.value === 'number' ? (h!.total as { value: number }).value : 0;
  return { files, total };
}

const PAGE = 100;
const MAX_PAGES = 10;

function indexUrl(source: 'esma' | 'fca', from: string, to: string, offset: number): string {
  if (source === 'esma') {
    const fq = encodeURIComponent(`publication_date:[${from}T00:00:00Z TO ${to}T23:59:59Z]`);
    return `${UNIVERSE_URLS.esmaIndex}?q=*&fq=${fq}&wt=json&rows=${PAGE}&start=${offset}`;
  }
  const q = encodeURIComponent(`((file_type:FULINS) AND (publication_date:[${from} TO ${to}]))`);
  return `${UNIVERSE_URLS.fcaIndex}?q=${q}&from=${offset}&size=${PAGE}`;
}

/**
 * Reads the latest weekly equity full set: index (last 14 days) → each FULINS_E part of the newest date → streamed
 * records → `onShare` for every share record whose MIC is in `mics` (terminated ones included; the build drops them).
 * `complete` is false when a part is missing from the index, a part fails, or a part ends inside a record; the
 * caller then changes nothing (Ruling 4: a failed refresh changes nothing). An index failure throws.
 */
export async function fetchFirdsShares(
  http: FirdsHttp,
  source: 'esma' | 'fca',
  mics: ReadonlySet<string>,
  onShare: (s: FirdsShare) => void,
  o: { now?: () => number } = {},
): Promise<{ files: number; complete: boolean }> {
  const now = (o.now ?? Date.now)();
  const from = ymd(now - 14 * 86_400_000);
  const to = ymd(now);

  const parts = new Map<string, Map<number, { link: string; of: number }>>();
  for (let page = 0, offset = 0; page < MAX_PAGES; page++, offset += PAGE) {
    const { files, total } = readIndexPage(source, await http.json(indexUrl(source, from, to, offset)));
    for (const f of files) {
      const m = /^FULINS_E_(\d{8})_(\d{2})of(\d{2})\.zip$/.exec(f.name);
      if (!m) continue;
      const byPart = parts.get(m[1]!) ?? new Map<number, { link: string; of: number }>();
      byPart.set(Number(m[2]), { link: f.link, of: Number(m[3]) });
      parts.set(m[1]!, byPart);
    }
    if (files.length === 0 || offset + PAGE >= total) break;
  }
  const latest = [...parts.keys()].sort().at(-1);
  if (!latest) return { files: 0, complete: false };

  const set = parts.get(latest)!;
  const of = Math.max(...[...set.values()].map((p) => p.of));
  let complete = set.size === of && [...set.keys()].every((n) => n >= 1 && n <= of);
  let files = 0;
  for (const n of [...set.keys()].sort((a, b) => a - b)) {
    const { link } = set.get(n)!;
    try {
      if (!PART_HOSTS.has(new URL(link).hostname)) throw new Error(`FIRDS part on an unexpected host: ${link}`);
      const zip = await http.bytes(link);
      let rest = '';
      for await (const chunk of streamZipEntryText(zip, (name) => name.toLowerCase().endsWith('.xml'))) {
        const text = rest + chunk;
        const used = scanRecords(text, (b) => {
          const s = parseBlock(b, now);
          if (s && mics.has(s.mic)) onShare(s);
        });
        // Keep from the last unfinished record on (or the tail, which may hold a split `<RefData>` tag).
        const open = text.indexOf(OPEN, used);
        rest = open >= 0 ? text.slice(open) : text.slice(Math.max(used, text.length - OPEN.length));
      }
      if (rest.includes(OPEN)) complete = false; // the part ended inside a record
      files++;
    } catch (err) {
      console.warn(`firds ${source}: part ${n} of ${latest} failed: ${(err as Error).message}`);
      complete = false;
    }
  }
  return { files, complete };
}

/** FIRDS client: JSON index through `makeHttp` and part downloads, both with EUROPE_UA and one shared 1 s gap. */
export function makeFirdsHttp(o: { fetchImpl?: typeof fetch; minIntervalMs?: number } = {}): FirdsHttp {
  const fetchImpl = o.fetchImpl ?? fetch;
  const gap = o.minIntervalMs ?? 1_000;
  let next = 0;
  const limiter = {
    async wait() {
      const t = Date.now();
      const slot = Math.max(t, next);
      next = slot + gap;
      if (slot > t) await new Promise<void>((r) => setTimeout(r, slot - t));
    },
  };
  const headers = { 'User-Agent': EUROPE_UA };
  const http = makeHttp({ headers, minIntervalMs: gap, limiter, fetchImpl });
  return {
    ...http,
    async bytes(url) {
      await limiter.wait();
      const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
