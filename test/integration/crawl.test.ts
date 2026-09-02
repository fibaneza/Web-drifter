import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/config/load.js';
import { resolveDevices } from '../../src/config/devices.js';
import { silentLogger } from '../../src/core/logger.js';
import type { PageSnapshot } from '../../src/core/types.js';
import { crawlSide } from '../../src/crawl/crawler.js';
import { createCrawlPool } from '../../src/crawl/create-pool.js';
import { ArtifactStore, generateRunId } from '../../src/store/artifact-store.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

/**
 * End-to-end crawl against the fixture pair.
 *
 * This is the test that proves the crawl bounds actually hold against a real
 * browser and a real HTTP server, rather than only against the unit-level
 * fakes: same-origin confinement, depth limiting, revisit avoidance, and
 * extraction of a comparable model from two structurally unrelated sites.
 */

describe('crawl (end to end)', () => {
  let legacy: FixtureServer;
  let modern: FixtureServer;
  let outDir: string;
  let store: ArtifactStore;
  let sourceSnapshots: Map<string, PageSnapshot>;
  let targetSnapshots: Map<string, PageSnapshot>;
  let sourceStats: Awaited<ReturnType<typeof crawlSide>>;

  before(async () => {
    legacy = await startFixtureServer({ site: 'legacy' });
    modern = await startFixtureServer({ site: 'modern' });
    outDir = await mkdtemp(join(tmpdir(), 'drifter-crawl-'));

    const config = parseConfig({
      source: { name: 'legacy', baseUrl: legacy.origin },
      target: { name: 'modern', baseUrl: modern.origin },
      crawl: {
        startUrls: ['/'],
        useSitemap: false,
        maxDepth: 2,
        maxPages: 50,
        concurrency: 2,
        respectRobotsTxt: false,
      },
      // Two viewports keep the test quick while still exercising the
      // per-viewport capture path and the responsive-visibility signal.
      viewports: ['desktop', 'tablet'],
      stabilization: { quietMs: 200, readyTimeoutMs: 8000 },
    });

    const devices = resolveDevices(config.viewports, config.devices);
    const primaryDevice = devices.find((d) => d.id === config.primaryViewport);
    if (!primaryDevice) throw new Error('no primary device resolved');

    store = await ArtifactStore.create(outDir, {
      runId: generateRunId(),
      startedAt: new Date().toISOString(),
      sourceBaseUrl: config.source.baseUrl,
      targetBaseUrl: config.target.baseUrl,
      viewports: config.viewports,
      schemaVersion: 1,
    });

    for (const side of ['source', 'target'] as const) {
      const pool = await createCrawlPool(config, side, silentLogger);
      try {
        const stats = await crawlSide({
          side,
          config,
          devices,
          primaryDevice,
          pool,
          store,
          logger: silentLogger,
          captureScreenshots: false,
        });
        if (side === 'source') sourceStats = stats;
      } finally {
        await pool.close();
      }
    }

    sourceSnapshots = await collect(store, 'source');
    targetSnapshots = await collect(store, 'target');
  });

  after(async () => {
    await legacy?.close();
    await modern?.close();
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  it('captures every linked page on the source', () => {
    assert.deepEqual([...sourceSnapshots.keys()].sort(), [
      '/',
      '/about',
      '/app#/parts',
      '/app#/tools',
      '/contact',
      '/products',
      '/search?q=hammer',
      '/search?q=saw',
    ]);
  });

  it('captures every linked page on the target', () => {
    // /missing-page is included deliberately: the target links to it, so it is
    // captured with its 404 status. That IS how the broken link is detected -
    // silently skipping non-2xx pages would lose the finding.
    assert.deepEqual([...targetSnapshots.keys()].sort(), [
      '/',
      '/about',
      '/app#/parts',
      '/app#/tools',
      '/blog',
      '/missing-page',
      '/products',
      '/search?q=hammer',
      '/search?q=saw',
    ]);
    assert.equal(targetSnapshots.get('/missing-page')?.status, 404);
  });

  it('never leaves the origin', () => {
    // The home page links to an external supplier. It must be recorded as a
    // link but never fetched - nothing outside the fixture origin may appear.
    for (const snapshot of sourceSnapshots.values()) {
      assert.ok(
        snapshot.finalUrl.startsWith(legacy.origin),
        `source crawl left its origin: ${snapshot.finalUrl}`,
      );
    }
    for (const snapshot of targetSnapshots.values()) {
      assert.ok(
        snapshot.finalUrl.startsWith(modern.origin),
        `target crawl left its origin: ${snapshot.finalUrl}`,
      );
    }
    assert.equal(sourceStats.pagesFailed, 0, 'no capture should have been attempted off-origin');
  });

  it('records the external link without crawling it', () => {
    const home = sourceSnapshots.get('/');
    const external = home?.links.find((l) => l.href.includes('external-supplier'));
    assert.ok(external, 'external link should be recorded');
    assert.equal(external.kind, 'external');
    assert.equal(external.path, null, 'an external link has no internal path');
  });

  it('respects the depth limit', () => {
    for (const snapshot of sourceSnapshots.values()) {
      assert.ok(snapshot.depth <= 2, `${snapshot.path} captured at depth ${snapshot.depth}`);
    }
  });

  it('captures each page exactly once despite reciprocal navigation links', () => {
    // Every page links back to every other page, so a frontier without revisit
    // detection would loop indefinitely.
    assert.equal(sourceSnapshots.size, 8);
    assert.equal(sourceStats.pagesFailed, 0);
  });

  it('crawls the same path with different query values as separate pages', () => {
    // Pagination, search and filter URLs share a path but are distinct pages.
    // Collapsing them would silently drop most of a catalogue from the crawl.
    const hammer = sourceSnapshots.get('/search?q=hammer');
    const saw = sourceSnapshots.get('/search?q=saw');
    assert.ok(hammer, '/search?q=hammer was not crawled');
    assert.ok(saw, '/search?q=saw was not crawled');

    const summaryOf = (s: PageSnapshot): string | undefined =>
      s.content.find((n) => n.text.startsWith('Results for'))?.text;

    assert.equal(summaryOf(hammer), 'Results for hammer');
    assert.equal(summaryOf(saw), 'Results for saw');
    assert.notEqual(
      hammer.contentHash,
      saw.contentHash,
      'query-driven pages must not share a content hash',
    );
  });

  it('treats client-side hash routes as separate pages', () => {
    // A hash-routed SPA carries its whole route after the '#'. Dropping the
    // fragment would collapse the entire app into one page.
    const tools = sourceSnapshots.get('/app#/tools');
    const parts = sourceSnapshots.get('/app#/parts');
    assert.ok(tools, '/app#/tools was not crawled');
    assert.ok(parts, '/app#/parts was not crawled');
    assert.notEqual(tools.contentHash, parts.contentHash, 'routes must render differently');
  });

  it('waits for a client-side route to render its content asynchronously', () => {
    // The fixture router fills the view 350ms after navigation. Capturing
    // before that would record "Loading..." and report the page as empty.
    const textOf = (snapshot: PageSnapshot): string[] => snapshot.content.map((n) => n.text);

    assert.ok(
      textOf(requireSnapshot(sourceSnapshots, '/app#/tools')).includes('Hand tools catalogue'),
      'route content was not rendered before capture',
    );
    assert.ok(
      !textOf(requireSnapshot(sourceSnapshots, '/app#/tools')).includes('Loading...'),
      'captured the pre-render placeholder',
    );
  });

  it('captures content that only loads after scrolling', () => {
    // Scrolling triggers a lazy load which itself resolves asynchronously, so
    // the readiness gate has to run again after the scroll pass.
    const footnote = requireSnapshot(sourceSnapshots, '/app#/tools').content.find(
      (n) => n.text === 'Lazy loaded footnote',
    );
    assert.ok(footnote, 'lazily-loaded content was not captured');
  });

  it('does not treat an in-page anchor as a separate page', () => {
    // "#pricing" points inside the page we are already on.
    assert.ok(!sourceSnapshots.has('/app#pricing'));
    const anchor = requireSnapshot(sourceSnapshots, '/app#/tools').links.find(
      (l) => l.href === '#pricing',
    );
    assert.ok(anchor, 'anchor link should still be recorded');
    assert.equal(anchor.kind, 'anchor');
  });

  it('extracts a comparable model from two unrelated DOM structures', () => {
    // Legacy uses tables and sc- classes; modern uses semantic HTML5 and BEM.
    const sourceAbout = sourceSnapshots.get('/about');
    const targetAbout = targetSnapshots.get('/about');
    assert.ok(sourceAbout && targetAbout);

    const shared = 'Founded in Sheffield in 1952, Acme Tools began as a family forge.';
    const inSource = sourceAbout.content.find((n) => n.text === shared);
    const inTarget = targetAbout.content.find((n) => n.text === shared);

    assert.ok(inSource, 'paragraph missing from source model');
    assert.ok(inTarget, 'paragraph missing from target model');
    assert.equal(inSource.key, inTarget.key, 'identical text must produce an identical node key');
    assert.equal(inSource.region, 'main');
    assert.equal(inTarget.region, 'main');
  });

  it('assigns landmark regions across different markup conventions', () => {
    const source = sourceSnapshots.get('/');
    const target = targetSnapshots.get('/');
    // Legacy declares role="navigation" on a <table>; modern uses <nav>.
    assert.ok(
      source?.links.some((l) => l.region === 'nav'),
      'legacy nav not detected',
    );
    assert.ok(
      target?.links.some((l) => l.region === 'nav'),
      'modern nav not detected',
    );
  });

  it('matches images across a media handler and an image proxy', () => {
    // The negative test that matters most: /-/media/images/hero.ashx?w=1200 and
    // /_next/image?url=%2Fstatic%2Fhero.a1b2c3d4.webp are the same picture.
    const sourceHero = sourceSnapshots.get('/')?.images.find((i) => i.alt === 'Workshop bench');
    const targetHero = targetSnapshots.get('/')?.images.find((i) => i.alt === 'Workshop bench');
    assert.ok(sourceHero && targetHero);
    assert.equal(sourceHero.assetKey, targetHero.assetKey);
    assert.equal(sourceHero.assetKey, 'hero');
  });

  it('parses prices to comparable numbers regardless of formatting', () => {
    const source = sourceSnapshots.get('/products');
    const target = targetSnapshots.get('/products');
    assert.ok(source && target);

    const amounts = (snapshot: PageSnapshot): number[] =>
      [...new Set(snapshot.prices.map((p) => p.amount))].sort((a, b) => a - b);

    assert.ok(amounts(source).includes(1299), `source prices: ${amounts(source).join()}`);
    assert.ok(amounts(target).includes(1399), `target prices: ${amounts(target).join()}`);

    // "$49.99" and "USD 49,99" are the same price written two ways.
    assert.ok(amounts(source).includes(49.99));
    assert.ok(amounts(target).includes(49.99));
  });

  it('captures styles and geometry at every enabled viewport', () => {
    const home = sourceSnapshots.get('/');
    assert.ok(home);
    assert.deepEqual(home.viewports.map((v) => v.viewport).sort(), ['desktop', 'tablet']);
    for (const capture of home.viewports) {
      assert.ok(capture.styles.length > 0, `${capture.viewport} captured no styles`);
      const withBox = capture.styles.find((s) => s.box.width > 0);
      assert.ok(withBox, `${capture.viewport} captured no geometry`);
      assert.ok(withBox.props['font-size'], 'font-size should be recorded');
    }
  });

  it('records the h1 font-size difference the fixtures plant', () => {
    const fontSizeOfH1 = (snapshot: PageSnapshot): string | undefined => {
      const heading = snapshot.content.find((n) => n.kind === 'heading' && n.text === 'Acme Tools');
      const desktop = snapshot.viewports.find((v) => v.viewport === 'desktop');
      return desktop?.styles.find(
        (s) => s.nodeKey === heading?.key && s.ordinal === heading.ordinal,
      )?.props['font-size'];
    };

    assert.equal(fontSizeOfH1(requireSnapshot(sourceSnapshots, '/')), '32px');
    assert.equal(fontSizeOfH1(requireSnapshot(targetSnapshots, '/')), '28px');
  });

  it('records the responsive visibility difference at tablet width', () => {
    // "Spring sale" is hidden below 480px on legacy and below 900px on modern,
    // so at the 768px tablet viewport it is visible on one side only.
    const promoVisibleAt = (snapshot: PageSnapshot, viewport: string): boolean | undefined => {
      const node = snapshot.content.find((n) => n.text === 'Spring sale');
      const capture = snapshot.viewports.find((v) => v.viewport === viewport);
      return capture?.styles.find((s) => s.nodeKey === node?.key && s.ordinal === node.ordinal)
        ?.visible;
    };

    const sourceHome = requireSnapshot(sourceSnapshots, '/');
    const targetHome = requireSnapshot(targetSnapshots, '/');
    assert.equal(promoVisibleAt(sourceHome, 'tablet'), true);
    assert.equal(promoVisibleAt(targetHome, 'tablet'), false);
    // ...and identical at desktop, so this really is viewport-specific.
    assert.equal(promoVisibleAt(sourceHome, 'desktop'), true);
    assert.equal(promoVisibleAt(targetHome, 'desktop'), true);
  });

  it('persists snapshots so a comparison can re-run without re-crawling', async () => {
    const reopened = await ArtifactStore.open(outDir, store.runId);
    const paths = await reopened.listPaths('source');
    assert.ok(paths.includes('/about'));
    assert.equal(paths.length, 8);

    const about = await reopened.readSnapshot('source', '/about');
    assert.ok(about);
    assert.equal(about.side, 'source');
    assert.ok(about.content.length > 0);
  });
});

function requireSnapshot(map: Map<string, PageSnapshot>, path: string): PageSnapshot {
  const snapshot = map.get(path);
  if (!snapshot) throw new Error(`no snapshot captured for ${path}`);
  return snapshot;
}

async function collect(
  store: ArtifactStore,
  side: 'source' | 'target',
): Promise<Map<string, PageSnapshot>> {
  const map = new Map<string, PageSnapshot>();
  for await (const snapshot of store.iterateSnapshots(side)) map.set(snapshot.path, snapshot);
  return map;
}
