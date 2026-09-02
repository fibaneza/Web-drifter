import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../../src/core/logger.js';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type LinkRecord,
  type PageSnapshot,
  type Side,
} from '../../src/core/types.js';
import { buildPageIndex } from '../../src/compare/coverage.js';
import { compareLinks } from '../../src/compare/links.js';
import { createPathMapping } from '../../src/map/path-map.js';
import { ArtifactStore, generateRunId } from '../../src/store/artifact-store.js';

/**
 * Link path parity.
 *
 * The check being pinned here is narrow and easy to get wrong: "the source
 * links somewhere the target does not". A crawl is bounded - by maxDepth,
 * maxPages, robots and the include/exclude patterns - so the overwhelming
 * majority of link destinations are never captured on either side. Judging
 * parity on captured pages alone turns every one of those into an error, which
 * is how a report ends up with thousands of rows nobody reads.
 */

function link(path: string, text: string, visible = true): LinkRecord {
  return {
    href: path,
    resolved: `https://example.test${path}`,
    path,
    text,
    kind: 'internal',
    region: 'main',
    visible,
  };
}

function page(side: Side, path: string, links: LinkRecord[]): PageSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    side,
    requestedUrl: `https://${side}.test${path}`,
    finalUrl: `https://${side}.test${path}`,
    path,
    depth: 0,
    status: 200,
    redirectChain: [],
    aliases: [],
    contentHash: `hash-${side}-${path}`,
    title: path,
    meta: {
      description: null,
      canonical: null,
      robots: null,
      lang: 'en',
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
    },
    content: [],
    links,
    images: [],
    prices: [],
    viewports: [],
    capturedAt: new Date().toISOString(),
    timings: { navMs: 1, readyMs: 1, totalMs: 1 },
    errors: [],
  };
}

describe('link path parity', () => {
  let baseDir: string;

  before(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'drifter-links-'));
  });

  after(async () => {
    if (baseDir) await rm(baseDir, { recursive: true, force: true });
  });

  async function compare(pages: PageSnapshot[]) {
    const store = await ArtifactStore.create(baseDir, {
      runId: generateRunId(),
      startedAt: new Date().toISOString(),
      sourceBaseUrl: 'https://source.test',
      targetBaseUrl: 'https://target.test',
      viewports: ['desktop'],
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    });
    for (const snapshot of pages) await store.writeSnapshot(snapshot);

    const result = await compareLinks(
      store,
      await buildPageIndex(store, 'source'),
      await buildPageIndex(store, 'target'),
      createPathMapping({ overrides: {}, rewrites: [] }),
      {
        // The network check is a separate concern and would make this a
        // network test; parity is pure computation over the stored snapshots.
        checkExternalLinks: false,
        concurrency: 1,
        timeoutMs: 1000,
        logger: silentLogger,
      },
    );
    return result.findings.filter((f) => f.category === 'link.path-mismatch');
  }

  it('stays quiet when both sides link beyond the crawl boundary', async () => {
    // Regression test, found by running `doctor` against a real site: a crawl
    // bounded at maxDepth 1 reported 29 errors comparing that site against
    // ITSELF, one per link pointing at a page the crawl never reached. Both
    // sides link to /deep; neither captured it. There is no evidence of drift
    // here, and reporting one is strictly worse than reporting nothing.
    const mismatches = await compare([
      page('source', '/', [link('/deep', 'Deep page')]),
      page('target', '/', [link('/deep', 'Deep page')]),
    ]);

    assert.deepEqual(
      mismatches.map((f) => f.subject),
      [],
      'a destination linked by both sides is not drift, captured or not',
    );
  });

  it('reports a route the target neither captured nor links to', async () => {
    // The real defect this check exists for: the rewrite dropped /products.
    const mismatches = await compare([
      page('source', '/', [link('/products', 'Products'), link('/about', 'About')]),
      page('target', '/', [link('/about', 'About')]),
      page('target', '/about', []),
    ]);

    assert.deepEqual(
      mismatches.map((f) => f.subject),
      ['/products'],
    );
    assert.equal(mismatches[0]?.severity, 'error');
  });

  it('accepts a destination the target captured but no longer links to', async () => {
    // Orphaned but present. The page survived the migration, so the route did
    // too - losing the link to it is a navigation change, not a dropped route.
    const mismatches = await compare([
      page('source', '/', [link('/orphan', 'Orphan')]),
      page('target', '/', []),
      page('target', '/orphan', []),
    ]);

    assert.deepEqual(
      mismatches.map((f) => f.subject),
      [],
    );
  });

  it('accepts a destination the target only links to from a collapsed menu', async () => {
    // Asymmetric on purpose: a hidden link on the target still proves the route
    // exists, while a hidden link on the source is not a promise to the user
    // and so is never held to parity in the first place.
    const mismatches = await compare([
      page('source', '/', [link('/legal', 'Legal')]),
      page('target', '/', [link('/legal', 'Legal', false)]),
    ]);

    assert.deepEqual(
      mismatches.map((f) => f.subject),
      [],
    );
  });

  it('ignores hidden source links entirely', async () => {
    const mismatches = await compare([
      page('source', '/', [link('/hidden-only', 'Hidden', false)]),
      page('target', '/', []),
    ]);

    assert.deepEqual(
      mismatches.map((f) => f.subject),
      [],
    );
  });

  it('reports a dropped destination once, not once per page that linked to it', async () => {
    const mismatches = await compare([
      page('source', '/', [link('/gone', 'Gone')]),
      page('source', '/a', [link('/gone', 'Gone')]),
      page('source', '/b', [link('/gone', 'Gone')]),
      page('target', '/', []),
      page('target', '/a', []),
      page('target', '/b', []),
    ]);

    assert.deepEqual(
      mismatches.map((f) => f.subject),
      ['/gone'],
    );
  });
});
