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

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const RESULTS = [
  // The brief's period words, with two controller rulings (fix round 1): "(first|second|third|fourth) quarter"
  // (the brief's alternation let a bare "first" trigger), and "annual" only directly before "results".
  /\b(half[- ]year|interim|full[- ]year|preliminary|Q[1-4]|(first|second|third|fourth) quarter|nine[- ]month|9M|H1|H2|FY) .*results/i,
  /\b(annual|full[- ]year|year[- ]end) results\b/i,
  // "Results for the Second Quarter", "Results for the 2st quarter": a period word must follow, so
  // "positive results for the Phase 3 trial" does not count.
  /\bresults for the (\d+(st|nd|rd|th) )?(first|second|third|fourth|quarter|half|year|period|nine|six|three|twelve|financial|fiscal|full)\b/i,
  /trading (update|statement)/i,
  /interim management statement/i,
  // Nordic/EU style (controller ruling): the release itself is called a report. A bare "annual report" is the
  // later document publication and never counts.
  /\b(interim|quarterly|half[- ]year|half[- ]yearly|six[- ]month|year[- ]end|full[- ]year) report\b/i,
  /\bQ[1-4](?: \d{4})? report\b/i,
  // "SKF Q3 2026: Improved margin ...": a period-and-year prefix right after the issuer name, read as one to four
  // capitalised words, so "Norwegian traffic figures Q3 2026:" does not count. Case-sensitive on purpose.
  /^(?:[\p{Lu}\p{N}][\p{L}\p{N}&.+'’-]*\s+){1,4}Q[1-4] \d{4}:/u,
  new RegExp(`\\bfinancial report (?:${MONTHS})\\s*[-–—]+\\s*(?:${MONTHS})\\b`, 'i'),
];
/** Date notices, invitations, presentations, reminders, calls and meetings: never the release itself. */
const NEVER = new RegExp([
  'notice of', '\\bdates? (for|of)\\b', 'to announce', 'will (announce|report|publish)',
  '\\bto (publish|release|present|host|hold|announce)\\b', '\\b(to be|will be) (published|released|presented)\\b',
  '\\bpresentation\\b', '\\breminder\\b', 'invitation',
  'teleconference', 'telephone conference', 'conference call', 'webcast', 'audiocast',
  'general meeting', '\\bAGM\\b', '\\bEGM\\b',
].join('|'), 'i');

/** A title that announces published results (not a date notice, an invitation or a call). */
export function isResultsTitle(title: string): boolean {
  if (NEVER.test(title)) return false;
  return RESULTS.some((r) => r.test(title));
}
