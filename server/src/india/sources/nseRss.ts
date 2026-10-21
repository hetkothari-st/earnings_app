import { SourceFormatError } from '../../sources/http.js';
import type { Http } from '../../sources/http.js';
import { parseNsePubDate } from '../domain/nseCalendar.js';
import type { DateTime } from 'luxon';

const RSS_BASE = 'https://nsearchives.nseindia.com/content/RSS/';
const XBRL_BASE = 'https://nsearchives.nseindia.com/corporate/';

export type NseFeed = 'Board_Meetings' | 'Online_announcements' | 'Integrated_Filing' | 'Financial_Results';

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: DateTime;         // IST
  pubDateRaw: string;        // original string
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i'));
  return m ? decodeEntities(m[1]!.trim()) : '';
}

/**
 * Fetch and parse an NSE RSS feed.
 * Throws SourceFormatError if the body is not a valid RSS document.
 */
export async function fetchNseRss(http: Http, feed: NseFeed): Promise<RssItem[]> {
  const url = `${RSS_BASE}${feed}.xml`;
  const text = await http.text(url);

  // Guard against HTML error pages (NSE returns 200 with HTML on some errors)
  if (!text.includes('<rss') && !text.includes('<RSS')) {
    throw new SourceFormatError(`${feed}: response is not RSS (HTML error page?)`);
  }

  // Split into items
  const itemMatches = [...text.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const items: RssItem[] = [];

  for (const match of itemMatches) {
    const block = match[1]!;
    const title = extractTag(block, 'title').replace(/\s+/g, ' ').trim();
    const link = extractTag(block, 'link').trim();
    const description = extractTag(block, 'description').replace(/\s+/g, ' ').trim();
    const pubDateRaw = extractTag(block, 'pubDate').trim();
    const pubDate = parseNsePubDate(pubDateRaw);
    if (!pubDate) continue; // skip malformed items
    items.push({ title, link, description, pubDate, pubDateRaw });
  }

  return items;
}

/**
 * Given an NSE RSS link from a Board_Meetings feed, detect if it is an XBRL
 * prior-intimation link vs a PDF link.
 */
export function isXbrlLink(link: string): boolean {
  return link.includes('/xbrl/') || link.includes('PRIOR_INTIMATION');
}

/**
 * Resolve an NSE document URL: the link in the feed is the canonical URL.
 * For integrated filings: the XBRL is at /corporate/xbrl/INTEGRATED_FILING_...
 */
export function resolveIntegratedFilingUrl(link: string): string {
  // link format: https://nsearchives.nseindia.com/corporate/INTEGRATED_FILING_...|<pdf|null>
  const [fileUrl] = link.split('|');
  if (!fileUrl) return link;
  // Replace /corporate/ path prefix with /corporate/xbrl/ if it doesn't already have it
  return fileUrl.replace(
    'nsearchives.nseindia.com/corporate/',
    'nsearchives.nseindia.com/corporate/xbrl/',
  ).replace('/corporate/xbrl/xbrl/', '/corporate/xbrl/');
}

/**
 * Extract NSE symbol from a Board_Meetings PDF link.
 * PDF path: /corporate/<UPLOADER>_<DDMMYYYYHHMMSS>_<x>.pdf
 * The UPLOADER is usually but not always the NSE symbol.
 */
export function symbolFromPdfLink(link: string): string | null {
  const m = link.match(/\/corporate\/([A-Z0-9&%-]+)_\d{14}_/i);
  if (!m) return null;
  const sym = m[1]!.toUpperCase();
  // Reject obviously bad "symbols": pure numbers (phone/IDs), too long, or contain only digits
  if (/^\d+$/.test(sym)) return null;          // phone numbers like 8448091598
  if (sym.length > 20) return null;             // uploader IDs are too long
  if (/^[A-Z]{2}\d{6,}/.test(sym)) return null; // ISIN-like codes
  return sym;
}

/**
 * Parse "Purpose |Meeting Date: DD-Mon-YYYY" from a Board_Meetings description.
 */
export function parseBoardMeetingDescription(desc: string): {
  purpose: string;
  meetingDate: string | null;
} {
  const parts = desc.split('|');
  const purpose = (parts[0] ?? '').trim();
  const datePart = (parts[1] ?? '').replace('Meeting Date:', '').trim();
  return { purpose, meetingDate: datePart || null };
}

/**
 * Parse "text |SUBJECT: subject" from Online_announcements description.
 */
export function parseAnnouncementDescription(desc: string): {
  text: string;
  subject: string;
} {
  const idx = desc.indexOf('|SUBJECT:');
  if (idx < 0) return { text: desc.trim(), subject: '' };
  return {
    text: desc.slice(0, idx).trim(),
    subject: desc.slice(idx + 9).trim(),
  };
}

/**
 * Returns true if an Online_announcements subject indicates a financial result.
 */
export function isResultSubject(subject: string): boolean {
  const s = subject.toLowerCase();
  return s.includes('outcome of board meeting') || s.includes('financial results');
}

/** Fetch raw XBRL bytes from NSE. */
export async function fetchXbrlText(http: Http, url: string): Promise<string> {
  return http.text(url);
}
