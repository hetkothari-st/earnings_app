/**
 * Hand-maintained Hong Kong universe. Full level = SEC + Cboe data exist (ADR with a CIK);
 * basic level = Yahoo only. Names are refreshed from Yahoo later. Full-level rows are
 * live-verified by `npm run verify-hk-universe`.
 */
export interface HkUniverseEntry {
  /** 4 digits, e.g. '0700'. */
  code: string;
  name: string;
  cadence: 'Q' | 'H';
  fyEndMonth: number;
  adr: string | null;
  /** HK shares per ADS (1 for common stock). */
  adrRatio: number | null;
  cik: number | null;
}

const full = (code: string, name: string, adr: string, adrRatio: number, cik: number, cadence: 'Q' | 'H' = 'Q', fyEndMonth = 12): HkUniverseEntry =>
  ({ code, name, cadence, fyEndMonth, adr, adrRatio, cik });
const basic = (code: string, name: string, cadence: 'Q' | 'H' = 'H', fyEndMonth = 12): HkUniverseEntry =>
  ({ code, name, cadence, fyEndMonth, adr: null, adrRatio: null, cik: null });

export const HK_UNIVERSE: readonly HkUniverseEntry[] = [
  // Full level: ADR listed, SEC filer, Cboe chain.
  full('9988', 'Alibaba', 'BABA', 8, 1577552, 'Q', 3),
  full('9618', 'JD.com', 'JD', 2, 1549802),
  full('9888', 'Baidu', 'BIDU', 8, 1329099),
  full('9999', 'NetEase', 'NTES', 5, 1110646),
  full('9961', 'Trip.com', 'TCOM', 1, 1269238),
  full('2015', 'Li Auto', 'LI', 2, 1791706),
  full('9866', 'NIO', 'NIO', 1, 1736541),
  full('9868', 'XPeng', 'XPEV', 2, 1810997),
  full('9626', 'Bilibili', 'BILI', 1, 1723690),
  full('9987', 'Yum China', 'YUMC', 1, 1673358),
  full('6160', 'BeOne Medicines', 'ONC', 13, 1651308),
  full('2057', 'ZTO Express', 'ZTO', 1, 1677250),
  full('2423', 'KE Holdings', 'BEKE', 3, 1809587),
  full('0005', 'HSBC', 'HSBC', 5, 1089113, 'Q'),
  full('1698', 'Tencent Music', 'TME', 2, 1744676),
  full('2378', 'Prudential', 'PUK', 2, 1116578, 'H'),
  // Basic level: Yahoo only.
  basic('0700', 'Tencent', 'Q'), basic('1810', 'Xiaomi', 'Q'), basic('3690', 'Meituan', 'Q'),
  basic('1211', 'BYD', 'Q'), basic('0992', 'Lenovo', 'Q', 3),
  basic('1299', 'AIA'), basic('0941', 'China Mobile', 'Q'), basic('1398', 'ICBC', 'Q'), basic('0939', 'CCB', 'Q'),
  basic('3988', 'Bank of China', 'Q'), basic('1288', 'ABC', 'Q'), basic('3968', 'China Merchants Bank', 'Q'),
  basic('2318', 'Ping An', 'Q'), basic('2628', 'China Life', 'Q'), basic('0388', 'HKEX'),
  basic('0883', 'CNOOC', 'Q'), basic('0857', 'PetroChina', 'Q'), basic('0386', 'Sinopec', 'Q'),
  basic('0762', 'China Unicom', 'Q'), basic('0728', 'China Telecom', 'Q'),
  basic('0016', 'SHK Properties', 'H', 6), basic('0001', 'CK Hutchison'), basic('1113', 'CK Asset'),
  basic('0002', 'CLP'), basic('0003', 'HK & China Gas'), basic('0006', 'Power Assets'),
  basic('0011', 'Hang Seng Bank'), basic('0066', 'MTR'), basic('0027', 'Galaxy'), basic('1928', 'Sands China'),
  basic('0019', 'Swire Pacific'), basic('0823', 'Link REIT', 'H', 3), basic('0688', 'China Overseas Land'),
  basic('1109', 'China Resources Land'), basic('2020', 'Anta'), basic('2319', 'Mengniu'), basic('0291', 'CR Beer'),
  basic('2269', 'WuXi Bio'), basic('1177', 'Sino Biopharm'), basic('1093', 'CSPC'), basic('2382', 'Sunny Optical'),
  basic('0981', 'SMIC', 'Q'), basic('0285', 'BYD Electronic'), basic('0669', 'Techtronic'), basic('0175', 'Geely'),
  basic('2331', 'Li Ning'),
  basic('6618', 'JD Health'), basic('0241', 'Ali Health', 'H', 3), basic('1024', 'Kuaishou', 'Q'),
  basic('9633', 'Nongfu Spring'), basic('6862', 'Haidilao'), basic('0267', 'CITIC'), basic('0998', 'CITIC Bank', 'Q'),
  basic('1658', 'PSBC', 'Q'), basic('2388', 'BOC HK'), basic('3328', 'BoCom', 'Q'),
  basic('6030', 'CITIC Securities', 'Q'), basic('2601', 'CPIC', 'Q'), basic('1339', 'PICC Group', 'Q'), basic('2328', 'PICC P&C', 'Q'),
  basic('0012', 'Henderson Land'), basic('0101', 'Hang Lung Properties'), basic('1038', 'CKI'),
  basic('0868', 'Xinyi Glass'), basic('0968', 'Xinyi Solar'), basic('1044', 'Hengan'),
  basic('0322', 'Tingyi'), basic('1876', 'Budweiser APAC'), basic('0384', 'China Gas', 'H', 3),
  basic('2688', 'ENN Energy'), basic('1088', 'China Shenhua', 'Q'), basic('2899', 'Zijin', 'Q'), basic('3993', 'CMOC', 'Q'),
  basic('0914', 'Anhui Conch', 'Q'), basic('2359', 'WuXi AppTec', 'Q'), basic('1801', 'Innovent'), basic('9992', 'Pop Mart'),
  basic('1929', 'Chow Tai Fook', 'H', 3),
];

export const hkLevel = (e: HkUniverseEntry): 'full' | 'basic' => (e.cik != null && e.adr != null ? 'full' : 'basic');

export const yahooHkSymbol = (code: string): string => `${code}.HK`;

/** Yahoo symbols; verified in Task 5. */
export const HK_INDICES: readonly { name: string; yahoo: string }[] = [
  { name: 'Hang Seng', yahoo: '^HSI' },
  { name: 'HS China Enterprises', yahoo: '^HSCE' },
  { name: 'HS Tech', yahoo: 'HSTECH.HK' },
];
