import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SourceFormatError } from '../../src/sources/http.js';
import { isResultsTitle, parsePrnRss, prnReleaseKey } from '../../src/europe/sources/prnewswire.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/europe/feeds/${n}`, import.meta.url), 'utf8');

describe('parsePrnRss', () => {
  it('parses items with pubDate to the second', () => {
    const items = parsePrnRss(fx('prn_uk.rss'));
    expect(items).toHaveLength(20);
    const pearson = items.find((i) => i.contributor === 'Pearson')!;
    expect(pearson).toEqual({
      id: 'https://www.prnewswire.co.uk/news-releases/pearson-2026-nine-month-trading-update-unaudited-302915984.html',
      title: 'Pearson 2026 Nine Month Trading Update (Unaudited)',
      link: 'https://www.prnewswire.co.uk/news-releases/pearson-2026-nine-month-trading-update-unaudited-302915984.html',
      publishedAt: '2026-10-22T06:10:00.000Z',
      description: expect.stringMatching(/^Accelerated growth in Q3/),
      contributor: 'Pearson',
    });
    // Entities decoded in titles and contributors; no HTML left in descriptions.
    expect(items.find((i) => i.contributor === 'KT&G Corporation')!.title).toMatch(/^KT&G Delivers Strong Q2 Results/);
    for (const i of items) expect(i.description).not.toMatch(/<\/?p>/);

    const eu = parsePrnRss(fx('prn_eu.rss'));
    expect(eu).toHaveLength(20);
    const ericsson = eu.find((i) => i.contributor === 'Ericsson')!;
    expect(ericsson.publishedAt).toBe('2026-10-15T05:32:00.000Z');
    // The same release in two feeds has one key, so a caller can handle it once across UK and EU.
    const pe = eu.find((i) => i.contributor === 'Pearson')!;
    expect(prnReleaseKey(pe.link)).toBe('prn:302915984');
    expect(prnReleaseKey(pe.link.replace('prnewswire.co.uk', 'prnewswire.com'))).toBe('prn:302915984');
    expect(prnReleaseKey('https://example.com/x')).toBe('https://example.com/x');
  });

  it('an empty contributor is null; a non-RSS answer throws', () => {
    const xml = '<rss><channel><item><title>A plc Half-year results</title><link>https://www.prnewswire.co.uk/news-releases/a-1.html</link>'
      + '<pubDate>Tue, 27 Oct 2026 07:00:05 +0000</pubDate><description><![CDATA[<p>x &amp; y</p>]]></description>'
      + '<dc:contributor><![CDATA[ ]]></dc:contributor></item>'
      + '<item><title>No date</title><link>https://x/2.html</link></item></channel></rss>';
    expect(parsePrnRss(xml)).toEqual([{
      id: 'https://www.prnewswire.co.uk/news-releases/a-1.html', title: 'A plc Half-year results',
      link: 'https://www.prnewswire.co.uk/news-releases/a-1.html', publishedAt: '2026-10-27T07:00:05.000Z',
      description: 'x & y', contributor: null,
    }]);
    expect(() => parsePrnRss('<html><body>Error</body></html>')).toThrow(SourceFormatError);
  });

  it('results titles yes; "to announce Q3 results on" no; "conference call" no', () => {
    for (const t of [
      'Pearson 2026 Nine Month Trading Update (Unaudited)',
      'Ericsson reports third quarter results 2026',
      'Truist reports third quarter 2026 results',
      'Shell plc Half-Year Results 2026',
      'Unilever full year results',
      'Tesco Preliminary Results 2025/26',
      'Acme plc Q3 2026 results',
      'Acme H1 2026 Results',
      'Cboe Global Markets Reports Results for the Second Quarter 2026',
      'Acme AG: Interim Management Statement Q3',
      'BP trading statement',
    ]) expect(isResultsTitle(t), t).toBe(true);
    for (const t of [
      'Acme plc to announce Q3 results on 5 November',
      'Acme plc Q3 2026 results conference call',
      'Acme plc Q3 2026 results webcast',
      'Notice of full year results',
      'Date of Q3 results',
      'Acme will report third quarter results on 4 November',
      'Acme will publish half-year results on 30 July',
      "Lundin Mining's Chile Operations Impacted by Second Severe Winter Storm",
      'IFS industrial AI bookings triple as ARR passes €1.3 billion',
    ]) expect(isResultsTitle(t), t).toBe(false);
  });

  it('EU interim and quarterly report titles count; annual report, AGM and invitations do not', () => {
    // Every Nordic/EU results release in the live EU earnings fixture.
    const eu = parsePrnRss(fx('prn_eu.rss'));
    for (const who of ['Swedish Orphan Biovitrum AB', 'ASSA ABLOY', 'Duni Group', 'Securitas', 'Electrolux Group', 'Essity', 'SKF', 'Autoliv']) {
      const item = eu.find((i) => i.contributor === who)!;
      expect(isResultsTitle(item.title), item.title).toBe(true);
    }
    expect(eu.find((i) => i.contributor === 'Autoliv')!.title).toBe('Financial Report July - September 2026');
    for (const t of [
      'Acme Half-Year Report 2026', 'Acme half year report', 'Acme Half-yearly Report January-June', 'Acme Six-Month Report 2026',
      'Acme Year-End Report 2025', 'Acme Full-Year Report 2025', 'Acme Q2 report', 'Acme Financial Report January – March 2026',
    ]) expect(isResultsTitle(t), t).toBe(true);
    for (const t of [
      'Annual Report 2025 published',
      'Acme publishes its Annual Report 2025',
      'Notice of Annual General Meeting',
      'Acme Annual General Meeting 2026',
      'Invitation to presentation of interim report',
      'Invitation to presentation of Acme Q3 2026 results',
    ]) expect(isResultsTitle(t), t).toBe(false);
  });

  it('date notices, presentations, reminders, meetings and trial headlines are not results (fix round 1)', () => {
    for (const t of [
      'Sobi to publish Q3 2026 report on 29 October',
      'Electrolux Group to publish interim report on 24 October',
      'Acme Q3 2026 report to be published on 5 November',
      'Acme: Presentation of Q3 2026 report',
      'Welcome to Acme Q3 report presentation',
      'Reminder: Acme interim report Q3 tomorrow',
      'Acme Q3 2026: Date for publication of interim report',
      'Acme to release Q3 results on 5 November',
      'Acme to present Q3 2026 results on 5 November',
      'Acme to host Q3 2026 results teleconference',
      'Acme Q3 2026 results will be released on 5 November',
      'Acme Q3 results audiocast',
      'Dates for 2027 financial reports',
      'Acme plc Annual General Meeting Results',
      'AGM Results',
      'Acme EGM results',
      'Acme announces first patient dosed; topline results expected 2027',
      'Acme announces positive results for the Phase 3 trial',
      'Acme annual meeting: voting results',
      // The Qn yyyy: prefix must follow the issuer name, not other words.
      'Norwegian traffic figures Q3 2026: passenger numbers up',
    ]) expect(isResultsTitle(t), t).toBe(false);
    for (const t of [
      'Acme annual results 2025', 'Acme Year-End Results 2025', 'Acme Results for the Nine Months to September',
      'Acme Results for the Year Ended 31 March 2026', 'Ørsted Q3 2026: Strong quarter', 'Novo Nordisk Q3 2026: Sales up',
    ]) expect(isResultsTitle(t), t).toBe(true);
  });

  it('the live UK and EU feeds keep exactly their results items', () => {
    const yes = (f: string) => parsePrnRss(fx(f)).filter((i) => isResultsTitle(i.title)).map((i) => i.contributor);
    expect(yes('prn_uk.rss')).toEqual([
      'Pearson', 'Truist Financial Corporation', 'Bank of America Corporation', 'Gentoo Media Inc', 'KT&G Corporation',
      'MIAX', 'Waters Corporation', 'Motiva S.A.', 'Markel Group', 'Landis+Gyr Group AG',
    ]);
    expect(yes('prn_eu.rss')).toEqual([
      'Royal Caribbean Group', 'Hycroft Mining Holding Corporation', 'Swedish Orphan Biovitrum AB', 'ASSA ABLOY', 'Autoliv',
      'Duni Group', 'Securitas', 'Electrolux Group', 'Essity', 'Pearson', 'SKF', 'Truist Financial Corporation', 'Ericsson',
    ]);
  });
});
