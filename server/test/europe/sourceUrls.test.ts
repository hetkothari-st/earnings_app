import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  PRN_FEEDS,
  DILA_BASE,
  DILA_RESULTS_TYPES,
  XBRL_FILINGS_URL,
  GOVUK_BANK_HOLIDAYS_URL,
  TRADEGATE_REFRESH,
  TRADEGATE_ROBOTS,
  EUROPE_UA,
} from '../../src/europe/sources/sourceUrls.js';

const dir = fileURLToPath(new URL('../fixtures/europe/feeds/', import.meta.url));
const text = (f: string): string => readFileSync(dir + f, 'utf8');
const bytes = (f: string): Buffer => readFileSync(dir + f);

/** Minimal ustar reader: every regular file's name and content. */
function tarFiles(gz: Buffer): Array<{ name: string; data: Buffer }> {
  const tar = gunzipSync(gz);
  const out: Array<{ name: string; data: Buffer }> = [];
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const head = tar.subarray(pos, pos + 512);
    if (head.every((b) => b === 0)) break;
    const name = head.subarray(0, 100).toString('latin1').replace(/\0[\s\S]*$/, '');
    const size = parseInt(head.subarray(124, 136).toString('latin1').replace(/\0[\s\S]*$/, '').trim() || '0', 8);
    out.push({ name, data: tar.subarray(pos + 512, pos + 512 + size) });
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('europe source facts', () => {
  it('constants', () => {
    expect(EUROPE_UA).toBe('EarningsCalendarPrototype/1.0');
    expect(EUROPE_UA).not.toMatch(/@/);
    expect(GOVUK_BANK_HOLIDAYS_URL).toBe('https://www.gov.uk/bank-holidays.json');
    expect(TRADEGATE_REFRESH).toBe('https://www.tradegatebsx.com/refresh.php');
    expect(TRADEGATE_ROBOTS).toBe('https://www.tradegatebsx.com/robots.txt');
    expect(DILA_BASE).toBe('https://echanges.dila.gouv.fr/OPENDATA/AMF/');
    expect(XBRL_FILINGS_URL.startsWith('https://filings.xbrl.org/api/filings')).toBe(true);
    for (const u of [...PRN_FEEDS.UK, ...PRN_FEEDS.EU]) {
      expect(u).toMatch(/^https:\/\/www\.prnewswire\.(com|co\.uk)\/rss\/.+\.rss$/);
    }
    expect(PRN_FEEDS.UK.length).toBeGreaterThan(0);
    expect(PRN_FEEDS.EU.length).toBeGreaterThan(0);
  });

  it('PRN fixtures are RSS with pubDate to the second', () => {
    for (const f of ['prn_uk.rss', 'prn_eu.rss']) {
      const xml = text(f);
      expect(xml).toContain('<rss');
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
      expect(items.length).toBeGreaterThanOrEqual(10);
      for (const it of items) {
        expect(it).toMatch(/<pubDate>[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000<\/pubDate>/);
        expect(it).toMatch(/<title>[\s\S]+<\/title>/);
        expect(it).toMatch(/<link>https:\/\/www\.prnewswire\.(com|co\.uk)\//);
      }
    }
    // a results release carries the issuer in dc:contributor and the Earnings subject
    const eu = text('prn_eu.rss');
    expect(eu).toMatch(/<dc:contributor><!\[CDATA\[ASSA ABLOY\]\]><\/dc:contributor>/);
    expect(eu).toMatch(/ASSA ABLOY: Quarterly Report Q3 2026/);
    expect(eu).toMatch(/<dc:subject><!\[CDATA\[ERN\]\]><\/dc:subject>/);
  });

  it('DILA samples contain ISIN-tagged records; the press sample has a results type from DILA_RESULTS_TYPES', () => {
    const files = tarFiles(bytes('dila_sample.tar.gz'));
    const xml = files.filter((f) => /^xml\/.+\.xml$/.test(f.name));
    expect(xml.length).toBeGreaterThan(0);
    expect(files.some((f) => /^pdf\/.+\.pdf$/.test(f.name))).toBe(true);
    let results = 0;
    for (const f of xml) {
      const s = f.data.toString('utf8');
      expect(s).toMatch(/ISO_CD_ISI="[A-Z]{2}[A-Z0-9]{9}\d"/);
      const t = /INF_STP_PRI="(\d{6})"/.exec(s)?.[1];
      expect(t).toBeTruthy();
      expect(s).toMatch(/INF_DAT_EMT="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}"/);
      if (DILA_RESULTS_TYPES.includes(t!)) results++;
    }
    // The annual sample holds only 003000 (annual financial report) and 013001 records: no results type (ruling).
    expect(results).toBe(0);
    // Report documents (003000 annual, 004000 half-year financial report) are often filed weeks after the results
    // (Exail's 004000 on 2026-10-26): controller ruling, they never flip a row.
    expect(DILA_RESULTS_TYPES).toEqual(['001007', '005002']);
    // the press-release sample carries the 001007 "results/accounts release" type
    const press = tarFiles(bytes('dila_sample_press.tar.gz')).filter((f) => f.name.startsWith('xml/'));
    expect(press.some((f) => /INF_STP_PRI="001007"/.test(f.data.toString('utf8')))).toBe(true);
    // listing: flat directory of tar.gz batches
    expect(text('dila_listing.html')).toMatch(/amf-gz_\d{8}_\d{4}\.tar\.gz/);
  });

  it('xbrl filings have json_url and an entity LEI', () => {
    for (const f of ['xbrl_filings_gb.json', 'xbrl_filings_fr.json']) {
      const d = JSON.parse(text(f));
      expect(d.data.length).toBe(100);
      const ent = new Map<string, string>(
        d.included.map((e: { id: string; attributes: { identifier: string } }) => [e.id, e.attributes.identifier]),
      );
      let withUrl = 0;
      for (const x of d.data) {
        // a rare filing (1 of 200 here) has json_url null: skip it, never guess a URL
        if (x.attributes.json_url === null) continue;
        withUrl++;
        expect(x.attributes.json_url).toMatch(/^\/[A-Za-z0-9]{20}\/\d{4}-\d{2}-\d{2}\/ESEF\/(GB|FR)\/\d+\/.+\.json$/);
        expect(x.attributes.period_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(x.attributes.date_added).toMatch(/^\d{4}-\d{2}-\d{2} /);
        expect(ent.get(x.relationships.entity.data.id)).toMatch(/^[A-Za-z0-9]{20}$/);
      }
      expect(withUrl).toBeGreaterThanOrEqual(95);
    }
    const facts = JSON.parse(text('xbrl_facts_sample.json'));
    expect(facts.documentInfo.documentType).toBe('https://xbrl.org/2021/xbrl-json');
    const concepts = new Set(
      Object.values<{ dimensions: { concept: string } }>(facts.facts).map((v) => v.dimensions.concept),
    );
    expect(concepts.has('ifrs-full:Revenue')).toBe(true);
    expect(concepts.has('ifrs-full:BasicEarningsLossPerShare')).toBe(true);
  });

  it('gov.uk has england-and-wales events for 2026 and 2027', () => {
    const d = JSON.parse(text('govuk_bank_holidays.json'));
    const dates: string[] = d['england-and-wales'].events.map((e: { date: string }) => e.date);
    const md = (y: string) => dates.filter((x) => x.startsWith(y)).map((x) => x.slice(5));
    expect(md('2026')).toEqual(['01-01', '04-03', '04-06', '05-04', '05-25', '08-31', '12-25', '12-28']);
    expect(md('2027')).toEqual(['01-01', '03-26', '03-29', '05-03', '05-31', '08-30', '12-27', '12-28']);
  });

  it('Tradegate answers have last and close; unknown ISIN recorded', () => {
    for (const f of ['tradegate_DE0007164600.json', 'tradegate_GB0009895292.json']) {
      const d = JSON.parse(text(f));
      for (const k of ['bid', 'ask', 'last', 'high', 'low', 'close', 'delta']) expect(d).toHaveProperty(k);
      // a field is either a JSON number or a German-format string ("213,10")
      for (const k of ['bid', 'ask', 'last', 'high', 'low', 'close']) {
        const v = d[k];
        expect(typeof v === 'number' || /^\d{1,3}(\.\d{3})*,\d+$|^\d+,\d+$/.test(v)).toBe(true);
      }
    }
    // delta is the percent change of last against close, in the same answer, before and after the 08:00 open
    const num = (v: number | string): number => (typeof v === 'number' ? v : Number(v.replace(',', '.')));
    for (const f of [
      'tradegate_DE0007164600.json',
      'tradegate_GB0009895292.json',
      'tradegate_DE0007164600_open.json',
      'tradegate_GB0009895292_open.json',
    ]) {
      const d = JSON.parse(text(f));
      const pct = ((num(d.last) - num(d.close)) / num(d.close)) * 100;
      expect(Math.abs(pct - d.delta)).toBeLessThan(0.011);
    }
    // close rolled forward to the next session between the 05:50 UTC and 07:12 UTC probes
    expect(JSON.parse(text('tradegate_DE0007164600.json')).close).not.toBe(
      JSON.parse(text('tradegate_DE0007164600_open.json')).close,
    );
    // an unknown ISIN is an empty body (HTTP 200, text/html), which is not JSON
    expect(text('tradegate_unknown.json')).toBe('');
  });

  it('robots: tradegate disallows /json/ only', () => {
    const r = text('tradegate_robots.txt');
    const disallows = [...r.matchAll(/^Disallow:\s*(.*)$/gim)].map((m) => (m[1] ?? '').trim());
    expect(disallows).toEqual(['/json/']);
    // PRN disallows no RSS path; DILA and filings.xbrl.org publish no robots.txt (404)
    expect(text('prn_robots.txt')).not.toMatch(/Disallow:\s*\/(rss|news-releases)/i);
    expect(text('dila_robots.txt')).toMatch(/^404/);
    expect(text('xbrl_robots.txt')).toMatch(/^404/);
  });
});
