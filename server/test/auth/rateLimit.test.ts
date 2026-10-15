import { describe, expect, test } from 'vitest';
import { LoginLimiter } from '../../src/auth/rateLimit.js';

const MIN = 60_000;

describe('LoginLimiter', () => {
  test('blocks after 5 failures for the same ID, from any IP', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) {
      expect(l.check('1A', `10.0.0.${i}`, i * MIN)).toBeNull();
      l.fail('1A', `10.0.0.${i}`, i * MIN);
    }
    // Oldest failure at t=0 expires at 15 min; now is 5 min, so 10 minutes remain.
    expect(l.check('1A', '10.9.9.9', 5 * MIN)).toBe(10 * MIN);
    expect(l.check('2A', '10.9.9.9', 5 * MIN)).toBeNull();
  });

  test('blocks after 5 failures from the same IP, for any ID', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.fail(`${i}X`, '1.2.3.4', 0);
    expect(l.check('9Z', '1.2.3.4', 1)).toBe(15 * MIN - 1);
    expect(l.check('9Z', '5.6.7.8', 1)).toBeNull();
  });

  test('failures older than 15 minutes no longer count', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.fail('1A', 'ip', 0);
    expect(l.check('1A', 'ip', 15 * MIN)).toBeNull();
  });

  test('success clears the ID count but not the IP count', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) l.fail('1A', 'ip', 0);
    l.succeed('1A');
    l.fail('1A', 'ip2', 1);
    expect(l.check('1A', 'ip3', 2)).toBeNull();
    l.fail('2A', 'ip', 3);
    expect(l.check('3A', 'ip', 4)).not.toBeNull();
  });
});
