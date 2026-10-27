/**
 * Corpus harness for the fast readers.
 *   npm run reader-corpus -w server                    (US press releases, print only)
 *   npm run reader-corpus -w server -- --write         (also write test/fixtures/us/releases/report.json)
 *   npm run reader-corpus -w server -- --india [--write] (India results PDFs, test/fixtures/india/pdf/)
 *   npm run reader-corpus -w server -- --hk            (HK 6-K releases, test/fixtures/hk/releases/, exact match)
 * Reads every test/fixtures/us/releases/*.htm and compares accepted values with
 * expected.json (EPS ±0.01, revenue ±0.5%). Adjusted EPS is gated against Nasdaq;
 * GAAP EPS against the release (hand-read); revenue against Finnhub or the release.
 * An accepted value whose expected figure is null counts as a miss.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { HkPeriodKind } from '../hk/domain/period.js';
import { readHkRelease } from '../hk/sources/releaseHk.js';
import { HK_UNIVERSE } from '../hk/universe.js';
import { readInResultsPdf } from '../india/sources/resultsPdf.js';
import { readUsRelease } from '../sources/releaseReader.js';

const write = process.argv.includes('--write');
const MIN_RATE = 95;
const MIN_COMPARED = 20;
interface Stat { accepted: number; compared: number; matched: number; unverified: number; rate: number | null; gatePasses: boolean }
const newStats = <F extends string>(fields: readonly F[]) =>
  Object.fromEntries(fields.map((f) => [f, { accepted: 0, compared: 0, matched: 0, unverified: 0, rate: null, gatePasses: false }])) as Record<F, Stat>;
function finish(s: Stat): void {
  s.rate = s.compared ? Math.round((s.matched / s.compared) * 1000) / 10 : null;
  s.gatePasses = s.rate !== null && s.rate >= MIN_RATE && s.compared >= MIN_COMPARED;
}

if (process.argv.includes('--india')) await runIndia();
else if (process.argv.includes('--hk')) runHk();
else runUs();

/**
 * HK (Ruling 10): every hand-checked entry of test/fixtures/hk/releases/expected.json is read for its period.
 * A field is exact when equal to the hand-read value (EPS to the stated decimals, revenue to the unit), blank
 * when the reader returned null, wrong otherwise. A release is exact when all five fields are; the gate needs
 * >= 20 checked releases, all exact, none wrong.
 */
function runHk(): void {
  const dir = fileURLToPath(new URL('../../test/fixtures/hk/releases/', import.meta.url));
  interface HkExpected {
    adr: string; periodEnd: string; kind: HkPeriodKind; checked: boolean; note: string;
    eps: number | null; epsBasis: string | null; epsCurrency: string | null; revenue: number | null; revenueCurrency: string | null;
  }
  const FIELDS = ['eps', 'epsBasis', 'epsCurrency', 'revenue', 'revenueCurrency'] as const;
  const expected: Record<string, HkExpected> = JSON.parse(readFileSync(`${dir}expected.json`, 'utf8'));
  let checked = 0, exact = 0, wrong = 0, unchecked = 0;
  for (const [file, e] of Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))) {
    if (!e.checked) { unchecked++; continue; }
    checked++;
    const adrRatio = HK_UNIVERSE.find((u) => u.adr === e.adr)?.adrRatio ?? null;
    const got = readHkRelease(readFileSync(`${dir}${file}`, 'utf8'), { periodEnd: e.periodEnd, kind: e.kind }, { adrRatio });
    const marks = FIELDS.map((f) => (got[f] === e[f] ? 'exact' : got[f] === null ? 'blank' : 'wrong'));
    const verdict = marks.includes('wrong') ? 'wrong' : marks.includes('blank') ? 'blank' : 'exact';
    if (verdict === 'exact') exact++;
    if (verdict === 'wrong') wrong++;
    console.log(`${verdict.padEnd(5)} ${file} (${e.kind})`);
    FIELDS.forEach((f, i) => { if (marks[i] !== 'exact') console.log(`      ${f}: got ${got[f]}, expected ${e[f]} [${marks[i]}]`); });
    if (verdict !== 'exact' && got.notes.length) console.log(`      notes: ${got.notes.join('; ')}`);
  }
  const gatePasses = checked >= 20 && exact === checked && wrong === 0;
  console.log(`checked ${checked}, exact ${exact}, wrong ${wrong}${unchecked ? `, not yet checked ${unchecked}` : ''}`);
  for (const k of ['hkEps', 'hkRevenue'] as const) {
    const cfg = config.fastFields[k] ?? false;
    console.log(`${k}=${gatePasses}  config ${cfg}${cfg === gatePasses ? '' : '  <-- config disagrees with corpus'}`);
  }
}

