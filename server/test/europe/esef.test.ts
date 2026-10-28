import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEsefClient, parseEsefFacts } from '../../src/europe/sources/esef.js';

const esefDir = new URL('../fixtures/europe/esef/', import.meta.url);
const corpus = (name: string): unknown => JSON.parse(gunzipSync(readFileSync(new URL(name, esefDir))).toString('utf8'));
const expected = JSON.parse(readFileSync(new URL('expected.json', esefDir), 'utf8')) as Record<string, any>;

const ENTITY = 'scheme:5493001KJTIIGC8Y1R12';
function fact(concept: string, period: string, unit: string, value: string, extra: Record<string, string> = {}) {
  return { value, decimals: 0, dimensions: { concept, entity: ENTITY, period, unit, ...extra } };
}
const YEAR = '2025-01-01T00:00:00/2026-01-01T00:00:00';
const doc = (...facts: ReturnType<typeof fact>[]) => ({ facts: Object.fromEntries(facts.map((f, i) => [`fact-${i}`, f])) });

describe('parseEsefFacts', () => {
  it('every corpus filing matches expected exactly', () => {
    const files = Object.keys(expected).filter((k) => k.endsWith('.gz'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const e = expected[f];
      const got = parseEsefFacts(corpus(f), e.periodEnd);
      expect({ file: f, revenue: got.revenue, revenueCurrency: got.revenueCurrency, epsBasic: got.epsBasic,
        epsDiluted: got.epsDiluted, epsCurrency: got.epsCurrency }).toEqual({ file: f, revenue: e.revenue,
        revenueCurrency: e.revenueCurrency, epsBasic: e.epsBasic, epsDiluted: e.epsDiluted, epsCurrency: e.epsCurrency });
    }
  });

  it('bank: revenue null, EPS read', () => {
    const got = parseEsefFacts(corpus('norion_se_bank.json.gz'), '2025-12-31');
    expect(got.revenue).toBeNull();
    expect(got.revenueCurrency).toBeNull();
    expect(got.epsBasic).toBe(7.12);
    expect(got.epsCurrency).toBe('SEK');
  });

  it('bank interest-income concepts are never revenue', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:RevenueFromInterest', YEAR, 'iso4217:EUR', '5000000'),
      fact('ifrs-full:InterestRevenueExpense', YEAR, 'iso4217:EUR', '3000000'),
      fact('ifrs-full:RevenueAndOperatingIncome', YEAR, 'iso4217:EUR', '4000000'),
    ), '2025-12-31');
    expect(got.revenue).toBeNull();
  });

  it('period end is exclusive: 2026-01-01 is the 2025-12-31 year; 3 days tolerated', () => {
    const d = doc(fact('ifrs-full:Revenue', YEAR, 'iso4217:EUR', '100'));
    expect(parseEsefFacts(d, '2025-12-31').revenue).toBe(100);
    expect(parseEsefFacts(d, '2026-01-02').revenue).toBe(100);
    expect(parseEsefFacts(d, '2025-12-28').revenue).toBe(100);
    expect(parseEsefFacts(d, '2025-12-27').revenue).toBeNull();
    expect(parseEsefFacts(d, '2026-01-05').revenue).toBeNull();
  });

  it('prior-year column ignored', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:Revenue', '2024-01-01T00:00:00/2025-01-01T00:00:00', 'iso4217:EUR', '90'),
      fact('ifrs-full:Revenue', YEAR, 'iso4217:EUR', '100'),
    ), '2025-12-31');
    expect(got.revenue).toBe(100);
  });

  it('dimensioned fact ignored', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:Revenue', YEAR, 'iso4217:EUR', '60', { 'x:SegmentAxis': 'x:EuropeMember' }),
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', '9.9', { 'x:Axis': 'x:AdjustedMember' }),
    ), '2025-12-31');
    expect(got.revenue).toBeNull();
    expect(got.epsBasic).toBeNull();
    const withTotal = parseEsefFacts(doc(
      fact('ifrs-full:Revenue', YEAR, 'iso4217:EUR', '60', { 'x:SegmentAxis': 'x:EuropeMember' }),
      fact('ifrs-full:Revenue', YEAR, 'iso4217:EUR', '100'),
    ), '2025-12-31');
    expect(withTotal.revenue).toBe(100);
  });

  it('a language dimension is allowed', () => {
    const got = parseEsefFacts(doc(fact('ifrs-full:Revenue', YEAR, 'iso4217:EUR', '100', { language: 'en' })), '2025-12-31');
    expect(got.revenue).toBe(100);
  });

  it('6-month duration ignored', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:Revenue', '2025-07-01T00:00:00/2026-01-01T00:00:00', 'iso4217:EUR', '50'),
      fact('ifrs-full:BasicEarningsLossPerShare', '2025-07-01T00:00:00/2026-01-01T00:00:00', 'iso4217:EUR/xbrli:shares', '1.1'),
    ), '2025-12-31');
    expect(got.revenue).toBeNull();
    expect(got.epsBasic).toBeNull();
    expect(got.epsCurrency).toBeNull();
  });

  it('two different Revenue values → revenue null', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:Revenue', YEAR, 'iso4217:EUR', '100'),
      fact('ifrs-full:RevenueFromContractsWithCustomers', YEAR, 'iso4217:EUR', '101'),
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', '2.5'),
    ), '2025-12-31');
    expect(got.revenue).toBeNull();
    expect(got.revenueCurrency).toBeNull();
    expect(got.epsBasic).toBe(2.5);
    expect(got.notes.join(' ')).toMatch(/revenue/i);
  });

  it('the same value tagged twice (or by both revenue concepts) is not a disagreement', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:Revenue', YEAR, 'iso4217:EUR', '100'),
      fact('ifrs-full:Revenue', YEAR, 'iso4217:EUR', '100.0'),
      fact('ifrs-full:RevenueFromContractsWithCustomers', YEAR, 'iso4217:EUR', '100'),
    ), '2025-12-31');
    expect(got.revenue).toBe(100);
  });

  it('two different basic EPS values blank basic only', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', '2.5'),
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', '2.6'),
      fact('ifrs-full:DilutedEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', '2.4'),
    ), '2025-12-31');
    expect(got.epsBasic).toBeNull();
    expect(got.epsDiluted).toBe(2.4);
    expect(got.epsCurrency).toBe('EUR');
  });

  it('GBX/shares → GBp, GBP/shares → GBP', () => {
    const pence = parseEsefFacts(doc(
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:GBX/xbrli:shares', '12.3'),
      fact('ifrs-full:DilutedEarningsLossPerShare', YEAR, 'iso4217:GBX/xbrli:shares', '12.1'),
    ), '2025-12-31');
    expect(pence.epsCurrency).toBe('GBp');
    expect(pence.epsBasic).toBe(12.3);
    const pounds = parseEsefFacts(doc(fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:GBP/xbrli:shares', '0.123')), '2025-12-31');
    expect(pounds.epsCurrency).toBe('GBP');
    expect(pounds.epsBasic).toBe(0.123);
  });

  it('EPS in two currencies → EPS blank', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:GBP/xbrli:shares', '0.12'),
      fact('ifrs-full:DilutedEarningsLossPerShare', YEAR, 'iso4217:GBX/xbrli:shares', '11.9'),
    ), '2025-12-31');
    expect(got.epsBasic).toBeNull();
    expect(got.epsDiluted).toBeNull();
    expect(got.epsCurrency).toBeNull();
  });

  it('EPS cross-check: mis-scaled EPS (496 vs profit/shares 4.96) → null; matching EPS kept', () => {
    const facts = (eps: string) => doc(
      fact('ifrs-full:ProfitLossAttributableToOwnersOfParent', YEAR, 'iso4217:EUR', '496000000'),
      fact('ifrs-full:WeightedAverageShares', YEAR, 'xbrli:shares', '100000000'),
      fact('ifrs-full:AdjustedWeightedAverageShares', YEAR, 'xbrli:shares', '100000000'),
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', eps),
      fact('ifrs-full:DilutedEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', eps),
    );
    const bad = parseEsefFacts(facts('496.0'), '2025-12-31');
    expect(bad.epsBasic).toBeNull();
    expect(bad.epsDiluted).toBeNull();
    expect(bad.epsCurrency).toBeNull();
    expect(bad.notes.join(' ')).toMatch(/eps/i);
    const ok = parseEsefFacts(facts('4.96'), '2025-12-31');
    expect(ok).toMatchObject({ epsBasic: 4.96, epsDiluted: 4.96, epsCurrency: 'EUR' });
    expect(parseEsefFacts(facts('5.15'), '2025-12-31').epsBasic).toBe(5.15); // +3.8%
    expect(parseEsefFacts(facts('5.30'), '2025-12-31').epsBasic).toBeNull(); // +6.9%
  });

  it('EPS cross-check: basic and diluted are checked against their own share counts', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:ProfitLossAttributableToOwnersOfParent', YEAR, 'iso4217:EUR', '100'),
      fact('ifrs-full:WeightedAverageShares', YEAR, 'xbrli:shares', '50'),
      fact('ifrs-full:AdjustedWeightedAverageShares', YEAR, 'xbrli:shares', '1000'),
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', '2'),
      fact('ifrs-full:DilutedEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', '2'),
    ), '2025-12-31');
    expect(got.epsBasic).toBe(2);
    expect(got.epsDiluted).toBeNull();
  });

  it('EPS cross-check: skipped when profit or shares are absent, zero, disagreeing or in another currency', () => {
    const eps = fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', '496');
    const profit = fact('ifrs-full:ProfitLossAttributableToOwnersOfParent', YEAR, 'iso4217:EUR', '496');
    const shares = fact('ifrs-full:WeightedAverageShares', YEAR, 'xbrli:shares', '100');
    expect(parseEsefFacts(doc(eps), '2025-12-31').epsBasic).toBe(496);
    expect(parseEsefFacts(doc(eps, profit), '2025-12-31').epsBasic).toBe(496);
    expect(parseEsefFacts(doc(eps, shares), '2025-12-31').epsBasic).toBe(496);
    expect(parseEsefFacts(doc(eps, profit, fact('ifrs-full:WeightedAverageShares', YEAR, 'xbrli:shares', '0')), '2025-12-31').epsBasic).toBe(496);
    expect(parseEsefFacts(doc(eps, profit, shares, fact('ifrs-full:WeightedAverageShares', YEAR, 'xbrli:shares', '7')), '2025-12-31').epsBasic).toBe(496);
    expect(parseEsefFacts(doc(eps, fact('ifrs-full:ProfitLossAttributableToOwnersOfParent', YEAR, 'iso4217:USD', '496'), shares), '2025-12-31').epsBasic).toBe(496);
    // a prior-year or dimensioned profit does not count
    expect(parseEsefFacts(doc(eps, shares, fact('ifrs-full:ProfitLossAttributableToOwnersOfParent', '2024-01-01T00:00:00/2025-01-01T00:00:00', 'iso4217:EUR', '496')), '2025-12-31').epsBasic).toBe(496);
  });

  it('EPS cross-check: pence EPS (GBX) is compared against profit in pounds x 100', () => {
    const f = (eps: string) => doc(
      fact('ifrs-full:ProfitLossAttributableToOwnersOfParent', YEAR, 'iso4217:GBP', '12300000'),
      fact('ifrs-full:WeightedAverageShares', YEAR, 'xbrli:shares', '100000000'),
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:GBX/xbrli:shares', eps),
    );
    expect(parseEsefFacts(f('12.3'), '2025-12-31')).toMatchObject({ epsBasic: 12.3, epsCurrency: 'GBp' });
    expect(parseEsefFacts(f('1230'), '2025-12-31').epsBasic).toBeNull();
  });

  it('a non-midnight exclusive end is the last day itself, not the day before', () => {
    const d = doc(fact('ifrs-full:Revenue', '2025-01-01T00:00:00/2025-12-31T12:00:00', 'iso4217:EUR', '100'));
    expect(parseEsefFacts(d, '2025-12-31').revenue).toBe(100);
    expect(parseEsefFacts(d, '2025-12-27').revenue).toBeNull();
  });

  it('wrong unit shapes and junk are ignored, never thrown on', () => {
    const got = parseEsefFacts(doc(
      fact('ifrs-full:Revenue', YEAR, 'xbrli:pure', '100'),
      fact('ifrs-full:BasicEarningsLossPerShare', YEAR, 'iso4217:EUR', '2.5'),
      fact('ifrs-full:DilutedEarningsLossPerShare', YEAR, 'iso4217:EUR/xbrli:shares', 'n/a'),
    ), '2025-12-31');
    expect(got).toMatchObject({ revenue: null, epsBasic: null, epsDiluted: null });
    for (const junk of [null, undefined, 5, 'x', {}, { facts: null }, { facts: [] }]) {
      expect(parseEsefFacts(junk, '2025-12-31').revenue).toBeNull();
    }
  });
});

