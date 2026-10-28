import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { robotsAllows } from '../../src/europe/sources/robots.js';

const fixture = readFileSync(new URL('../fixtures/europe/feeds/tradegate_robots.txt', import.meta.url), 'utf8');

describe('robotsAllows', () => {
  it('tradegate fixture: /refresh.php allowed, /json/x disallowed', () => {
    expect(robotsAllows(fixture, '/refresh.php')).toBe(true);
    expect(robotsAllows(fixture, '/refresh.php?isin=DE0007164600')).toBe(true);
    expect(robotsAllows(fixture, '/json/x')).toBe(false);
  });

  it('Disallow: / blocks everything', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /\n', '/refresh.php')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow:\n', '/refresh.php')).toBe(true);
    expect(robotsAllows('', '/refresh.php')).toBe(true);
  });

  it('longest match wins', () => {
    const txt = 'User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /a/b/c\n';
    expect(robotsAllows(txt, '/a/x')).toBe(false);
    expect(robotsAllows(txt, '/a/b/x')).toBe(true);
    expect(robotsAllows(txt, '/a/b/c/d')).toBe(false);
    // equal length: Allow wins
    expect(robotsAllows('User-agent: *\nDisallow: /p\nAllow: /p\n', '/p')).toBe(true);
  });

  it('supports * and $ wildcards', () => {
    const txt = 'User-agent: *\nDisallow: /*.php$\nAllow: /refresh.php$\n';
    expect(robotsAllows(txt, '/x.php')).toBe(false);
    expect(robotsAllows(txt, '/x.php?q=1')).toBe(true);
    expect(robotsAllows(txt, '/refresh.php')).toBe(true);
  });

  it('a group naming the product token replaces the * group', () => {
    const txt =
      'User-agent: *\nDisallow: /\n\nUser-agent: EarningsCalendarPrototype\nUser-agent: other\nDisallow: /json/\n';
    expect(robotsAllows(txt, '/refresh.php')).toBe(true);
    expect(robotsAllows(txt, '/json/x')).toBe(false);
    expect(robotsAllows(txt, '/refresh.php', 'SomeoneElse/2.0')).toBe(false);
  });
});
