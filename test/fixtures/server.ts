import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static server for the fixture sites.
 *
 * The two fixtures are deliberately built with *completely different markup*
 * that renders the *same* content - which is the whole premise of the tool. If
 * the fixtures shared structure, the tests would pass for the wrong reason.
 *
 * Binds to port 0 so tests can run in parallel without port collisions.
 */

const FIXTURES_DIR = fileURLToPath(new URL('.', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

export interface FixtureServer {
  origin: string;
  close: () => Promise<void>;
}

export interface FixtureServerOptions {
  /** Directory under test/fixtures to serve, e.g. `legacy` or `modern`. */
  site: 'legacy' | 'modern';
  /** Extra permanent redirects, as `from path` -> `to path`. */
  redirects?: Record<string, string>;
}

export async function startFixtureServer(options: FixtureServerOptions): Promise<FixtureServer> {
  const root = join(FIXTURES_DIR, options.site);
  const redirects = options.redirects ?? {};

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);

      const redirectTarget = redirects[pathname];
      if (redirectTarget) {
        res.writeHead(301, { location: redirectTarget });
        res.end();
        return;
      }

      // `/about` -> `about.html`, `/` -> `index.html`.
      if (pathname === '/') pathname = '/index.html';
      else if (!extname(pathname)) pathname = `${pathname.replace(/\/$/, '')}.html`;

      // Contain path traversal: a fixture must never serve outside its root.
      const target = normalize(join(root, pathname));
      if (!target.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }

      try {
        const body = await readFile(target);
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>404</title><h1>Not found</h1>');
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture server did not bind to a TCP port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
