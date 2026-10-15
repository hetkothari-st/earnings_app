import type { SecCheck, Timing } from '../types.js';
import { sessionClose } from './marketCalendar.js';

export type SecDerived = 'BMO' | 'AMC' | 'BEFORE_CLOSE' | null;

/**
 * acceptedEt is the SGML header ACCEPTANCE-DATETIME as ET wall clock (YYYY-MM-DDTHH:mm:ss).
 * An 8-K is filed at or after the release, so this is an upper bound on the release time.
 */
export function deriveFromAcceptance(reportDate: string, acceptedEt: string): SecDerived {
  if (acceptedEt.slice(0, 10) !== reportDate) return null;
  const time = acceptedEt.slice(11, 19);
  if (time < '09:30:00') return 'BMO';
  if (time >= `${sessionClose(reportDate)}:00`) return 'AMC';
  return 'BEFORE_CLOSE';
}

/** Spec 6.6 table. The upper bound can prove BMO or disprove AMC, never prove AMC. */
export function checkTiming(label: Timing, derived: SecDerived): { check: SecCheck; timing: Timing } {
  const r = (check: SecCheck, timing: Timing = label) => ({ check, timing });
  if (derived === null) return r('unverifiable');
  switch (label) {
    case 'BMO':
      return derived === 'BMO' ? r('verified') : r('unverifiable');
    case 'AMC':
      return derived === 'AMC' ? r('consistent') : r('contradicted');
    case 'DMH':
      if (derived === 'BMO') return r('contradicted');
      return derived === 'BEFORE_CLOSE' ? r('consistent') : r('unverifiable');
    case 'UNKNOWN':
      return derived === 'BMO' ? r('derived', 'BMO') : r('unverifiable');
  }
}
