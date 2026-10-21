import { DateTime } from 'luxon';
import { todayEt } from './time';

export const todayIst = (): string => DateTime.now().setZone('Asia/Kolkata').toISODate()!;

/**
 * Live market cap = live price x share count, only for a report dated today or later
 * (today in ET for US, IST for India). Past reports keep their stored cap: null here.
 */
export function liveCap(reportDate: string, today: string, price: number | null | undefined, shares: number | null): number | null {
  if (reportDate < today || price == null || shares == null || !(price > 0) || !(shares > 0)) return null;
  return price * shares;
}

export { todayEt };