describe('createEsefClient', () => {
  afterEach(() => vi.useRealTimers());
  const feeds = (name: string) => readFileSync(new URL(`../fixtures/europe/feeds/${name}`, import.meta.url), 'utf8');
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('client pages until since; 1 s apart', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-28T12:00:00Z') });
    const page1 = JSON.parse(feeds('xbrl_filings_gb.json'));
    page1.links.next = 'https://filings.xbrl.org/api/filings?page2';
    const mk = (id: string, date: string, jsonUrl: string | null) => ({ type: 'filing', id, attributes: {
      fxo_id: `X${id}-ESEF-GB-0`, country: 'GB', period_end: '2026-03-31', date_added: date,
      json_url: jsonUrl, report_url: jsonUrl ? '/r.xhtml' : null }, relationships: { entity: { data: { type: 'entity', id: '2577' } } } });
    const page2 = { data: [mk('900', '2026-06-20 08:00:00.000000', null), mk('901', '2026-06-10 08:00:00.000000', '/a/b.json'),
      mk('902', '2026-04-01 08:00:00.000000', '/old.json')],
      included: page1.included, links: { next: 'https://filings.xbrl.org/api/filings?page3' } };
    const calls: { url: string; at: number; ua: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), at: Date.now(), ua: new Headers(init?.headers).get('user-agent') });
      return json(calls.length === 1 ? page1 : page2);
    }) as unknown as typeof fetch;
    const client = createEsefClient({ fetchImpl });
    const p = client.recent(['GB'], '2026-05-01 00:00:00');
    await vi.advanceTimersByTimeAsync(5000);
    const out = await p;
    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls[0]!.url)).toContain('filter[country]=GB');
    expect(calls[0]!.url).toContain('sort=-date_added');
    expect(calls[1]!.url).toBe('https://filings.xbrl.org/api/filings?page2');
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(calls[0]!.ua).toMatch(/^EarningsCalendarPrototype/);
    expect(calls[0]!.ua).not.toMatch(/@/);
    // page 1 (100 filings, all newer than since) + page 2's 901 only: 900 has no json_url, 902 is older than since
    expect(out).toHaveLength(101);
    const first = out[0]!;
    expect(first.lei).toBe('254900YT8SO8JT2LGD15');
    expect(first.country).toBe('GB');
    expect(first.periodEnd).toBe('2026-06-30');
    expect(first.jsonUrl).toMatch(/^https:\/\/filings\.xbrl\.org\/254900YT8SO8JT2LGD15\/.*\.json$/);
    expect(first.reportUrl).toMatch(/^https:\/\/filings\.xbrl\.org\/.*\.xhtml$/);
    expect(out.map((f) => f.fxoId)).not.toContain('X900-ESEF-GB-0');
    expect(out.map((f) => f.fxoId)).not.toContain('X902-ESEF-GB-0');
  });

  it('caps at 20 pages and spaces facts() from recent() too', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-28T12:00:00Z') });
    const times: number[] = [];
    const fetchImpl = (async (url: string) => {
      times.push(Date.now());
      if (String(url).endsWith('.json')) return json({ facts: {} });
      return json({ data: [{ type: 'filing', id: '1', attributes: { fxo_id: 'F', country: 'GB', period_end: '2026-03-31',
        date_added: '2026-10-01 00:00:00.000000', json_url: '/x.json', report_url: null },
        relationships: { entity: { data: { type: 'entity', id: '7' } } } }],
        included: [{ type: 'entity', id: '7', attributes: { identifier: 'LEI7', name: 'n' } }],
        links: { next: 'https://filings.xbrl.org/api/filings?more' } });
    }) as unknown as typeof fetch;
    const client = createEsefClient({ fetchImpl });
    const p = client.recent(['GB'], '2020-01-01 00:00:00');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toHaveLength(20);
    expect(times).toHaveLength(20);
    const f = client.facts('https://filings.xbrl.org/x.json');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await f).toEqual({ facts: {} });
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1000);
  });

  it('a non-200 answer rejects', async () => {
    const client = createEsefClient({ fetchImpl: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch, minIntervalMs: 0 });
    await expect(client.recent(['GB'], '2026-01-01 00:00:00')).rejects.toThrow(/503/);
    await expect(client.facts('https://filings.xbrl.org/x.json')).rejects.toThrow(/503/);
  });

  it('refuses a facts url off filings.xbrl.org', async () => {
    const fetchImpl = vi.fn();
    const client = createEsefClient({ fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMs: 0 });
    await expect(client.facts('https://example.com/x.json')).rejects.toThrow(/host/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses a links.next off filings.xbrl.org', async () => {
    const page = { data: [], included: [], links: { next: 'https://evil.example.com/api/filings?p=2' } };
    const fetchImpl = vi.fn(async () => json(page));
    const client = createEsefClient({ fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMs: 0 });
    await expect(client.recent(['GB'], '2020-01-01 00:00:00')).rejects.toThrow(/host/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
