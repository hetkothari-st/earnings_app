import { EUROPE_UA } from './sourceUrls.js';

interface Rule {
  allow: boolean;
  pattern: string;
}

/** A robots.txt path pattern (`*` any run, trailing `$` end of path) as a regex anchored at the start. */
function toRegex(pattern: string): RegExp {
  const end = pattern.endsWith('$');
  const body = end ? pattern.slice(0, -1) : pattern;
  const src = body
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${src}${end ? '$' : ''}`);
}

/**
 * RFC 9309 check: may `ua` fetch `path` (with its query string)? The group naming the UA's product token
 * (the part before `/`) applies; otherwise the `*` group. The longest matching Allow/Disallow pattern wins, and
 * Allow wins a tie. No matching rule, or no group at all, means allowed.
 */
export function robotsAllows(robotsTxt: string, path: string, ua: string = EUROPE_UA): boolean {
  const token = (ua.split(/[/\s]/)[0] ?? '').toLowerCase();
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      // consecutive User-agent lines share one group
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (cur && value !== '') cur.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const named = groups.filter((g) => token !== '' && g.agents.includes(token));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  let best: Rule | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!toRegex(r.pattern).test(path)) continue;
      if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) {
        best = r;
      }
    }
  }
  return best ? best.allow : true;
}
