import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/config/load.js';
import { resolveDevices } from '../../src/config/devices.js';
import { silentLogger } from '../../src/core/logger.js';
import type { CrawlStats } from '../../src/core/types.js';
import { crawlSide } from '../../src/crawl/crawler.js';
import { createCrawlPool } from '../../src/crawl/create-pool.js';
import { ArtifactStore, generateRunId } from '../../src/store/artifact-store.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

/**
 * `crawl.retries` against a real browser.
 *
 * The option only earns its place if a page that fails to settle is actually
 * re-attempted and the page is still captured afterwards. Both halves matter:
 * a retry that lost the partial capture would trade a slow page for a missing
 * one, which is a far worse outcome - a missing page is reported as drift on
 * every node it contains.
 */

/**
 * A page that can never be quiet, by construction: it mutates an attribute
 * forever, so the readiness gate times out on every attempt no matter how long
 * it waits. That makes the retry path deterministic rather than timing-dependent.
 */
const NEVER_SETTLES = `<!doctype html>
<html lang="en"><head><title>Never settles</title></head>
<body>
  <h1>Perpetually rendering</h1>
  <p>This page mutates forever, so the readiness gate can never report quiet.</p>
  <script>
    setInterval(() => {
      document.body.setAttribute('data-tick', String(Date.now()));
    }, 30);
  </script>
</body></html>`;

describe('crawl retries', () => {
  let server: FixtureServer;
  let outDir: string;

  before(async () => {
    server = await startFixtureServer({
      site: 'legacy',
      extraRoutes: { '/never-settles': NEVER_SETTLES },
    });
    outDir = await mkdtemp(join(tmpdir(), 'drifter-retries-'));
  });

  after(async () => {
    await server?.close();
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  async function crawlNeverSettling(retries: number): Promise<CrawlStats> {
    const config = parseConfig({
      source: { name: 'legacy', baseUrl: server.origin },
      target: { name: 'modern', baseUrl: 'http://127.0.0.1:1/' },
      crawl: {
        startUrls: ['/never-settles'],
        useSitemap: false,
        // Only the seed: this test is about one page's capture, not discovery.
        maxDepth: 0,
        maxPages: 1,
        concurrency: 1,
        respectRobotsTxt: false,
        retries,
      },
      viewports: ['desktop'],
      // Short enough that exhausting the retries stays quick, long enough that
      // a healthy page would settle well inside it.
      stabilization: { quietMs: 300, readyTimeoutMs: 1200 },
    });

    const devices = resolveDevices(config.viewports, config.devices);
    const primaryDevice = devices.find((d) => d.id === config.primaryViewport);
    if (!primaryDevice) throw new Error('no primary device resolved');

    const store = await ArtifactStore.create(outDir, {
      runId: generateRunId(),
      startedAt: new Date().toISOString(),
      sourceBaseUrl: config.source.baseUrl,
      targetBaseUrl: config.target.baseUrl,
      viewports: config.viewports,
      schemaVersion: 1,
    });

    const pool = await createCrawlPool(config, 'source', silentLogger);
    try {
      return await crawlSide({
        side: 'source',
        config,
        devices,
        primaryDevice,
        pool,
        store,
        logger: silentLogger,
        captureScreenshots: false,
      });
    } finally {
      await pool.close();
    }
  }

  it('re-attempts a page whose readiness gate timed out, and still captures it', async () => {
    const stats = await crawlNeverSettling(1);

    assert.equal(stats.retriedPages, 1, 'the page should have been re-attempted');
    assert.equal(stats.pagesCaptured, 1, 'a retried page must still be captured, not dropped');
    assert.equal(stats.pagesFailed, 0);
    assert.equal(stats.slowPages, 1, 'the surviving capture should be flagged as not-settled');
  });

  it('does not retry when the option is zero', async () => {
    // Guards the counter itself: without this, `retriedPages` incrementing on
    // every slow page would look identical to a working retry.
    const stats = await crawlNeverSettling(0);

    assert.equal(stats.retriedPages, 0, 'retries: 0 must mean exactly one attempt');
    assert.equal(stats.pagesCaptured, 1);
    assert.equal(stats.slowPages, 1);
  });
});
