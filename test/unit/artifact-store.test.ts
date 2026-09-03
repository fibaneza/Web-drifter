import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactStore,
  formatBytes,
  generateRunId,
  pathSlug,
} from '../../src/store/artifact-store.js';
import { SNAPSHOT_SCHEMA_VERSION, type PageSnapshot } from '../../src/core/types.js';

/**
 * Storage behaviour, including the two things `output.keepSnapshots` and
 * compression exist to control: how much disk a run costs, and whether it can
 * be re-compared afterwards.
 */

function snapshot(path: string, nodes = 200): PageSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    side: 'source',
    requestedUrl: `https://legacy.test${path}`,
    finalUrl: `https://legacy.test${path}`,
    path,
    depth: 1,
    status: 200,
    redirectChain: [],
    aliases: [],
    contentHash: 'abc123',
    title: 'Acme Tools',
    meta: {
      description: null,
      canonical: null,
      robots: null,
      lang: 'en',
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
    },
    // Repetitive, style-heavy content, which is what a real snapshot looks like.
    content: Array.from({ length: nodes }, (_, i) => ({
      key: `key${i}`,
      ordinal: 0,
      region: 'main' as const,
      kind: 'paragraph' as const,
      text: `Paragraph number ${i} with a reasonable amount of body copy in it.`,
      attrs: {},
      selectorHint: 'main > div > p',
    })),
    links: [],
    images: [],
    prices: [],
    viewports: [
      {
        viewport: 'desktop',
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        documentHeight: 4000,
        hasHorizontalOverflow: false,
        styles: Array.from({ length: nodes }, (_, i) => ({
          nodeKey: `key${i}`,
          ordinal: 0,
          props: {
            'font-size': '16px',
            'font-family': 'Arial, sans-serif',
            color: 'rgb(26, 29, 33)',
            'margin-top': '0px',
            'line-height': '24px',
          },
          box: { x: 0, y: i * 24, width: 800, height: 24 },
          visible: true,
        })),
      },
    ],
    capturedAt: new Date().toISOString(),
    timings: { navMs: 100, readyMs: 200, totalMs: 400 },
    errors: [],
  };
}

describe('ArtifactStore', () => {
  let baseDir: string;
  let store: ArtifactStore;

  before(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'drifter-store-'));
    store = await ArtifactStore.create(baseDir, {
      runId: generateRunId(),
      startedAt: new Date().toISOString(),
      sourceBaseUrl: 'https://legacy.test',
      targetBaseUrl: 'https://new.test',
      viewports: ['desktop'],
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    });
  });

  after(async () => {
    if (baseDir) await rm(baseDir, { recursive: true, force: true });
  });

  it('round-trips a snapshot through compression', async () => {
    const original = snapshot('/products');
    await store.writeSnapshot(original);

    const read = await store.readSnapshot('source', '/products');
    assert.ok(read);
    assert.equal(read.path, '/products');
    assert.equal(read.content.length, original.content.length);
    assert.deepEqual(read.viewports[0]?.styles[0]?.box, { x: 0, y: 0, width: 800, height: 24 });
  });

  it('stores snapshots compressed, cutting disk cost by roughly an order of magnitude', async () => {
    const original = snapshot('/big', 500);
    await store.writeSnapshot(original);

    const uncompressed = Buffer.byteLength(JSON.stringify(original));
    const onDisk = await store.diskUsage();

    // The whole run is measured, so this is a generous bound; the point is that
    // a 500-node page does not cost its full JSON size on disk.
    assert.ok(
      onDisk < uncompressed / 3,
      `expected substantial compression: ${onDisk} bytes on disk vs ${uncompressed} raw`,
    );
  });

  it('still reads an uncompressed snapshot written by an earlier version', async () => {
    // A run captured before compression must remain comparable without a
    // re-crawl, or upgrading silently invalidates every stored run.
    const legacy = snapshot('/legacy-format');
    const dir = join(store.dir, 'snapshots', 'source');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${pathSlug('/legacy-format')}.json`),
      JSON.stringify(legacy),
      'utf8',
    );

    const read = await store.readSnapshot('source', '/legacy-format');
    assert.ok(read, 'an uncompressed snapshot should still be readable');
    assert.equal(read.path, '/legacy-format');
  });

  it('iterates both compressed and uncompressed snapshots', async () => {
    const paths = await store.listPaths('source');
    assert.ok(paths.includes('/products'));
    assert.ok(paths.includes('/legacy-format'), 'the uncompressed snapshot should be iterated');
  });

  it('returns null for a page that was never captured', async () => {
    assert.equal(await store.readSnapshot('source', '/never-crawled'), null);
  });

  it('prunes snapshots when asked, leaving the rest of the run intact', async () => {
    await store.writeJson('report.json', { findings: [] });
    const before = await store.diskUsage();

    await store.pruneSnapshots();

    assert.ok(!existsSync(join(store.dir, 'snapshots')), 'snapshots should be gone');
    assert.ok(existsSync(join(store.dir, 'report.json')), 'the report must survive pruning');
    assert.ok((await store.diskUsage()) < before);

    // And the store degrades honestly rather than throwing.
    assert.equal(await store.readSnapshot('source', '/products'), null);
    assert.deepEqual(await store.listPaths('source'), []);
  });

  it('prunes the full-page captures without touching the evidence crops', async () => {
    // Gzipping snapshots moved the bottleneck: on a two-viewport fixture run the
    // snapshots come to 72 KB and the screenshots to 1.5 MB. The crops the
    // report displays live under `assets/` and must survive.
    await store.writeScreenshot('source', '/products', 'desktop', Buffer.from('png-bytes'));
    await store.writeText(join('assets', 'shots', 'keep.txt'), 'crop');

    assert.ok(existsSync(join(store.dir, 'screenshots')));

    await store.pruneScreenshots();

    assert.ok(!existsSync(join(store.dir, 'screenshots')), 'screenshots should be gone');
    assert.ok(
      existsSync(join(store.dir, 'assets', 'shots', 'keep.txt')),
      'evidence crops must survive; they are what the report shows',
    );
  });

  it('reports disk usage recursively', async () => {
    const usage = await store.diskUsage();
    assert.ok(usage > 0);

    const entries = await readdir(store.dir);
    assert.ok(entries.length > 0);
  });
});

describe('formatBytes', () => {
  it('scales units so a run size is readable at a glance', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(formatBytes(7 * 1024 * 1024 * 1024), '7.0 GB');
  });

  it('drops the decimal once the number is large enough not to need it', () => {
    assert.equal(formatBytes(64 * 1024), '64 KB');
  });
});
