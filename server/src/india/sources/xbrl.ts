import { SourceFormatError } from '../../sources/http.js';
import { quarterFromPeriod } from '../domain/quarter.js';
import { latestQuarterEndBefore, quarterLabel } from '../domain/quarter.js';

/**
 * Parsed fields from an NSE XBRL prior-intimation document.
 * (Board Meeting Intimation; linked from Board_Meetings feed)
 */
export interface PriorIntimation {
  symbol: string | null;
  meetingDate: string | null;         // YYYY-MM-DD
  purposes: string[];
  quarterEnd: string | null;          // YYYY-MM-DD, inferred
  quarterLabel: string | null;        // e.g. "Sep/2026"
}

/**
 * Parsed fields from an NSE Integrated Filing XBRL.
 * (Financial results; linked from Integrated_Filing feed)
 */
export interface IntegratedFiling {
  symbol: string;
  companyName: string;
  reportDate: string;                 // YYYY-MM-DD (DateOfBoardMeetingWhenFinancialResultsWereApproved)
  periodStart: string | null;         // YYYY-MM-DD
  periodEnd: string | null;           // YYYY-MM-DD
  quarterLabel: string;               // e.g. "Sep/2026"
  nature: 'Standalone' | 'Consolidated';
  // Ind AS
  revenueFromOperations: number | null;   // absolute INR
  profitLoss: number | null;              // absolute INR
  eps: number | null;                     // INR per share (basic, continuing + discontinued)
  // Banking alternative fields
  interestEarned: number | null;          // absolute INR
  totalIncome: number | null;             // absolute INR (Income)
  isBank: boolean;
  revenueKind: 'revenue-from-ops' | 'total-income';
  isRevision: boolean;
}

/**
 * The text of the first fact named exactly `tag` (any namespace prefix). With `context`, only facts
 * on that context count: financial figures must come from `OneD` (the quarter alone), never `FourD`
 * (year to date) or any other context.
 */
function fact(xml: string, tag: string, context?: string): string | null {
  const re = new RegExp(`<[\\w-]+:${tag}(?=[\\s>/])([^>]*)>([^<]*)<`, 'g');
  for (const m of xml.matchAll(re)) {
    if (context && !m[1]!.includes(`contextRef="${context}"`)) continue;
    const v = m[2]!.trim();
    if (v) return v;
  }
  return null;
}

function extractXbrlFact(xml: string, ...tagNames: string[]): string | null {
  for (const tag of tagNames) {
    const v = fact(xml, tag);
    if (v) return v;
  }
  return null;
}

/** A figure for the current quarter only. */
function quarterFact(xml: string, ...tagNames: string[]): string | null {
  for (const tag of tagNames) {
    const v = fact(xml, tag, 'OneD');
    if (v) return v;
  }
  return null;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "September", "Sep", "9" or "09" → 9; anything else → null. */
export function parseMonth(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 12 ? n : null;
  }
  const i = MONTH_NAMES.findIndex((m) => t.length >= 3 && m.startsWith(t));
  return i >= 0 ? i + 1 : null;
}

function parseNumber(s: string | null): number | null {
  if (!s) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a prior-intimation XBRL document (Board Meeting Intimation).
 * Throws SourceFormatError on malformed XML.
 */
export function parsePriorIntimation(xml: string, meetingDateFallback?: string): PriorIntimation {
  if (!xml.includes('xbrli:xbrl') && !xml.includes('<xbrl')) {
    throw new SourceFormatError('Not a valid XBRL document');
  }

  const symbol = extractXbrlFact(xml, 'NSESymbol') ?? extractXbrlFact(xml, 'Symbol');
  const meetingDateRaw = extractXbrlFact(xml, 'DateOfProposedMeeting') ?? meetingDateFallback ?? null;

  // Normalize date: "DD/MM/YYYY" or "YYYY-MM-DD"
  let meetingDate: string | null = null;
  if (meetingDateRaw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(meetingDateRaw)) {
      meetingDate = meetingDateRaw;
    } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(meetingDateRaw)) {
      const [d, m, y] = meetingDateRaw.split('/');
      meetingDate = `${y}-${m}-${d}`;
    }
  }

  // Extract agenda items
  const purposes: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const a = extractXbrlFact(xml, `Agenda${i}`);
    if (a) purposes.push(a.trim());
    else break;
  }
  if (purposes.length === 0) {
    const a = extractXbrlFact(xml, 'Agenda');
    if (a) purposes.push(a.trim());
  }

  // Infer quarter
  let quarterEnd: string | null = null;
  let qLabel: string | null = null;
  const monthRaw = extractXbrlFact(xml, 'MonthOfPeriodEnded');
  const yearRaw = extractXbrlFact(xml, 'YearOfPeriodEnded');
  if (monthRaw && yearRaw) {
    const month = parseMonth(monthRaw) ?? 0;
    const year = Number(yearRaw);
    if (month >= 1 && month <= 12 && year > 2000) {
      qLabel = quarterFromPeriod(month, year);
      // Map month to quarter end date
      const qEnds: Record<number, string> = {
        3: `${year}-03-31`, 6: `${year}-06-30`, 9: `${year}-09-30`, 12: `${year}-12-31`,
      };
      quarterEnd = qEnds[month] ?? null;
    }
  } else if (meetingDate) {
    quarterEnd = latestQuarterEndBefore(meetingDate);
    qLabel = quarterLabel(quarterEnd);
  }

  return {
    symbol: symbol ? symbol.trim().toUpperCase() : null,
    meetingDate,
    purposes,
    quarterEnd,
    quarterLabel: qLabel,
  };
}

