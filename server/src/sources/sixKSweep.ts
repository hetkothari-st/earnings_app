import type { DatabaseSync } from 'node:sqlite';
import { DateTime } from 'luxon';
import { ET } from '../domain/marketCalendar.js';
import { guardedIn } from '../india/jobs/context.js';
import type { Http } from './http.js';
import { fetchAcceptance, fetchEarningsFilings } from './sec.js';
import type { SixKMarket } from './sixKWatch.js';

/**
 * Per-CIK submissions sweep, the backstop for the 6-K feed: every full-level CIK of `market`, with or without a
 * calendar row. Filings dated on or after `since` (a date notice can come weeks before the results) and not yet
 * seen get the acceptance time (ET wall clock in the SEC header, as UTC ISO) and go through `market.handle`,
 * oldest first so the earliest filing of a report is the one that sticks. Returns the changed report ids.
 */
export async function sweepSixK(
  base: { db: DatabaseSync; now(): string }, http: Http, market: SixKMarket, since: string,
): Promise<number[]> {
  const changed = new Set<number>();
  for (const cik of market.ciks()) {
    const filings = (await guardedIn(base, { name: 'sec-submissions', run: () => fetchEarningsFilings(http, cik) }))?.value;
    if (!filings) continue;
    const fresh = filings.filter((f) => f.filingDate >= since && !market.seen(f.accession))
      .sort((a, b) => a.filingDate.localeCompare(b.filingDate) || a.accession.localeCompare(b.accession));
    for (const f of fresh) {
      try {
        const et = await fetchAcceptance(http, cik, f.accession);
        const acceptedAt = DateTime.fromISO(et, { zone: ET }).toUTC().toISO()!;
        for (const id of await market.handle({ cik, accession: f.accession, indexUrl: f.indexUrl, acceptedAt, form: f.form })) changed.add(id);
      } catch (err) {
        console.error(`[${market.name}-sec-sweep] ${cik} ${f.accession}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return [...changed];
}
