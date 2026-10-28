/**
 * filings.xbrl.org (ESEF annual reports): the filing index client and the xBRL-JSON annual revenue/EPS parser.
 * Live facts are in sourceUrls.ts (Task 3). In short:
 * - The index is JSON:API, `sort=-date_added`, paged by `links.next`; `include=entity` carries the LEI.
 * - `date_added` is a naive UTC "YYYY-MM-DD HH:MM:SS.ffffff"; it is when the filing reached the site, not a release time.
 * - About 1 filing in 200 has `json_url: null`: it is skipped, never an error.
 * - Facts: the period end is EXCLUSIVE ("2025-01-01T00:00:00/2026-01-01T00:00:00" is the year to 2025-12-31). Values are
 *   canonical decimals in the base unit, so UK pence-reporters still show EPS in pounds (-3.64p is "-0.0364" GBP/shares).
 * - A bank has no `ifrs-full:Revenue` fact (interest income / operating income are other concepts, never used here).
 */
import { EUROPE_UA, XBRL_FILINGS_URL } from './sourceUrls.js';

const BASE = 'https://filings.xbrl.org';
const MAX_PAGES = 20;

export interface EsefFiling {
  fxoId: string;
  lei: string;
  country: string;
  periodEnd: string;
  dateAdded: string;
  /** Absolute https://filings.xbrl.org URL. */
  jsonUrl: string;
  reportUrl: string | null;
}

export interface EsefClient {
  recent(countries: readonly string[], sinceDateAdded: string): Promise<EsefFiling[]>;
  facts(jsonUrl: string): Promise<unknown>;
}

const absolute = (u: string): string => new URL(u, BASE).toString();

/** Every request stays on https://filings.xbrl.org, including the pages the API links to. */
function assertHost(url: string): string {
  const u = new URL(url, BASE);
  if (u.protocol !== 'https:' || u.hostname !== 'filings.xbrl.org') throw new Error(`refusing host ${u.hostname}`);
  return u.toString();
}

export function createEsefClient(o: { fetchImpl?: typeof fetch; minIntervalMs?: number } = {}): EsefClient {
  const fetchImpl = o.fetchImpl ?? fetch;
  const gap = o.minIntervalMs ?? 1000;
  let last = -Infinity;
  let queue: Promise<unknown> = Promise.resolve();

  /** One request at a time, at least `gap` ms after the previous one started (all calls share this). */
  function get(url: string): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      const wait = last + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await fetchImpl(url, { headers: { 'user-agent': EUROPE_UA, accept: 'application/json' } });
      if (!res.ok) throw new Error(`filings.xbrl.org ${res.status}`);
      return res.json();
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  }

  return {
    async recent(countries, sinceDateAdded) {
      const since = sinceDateAdded.replace('T', ' ');
      const out: EsefFiling[] = [];
      for (const country of countries) {
        let url: string | null =
          `${XBRL_FILINGS_URL}?filter[country]=${encodeURIComponent(country)}&sort=-date_added&page[size]=100&include=entity`;
        for (let page = 0; url && page < MAX_PAGES; page++) {
          assertHost(url);
          const body = (await get(url)) as any;
          const lei = new Map<string, string>();
          for (const inc of Array.isArray(body?.included) ? body.included : []) {
            if (inc?.type === 'entity' && typeof inc.attributes?.identifier === 'string') lei.set(String(inc.id), inc.attributes.identifier);
          }
          let reachedOlder = false;
          for (const d of Array.isArray(body?.data) ? body.data : []) {
            const a = d?.attributes ?? {};
            const added = typeof a.date_added === 'string' ? a.date_added : '';
            if (added < since) { reachedOlder = true; continue; }
            if (typeof a.json_url !== 'string' || !a.json_url) continue; // ~1 in 200: no xBRL-JSON, skip
            const entityId = d?.relationships?.entity?.data?.id;
            const l = entityId == null ? undefined : lei.get(String(entityId));
            if (!l || typeof a.fxo_id !== 'string' || typeof a.period_end !== 'string') continue;
            out.push({
              fxoId: a.fxo_id, lei: l, country: typeof a.country === 'string' ? a.country : country,
              periodEnd: a.period_end, dateAdded: added, jsonUrl: absolute(a.json_url),
              reportUrl: typeof a.report_url === 'string' && a.report_url ? absolute(a.report_url) : null,
            });
          }
          const next = body?.links?.next;
          url = !reachedOlder && typeof next === 'string' && next ? next : null;
        }
      }
      return out;
    },

    async facts(jsonUrl) {
      return get(assertHost(jsonUrl));
    },
  };
}

export interface EsefFigures {
  revenue: number | null;
  revenueCurrency: string | null;
  epsBasic: number | null;
  epsDiluted: number | null;
  epsCurrency: string | null;
  notes: string[];
}

const REVENUE = new Set(['ifrs-full:Revenue', 'ifrs-full:RevenueFromContractsWithCustomers']);
const EPS_BASIC = 'ifrs-full:BasicEarningsLossPerShare';
const EPS_DILUTED = 'ifrs-full:DilutedEarningsLossPerShare';
const PROFIT = 'ifrs-full:ProfitLossAttributableToOwnersOfParent';
const SHARES_BASIC = 'ifrs-full:WeightedAverageShares';
const SHARES_DILUTED = 'ifrs-full:AdjustedWeightedAverageShares';
/** EPS must be within 5% of profit / weighted shares (or within half a cent of it, for rounding on tiny EPS). */
const EPS_TOLERANCE = 0.05;
const PLAIN_DIMS = new Set(['concept', 'entity', 'period', 'unit', 'language']);
const DAY = 86_400_000;

const dayNumber = (iso: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / DAY : NaN;
};

