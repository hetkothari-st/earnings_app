/**
 * UK/Europe free-source URLs, verified live on 2026-10-28 (Task 3). Fixtures of every answer are in
 * server/test/fixtures/europe/feeds/. Requests use EUROPE_UA, a 1 s gap, and no personal email.
 *
 * robots.txt results
 * - www.prnewswire.com: disallows only /templates/*, /widget-landing-page.html, /multivu/. /rss/ is allowed.
 * - www.prnewswire.co.uk: disallows only /templates/get-bitly-url.txt. /rss/ is allowed.
 * - echanges.dila.gouv.fr: /robots.txt is 404 (no rules published). Only /OPENDATA/AMF/ is used.
 * - filings.xbrl.org: /robots.txt is 404 (no rules published). Only /api/filings and json_url paths are used.
 * - www.gov.uk: allows /bank-holidays.json (disallows /search/all* and print views only).
 * - www.tradegatebsx.com: "User-agent: *" / "Disallow: /json/". /refresh.php is allowed; /json/ is never fetched.
 *
 * PR Newswire RSS (RSS 2.0, UTF-8, 20 items per feed, no paging, no geography feeds exist)
 * - The /rss/ index lists only industry and "All News Releases" feeds. Europe-heavy results releases are in the
 *   subject feed ".../rss/general-business-latest-news/earnings-list.rss" (and the financial-services one) on
 *   prnewswire.co.uk (Sobi, ASSA ABLOY, Securitas, Electrolux, Essity, SKF, Pearson, Ericsson in one week);
 *   the .com earnings-list is US/LatAm-heavy (it did carry Ferrovial). A made-up path such as
 *   /rss/europe-latest-news/... silently returns the default All News feed, so never guess a feed URL.
 * - Item fields: title, link, guid (same as link), pubDate, description (CDATA <p>, a dateline "CITY, Oct. 27,
 *   2026 /PRNewswire/ -- ..." then ~250 chars), prn:industry (0..n), prn:subject ("Earnings "), dc:subject
 *   ("ERN"), dc:contributor (the issuer name as the sender wrote it), dc:language, dc:publisher, media:content.
 * - pubDate is true UTC (+0000) to the second: Pearson's 07:00 BST trading update is 06:10 +0000, Ericsson's
 *   07:00 CEST report is 05:32 +0000. It lags the issuer's own release by minutes to about 40 minutes, so a PRN
 *   time is an upper bound on the release time. Read it in the row's exchange zone (Ruling 9). Some descriptions
 *   hold bytes that are not valid UTF-8 (the feed re-encodes "-"/"EUR" glyphs); decode leniently.
 *
 * DILA AMF regulated-information flow ("INFOFI", published as /OPENDATA/AMF/, not /OPENDATA/INFOFI/ which is 404)
 * - Layout: one flat directory with one gzipped tar per publication batch, up to 10 a day:
 *   amf-gz_DDMMYYYY_HHMM.tar.gz (HHMM is the batch start in French local time; the Last-modified time is about an
 *   hour later). Plus numbered sub-directories per distributor (101/ .. 8888/) with yearly folders; they are not
 *   needed. About 16,000 archives since 2019; the newest are at the end of the listing (sort by Last-modified).
 * - Archive: tar.gz holding xml/<DIF>/<YYYY>/<MM>/MD<DIF><n>_<YYYYMMDD>.xml and the PDF it describes at
 *   pdf/<DIF>/<YYYY>/<MM>/FC<DIF><n>_<YYYYMMDD>.pdf. Most bytes are PDFs: an ordinary batch is 0.3 to 25 MB, a
 *   results-season batch (the 19:05 one) reaches 200 to 660 MB. A reader must stream and skip the pdf/ entries.
 * - Record (XSD Schema_XSD_donnees_AMF.xsd): <UniteInformation UIN_DAT_AMF=.. UIN_DAT_MAR=..>
 *   <identificationSociete ISO_PAY_SS ISO_NOM_SOC ISO_CD_ISI ISO_CD_LEI> (ISO_CD_LEI may be empty)
 *   <InformationDeposee INF_DAT_EMT="2026-03-31T22:15:00+02:00" INF_STP_PRI="003000" INF_TIT_INF=".." INF_LNG_INF="EN|FR">
 *   <INF_STP_INF>type</INF_STP_INF>* <FichierDeContenu INF_FIC_NOM=".."/>. Titles are XML-escaped (&#xE9;). One
 *   filing often appears twice (FR and EN, or twice in one batch): dedupe by ISIN + type + INF_DAT_EMT.
 *   INF_DAT_EMT is the AMF filing time, not the issuer's release time.
 * - Type codes (INF_STP_PRI) seen in 161 records across 50 batches, with the observed meaning from the titles:
 *     001007 communique sur comptes, resultats (news release on accounts, results; Orange Q3 revenue, Crossject FY)
 *     003000 annual results / annual financial report release (Nanobiotix full-year 2025)
 *     004000 rapport financier semestriel (half-year financial report)
 *     005002 information financiere trimestrielle (quarterly financial information; Saint-Gobain "Chiffre d'affaires
 *            du 3e trimestre 2026", filed 2026-10-27 18:01 Paris, fixture dila_005002_MDECO083570_20261027.xml)
 *   Results types (DILA_RESULTS_TYPES) are 001007 and 005002 only. 003000 and 004000 are the annual / half-year
 *   financial report DOCUMENTS, often filed weeks after the results: Exail Technologies filed its "RAPPORT FINANCIER
 *   SEMESTRIEL 2026" (004000) on 2026-10-26 (fixture dila_004000_MDACT081985_20261026.xml), well after its H1 results,
 *   so within ±3 days of a Q3 date it would flip the wrong row. Controller ruling (Task 16): they never flip a row,
 *   at the cost of the occasional 003000 that is the results release itself (Nanobiotix FY2025).
 *   Not results: 001002/001006 other press releases, 001008 audit and trading notices, 002001..002009 meeting and
 *   availability notices, 006000 voting rights, 009xxx offers, 013xxx buy-backs, 015000 governance. The LOV
 *   document is an image PDF, so the list is empirical; 005001/005003 (other quarters) were not observed and are
 *   not listed.
 *
 * filings.xbrl.org JSON:API
 * - GET /api/filings?filter[country]=GB&sort=-date_added&page[size]=100&include=entity returns
 *   data[].attributes {fxo_id, period_end "YYYY-MM-DD", date_added "YYYY-MM-DD HH:MM:SS.ffffff" (naive, UTC),
 *   processed, json_url, report_url, viewer_url, package_url (all relative to https://filings.xbrl.org),
 *   error_count, warning_count} and relationships.entity.data.id, which joins included[] (type entity) whose
 *   attributes.identifier is the LEI and attributes.name the legal name. meta.count and links.next page it.
 *   A rare filing has json_url null (1 of 200 sampled): skip it. Unquoted [] in the query need curl -g. GB had 2,966 and FR 1,183 filings.
 * - date_added is when the filing reached the site, often weeks after the issuer published (UK FY June 2026
 *   filings were added in September to October). It is not a release time.
 * - json_url is xBRL-JSON: {documentInfo{documentType, namespaces, taxonomy}, facts{ "fact-N": {value (string),
 *   decimals, dimensions{concept, entity "scheme:<LEI>", period "2025-07-01T00:00:00/2026-07-01T00:00:00",
 *   unit "iso4217:GBP" | "iso4217:GBP/xbrli:shares", language?, <axis>: member}}}}. The period end is exclusive
 *   (2026-07-01T00:00:00 means period_end 2026-06-30). Values are canonical decimals in the base unit: EPS of
 *   -3.64p is "-0.0364" with unit GBP/shares, revenue is "6421200000.0". Axis members (for example
 *   BeforeExceptionalItemsMember) make a fact a sub-total; only dimension-free facts are the headline figure.
 *
 * Tradegate refresh.php (https://www.tradegatebsx.com/refresh.php?isin=<ISIN>, one request per ISIN)
 * - 200 application/json: {bid, ask, bidsize, asksize, delta, stueck, umsatz, avg, executions, last, high, low,
 *   close, refresh}. Content is cached for ten seconds (Expires header; refresh = 10).
 * - Number format is MIXED inside one answer: each price is either a JSON number (212.55) or a German-format
 *   string ("213,10", a decimal comma; thousands dots are possible in principle, none seen). Parse both.
 * - delta is the percent change of last against close ((152.40 - 153.90) / 153.90 = -0.97).
 * - close is the previous trading day's close and the reference for delta. It rolls forward once a day: at
 *   05:50 UTC (06:50 Berlin, before the open) SAP showed last 213.15 / close 213.00 (last session pair), at
 *   07:12 UTC (08:12 Berlin) it showed last 211.90 / close 212.85 (new reference). The roll falls between those
 *   times; the exact minute is unknown. In every answer (last - close) / close * 100 equals delta, so always
 *   take the change from one answer, never mix it with another source's previous close. The "refresh" field
 *   (10) is present in some answers and absent in others: never rely on it.
 * - An unknown ISIN answers 200 text/html with an empty body: not JSON, treat as "Tradegate does not quote it".
 *   GB0009895292 (AstraZeneca) is quoted in EUR, so a UK line can have a Tradegate EUR price.
 *
 * gov.uk: /bank-holidays.json is {"england-and-wales"|"scotland"|"northern-ireland": {division, events[{title,
 *   date, notes, bunting}]}}; England and Wales has 83 events from 2019-01-01 to 2028-12-26, so it covers 2026 to
 *   2028 (2026: 01-01 04-03 04-06 05-04 05-25 08-31 12-25 12-28).
 */

