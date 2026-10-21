import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fetchNseRss, parseBoardMeetingDescription, parseAnnouncementDescription, isResultSubject, isXbrlLink, symbolFromPdfLink, resolveIntegratedFilingUrl } from '../../src/india/sources/nseRss.js';
import type { Http } from '../../src/sources/http.js';
import { SourceFormatError } from '../../src/sources/http.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/india');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

/** Make a mock Http that returns the given text for any url. */
function mockHttp(text: string): Http {
  return { json: async () => ({}), text: async () => text };
}

describe('fetchNseRss', () => {
  it('parses Board_Meetings fixture', async () => {
    const items = await fetchNseRss(mockHttp(fixture('rss_Board_Meetings.xml')), 'Board_Meetings');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.title).toBeTruthy();
      expect(item.pubDate.isValid).toBe(true);
    }
  });

  it('parses Integrated_Filing fixture', async () => {
    const items = await fetchNseRss(mockHttp(fixture('rss_Integrated_Filing.xml')), 'Integrated_Filing');
    expect(items.length).toBeGreaterThan(0);
  });

  it('throws SourceFormatError when body is HTML (not RSS)', async () => {
    const html = '<html><head></head><body><h1>Error 503</h1></body></html>';
    await expect(fetchNseRss(mockHttp(html), 'Board_Meetings')).rejects.toThrow(SourceFormatError);
  });

  it('parses Online_announcements fixture', async () => {
    const items = await fetchNseRss(mockHttp(fixture('rss_Online_announcements.xml')), 'Online_announcements');
    expect(items.length).toBeGreaterThan(0);
  });
});

describe('parseBoardMeetingDescription', () => {
  it('splits purpose from meeting date', () => {
    const r = parseBoardMeetingDescription('Quarterly Results |Meeting Date: 15-Oct-2026');
    expect(r.purpose).toBe('Quarterly Results');
    expect(r.meetingDate).toBe('15-Oct-2026');
  });
  it('handles missing date part', () => {
    const r = parseBoardMeetingDescription('Board Meeting Intimation');
    expect(r.purpose).toBe('Board Meeting Intimation');
    expect(r.meetingDate).toBeNull();
  });
});

describe('parseAnnouncementDescription', () => {
  it('splits text from subject', () => {
    const r = parseAnnouncementDescription('TATA COMMUNICATIONS LIMITED |SUBJECT: Outcome of Board Meeting');
    expect(r.text).toBe('TATA COMMUNICATIONS LIMITED');
    expect(r.subject).toBe('Outcome of Board Meeting');
  });
});

describe('isResultSubject', () => {
  it('matches outcome of board meeting', () => {
    expect(isResultSubject('Outcome of Board Meeting')).toBe(true);
    expect(isResultSubject('OUTCOME OF BOARD MEETING')).toBe(true);
  });
  it('matches financial results updates', () => {
    expect(isResultSubject('Financial Results Updates')).toBe(true);
  });
  it('does not match unrelated subjects', () => {
    expect(isResultSubject('AGM Notice')).toBe(false);
    expect(isResultSubject('Dividend Declaration')).toBe(false);
  });
});

describe('isXbrlLink', () => {
  it('returns true for XBRL paths', () => {
    expect(isXbrlLink('https://nsearchives.nseindia.com/corporate/xbrl/PRIOR_INTIMATION_123_WebXMLFile.xml')).toBe(true);
  });
  it('returns false for PDF paths', () => {
    expect(isXbrlLink('https://nsearchives.nseindia.com/corporate/RELIANCE_20261015123456_1.pdf')).toBe(false);
  });
});

describe('symbolFromPdfLink', () => {
  it('extracts symbol from PDF URL', () => {
    expect(symbolFromPdfLink('https://nsearchives.nseindia.com/corporate/RELIANCE_20261015143000_1.pdf')).toBe('RELIANCE');
    expect(symbolFromPdfLink('https://nsearchives.nseindia.com/corporate/BAJAJ-AUTO_20261015143000_1.pdf')).toBe('BAJAJ-AUTO');
  });
});

describe('resolveIntegratedFilingUrl', () => {
  it('resolves pipe-separated link to XBRL URL', () => {
    const link = 'https://nsearchives.nseindia.com/corporate/INTEGRATED_FILING_IndAS_123_abc_WEB.xml|null';
    const url = resolveIntegratedFilingUrl(link);
    expect(url).toContain('/corporate/xbrl/INTEGRATED_FILING_');
  });
});