/**
 * Parse an NSE Integrated Filing XBRL document.
 * Throws SourceFormatError on malformed XML.
 */
export function parseIntegratedFiling(xml: string): IntegratedFiling {
  if (!xml.includes('xbrli:xbrl') && !xml.includes('<xbrl')) {
    throw new SourceFormatError('Not a valid XBRL document');
  }

  // Symbol (try both field names)
  const symbolRaw = extractXbrlFact(xml, 'Symbol', 'NSESymbol');
  if (!symbolRaw) throw new SourceFormatError('Integrated filing missing Symbol');

  const companyNameRaw =
    extractXbrlFact(xml, 'NameOfTheCompany') ??
    extractXbrlFact(xml, 'NameOfBank') ??
    '';

  const reportDateRaw = extractXbrlFact(xml, 'DateOfBoardMeetingWhenFinancialResultsWereApproved');
  let reportDate = reportDateRaw ?? '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(reportDate)) {
    const [d, m, y] = reportDate.split('/');
    reportDate = `${y}-${m}-${d}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new SourceFormatError(`Integrated filing has invalid report date: ${reportDate}`);
  }

  const periodStartRaw = quarterFact(xml, 'DateOfStartOfReportingPeriod');
  const periodEndRaw = quarterFact(xml, 'DateOfEndOfReportingPeriod');

  // Normalize dates
  const normDate = (raw: string | null): string | null => {
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
      const [d, m, y] = raw.split('/');
      return `${y}-${m}-${d}`;
    }
    return null;
  };
  const periodStart = normDate(periodStartRaw);
  const periodEnd = normDate(periodEndRaw);

  // Quarter label
  const qLabel = periodEnd ? quarterLabel(periodEnd) : 'Unknown';

  const nature = quarterFact(xml, 'NatureOfReportStandaloneConsolidated') ?? extractXbrlFact(xml, 'NatureOfReportStandaloneConsolidated');
  if (nature !== 'Standalone' && nature !== 'Consolidated') throw new SourceFormatError(`Integrated filing: unknown basis ${nature}`);
  const isRevisionRaw = extractXbrlFact(xml, 'TypeOfXBRLFiling') ?? '';
  const isRevision = isRevisionRaw.toLowerCase().includes('revision');

  // Financial facts
  const revOps = parseNumber(quarterFact(xml, 'RevenueFromOperations'));
  const pnl = parseNumber(quarterFact(xml, 'ProfitLossForPeriod', 'ProfitLossForThePeriod'));
  const eps = parseNumber(quarterFact(xml,
    'BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations', 'BasicEarningsPerShareAfterExtraordinaryItems'));

  // Banking-specific
  const interestEarned = parseNumber(quarterFact(xml, 'InterestEarned'));
  const totalIncome = parseNumber(quarterFact(xml, 'Income'));
  // Banks are identified by the presence of InterestEarned (not just Income — Ind AS companies also have Income).
  // NBFCs also file InterestEarned, but under Ind AS with revenue from operations: they are not banks.
  const isBank = interestEarned != null && revOps == null;

  return {
    symbol: symbolRaw.trim().toUpperCase(),
    companyName: companyNameRaw.trim(),
    reportDate,
    periodStart,
    periodEnd,
    quarterLabel: qLabel,
    nature,
    revenueFromOperations: revOps,
    profitLoss: pnl,
    eps,
    interestEarned,
    totalIncome,
    isBank,
    revenueKind: isBank ? 'total-income' : 'revenue-from-ops',
    isRevision,
  };
}
