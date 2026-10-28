import { DateTime } from 'luxon';
import { todayEt } from './time';

export const todayHkt = (): string => DateTime.now().setZone('Asia/Hong_Kong').toISODate()!;

export const todayJst = (): string => DateTime.now().setZone('Asia/Tokyo').toISODate()!;

export const todayLondon = (): string => DateTime.now().setZone('Europe/London').toISODate()!;

export const todayParis = (): string => DateTime.now().setZone('Europe/Paris').toISODate()!;

export const todayIst = (): string => DateTime.now().setZone('Asia/Kolkata').toISODate()!;

/**
 * Live market cap = live price x share count, only for a report dated today or later
 * (today in ET for US, IST for India). Past reports keep their stored cap: null here.
 * Also null (the stored cap is shown) when the live figure is more than 3x off the stored cap either way:
 * multi-class issuers report a share count per class, and one class is not the whole company.
 */
export function liveCap(
  reportDate: string, today: string, price: number | null | undefined, shares: number | null, storedCap?: number | null,
): number | null {
  if (reportDate < today || price == null || shares == null || !(price > 0) || !(shares > 0)) return null;
  const live = price * shares;
  if (storedCap != null && storedCap > 0 && (live > storedCap * 3 || live < storedCap / 3)) return null;
  return live;
}

export { todayEt };
