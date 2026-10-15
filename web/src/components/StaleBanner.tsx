import type { SourceStatusDto } from '../../../server/src/api/types';
import { staleSources } from '../lib/stale';

export function StaleBanner({ sources }: { sources: SourceStatusDto[] }) {
  const stale = staleSources(sources, Date.now());
  if (stale.length === 0) return null;
  return (
    <div className="banner" role="status">
      {stale.map((s) => <p key={s.source}>{s.message} <a href="/status">Details</a></p>)}
    </div>
  );
}
