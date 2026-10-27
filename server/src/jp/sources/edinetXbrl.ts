/**
 * Revenue and EPS out of an EDINET `XBRL/PublicDoc/*.xbrl` instance (有価証券報告書 `120`, 半期報告書 `160`).
 * Source: EDINET (Financial Services Agency), edited (PDL1.0).
 *
 * Rules (plan Ruling 14):
 * - The accounting standard comes from `jpdei_cor:AccountingStandardsDEI` (`Japan GAAP` / `IFRS` / `US GAAP`);
 *   anything else gives all blank.
 * - Facts are chosen by context **period**, never by context id: the duration context that starts on
 *   `jpdei_cor:CurrentFiscalYearStartDateDEI` and ends on the document's `periodEnd`, with no dimension members.
 *   Only when `jpdei_cor:WhetherConsolidatedFinancialStatementsArePreparedDEI` is `false` is the variant with the
 *   single member `NonConsolidatedMember` used instead.
 * - That span must be 12 months for `120` and 6 months for `160`; otherwise everything is blank.
 * - Amounts need unit `JPY` (one measure, `iso4217:JPY`); EPS needs `JPYPerShares` (JPY ÷ shares). Any other
 *   unit on a listed element blanks the field. `xsi:nil="true"` facts are blank. Values are full yen; the
 *   `decimals` attribute is ignored.
 * - Every element of a field's table that has a value must agree; otherwise the field is blank.
 * - Revenue never uses an ordinary-income element (`OrdinaryIncome…` = 経常収益/経常利益 of banks and insurers),
 *   nor `OperatingIncome…` / `GrossProfit…`. Such names are simply absent from the tables.
 * - Names are matched without their namespace prefix (as in `india/sources/xbrl.ts`). Unknown names give blank.
 *
 * Element list, confirmed 2026-10-27 against the corpus in `test/fixtures/jp/edinet/` (Nintendo 有報 + 半期,
 * Toyota 有報, Takeda 半期, Nomura 有報, MUFG 有報, 三晃金属工業 有報) and the plan's taxonomy starting list:
 *   DEI    jpdei_cor: AccountingStandardsDEI, CurrentFiscalYearStartDateDEI, CurrentPeriodEndDateDEI,
 *          TypeOfCurrentPeriodDEI, SecurityCodeDEI, WhetherConsolidatedFinancialStatementsArePreparedDEI  (all 7 docs)
 *   J-GAAP revenue  jpcrp_cor:NetSalesSummaryOfBusinessResults (Nintendo, 三晃), jppfs_cor:NetSales (Nintendo, 三晃);
 *                   jpcrp_cor:OperatingRevenue1SummaryOfBusinessResults, jpcrp_cor:OperatingRevenue2SummaryOfBusinessResults,
 *                   jppfs_cor:OperatingRevenue1 (taxonomy list; not in the corpus)
 *          EPS     jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults (Nintendo, MUFG, 三晃),
 *                  jpcrp_cor:DilutedEarningsPerShareSummaryOfBusinessResults (MUFG; nil at Nintendo/三晃),
 *                  jppfs_cor:BasicEarningsLossPerShare, jppfs_cor:DilutedEarningsPerShare (taxonomy list)
 *   IFRS   revenue  jpcrp_cor:RevenueIFRSSummaryOfBusinessResults, jpigp_cor:RevenueIFRS (Takeda);
 *                   jpigp_cor:NetSalesIFRS, ifrs-full:Revenue (taxonomy list)
 *          EPS     jpcrp_cor:BasicEarningsLossPerShareIFRSSummaryOfBusinessResults,
 *                  jpcrp_cor:DilutedEarningsLossPerShareIFRSSummaryOfBusinessResults (Toyota, Takeda),
 *                  jpigp_cor:BasicEarningsLossPerShareIFRS, jpigp_cor:DilutedEarningsLossPerShareIFRS (Takeda)
 *   US GAAP revenue jpcrp_cor:RevenuesUSGAAPSummaryOfBusinessResults (Nomura: 収益合計), cross-checked with
 *                   NetRevenueSummaryOfBusinessResults (Nomura's own element: 収益合計（金融費用控除後）, net revenue).
 *                   A broker shows both and they differ, so its revenue is blank rather than the gross figure.
 *          EPS     jpcrp_cor:BasicEarningsLossPerShareUSGAAPSummaryOfBusinessResults,
 *                  jpcrp_cor:DilutedEarningsLossPerShareUSGAAPSummaryOfBusinessResults (Nomura)
 *   Never revenue   jpcrp_cor:OrdinaryIncomeSummaryOfBusinessResults, jppfs_cor:OrdinaryIncome,
 *                   jppfs_cor:OrdinaryIncomeBNK (MUFG), OrdinaryIncomeLoss…, OperatingIncome…, GrossProfit…
 *   Known gap       Toyota tags 営業収益 only with its own extension (OperatingRevenuesIFRSKeyFinancialData), so its
 *                   EDINET revenue is blank.
 */

