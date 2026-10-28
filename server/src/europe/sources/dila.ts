import { DateTime } from 'luxon';
import { SourceFormatError } from '../../sources/http.js';
import { untarEntries, untarStream } from '../../sources/tar.js';
import { DILA_RESULTS_TYPES } from './sourceUrls.js';

/**
 * The DILA AMF regulated-information flow (DILA_BASE, see sourceUrls.ts): one amf-gz_DDMMYYYY_HHMM.tar.gz per
 * publication batch, each holding xml/<DIF>/<YYYY>/<MM>/MD*.xml records and the pdf/ documents they describe.
 * Only the xml/ records are read; pdf/ entries are skipped unbuffered. Use `parseDilaArchiveStream` on a download:
 * a results-season batch is 200-660 MB of gzip.
 *
 * `filedAt` is INF_DAT_EMT, the AMF filing time. It is not the issuer's release time and never sets timing.
 */
export interface DilaDoc {
  id: string;             // the record file name, e.g. MDMKW111969_20260331
  isin: string | null;
  issuer: string;         // ISO_NOM_SOC as filed
  type: string;           // INF_STP_PRI, e.g. 001007
  subtype: string | null; // the first INF_STP_INF that differs from `type`
  filedAt: string;        // ISO UTC
  title: string;
  url: string | null;     // no public document URL is verified: the PDF exists only inside the archive
}

/** The batch archives published on `day` (YYYY-MM-DD, the French date in the file name), oldest first. */
export function listDilaFiles(html: string, day: string): string[] {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const stamp = `${m[3]}${m[2]}${m[1]}`;
  const files = new Set<string>();
  // Relative, ./, /OPENDATA/AMF/ or absolute on the DILA host; a link to any other host is ignored.
  const href = /href="(?:https:\/\/echanges\.dila\.gouv\.fr\/OPENDATA\/AMF\/|\/OPENDATA\/AMF\/|\.\/)?(amf-gz_(\d{8})_(\d{4})\.tar\.gz)"/g;
  for (const a of html.matchAll(href)) {
    if (a[2] === stamp) files.add(a[1]!);
  }
  return [...files].sort(); // same day, so HHMM order
}

const isRecord = (name: string): boolean => name.startsWith('xml/') && name.endsWith('.xml');

/** Records skipped in a batch: not an AMF record, or no type or filing time. */
export interface DilaParseStats { skipped: number }

/**
 * Every record in a batch archive (whole buffer), deduplicated. A bad record is skipped and counted in `stats`;
 * only a batch whose records all fail throws `SourceFormatError`.
 */
export function parseDilaArchive(buf: Uint8Array, stats?: DilaParseStats): DilaDoc[] {
  return fromEntries(untarEntries(buf, isRecord), stats);
}

/** Every record in a batch archive read as a stream (a fetch body), deduplicated. As `parseDilaArchive`. */
export async function parseDilaArchiveStream(source: AsyncIterable<Uint8Array>, stats?: DilaParseStats): Promise<DilaDoc[]> {
  return fromEntries(await untarStream(source, isRecord), stats);
}

/** A results publication, by its primary type (DILA_RESULTS_TYPES). Titles never decide it. */
export function isDilaResults(d: DilaDoc): boolean {
  return DILA_RESULTS_TYPES.includes(d.type);
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]!).replace(/\s+/g, ' ').trim() : null;
}

interface Parsed extends DilaDoc { lang: string }

/** One MD*.xml record, or null when it is not an AMF record or lacks a type or a valid filing time. */
function parseRecord(name: string, xml: string): Parsed | null {
  if (!xml.includes('<UniteInformation')) return null;
  const soc = xml.match(/<identificationSociete\b[^>]*>/)?.[0] ?? '';
  const inf = xml.match(/<InformationDeposee\b[^>]*>/)?.[0] ?? '';
  const type = attr(inf, 'INF_STP_PRI');
  // INF_DAT_EMT carries an offset; one without is French local time, never the machine's zone.
  const at = DateTime.fromISO(attr(inf, 'INF_DAT_EMT') ?? '', { zone: 'Europe/Paris' });
  if (!type || !at.isValid) return null;
  const isinRaw = (attr(soc, 'ISO_CD_ISI') ?? '').toUpperCase();
  const subtypes = [...xml.matchAll(/<INF_STP_INF>\s*([^<\s]+)\s*<\/INF_STP_INF>/g)].map((x) => x[1]!);
  return {
    id: name.split('/').pop()!.replace(/\.xml$/, ''),
    isin: ISIN.test(isinRaw) ? isinRaw : null,
    issuer: attr(soc, 'ISO_NOM_SOC') ?? '',
    type,
    subtype: subtypes.find((s) => s !== type) ?? null,
    filedAt: at.toUTC().toISO()!,
    title: attr(inf, 'INF_TIT_INF') ?? '',
    url: null,
    lang: (attr(inf, 'INF_LNG_INF') ?? '').toUpperCase(),
  };
}

/**
 * One filing often comes twice (FR and EN, or twice in one batch): keep one per ISIN (else issuer) + type +
 * filing time, the English one when there is one. Sorted by filing time, then id.
 */
function fromEntries(entries: Map<string, Uint8Array>, stats?: DilaParseStats): DilaDoc[] {
  const utf8 = new TextDecoder('utf-8');
  const best = new Map<string, Parsed>();
  let skipped = 0;
  for (const [name, bytes] of entries) {
    const p = parseRecord(name, utf8.decode(bytes));
    if (!p) { skipped++; continue; }
    const key = `${p.isin ?? p.issuer}|${p.type}|${p.filedAt}`;
    const prev = best.get(key);
    if (!prev || (prev.lang !== 'EN' && p.lang === 'EN') || (prev.lang === p.lang && p.id < prev.id)) best.set(key, p);
  }
  if (stats) stats.skipped += skipped;
  if (entries.size > 0 && skipped === entries.size) {
    throw new SourceFormatError(`DILA: none of the ${entries.size} xml records is an AMF record`);
  }
  return [...best.values()]
    .sort((a, b) => a.filedAt.localeCompare(b.filedAt) || a.id.localeCompare(b.id))
    .map(({ lang: _lang, ...d }) => d);
}
