import { describe, expect, test, vi } from 'vitest';
import { Broadcaster } from '../../src/api/stream.js';

describe('Broadcaster', () => {
  test('sends each published event to every subscriber as an SSE frame', () => {
    const b = new Broadcaster();
    const a = vi.fn();
    const c = vi.fn();
    b.subscribe(a);
    const off = b.subscribe(c);
    b.publish('results', { ids: [1, 2] });
    expect(a).toHaveBeenCalledWith('event: results\ndata: {"ids":[1,2]}\n\n');
    off();
    b.publish('results', { ids: [3] });
    expect(c).toHaveBeenCalledTimes(1);
    expect(b.size).toBe(1);
  });
});
