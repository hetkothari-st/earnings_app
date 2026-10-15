import { describe, expect, test, vi } from 'vitest';
import { HttpError, makeHttp } from '../../src/sources/http.js';

const res = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('makeHttp', () => {
  test('retries 5xx then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(503, 'busy'))
      .mockResolvedValueOnce(res(200, { ok: true }));
    const http = makeHttp({ minIntervalMs: 0, backoffMs: 0, fetchImpl });
    await expect(http.json('https://x.test/a')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  test('404 is not retried and throws HttpError with status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, 'nope'));
    const http = makeHttp({ minIntervalMs: 0, backoffMs: 0, fetchImpl });
    await expect(http.json('https://x.test/a')).rejects.toMatchObject({ status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  test('gives up after retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(500, 'err'));
    const http = makeHttp({ minIntervalMs: 0, backoffMs: 0, retries: 2, fetchImpl });
    await expect(http.json('https://x.test/a')).rejects.toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  test('sends configured headers and returns text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, 'hello'));
    const http = makeHttp({ minIntervalMs: 0, headers: { 'User-Agent': 'UA' }, fetchImpl });
    await expect(http.text('https://x.test/t')).resolves.toBe('hello');
    expect(fetchImpl.mock.calls[0]![1].headers).toEqual({ 'User-Agent': 'UA' });
  });
});
