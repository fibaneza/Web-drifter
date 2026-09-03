import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type LinkRecord,
  type PageSnapshot,
} from '../../src/core/types.js';
import { findOrphanPages } from '../../src/compare/reachability.js';
import { ArtifactStore, generateRunId } from '../../src/store/artifact-store.js';

/**
 * Which source pages nothing links to.
 *
 * The distinction decides what page coverage means: counting a published-but-
 * unreachable 2019 campaign page against the migration measures the size of the
 * legacy backlog, not the quality of the rewrite.
 */

function link(path: string, visible = true): LinkRecord {
  return {
    href: path,
    resolved: `https://legacy.test${path}`,
    path,
    text: path,
    kind: 'internal',
    region: 'nav',
    visible,
  };
}

function page(path: string, links: LinkRecord[] = []): PageSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    side: 'source',
    requestedUrl: `https://legacy.test${path}`,
    finalUrl: `https://legacy.test${path}`,
    path,
    depth: 0,
    status: 200,
    redirectChain: [],
    aliases: [],
    contentHash: `hash${path}`,
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

describe('findOrphanPages', () => {
  let baseDir: string;

  before(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'drifter-reach-'));
  });

  after(async () => {
    if (baseDir) await rm(baseDir, { recursive: true, force: true });
  });

  async function orphansOf(pages: PageSnapshot[], startUrls: string[] = ['/']): Promise<string[]> {
    const store = await ArtifactStore.create(baseDir, {
      runId: generateRunId(),
      startedAt: new Date().toISOString(),
      sourceBaseUrl: 'https://legacy.test',
      targetBaseUrl: 'https://new.test',
      viewports: ['desktop'],
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    });
    for (const snapshot of pages) await store.writeSnapshot(snapshot);
    const { orphans } = await findOrphanPages(store, startUrls);
    return [...orphans].sort();
  }

  it('finds a page nothing links to', async () => {
    const orphans = await orphansOf([
      page('/', [link('/products')]),
      page('/products'),
      // Only the sitemap knows about this one.
      page('/campaigns/spring-2019'),
    ]);

    assert.deepEqual(orphans, ['/campaigns/spring-2019']);
  });

  it('does not call a linked page an orphan', async () => {
    const orphans = await orphansOf([
      page('/', [link('/products'), link('/about')]),
      page('/products'),
      page('/about'),
    ]);

    assert.deepEqual(orphans, []);
  });

  it('never treats a configured start URL as an orphan', async () => {
    // Nothing links to `/` here - a real possibility when the home link is a
    // logo image - but it was named deliberately, so it is not orphaned.
    const orphans = await orphansOf([page('/', [link('/products')]), page('/products')]);

    assert.deepEqual(orphans, []);
  });

  it('accepts an absolute start URL as well as a path', async () => {
    const orphans = await orphansOf(
      [page('/en/home', [link('/products')]), page('/products')],
      ['https://legacy.test/en/home'],
    );

    assert.deepEqual(orphans, []);
  });

  it('counts a hidden link as making a page reachable', async () => {
    // Reachability is a question about the site's shape, not about what a
    // visitor can click; a collapsed menu still links the page.
    const orphans = await orphansOf([page('/', [link('/legal', false)]), page('/legal')]);

    assert.deepEqual(orphans, []);
  });

  it('links from any crawled page count, not only from the start URL', async () => {
    const orphans = await orphansOf([
      page('/', [link('/products')]),
      page('/products', [link('/products/hats')]),
      page('/products/hats'),
    ]);

    assert.deepEqual(orphans, []);
  });
});