export interface EdinetFigures {
  revenue: number | null;
  epsBasic: number | null;
  epsDiluted: number | null;
  currency: 'JPY' | null;
  ytdMonths: 6 | 12 | null;
  standard: 'jgaap' | 'ifrs' | 'usgaap' | null;
  consolidated: boolean;
  notes: string[];
}

type Standard = 'jgaap' | 'ifrs' | 'usgaap';
type Field = 'revenue' | 'epsBasic' | 'epsDiluted';

const TABLES: Record<Standard, Record<Field, string[]>> = {
  jgaap: {
    revenue: [
      'NetSalesSummaryOfBusinessResults',
      'OperatingRevenue1SummaryOfBusinessResults',
      'OperatingRevenue2SummaryOfBusinessResults',
      'NetSales',
      'OperatingRevenue1',
    ],
    epsBasic: ['BasicEarningsLossPerShareSummaryOfBusinessResults', 'BasicEarningsLossPerShare'],
    epsDiluted: ['DilutedEarningsPerShareSummaryOfBusinessResults', 'DilutedEarningsPerShare'],
  },
  ifrs: {
    revenue: ['RevenueIFRSSummaryOfBusinessResults', 'RevenueIFRS', 'NetSalesIFRS', 'Revenue'],
    epsBasic: ['BasicEarningsLossPerShareIFRSSummaryOfBusinessResults', 'BasicEarningsLossPerShareIFRS'],
    epsDiluted: ['DilutedEarningsLossPerShareIFRSSummaryOfBusinessResults', 'DilutedEarningsLossPerShareIFRS'],
  },
  usgaap: {
    revenue: ['RevenuesUSGAAPSummaryOfBusinessResults', 'NetRevenueSummaryOfBusinessResults'],
    epsBasic: ['BasicEarningsLossPerShareUSGAAPSummaryOfBusinessResults'],
    epsDiluted: ['DilutedEarningsLossPerShareUSGAAPSummaryOfBusinessResults'],
  },
};

const STANDARDS: Record<string, Standard> = { 'Japan GAAP': 'jgaap', IFRS: 'ifrs', 'US GAAP': 'usgaap' };

interface Context {
  id: string;
  start: string | null;
  end: string | null;
  instant: string | null;
  /** Local names of explicit members (typed members give their dimension's local name). */
  members: string[];
}

interface Fact {
  contextRef: string;
  unitRef: string | null;
  nil: boolean;
  value: string;
}

const local = (qname: string) => qname.trim().replace(/^.*:/, '');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseContexts(xml: string): Context[] {
  const out: Context[] = [];
  const re = /<(?:[\w.-]+:)?context\s[^>]*?\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?context>/g;
  for (const m of xml.matchAll(re)) {
    const body = m[2]!;
    const tag = (name: string) => body.match(new RegExp(`<(?:[\\w.-]+:)?${name}>\\s*([^<]*?)\\s*<`))?.[1] ?? null;
    const members: string[] = [];
    for (const e of body.matchAll(/<(?:[\w.-]+:)?explicitMember\b[^>]*>([^<]*)</g)) members.push(local(e[1]!));
    for (const t of body.matchAll(/<(?:[\w.-]+:)?typedMember\b[^>]*\bdimension="([^"]+)"/g)) members.push(local(t[1]!));
    out.push({ id: m[1]!, start: tag('startDate'), end: tag('endDate'), instant: tag('instant'), members });
  }
  return out;
}

/** Unit id → 'JPY' | 'JPYPerShares' | 'other'. */
function parseUnits(xml: string): Map<string, 'JPY' | 'JPYPerShares' | 'other'> {
  const out = new Map<string, 'JPY' | 'JPYPerShares' | 'other'>();
  const re = /<(?:[\w.-]+:)?unit\s[^>]*?\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?unit>/g;
  const measures = (s: string) => [...s.matchAll(/<(?:[\w.-]+:)?measure>\s*([^<]*?)\s*</g)].map((x) => x[1]!);
  const isJpy = (m: string[]) => m.length === 1 && /^(?:[\w.-]+:)?JPY$/.test(m[0]!);
  const isShares = (m: string[]) => m.length === 1 && /^(?:[\w.-]+:)?shares$/.test(m[0]!);
  for (const m of xml.matchAll(re)) {
    const body = m[2]!;
    const num = body.match(/<(?:[\w.-]+:)?unitNumerator>([\s\S]*?)<\/(?:[\w.-]+:)?unitNumerator>/);
    const den = body.match(/<(?:[\w.-]+:)?unitDenominator>([\s\S]*?)<\/(?:[\w.-]+:)?unitDenominator>/);
    let kind: 'JPY' | 'JPYPerShares' | 'other' = 'other';
    if (num && den) {
      if (isJpy(measures(num[1]!)) && isShares(measures(den[1]!))) kind = 'JPYPerShares';
    } else if (isJpy(measures(body))) {
      kind = 'JPY';
    }
    out.set(m[1]!, kind);
  }
  return out;
}

