import { SourceFormatError } from '../../sources/http.js';

// Named prnewswire.ts, not prn.ts: PRN is a reserved device name on Windows and git there refuses "prn.*" paths.

/**
 * PR Newswire RSS 2.0 (the prnewswire.co.uk / .com earnings-list feeds in PRN_FEEDS; see sourceUrls.ts).
 * Feeds hold 20 items with no paging. pubDate is true UTC to the second and lags the issuer's own release by
 * minutes to about 40 minutes, so `publishedAt` is an upper bound on the release time.
 *
 * The UK and EU markets read the same .co.uk earnings feed, so one release appears in both: callers key it with
 * `prnReleaseKey` and handle it once, against one issuer index over both markets.
 */
export interface PrnItem {
  id: string; // link
  title: string;
  link: string;
  publishedAt: string; // ISO UTC
  description: string;
  contributor: string | null; // dc:contributor, the issuer name as the sender wrote it
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/**
 * The content of the first <tag>, CDATA unwrapped, trimmed ('' when absent). Entities are left for the caller
 * to decode exactly once: plain text holds XML entities, CDATA holds HTML with its own entities.
 */
function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  const raw = m[1]!.trim();
  return raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)?.[1] ?? raw;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Parse a PR Newswire RSS feed. Items without a link or a valid pubDate are skipped. Throws if it is not RSS. */
export function parsePrnRss(xml: string): PrnItem[] {
  if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) {
    throw new SourceFormatError('PRN: response is not RSS (HTML error page?)');
  }
  const out: PrnItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]!;
    const link = squash(decodeEntities(tagText(block, 'link')));
    const ms = Date.parse(tagText(block, 'pubDate'));
    if (!link || Number.isNaN(ms)) continue;
    const title = squash(decodeEntities(tagText(block, 'title')));
    const description = squash(decodeEntities(tagText(block, 'description').replace(/<[^>]+>/g, ' ')));
    const contributor = squash(decodeEntities(tagText(block, 'dc:contributor'))) || null;
    out.push({ id: link, title, link, publishedAt: new Date(ms).toISOString(), description, contributor });
  }
  return out;
}

/**
 * One key per release across prnewswire.co.uk and .com: the release number that ends every news-release link
 * ("...-302915984.html" → "prn:302915984"). A link without one is its own key.
 */
export function prnReleaseKey(link: string): string {
  const m = link.match(/-(\d{6,})\.html?(?:[?#].*)?$/i);
  return m ? `prn:${m[1]}` : link;
}

const RESULTS = [
  /\b(half[- ]year|interim|full[- ]year|preliminary|annual|Q[1-4]|first|second|third|fourth quarter|nine[- ]month|9M|H1|H2|FY) .*results/i,
  /results for the/i,
  /trading (update|statement)/i,
  /interim management statement/i,
];
const NEVER = /notice of|date of|to announce|will (announce|report|publish)|conference call|webcast/i;

/** A title that announces published results (not a date notice, an invitation or a call). */
export function isResultsTitle(title: string): boolean {
  if (NEVER.test(title)) return false;
  return RESULTS.some((r) => r.test(title));
}
