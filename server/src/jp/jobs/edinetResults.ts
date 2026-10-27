import { recordSourceError } from '../../db/repo.js';
import { edinetSeen, findJpReportId, jpStocks, markEdinetSeen, mergeJpActuals } from '../db/jpRepo.js';
import { addDaysJST } from '../domain/jpCalendar.js';
import { codeFromSec, type EdinetDoc, isResultsFiling } from '../sources/edinet.js';
import { type EdinetFigures, parseEdinetXbrl } from '../sources/edinetXbrl.js';
import { guardedIn, type JpJobContext } from './context.js';

/** Any subscription key left in a message becomes `***` (Review Focus 1: the client redacts already; this is a second line). */
const redactKey = (text: string): string => text.replace(/Subscription-Key=[^&\s"')]*/g, 'Subscription-Key=***');

/** Runs an EDINET call with the key scrubbed from any error it throws (the error keeps its class for block detection). */
async function scrubbed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Error) {
      err.message = redactKey(err.message);
      if (err.stack) err.stack = redactKey(err.stack);
      throw err;
    }
    throw new Error(redactKey(String(err)));
  }
}

/** Ruling 13 polling: today's list, or the 7 days ending today (oldest first). */
export function jpEdinetDates(today: string, mode: 'today' | 'backfill'): string[] {
  if (mode === 'today') return [today];
  return Array.from({ length: 7 }, (_, i) => addDaysJST(today, i - 6));
}

/**
 * EDINET results (Ruling 13): 有価証券報告書 / 半期報告書 of active codes, read from the XBRL instance and merged as
 * year-to-date actuals (source `edinet`) into the row with the document's period end. Never creates rows and never
 * sets `releasedAt`. Each docID is handled once; a failed download is recorded as an `error` and retried with
 * backoff (bounded) on later runs. Without an EDINET client it does nothing. Returns the changed report ids.
 */
export async function refreshJpEdinet(ctx: JpJobContext, dates: string[]): Promise<number[]> {
  const { db } = ctx;
  const edinet = ctx.edinet;
  if (!edinet) {
    recordSourceError(db, 'edinet', 'EDINET_API_KEY not set', ctx.now());
    return [];
  }
  const active = new Set(jpStocks(db).filter((s) => s.active).map((s) => s.code));
  const changed: number[] = [];
  const handled = new Set<string>();

  for (const date of [...new Set(dates)]) {
    const list = await guardedIn(ctx, { name: 'edinet', run: () => scrubbed(() => edinet.docList(date)) });
    if (!list) continue;
    const docs = list.value.filter((d) => isResultsFiling(d) && active.has(codeFromSec(d.secCode)!));
    for (const doc of docs) {
      if (handled.has(doc.docID) || edinetSeen(db, doc.docID, ctx.now())) continue;
      handled.add(doc.docID);
      const r = await handle(ctx, doc);
      if (r === 'blocked') return changed;
      if (r != null) changed.push(r);
    }
  }
  return changed;
}

/** One document: the changed report id, null when nothing changed, or 'blocked' when EDINET is backing off. */
async function handle(ctx: JpJobContext, doc: EdinetDoc): Promise<number | null | 'blocked'> {
  const { db } = ctx;
  const code = codeFromSec(doc.secCode)!;
  const docType = doc.docTypeCode as '120' | '160';
  const mark = (outcome: 'merged' | 'no-row' | 'blank' | 'error') =>
    markEdinetSeen(db, doc.docID, code, docType, doc.periodEnd, outcome, ctx.now());

  if (!doc.periodEnd) {
    mark('no-row');
    return null;
  }
  const periodEnd = doc.periodEnd;

  let failed: string | null = null;
  const fail = (why: string) => {
    // Recorded as an error and retried with backoff; the text is scrubbed before it is logged.
    console.error(`[edinet] ${doc.docID}: ${redactKey(why)}`);
    mark('error');
  };
  const got = await guardedIn(ctx, {
    name: 'edinet',
    run: () => scrubbed(async () => {
      try {
        return await ctx.edinet!.xbrlInstance(doc.docID);
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }),
  });
  if (!got) {
    if (failed == null) return 'blocked'; // backing off: not attempted, nothing recorded
    fail(failed);
    return null;
  }

  let f: EdinetFigures;
  try {
    f = parseEdinetXbrl(got.value, { docTypeCode: docType, periodEnd });
  } catch (err) {
    fail(`parse: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (f.revenue == null && f.epsBasic == null && f.epsDiluted == null) {
    mark('blank');
    return null;
  }
  const id = findJpReportId(db, code, periodEnd);
  if (id == null) {
    mark('no-row');
    return null;
  }
  const ytdMonths = f.ytdMonths;
  const changed = mergeJpActuals(db, id, {
    revenue: f.revenue != null ? { value: f.revenue, currency: 'JPY', span: 'ytd', ytdMonths } : null,
    eps: f.epsBasic != null || f.epsDiluted != null
      ? { basic: f.epsBasic, diluted: f.epsDiluted, currency: 'JPY', span: 'ytd', ytdMonths }
      : null,
    source: 'edinet',
    edinetDocId: doc.docID,
  }, ctx.now());
  mark('merged');
  return changed ? id : null;
}
