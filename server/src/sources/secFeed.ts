import { BlockedError, looksBlocked } from './failover.js';
import { HttpError, SourceFormatError } from './http.js';
import type { Http } from './http.js';

const FEED_URL =
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&start=0&count=100&output=atom';

export interface SecFeedItem {
  cik: number;
  accession: string;
  acceptedAt: string; // ISO UTC
  items: string[];    // e.g. ['2.02', '7.01', '9.01']
  indexUrl: string;
  form: string;       // '8-K' | '8-K/A'
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1]!.trim() : '';
}

/** Parse the EDGAR "getcurrent" Atom feed. Throws SourceFormatError if it is not Atom. */
export function parseSecFeed(xml: string): SecFeedItem[] {
  if (!xml.includes('<feed')) throw new SourceFormatError('SEC feed: response is not Atom (HTML error page?)');

  const out: SecFeedItem[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const block = m[1]!;
    const title = decodeEntities(extractTag(block, 'title'));
    const indexUrl = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '';
    const summary = decodeEntities(extractTag(block, 'summary'));
    const form = block.match(/<category[^>]*term="([^"]+)"/i)?.[1] ?? title.split(' - ')[0]!.trim();
    const accession = summary.match(/AccNo:<\/b>\s*(\d{10}-\d{2}-\d{6})/)?.[1]
      ?? block.match(/accession-number=(\d{10}-\d{2}-\d{6})/)?.[1];
    const cikStr = title.match(/\((\d{4,10})\)/)?.[1] ?? indexUrl.match(/\/data\/(\d+)\//)?.[1];
    const ms = Date.parse(extractTag(block, 'updated'));
    if (!accession || !cikStr || !indexUrl || Number.isNaN(ms)) continue; // skip malformed entries

    const items = [...summary.matchAll(/Item\s+(\d\.\d{2})/g)].map((x) => x[1]!);
    out.push({ cik: Number(cikStr), accession, acceptedAt: new Date(ms).toISOString(), items, indexUrl, form });
  }
  return out;
}

/** Find the EX-99.1 (else first EX-99*) document on a filing index page, as an absolute URL. */
export function parseFilingIndex(html: string, indexUrl: string): { exhibit991Url: string | null } {
  let first: string | null = null;
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]!);
    const type = cells[3]?.replace(/<[^>]+>/g, '').trim();
    const href = cells[2]?.match(/href="([^"]+)"/i)?.[1];
    if (!type || !href || !/^EX-99/i.test(type)) continue;
    // iXBRL viewer links look like /ix?doc=/Archives/...
    const url = new URL(href.replace(/^\/ix\?doc=/, ''), indexUrl).toString();
    if (type.toUpperCase() === 'EX-99.1') return { exhibit991Url: url };
    first ??= url;
  }
  return { exhibit991Url: first };
}

/** Fetch the latest 100 8-K filings. A block (403/429 or a 200 challenge page) throws BlockedError. */
export async function fetchSecFeed(http: Http): Promise<SecFeedItem[]> {
  let text: string;
  try {
    text = await http.text(FEED_URL);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 429)) {
      throw new BlockedError('sec', `HTTP ${err.status}`);
    }
    throw err;
  }
  if (looksBlocked(200, text)) throw new BlockedError('sec', 'block or rate-limit page');
  return parseSecFeed(text);
}
