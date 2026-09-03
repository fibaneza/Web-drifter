import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { silentLogger } from '../../src/core/logger.js';
import { discoverSitemapUrls } from '../../src/crawl/sitemap.js';
import { startFixtureServer } from '../fixtures/server.js';

/**
 * Sitemap seeding, over real HTTP.
 *
 * Parsing is only reachable through the network path, so it is exercised there
 * rather than by calling the parser directly - and the shapes below are the ones
 * that break across a `fast-xml-parser` major: a lone `<url>` arrives as an
 * object where several arrive as an array, and a body that is not a sitemap must
 * yield no seeds rather than a crash.
 */

/**
 * Serve `routes` from the legacy fixture and collect the discovered seed paths.
 *
 * Routes are built from the origin because the port is only known once the
 * server is listening, and a sitemap index has to point at an absolute URL. The
 * handler reads the same object it was given, so filling it in after `listen`
 * is what makes that possible.
 */
async function seedsFrom(build: (origin: string) => Record<string, string>): Promise<string[]> {
  const routes: Record<string, string> = {};
  const server = await startFixtureServer({ site: 'legacy', extraRoutes: routes });
  try {
    Object.assign(routes, build(server.origin));
    const urls = await discoverSitemapUrls(server.origin, silentLogger);
    return urls.map((url) => url.pathname).sort();
  } finally {
    await server.close();
  }
}

const urlset = (locs: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <url><loc>${loc}</loc><changefreq>daily</changefreq></url>`).join('\n')}
</urlset>`;

describe('sitemap discovery', () => {
  it('reads every <loc> from a flat urlset', async () => {
    const paths = await seedsFrom((origin) => ({
      '/sitemap.xml': urlset([`${origin}/`, `${origin}/about`, `${origin}/catalogue`]),
    }));

    assert.deepEqual(paths, ['/', '/about', '/catalogue']);
  });

  it('reads a sitemap holding exactly one <url>', async () => {
    // The parser hands back an object here and an array above. Getting that
    // wrong silently drops the only seed, which is indistinguishable from a
    // site with an empty sitemap.
    const paths = await seedsFrom((origin) => ({ '/sitemap.xml': urlset([`${origin}/only`]) }));

    assert.deepEqual(paths, ['/only']);
  });

  it('follows a sitemap index one level down', async () => {
    const paths = await seedsFrom((origin) => ({
      '/sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`,
      '/sitemap-pages.xml': urlset([`${origin}/deep`]),
    }));

    // The index contributes no seeds of its own, so an empty result would mean
    // the child sitemap was never fetched.
    assert.deepEqual(paths, ['/deep']);
  });

  it('skips a malformed <loc> without losing the rest of the sitemap', async () => {
    const paths = await seedsFrom((origin) => ({
      '/sitemap.xml': urlset(['not a url', `${origin}/valid`]),
    }));

    assert.deepEqual(paths, ['/valid']);
  });

  it('returns no seeds when the site has no sitemap', async () => {
    // A 404 is the common case rather than an error: plenty of sites have none.
    assert.deepEqual(await seedsFrom(() => ({})), []);
  });

  it('returns no seeds for a body that is not a sitemap at all', async () => {
    const paths = await seedsFrom(() => ({
      '/sitemap.xml': '<!doctype html><html><body>login required</body></html>',
    }));

    assert.deepEqual(paths, []);
  });
});