function runUs(): void {
const dir = fileURLToPath(new URL('../../test/fixtures/us/releases/', import.meta.url));

interface Expected {
  symbol: string;
  quarterEnd: string;
  epsAdjusted: number | null;
  epsGaap: number | null;
  revenue: number | null;
  releaseEpsAdjusted?: number;
  note?: string;
}

const FIELDS = ['epsAdjusted', 'epsGaap', 'revenue'] as const;
type Field = (typeof FIELDS)[number];
const GATE: Record<Field, keyof typeof config.fastFields> = { epsAdjusted: 'usEpsAdjusted', epsGaap: 'usEpsGaap', revenue: 'usRevenue' };

const matches = (f: Field, got: number, want: number) =>
  f === 'revenue' ? Math.abs(got - want) <= 0.005 * Math.abs(want) : Math.abs(got - want) <= 0.01 + 1e-9;

const expected: Record<string, Expected> = JSON.parse(readFileSync(`${dir}expected.json`, 'utf8'));
const files = readdirSync(dir).filter((f) => f.endsWith('.htm')).sort();

const stats = newStats(FIELDS);
const mismatches: Array<{ file: string; field: Field; got: number; expected: number | null; matchesRelease?: boolean; note?: string }> = [];
const perFile: Array<Record<string, unknown>> = [];

for (const file of files) {
  const e = expected[file];
  if (!e) throw new Error(`expected.json has no entry for ${file}`);
  const v = readUsRelease(readFileSync(`${dir}${file}`, 'utf8'), e.quarterEnd);
  perFile.push({ file, symbol: e.symbol, epsAdjusted: v.epsAdjusted, epsGaap: v.epsGaap, revenue: v.revenue, unit: v.unit, notes: v.notes });
  for (const f of FIELDS) {
    const got = v[f];
    if (got === null) continue;
    const s = stats[f];
    s.accepted++;
    s.compared++;
    const want = e[f];
    const note = e.note ? { note: e.note } : {};
    if (want === null) {
      s.unverified++;
      mismatches.push({ file, field: f, got, expected: null, ...note });
    } else if (matches(f, got, want)) {
      s.matched++;
    } else {
      const rel = f === 'epsAdjusted' && e.releaseEpsAdjusted !== undefined ? { matchesRelease: matches(f, got, e.releaseEpsAdjusted) } : {};
      mismatches.push({ file, field: f, got, expected: want, ...rel, ...note });
    }
  }
}
for (const f of FIELDS) finish(stats[f]);

console.log(`Corpus: ${files.length} releases (gate: rate >= ${MIN_RATE}% over >= ${MIN_COMPARED} accepted values)`);
console.log('field        accepted  matched  rate    gate            config');
for (const f of FIELDS) {
  const s = stats[f];
  const cfg = config.fastFields[GATE[f]];
  const flag = cfg === s.gatePasses ? '' : '  <-- config disagrees with corpus';
  console.log(`${f.padEnd(12)} ${String(s.accepted).padStart(8)}  ${String(s.matched).padStart(7)}  ${(s.rate === null ? '—' : `${s.rate}%`).padEnd(6)}  ${`${GATE[f]}=${s.gatePasses}`.padEnd(18)} ${cfg}${flag}`);
}
for (const m of mismatches) {
  const rel = m.matchesRelease === undefined ? '' : m.matchesRelease ? ' [matches the release]' : ' [does not match the release either]';
  console.log(`  miss ${m.file} ${m.field}: got ${m.got}, expected ${m.expected}${rel}${m.note ? ` (${m.note})` : ''}`);
}

if (write) {
  writeFileSync(
    `${dir}report.json`,
    JSON.stringify({ files: files.length, tolerance: { eps: 0.01, revenuePct: 0.5 }, gate: { minRate: MIN_RATE, minCompared: MIN_COMPARED }, fields: stats, mismatches, perFile }, null, 2) + '\n',
  );
  console.log(`Wrote ${dir}report.json`);
}
}

/**
 * India: every test/fixtures/india/pdf/*.pdf is read for its quarter and compared with expected.json, which
 * holds the company's XBRL filing figures (consolidated when filed). EPS within 0.01, revenue and profit within
 * 0.5%. A value read on the other basis, or of the other revenue kind, is a miss; so is one with no expected figure.
 */
