import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { openDb } from '../../src/db/repo.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title>');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app-123.js'), 'console.log(1)');
  writeFileSync(join(root, '..', 'secret.txt'), 'nope');
});

describe('serving the built web app', () => {
  const app = () => buildServer(openDb(':memory:'), { webRoot: root });
  test('index page at /', async () => {
    const res = await app().inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<title>app</title>');
  });
  test('client-side routes fall back to the index page', async () => {
    for (const url of ['/status', '/admin']) {
      const res = await app().inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<title>app</title>');
    }
  });
  test('built assets with their type and long caching', async () => {
    const res = await app().inject({ method: 'GET', url: '/assets/app-123.js' });
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.body).toBe('console.log(1)');
  });
  test('never serves files outside the web root', async () => {
    const res = await app().inject({ method: 'GET', url: '/..%2Fsecret.txt' });
    expect(res.body).not.toBe('nope');
  });
  test('unknown API paths stay JSON 404s', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});
