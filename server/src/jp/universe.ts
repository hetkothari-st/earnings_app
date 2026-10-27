/**
 * Japan universe. Listed companies come from the EDINET code list (about 3,800); the 8 full-level
 * names (SEC 6-K filer with an ADR and a Cboe chain) are hand-kept in JP_FULL and live-verified by
 * `npm run verify-jp-universe`. Everything else is basic level (Yahoo + EDINET).
 */
import { SourceFormatError } from '../sources/http.js';

export interface JpUniverseEntry {
  /** 4 characters, e.g. '7203' or '285A'. */
  code: string;
  edinetCode: string;
  name: string;
  nameJa: string;
  fyEndMonth: number | null;
  industryJa: string | null;
  adr: string | null;
  /** Tokyo shares per ADS (may be fractional). */
  adrRatio: number | null;
  cik: number | null;
}

export interface JpFullEntry {
  code: string;
  adr: string;
  adrRatio: number;
  cik: number;
  /** English name variants as the issuer's releases print them (the 6-K reader allows only these in group headings). */
  names?: readonly string[];
  /**
   * The ratio is display-only and shown only when true: `npm run verify-jp-universe` found the 20-F ratio and the
   * price-implied one (ADR close × USD/JPY ÷ Tokyo close) within 15% of each other. Recorded by hand from its output.
   */
  adrRatioVerified: boolean;
}

/** Live-verified by `npm run verify-jp-universe` (SEC company_tickers.json, Cboe chain, latest 20-F). */
export const JP_FULL: readonly JpFullEntry[] = [
  { code: '7203', adr: 'TM', adrRatio: 10, cik: 1094517, names: ['Toyota Motor Corporation'], adrRatioVerified: true },
  { code: '6758', adr: 'SONY', adrRatio: 1, cik: 313838, names: ['Sony Group Corporation'], adrRatioVerified: true },
  { code: '8306', adr: 'MUFG', adrRatio: 1, cik: 67088, names: ['Mitsubishi UFJ Financial Group, Inc.', 'Mitsubishi UFJ Financial Group'], adrRatioVerified: true },
  { code: '8316', adr: 'SMFG', adrRatio: 0.6, cik: 1022837, names: ['Sumitomo Mitsui Financial Group, Inc.', 'Sumitomo Mitsui Financial Group'], adrRatioVerified: false },
  { code: '8411', adr: 'MFG', adrRatio: 2, cik: 1335730, names: ['Mizuho Financial Group, Inc.', 'Mizuho Financial Group'], adrRatioVerified: false },
  { code: '7267', adr: 'HMC', adrRatio: 3, cik: 715153, names: ['Honda Motor Co., Ltd.'], adrRatioVerified: true },
  { code: '8604', adr: 'NMR', adrRatio: 1, cik: 1163653, names: ['Nomura Holdings, Inc.', 'Nomura Holdings'], adrRatioVerified: true },
  { code: '4502', adr: 'TAK', adrRatio: 0.5, cik: 1395064, names: ['Takeda Pharmaceutical Company Limited', 'Takeda Pharmaceutical Co., Ltd.'], adrRatioVerified: true },
];

/** The ADR ratio as served (display only): the stored ratio when the code's full-level entry is verified, else null. */
export function jpAdrRatioShown(code: string, ratio: number | null, full: readonly Pick<JpFullEntry, 'code' | 'adrRatioVerified'>[] = JP_FULL): number | null {
  return ratio != null && full.find((e) => e.code === code)?.adrRatioVerified === true ? ratio : null;
}

/** The 6-K reader's issuer identity for a full-level name (by TSE code or ADR ticker): its names and ADR ticker. */
export function jpIssuerFor(codeOrAdr: string): { names: readonly string[]; ticker: string } | undefined {
  const e = JP_FULL.find((f) => f.code === codeOrAdr || f.adr === codeOrAdr);
  return e ? { names: e.names ?? [], ticker: e.adr } : undefined;
}

const HEADER =
  'ＥＤＩＮＥＴコード,提出者種別,上場区分,連結の有無,資本金,決算日,提出者名,提出者名（英字）,提出者名（ヨミ）,所在地,提出者業種,証券コード,提出者法人番号';

/** Minimal CSV line splitter: quoted fields, doubled quotes, commas inside quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** "3月31日" and "2月末日" both give the month; anything else is null. */
function fyMonth(s: string): number | null {
  const m = /^(\d{1,2})月(?:\d{1,2}日|末日)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? n : null;
}

/** The decoded (UTF-8) text of EdinetcodeDlInfo.csv: a metadata line, the header, then rows. */
export function parseEdinetCodeList(csv: string): JpUniverseEntry[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2 || splitCsvLine(lines[1]!).join(',') !== HEADER) {
    throw new SourceFormatError('EDINET code list: header line does not match the expected columns');
  }
  const out: JpUniverseEntry[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(2)) {
    const f = splitCsvLine(line);
    if (f.length < 12) continue;
    if (f[2] !== '上場') continue;
    const sec = f[11]!.trim();
    if (!sec) continue;
    if (sec.length !== 5 || !sec.endsWith('0')) continue;
    const code = sec.slice(0, 4);
    if (!/^[0-9][0-9A-Z]{3}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    const nameJa = f[6]!.trim();
    out.push({
      code,
      edinetCode: f[0]!.trim(),
      name: f[7]!.trim() || nameJa,
      nameJa,
      fyEndMonth: fyMonth(f[5]!),
      industryJa: f[10]!.trim() || null,
      adr: null,
      adrRatio: null,
      cik: null,
    });
  }
  return out;
}

/** Full entries override level/ADR/CIK; a full code missing from the list is appended with name = adr. */
export function buildJpUniverse(listed: JpUniverseEntry[], full: readonly Pick<JpFullEntry, 'code' | 'adr' | 'adrRatio' | 'cik'>[] = JP_FULL): JpUniverseEntry[] {
  const fullBy = new Map(full.map((f) => [f.code, f]));
  const out = listed.map((e) => {
    const f = fullBy.get(e.code);
    return f ? { ...e, adr: f.adr, adrRatio: f.adrRatio, cik: f.cik } : e;
  });
  const have = new Set(listed.map((e) => e.code));
  for (const f of full) {
    if (have.has(f.code)) continue;
    console.warn(`jp universe: full-level code ${f.code} (${f.adr}) is not in the EDINET code list; kept`);
    out.push({
      code: f.code, edinetCode: '', name: f.adr, nameJa: f.adr, fyEndMonth: null, industryJa: null,
      adr: f.adr, adrRatio: f.adrRatio, cik: f.cik,
    });
  }
  return out;
}

export const jpLevel = (e: Pick<JpUniverseEntry, 'cik' | 'adr'>): 'full' | 'basic' => (e.cik != null && e.adr != null ? 'full' : 'basic');

export const yahooJpSymbol = (code: string): string => `${code}.T`;

export const JP_INDICES = [
  { name: 'Nikkei 225', yahoo: '^N225' },
  { name: 'TOPIX (ETF 1306)', yahoo: '1306.T' },
] as const;