async function runIndia(): Promise<void> {
  const dir = fileURLToPath(new URL('../../test/fixtures/india/pdf/', import.meta.url));
  interface InExpected {
    symbol: string; quarterEnd: string; type: 'company' | 'bank' | 'nbfc';
    basis: 'Consolidated' | 'Standalone'; eps: number | null; revenue: number | null;
    revenueKind: 'revenue-from-ops' | 'total-income'; profit: number | null; note?: string;
  }
  const FIELDS = ['eps', 'revenue', 'profit'] as const;
  type Field = (typeof FIELDS)[number];
  const GATE: Record<Field, keyof typeof config.fastFields> = { eps: 'inEps', revenue: 'inRevenue', profit: 'inProfit' };
  const matches = (f: Field, got: number, want: number) =>
    f === 'eps' ? Math.abs(got - want) <= 0.01 + 1e-9 : Math.abs(got - want) <= 0.005 * Math.abs(want) + 1e-6;

  const expected: Record<string, InExpected> = JSON.parse(readFileSync(`${dir}expected.json`, 'utf8'));
  const files = readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();
  const stats = newStats(FIELDS);
  const mismatches: Array<{ file: string; field: Field; got: number; expected: number | null; reason: string; note?: string }> = [];
  const perFile: Array<Record<string, unknown>> = [];
  const types = { company: 0, bank: 0, nbfc: 0 };

  for (const file of files) {
    const e = expected[file];
    if (!e) throw new Error(`expected.json has no entry for ${file}`);
    types[e.type]++;
    const v = await readInResultsPdf(new Uint8Array(readFileSync(`${dir}${file}`)), e.quarterEnd);
    perFile.push({ file, symbol: e.symbol, type: e.type, basis: v.basis, eps: v.eps, revenue: v.revenue, revenueKind: v.revenueKind, profit: v.profit, notes: v.notes });
    for (const f of FIELDS) {
      const got = v[f];
      if (got === null) continue;
      const s = stats[f];
      s.accepted++;
      s.compared++;
      const want = e[f];
      const note = e.note ? { note: e.note } : {};
      if (v.basis !== e.basis) mismatches.push({ file, field: f, got, expected: want, reason: `basis ${v.basis}, filing ${e.basis}`, ...note });
      else if (f === 'revenue' && v.revenueKind !== e.revenueKind) mismatches.push({ file, field: f, got, expected: want, reason: `kind ${v.revenueKind}, filing ${e.revenueKind}`, ...note });
      else if (want === null) { s.unverified++; mismatches.push({ file, field: f, got, expected: null, reason: 'not in the filing', ...note }); }
      else if (matches(f, got, want)) s.matched++;
      else mismatches.push({ file, field: f, got, expected: want, reason: 'value', ...note });
    }
  }
  for (const f of FIELDS) finish(stats[f]);

  console.log(`Corpus: ${files.length} results PDFs (${types.company} companies, ${types.bank} banks, ${types.nbfc} NBFCs); gate: rate >= ${MIN_RATE}% over >= ${MIN_COMPARED} compared values`);
  console.log('field     accepted  compared  matched  rate    gate            config');
  for (const f of FIELDS) {
    const s = stats[f];
    const cfg = config.fastFields[GATE[f]];
    const flag = cfg === s.gatePasses ? '' : '  <-- config disagrees with corpus';
    console.log(`${f.padEnd(9)} ${String(s.accepted).padStart(8)}  ${String(s.compared).padStart(8)}  ${String(s.matched).padStart(7)}  ${(s.rate === null ? '—' : `${s.rate}%`).padEnd(6)}  ${`${GATE[f]}=${s.gatePasses}`.padEnd(15)} ${cfg}${flag}`);
  }
  for (const m of mismatches) console.log(`  miss ${m.file} ${m.field}: got ${m.got}, expected ${m.expected} (${m.reason})${m.note ? ` — ${m.note}` : ''}`);

  if (write) {
    writeFileSync(
      `${dir}report.json`,
      JSON.stringify({ files: files.length, types, tolerance: { eps: 0.01, revenuePct: 0.5, profitPct: 0.5 }, gate: { minRate: MIN_RATE, minCompared: MIN_COMPARED }, fields: stats, mismatches, perFile }, null, 2) + '\n',
    );
    console.log(`Wrote ${dir}report.json`);
  }
}
