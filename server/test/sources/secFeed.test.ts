import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BlockedError } from '../../src/sources/failover.js';
import { HttpError, SourceFormatError } from '../../src/sources/http.js';
import type { Http } from '../../src/sources/http.js';
import { fetchSecFeed, parseFilingIndex, parseSecFeed } from '../../src/sources/secFeed.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/us/${n}`, import.meta.url), 'utf8');
const stub = (text: () => Promise<string>, urls: string[] = []): Http => ({
  json: async () => { throw new Error('unused'); },
  text: async (u) => { urls.push(u); return text(); },
});

describe('parseSecFeed', () => {
  it('UDR entry: cik 74208, accession 0000074208-26-000081, items include 2.02, acceptedAt 2026-10-21T12:05:10.000Z', () => {
    const udr = parseSecFeed(fx('sec_getcurrent_8k.xml')).find((i) => i.cik === 74208)!;
    expect(udr.accession).toBe('0000074208-26-000081');
    expect(udr.items).toEqual(['2.02', '7.01', '9.01']);
    expect(udr.acceptedAt).toBe('2026-10-21T12:05:10.000Z');
    expect(udr.form).toBe('8-K');
    expect(udr.indexUrl).toBe('https://www.sec.gov/Archives/edgar/data/74208/000007420826000081/0000074208-26-000081-index.htm');
  });

  it('entries without 2.02 still parse (Zedge has 7.01, 9.01 only)', () => {
    const z = parseSecFeed(fx('sec_getcurrent_8k.xml')).find((i) => i.cik === 1667313)!;
    expect(z.items).toEqual(['7.01', '9.01']);
  });

  it('an HTML page instead of atom throws SourceFormatError', () => {
    expect(() => parseSecFeed('<html><body>oops</body></html>')).toThrow(SourceFormatError);
  });
});

describe('parseFilingIndex', () => {
  const url = 'https://www.sec.gov/Archives/edgar/data/74208/000007420826000081/0000074208-26-000081-index.htm';
  it('index page yields the EX-99.1 absolute URL', () => {
    expect(parseFilingIndex(fx('sec_index_udr_ex99.htm'), url).exhibit991Url)
      .toBe('https://www.sec.gov/Archives/edgar/data/74208/000007420826000081/udr-ex99d1.htm');
  });
  it('falls back to the first EX-99* and returns null when none', () => {
    const html = '<table><tr><td>1</td><td>x</td><td><a href="/a/b-ex99d2.htm">b</a></td><td>EX-99.2</td></tr></table>';
    expect(parseFilingIndex(html, url).exhibit991Url).toBe('https://www.sec.gov/a/b-ex99d2.htm');
    expect(parseFilingIndex('<table></table>', url).exhibit991Url).toBeNull();
  });
});

describe('fetchSecFeed', () => {
  it('requests count=100 and parses', async () => {
    const urls: string[] = [];
    const items = await fetchSecFeed(stub(async () => fx('sec_getcurrent_8k.xml'), urls));
    expect(urls[0]).toContain('count=100');
    expect(items.length).toBeGreaterThan(1);
  });
  it('200 rate-limit HTML page throws BlockedError', async () => {
    await expect(fetchSecFeed(stub(async () => '<html>Request Rate Threshold Exceeded</html>'))).rejects.toBeInstanceOf(BlockedError);
  });
  it('HTTP 403/429 throw BlockedError, other errors pass through', async () => {
    await expect(fetchSecFeed(stub(async () => { throw new HttpError(429, 'u'); }))).rejects.toBeInstanceOf(BlockedError);
    await expect(fetchSecFeed(stub(async () => { throw new HttpError(403, 'u'); }))).rejects.toBeInstanceOf(BlockedError);
    await expect(fetchSecFeed(stub(async () => { throw new HttpError(500, 'u'); }))).rejects.toBeInstanceOf(HttpError);
  });
});
