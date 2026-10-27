import { DateTime } from 'luxon';
import { ET } from '../../domain/marketCalendar.js';
import { fetchAcceptance, fetchEarningsFilings } from '../../sources/sec.js';
import { hkReportsBetween, secSeen } from '../db/hkRepo.js';
import { addDaysHKT } from '../domain/hkCalendar.js';
import { handleHkFiling } from '../live/hkSecWatch.js';
import { guardedIn, type HkJobContext } from './context.js';

/**
 * Per-CIK submissions sweep (Ruling 11), the backstop for the 6-K feed: full-level stocks with a report in
 * [today-5, today+30] (HKT). Their filings dated on or after today-10 and not yet seen get the acceptance time
 * (ET wall clock in the SEC header) and go through `handleHkFiling`. Without the SEC client nothing runs.
 * Returns the released and re-dated report ids.
 */
export async function sweepHkSec(ctx: HkJobContext): Promise<number[]> {
  const http = ctx.secHttp;
  if (!http) return [];
  const today = ctx.todayHKT();
  const since = addDaysHKT(today, -10);
  const ciks = [...new Set(hkReportsBetween(ctx.db, addDaysHKT(today, -5), addDaysHKT(today, 30))
    .filter((r) => r.level === 'full' && r.cik != null).map((r) => r.cik!))];
  const changed = new Set<number>();
  for (const cik of ciks) {
    const filings = (await guardedIn(ctx, { name: 'sec-submissions', run: () => fetchEarningsFilings(http, cik) }))?.value;
    if (!filings) continue;
    // Oldest first, so the earliest filing of a report is the one that sticks.
    const fresh = filings.filter((f) => f.filingDate >= since && !secSeen(ctx.db, f.accession))
      .sort((a, b) => a.filingDate.localeCompare(b.filingDate) || a.accession.localeCompare(b.accession));
    for (const f of fresh) {
      try {
        const et = await fetchAcceptance(http, cik, f.accession);
        const acceptedAt = DateTime.fromISO(et, { zone: ET }).toUTC().toISO()!;
        const r = await handleHkFiling(ctx, { cik, accession: f.accession, indexUrl: f.indexUrl, acceptedAt, form: f.form });
        for (const id of [...r.released, ...r.dated]) changed.add(id);
      } catch (err) {
        console.error(`[hk-sec-sweep] ${cik} ${f.accession}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return [...changed];
}