/** Every fact named `name` (any namespace prefix). */
function factsNamed(xml: string, name: string): Fact[] {
  const n = esc(name);
  const re = new RegExp(`<([\\w.-]+):${n}(?=[\\s/>])([^>]*?)(?:\\/>|>([^<]*)<\\/\\1:${n}\\s*>)`, 'g');
  const out: Fact[] = [];
  for (const m of xml.matchAll(re)) {
    const attrs = m[2]!;
    const ctx = attrs.match(/\bcontextRef="([^"]+)"/)?.[1];
    if (!ctx) continue;
    out.push({
      contextRef: ctx,
      unitRef: attrs.match(/\bunitRef="([^"]+)"/)?.[1] ?? null,
      nil: /\bxsi:nil="true"/.test(attrs) || /\bnil="true"/.test(attrs),
      value: (m[3] ?? '').trim(),
    });
  }
  return out;
}

/** The first non-nil, non-empty value of a DEI element. */
function dei(xml: string, name: string): string | null {
  for (const f of factsNamed(xml, name)) if (!f.nil && f.value) return f.value;
  return null;
}

function daysBetween(start: string, end: string): number | null {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

export function parseEdinetXbrl(xml: string, doc: { docTypeCode: '120' | '160'; periodEnd: string }): EdinetFigures {
  const notes: string[] = [];
  const standard = STANDARDS[dei(xml, 'AccountingStandardsDEI') ?? ''] ?? null;
  const consolidated = dei(xml, 'WhetherConsolidatedFinancialStatementsArePreparedDEI') !== 'false';
  const blank = (why: string): EdinetFigures => ({
    revenue: null, epsBasic: null, epsDiluted: null, currency: null, ytdMonths: null, standard, consolidated,
    notes: [...notes, why],
  });

  if (!standard) return blank('unknown accounting standard');
  const fyStart = dei(xml, 'CurrentFiscalYearStartDateDEI');
  if (!fyStart) return blank('no CurrentFiscalYearStartDateDEI');

  const days = daysBetween(fyStart, doc.periodEnd);
  const months = days === null ? null : Math.round(days / (365.25 / 12));
  const want = doc.docTypeCode === '120' ? 12 : 6;
  if (months !== want) return blank(`period ${fyStart}..${doc.periodEnd} is not ${want} months`);

  const wantedMembers = consolidated ? [] : ['NonConsolidatedMember'];
  const contextIds = new Set(
    parseContexts(xml)
      .filter((c) => c.start === fyStart && c.end === doc.periodEnd && c.instant === null)
      .filter((c) => c.members.length === wantedMembers.length && c.members.every((m, i) => m === wantedMembers[i]))
      .map((c) => c.id),
  );
  if (contextIds.size === 0) return blank(`no ${consolidated ? 'consolidated' : 'non-consolidated'} context ${fyStart}..${doc.periodEnd}`);

  const units = parseUnits(xml);
  const read = (field: Field): number | null => {
    const unit = field === 'revenue' ? 'JPY' : 'JPYPerShares';
    const values: number[] = [];
    for (const name of TABLES[standard][field]) {
      for (const f of factsNamed(xml, name)) {
        if (!contextIds.has(f.contextRef) || f.nil || f.value === '') continue;
        if (!f.unitRef || units.get(f.unitRef) !== unit) {
          notes.push(`${field}: ${name} has unit ${f.unitRef ?? 'none'}, not ${unit}`);
          return null;
        }
        const v = Number(f.value);
        if (!Number.isFinite(v)) {
          notes.push(`${field}: ${name} is not a number`);
          return null;
        }
        values.push(v);
      }
    }
    if (values.length === 0) {
      notes.push(`${field}: no value`);
      return null;
    }
    if (values.some((v) => v !== values[0])) {
      notes.push(`${field}: elements disagree (${[...new Set(values)].join(' / ')})`);
      return null;
    }
    return values[0]!;
  };

  const revenue = read('revenue');
  const epsBasic = read('epsBasic');
  const epsDiluted = read('epsDiluted');
  const any = revenue !== null || epsBasic !== null || epsDiluted !== null;
  return {
    revenue,
    epsBasic,
    epsDiluted,
    currency: any ? 'JPY' : null,
    ytdMonths: want,
    standard,
    consolidated,
    notes,
  };
}
