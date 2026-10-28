import { z } from 'zod';
import { normalizeTicker } from '../domain/ticker.js';
import type { Filing } from '../types.js';
import { type Http, SourceFormatError } from './http.js';

export interface SecTicker {
  cik: number;
  exchange: string | null;
  /** Company name as SEC lists it (empty when missing). */
  name?: string;
}

const TickersSchema = z.object({
  fields: z.array(z.string()),
  data: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
});

export function parseSecTickers(json: unknown): Map<string, SecTicker> {
  const parsed = TickersSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`SEC tickers: ${parsed.error.message}`);
  const { fields, data } = parsed.data;
  const iCik = fields.indexOf('cik');
  const iTicker = fields.indexOf('ticker');
  const iExchange = fields.indexOf('exchange');
  const iName = fields.indexOf('name');
  if (iCik < 0 || iTicker < 0 || iExchange < 0) throw new SourceFormatError(`SEC tickers: unexpected fields ${fields.join(',')}`);
  const map = new Map<string, SecTicker>();
  for (const row of data) {
    const cik = Number(row[iCik]);
    const ticker = row[iTicker];
    const exchange = row[iExchange];
    if (typeof ticker !== 'string' || !Number.isFinite(cik)) continue;
    const key = normalizeTicker(ticker);
    if (!map.has(key)) map.set(key, { cik, exchange: typeof exchange === 'string' ? exchange : null, name: typeof row[iName] === 'string' ? (row[iName] as string) : '' });
  }
  return map;
}

const SubmissionsSchema = z.object({
  /** Fiscal year end, "MMDD" (optional and unchecked here: its absence or shape never fails the filings parse). */
  fiscalYearEnd: z.unknown().optional(),
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      filingDate: z.array(z.string()),
      form: z.array(z.string()),
      items: z.array(z.string()),
      primaryDocument: z.array(z.string()),
    }),
  }),
});

export function parseEarningsFilings(json: unknown, cik: number): Filing[] {
  const parsed = SubmissionsSchema.safeParse(json);
  if (!parsed.success) throw new SourceFormatError(`SEC submissions ${cik}: ${parsed.error.message}`);
  const r = parsed.data.filings.recent;
  const out: Filing[] = [];
  r.form.forEach((form, i) => {
    if (form !== '8-K' && form !== '6-K') return;
    // 8-K: only Item 2.02 (results). 6-K (foreign issuers) has no item codes, so all are listed.
    const items = (r.items[i] ?? '').split(',').map((s) => s.trim());
    if (form === '8-K' && !items.includes('2.02')) return;
    const accession = r.accessionNumber[i] ?? '';
    const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}`;
    out.push({
      accession,
      form,
      filingDate: r.filingDate[i] ?? '',
      docUrl: `${base}/${r.primaryDocument[i] ?? ''}`,
      indexUrl: `${base}/${accession}-index.htm`,
    });
  });
  return out;
}

/** The submissions JSON's `fiscalYearEnd` ("MMDD", e.g. "1231"), or null when absent or not a valid month-day. */
export function parseFiscalYearEnd(json: unknown): string | null {
  const parsed = SubmissionsSchema.pick({ fiscalYearEnd: true }).safeParse(json);
  const v = parsed.success ? parsed.data.fiscalYearEnd : undefined;
  return typeof v === 'string' && /^(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(v) ? v : null;
}

/** <ACCEPTANCE-DATETIME>yyyyMMddHHmmss is ET wall clock (verified against EDGAR index pages). */
export function parseAcceptance(text: string): string {
  const m = /<ACCEPTANCE-DATETIME>(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(text);
  if (!m) throw new SourceFormatError('SEC header: ACCEPTANCE-DATETIME not found');
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

export async function fetchSecTickers(http: Http): Promise<Map<string, SecTicker>> {
  return parseSecTickers(await http.json('https://www.sec.gov/files/company_tickers_exchange.json'));
}

export async function fetchEarningsFilings(http: Http, cik: number): Promise<Filing[]> {
  const padded = String(cik).padStart(10, '0');
  return parseEarningsFilings(await http.json(`https://data.sec.gov/submissions/CIK${padded}.json`), cik);
}

export async function fetchAcceptance(http: Http, cik: number, accession: string): Promise<string> {
  const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${accession}.hdr.sgml`;
  return parseAcceptance(await http.text(url));
}
