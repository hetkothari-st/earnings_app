import { HttpError, SourceFormatError } from '../../sources/http.js';
import { unzipEntries } from '../../sources/zip.js';

/**
 * EDINET API v2 (Financial Services Agency, PDL1.0). Source: EDINET (Financial Services Agency), edited.
 *
 * - Document list: `https://api.edinet-fsa.go.jp/api/v2/documents.json?date=YYYY-MM-DD&type=2&Subscription-Key=KEY`
 * - Document:      `https://api.edinet-fsa.go.jp/api/v2/documents/{docID}?type=1&Subscription-Key=KEY` → ZIP
 *   whose main instance is `XBRL/PublicDoc/*.xbrl` (audit files under `XBRL/AuditDoc/` are ignored).
 * - Code list (no key): `https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip`
 *   → `EdinetcodeDlInfo.csv` in Shift_JIS.
 *
 * The key is never logged and never put into an error: every message that holds a request URL has the key
 * replaced by `***` (`Subscription-Key=***`).
 *
 * LIVE API CHECK PENDING: written without an EDINET_API_KEY (2026-10-27). The document-list fixture is
 * hand-built from the API v2 specification; the XBRL corpus was downloaded by hand from the EDINET viewer.
 */

const API = 'https://api.edinet-fsa.go.jp/api/v2';
export const EDINET_CODE_LIST_URL = 'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip';

export interface EdinetDoc {
  docID: string;
  edinetCode: string;
  secCode: string | null;
  filerName: string;
  docTypeCode: string;
  ordinanceCode: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** `YYYY-MM-DD hh:mm`, JST. */
  submitDateTime: string;
  withdrawalStatus: string;
  xbrlFlag: string;
}

export interface EdinetClient {
  docList(date: string): Promise<EdinetDoc[]>;
  xbrlInstance(docID: string): Promise<string>;
}

/** Replace the subscription key in any text with `***`. */
function redact(text: string, key: string): string {
  let out = text.replace(/Subscription-Key=[^&\s"']*/g, 'Subscription-Key=***');
  if (key) out = out.split(key).join('***');
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeEdinetClient(o: { key: string; fetchImpl?: typeof fetch; minIntervalMs?: number }): EdinetClient {
  const { key, fetchImpl = fetch, minIntervalMs = 1000 } = o;
  let next = 0;

  async function get(path: string): Promise<Response> {
    const url = `${API}${path}${path.includes('?') ? '&' : '?'}Subscription-Key=${encodeURIComponent(key)}`;
    const safe = redact(url, key);
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + minIntervalMs;
    if (slot > now) await sleep(slot - now);
    let res: Response;
    try {
      res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      // A new error without `cause`: the original may carry the URL.
      const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new Error(`EDINET request failed for ${safe}: ${redact(why, key)}`);
    }
    if (!res.ok) throw new HttpError(res.status, safe);
    return res;
  }

  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

  return {
    async docList(date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SourceFormatError(`EDINET document list: bad date ${date}`);
      const path = `/documents.json?date=${date}&type=2`;
      const res = await get(path);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new SourceFormatError(`EDINET document list for ${date}: not JSON (Subscription-Key=***)`);
      }
      const b = body as { metadata?: { status?: unknown; message?: unknown }; results?: unknown };
      const status = b?.metadata?.status;
      if (String(status) !== '200') {
        throw new SourceFormatError(
          `EDINET document list for ${date}: status ${redact(String(status), key)} ${redact(String(b?.metadata?.message ?? ''), key)} (Subscription-Key=***)`,
        );
      }
      if (!Array.isArray(b.results)) throw new SourceFormatError(`EDINET document list for ${date}: no results (Subscription-Key=***)`);
      const docs: EdinetDoc[] = [];
      for (const r of b.results as Record<string, unknown>[]) {
        const docID = str(r?.docID);
        if (!docID) continue;
        docs.push({
          docID,
          edinetCode: str(r.edinetCode) ?? '',
          secCode: str(r.secCode),
          filerName: str(r.filerName) ?? '',
          docTypeCode: str(r.docTypeCode) ?? '',
          ordinanceCode: str(r.ordinanceCode),
          periodStart: str(r.periodStart),
          periodEnd: str(r.periodEnd),
          submitDateTime: str(r.submitDateTime) ?? '',
          withdrawalStatus: str(r.withdrawalStatus) ?? '',
          xbrlFlag: str(r.xbrlFlag) ?? '',
        });
      }
      return docs;
    },

    async xbrlInstance(docID) {
      if (!/^[A-Za-z0-9]+$/.test(docID)) throw new SourceFormatError(`EDINET document: bad docID ${docID}`);
      const res = await get(`/documents/${docID}?type=1`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const found = unzipEntries(buf, (name) => /(^|\/)XBRL\/PublicDoc\/[^/]+\.xbrl$/.test(name));
      if (found.size !== 1) {
        throw new SourceFormatError(`EDINET document ${docID}: ${found.size} PublicDoc instances, expected 1 (Subscription-Key=***)`);
      }
      return new TextDecoder('utf-8').decode([...found.values()][0]);
    },
  };
}

/**
 * Ruling 13: only 有価証券報告書 (`120`) and 半期報告書 (`160`) under the ordinance for listed companies (`010`),
 * not withdrawn, with XBRL, and with a usable securities code. The active-universe check is the caller's.
 */
export function isResultsFiling(d: EdinetDoc): boolean {
  return (
    (d.docTypeCode === '120' || d.docTypeCode === '160') &&
    d.ordinanceCode === '010' &&
    d.withdrawalStatus === '0' &&
    d.xbrlFlag === '1' &&
    codeFromSec(d.secCode) !== null
  );
}

/** Ruling 2: EDINET `72030` → `7203`, `285A0` → `285A`; a 5-character code not ending in `0` → null. */
export function codeFromSec(secCode: string | null): string | null {
  if (!secCode || !/^[0-9][0-9A-Z]{3}0$/.test(secCode)) return null;
  return secCode.slice(0, 4);
}

/** The EDINET code list CSV (`EdinetcodeDlInfo.csv`), decoded from Shift_JIS. No key needed. */
export async function fetchEdinetCodeList(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(EDINET_CODE_LIST_URL, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new HttpError(res.status, EDINET_CODE_LIST_URL);
  const buf = new Uint8Array(await res.arrayBuffer());
  const found = unzipEntries(buf, (name) => /\.csv$/i.test(name));
  if (found.size !== 1) throw new SourceFormatError(`EDINET code list: ${found.size} CSV files, expected 1`);
  return new TextDecoder('shift_jis').decode([...found.values()][0]);
}