export const EUROPE_UA = 'EarningsCalendarPrototype/1.0';

export const PRN_FEEDS: { UK: readonly string[]; EU: readonly string[] } = {
  UK: [
    'https://www.prnewswire.co.uk/rss/general-business-latest-news/earnings-list.rss',
    'https://www.prnewswire.co.uk/rss/financial-services-latest-news/earnings-forecasts-projections-list.rss',
  ],
  EU: [
    'https://www.prnewswire.co.uk/rss/general-business-latest-news/earnings-list.rss',
    'https://www.prnewswire.com/rss/general-business-latest-news/earnings-list.rss',
  ],
};

export const DILA_BASE = 'https://echanges.dila.gouv.fr/OPENDATA/AMF/';

/** INF_STP_PRI values that mean a results publication (see the header for the evidence). */
export const DILA_RESULTS_TYPES: readonly string[] = ['001007', '005002'];

export const XBRL_FILINGS_URL = 'https://filings.xbrl.org/api/filings';

export const GOVUK_BANK_HOLIDAYS_URL = 'https://www.gov.uk/bank-holidays.json';

export const TRADEGATE_REFRESH = 'https://www.tradegatebsx.com/refresh.php';
export const TRADEGATE_ROBOTS = 'https://www.tradegatebsx.com/robots.txt';

/** `s` trimmed when it is an absolute http(s) URL, else null (a signal link is only ever stored or shown as http(s)). */
export function httpUrlOrNull(s: string | null | undefined): string | null {
  const t = s?.trim();
  if (!t || !/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? t : null;
  } catch {
    return null;
  }
}
