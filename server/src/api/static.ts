import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** Serves the built web app; any non-API path without a file falls back to index.html (client-side routes). */
export function registerWebApp(app: FastifyInstance, webRoot: string): void {
  const root = resolve(webRoot);
  const index = join(root, 'index.html');

  app.setNotFoundHandler(async (req, reply) => {
    const path = decodeURIComponent(req.url.split('?')[0]!);
    if (req.method !== 'GET' || path.toLowerCase().startsWith('/api')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // Zerodha's return when the Kite app's redirect URL is the site itself: hand it to the callback.
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    if (path === '/' && /[?&]request_token=/.test(query)) return reply.redirect(`/api/admin/kite/callback${query}`);
    const target = normalize(join(root, path));
    let file = index;
    if (target.startsWith(root + sep)) {
      try {
        if ((await stat(target)).isFile()) file = target;
      } catch {
        // no such file: client-side route
      }
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    // Built assets carry a content hash in their name; the index must always be revalidated.
    reply.header('cache-control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.type(type).send(await readFile(file));
  });
}