/** "start/end" with an exclusive end: the inclusive last day as a day number, and the length in days. */
function duration(period: unknown): { end: number; days: number } | null {
  if (typeof period !== 'string') return null;
  const [s, e] = period.split('/');
  if (!s || !e) return null;
  const start = dayNumber(s);
  const endExclusive = dayNumber(e);
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive)) return null;
  const midnight = /T00:00:00/.test(e) || !e.includes('T');
  return { end: midnight ? endExclusive - 1 : endExclusive, days: endExclusive - start };
}

/** "iso4217:XXX" → XXX, pence GBX → GBp. null for anything else. `perShare` picks the "/xbrli:shares" form. */
function currencyOf(unit: unknown, perShare: boolean): string | null {
  if (typeof unit !== 'string') return null;
  const m = perShare ? /^iso4217:([A-Z]{3})\/xbrli:shares$/.exec(unit) : /^iso4217:([A-Z]{3})$/.exec(unit);
  if (!m) return null;
  return m[1] === 'GBX' ? 'GBp' : m[1]!;
}

interface Val { value: number; currency: string }

/** The single agreed value of a field, or null (with a note) when facts disagree or none exist. */
function settle(vals: Val[], label: string, notes: string[]): Val | null {
  if (vals.length === 0) return null;
  const first = vals[0]!;
  if (vals.some((v) => v.value !== first.value || v.currency !== first.currency)) {
    notes.push(`${label}: disagreeing facts, left blank`);
    return null;
  }
  return first;
}

/**
 * Guard against a filer's mis-scaled EPS (Pirelli tags 496.0 for EUR 0.496... a x1000 slip): with owners' profit and a
 * weighted share count for the same year in the same currency, EPS must be within 5% of profit / shares. Without
 * those facts (or with zero shares / another currency) the EPS is kept as parsed.
 */
function crossChecked(eps: Val | null, profit: Val | null, shares: Val | null, label: string, notes: string[]): Val | null {
  if (!eps || !profit || !shares || shares.value <= 0) return eps;
  let scale: number;
  if (profit.currency === eps.currency) scale = 1;
  else if (profit.currency === 'GBP' && eps.currency === 'GBp') scale = 100;
  else return eps;
  const implied = (profit.value / shares.value) * scale;
  const tolerance = Math.max(Math.abs(implied) * EPS_TOLERANCE, 0.005 * scale);
  if (Math.abs(eps.value - implied) <= tolerance) return eps;
  notes.push(`${label}: ${eps.value} is not within 5% of profit / shares (${implied}), left blank`);
  return null;
}

/**
 * Annual revenue and EPS from an xBRL-JSON document. Only dimension-free facts whose duration is 12 months ending
 * `periodEnd` (± 3 days) count. Disagreeing facts blank that field; nothing is guessed or converted.
 */
export function parseEsefFacts(json: unknown, periodEnd: string): EsefFigures {
  const notes: string[] = [];
  const target = dayNumber(periodEnd);
  const facts = (json as any)?.facts;
  const revenue: Val[] = [];
  const basic: Val[] = [];
  const diluted: Val[] = [];
  const profit: Val[] = [];
  const sharesBasic: Val[] = [];
  const sharesDiluted: Val[] = [];

  if (facts && typeof facts === 'object' && !Array.isArray(facts) && Number.isFinite(target)) {
    for (const f of Object.values(facts) as any[]) {
      const dims = f?.dimensions;
      if (!dims || typeof dims !== 'object') continue;
      const concept = dims.concept;
      const isRevenue = REVENUE.has(concept);
      const isShares = concept === SHARES_BASIC || concept === SHARES_DILUTED;
      if (!isRevenue && !isShares && concept !== PROFIT && concept !== EPS_BASIC && concept !== EPS_DILUTED) continue;
      if (Object.keys(dims).some((k) => !PLAIN_DIMS.has(k))) continue; // an axis member: a sub-total, not the headline
      const d = duration(dims.period);
      if (!d || Math.abs(d.end - target) > 3 || d.days < 358 || d.days > 372) continue;
      const currency = isShares ? (dims.unit === 'xbrli:shares' ? 'shares' : null)
        : currencyOf(dims.unit, concept === EPS_BASIC || concept === EPS_DILUTED);
      if (!currency) continue;
      const raw = typeof f.value === 'string' ? f.value.trim() : f.value;
      const value = typeof raw === 'number' ? raw : raw === '' || typeof raw !== 'string' ? NaN : Number(raw);
      if (!Number.isFinite(value)) continue;
      const bucket = isRevenue ? revenue : concept === EPS_BASIC ? basic : concept === EPS_DILUTED ? diluted
        : concept === PROFIT ? profit : concept === SHARES_BASIC ? sharesBasic : sharesDiluted;
      bucket.push({ value, currency });
    }
  }

  const rev = settle(revenue, 'revenue', notes);
  const owners = settle(profit, 'profit', []);
  let b = crossChecked(settle(basic, 'epsBasic', notes), owners, settle(sharesBasic, 'sharesBasic', []), 'epsBasic', notes);
  let dl = crossChecked(settle(diluted, 'epsDiluted', notes), owners, settle(sharesDiluted, 'sharesDiluted', []), 'epsDiluted', notes);
  if (b && dl && b.currency !== dl.currency) {
    notes.push('eps: basic and diluted in different currencies, left blank');
    b = null;
    dl = null;
  }
  return {
    revenue: rev?.value ?? null,
    revenueCurrency: rev?.currency ?? null,
    epsBasic: b?.value ?? null,
    epsDiluted: dl?.value ?? null,
    epsCurrency: (b ?? dl)?.currency ?? null,
    notes,
  };
}
