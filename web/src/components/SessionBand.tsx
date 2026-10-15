import type { Timing } from '../../../server/src/api/types';
import { sessionBand } from '../lib/session';

interface Props {
  date: string;
  sessionClose: string;
  zone: string;
  zoneText: string;
  counts: { bmo: number; amc: number; other: number };
  onJump: (timing: Timing) => void;
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const plural = (n: number) => `${n} report${n === 1 ? '' : 's'}`;

/** The US trading day drawn on the viewer's own clock, with tonight's release points marked. */
export function SessionBand({ date, sessionClose, zone, zoneText, counts, onJump }: Props) {
  const b = sessionBand(date, sessionClose, zone);
  return (
    <section className="band" aria-label={`US trading day in your time (${zoneText})`}>
      <div className="band-track">
        <div className="seg seg-pre" style={{ left: 0, width: pct(b.open) }}><span>Pre-market</span></div>
        <div className="seg seg-open" style={{ left: pct(b.open), width: pct(b.close - b.open) }}><span>US market open</span></div>
        <div className="seg seg-after" style={{ left: pct(b.close), right: 0 }}><span>After hours</span></div>
        {b.ticks.map((t) => (
          <span key={t.at} className="tick" style={{ left: pct(t.at) }}>{t.label}</span>
        ))}
      </div>
      <div className="band-marks">
        <button className="mark mark-bmo" style={{ left: pct(b.open) }} onClick={() => onJump('BMO')} disabled={counts.bmo === 0}>
          <strong>{plural(counts.bmo)} before the open</strong>
          <span>out by {b.openLabel}</span>
        </button>
        <button className="mark mark-amc" style={{ left: pct(b.close) }} onClick={() => onJump('AMC')} disabled={counts.amc === 0}>
          <strong>{plural(counts.amc)} after the close</strong>
          <span>from {b.closeLabel}</span>
        </button>
      </div>
      {counts.other > 0 && (
        <button className="band-other" onClick={() => onJump('UNKNOWN')}>
          {plural(counts.other)} without a confirmed time
        </button>
      )}
    </section>
  );
}
