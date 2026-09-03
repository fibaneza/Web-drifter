import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, type DrifterConfig } from '../../src/config/index.js';
import { silentLogger } from '../../src/core/logger.js';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type ContentNode,
  type LinkRecord,
  type PageSnapshot,
  type Side,
} from '../../src/core/types.js';
import { compareRun } from '../../src/compare/engine.js';
import { exitCodeFor, writeReport } from '../../src/report/write.js';
import { ArtifactStore, generateRunId } from '../../src/store/artifact-store.js';

/**
 * Source pages nothing links to.
 *
 * Written as snapshots rather than crawled: everything under test here is
 * comparison and reporting, and seeding a sitemap into the shared fixture sites
 * would perturb the expectations `test/fixtures/DRIFTS.md` pins.
 */

const link = (path: string): LinkRecord => ({
  href: path,
  resolved: `https://legacy.test${path}`,
  path,
  text: path,
  kind: 'internal',
  region: 'nav',
  visible: true,
});

const text = (value: string): ContentNode => ({
  key: `key-${value.replace(/\W+/g, '')}`,
  ordinal: 0,
  region: 'main',
  kind: 'paragraph',
  text: value,
  attrs: {},
  selectorHint: 'main > p',
});

function page(side: Side, path: string, body: string, links: LinkRecord[] = []): PageSnapshot {
  const host = side === 'source' ? 'legacy.test' : 'new.test';
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    side,
    requestedUrl: `https://${host}${path}`,
    finalUrl: `https://${host}${path}`,
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
    content: [text(body)],
    links,
    images: [],
    prices: [],
    viewports: [],
    capturedAt: new Date().toISOString(),
    timings: { navMs: 1, readyMs: 1, totalMs: 1 },
    errors: [],
  };
}

describe('unreachable source pages', () => {
  let outDir: string;
  let config: DrifterConfig;
  let store: ArtifactStore;
  let result: Awaited<ReturnType<typeof compareRun>>;
  let reportDir: string;

  before(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'drifter-orphan-'));
    config = parseConfig({
      source: { name: 'legacy', baseUrl: 'https://legacy.test' },
      target: { name: 'modern', baseUrl: 'https://new.test' },
      crawl: { startUrls: ['/'], checkExternalLinks: false },
      viewports: ['desktop'],
      output: { dir: outDir },
    });

    store = await ArtifactStore.create(outDir, {
      runId: generateRunId(),
      startedAt: new Date().toISOString(),
      sourceBaseUrl: config.source.baseUrl,
      targetBaseUrl: config.target.baseUrl,
      viewports: ['desktop'],
      schemaVersion: 1,
    });

    // Two linked pages that migrated cleanly, and one campaign page that only
    // the sitemap remembers - drifted, and missing from the target entirely.
    for (const snapshot of [
      page('source', '/', 'Welcome', [link('/products')]),
      page('source', '/products', 'Hand tools'),
      page('source', '/campaigns/spring-2019', 'Spring sale ends soon'),
      page('target', '/', 'Welcome', [link('/products')]),
      page('target', '/products', 'Hand tools'),
    ]) {
      await store.writeSnapshot(snapshot);
    }

    const startedAt = new Date().toISOString();
    result = await compareRun({
      store,
      config,
      logger: silentLogger,
      runId: store.runId,
      startedAt,
    });
    const written = await writeReport({
      outDir: store.dir,
      store,
      config,
      logger: silentLogger,
      findings: result.findings,
      stats: result.stats,
      pageStats: result.pageStats,
      skipEvidence: true,
    });
    reportDir = written.outDir;
  });

  after(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  it('identifies the page nothing links to', () => {
    assert.deepEqual(result.stats.coverage.orphanPages, ['/campaigns/spring-2019']);
  });

  it('keeps it out of page coverage, which stays at 100%', () => {
    // Both LINKED source pages made it across, so the migration is complete as
    // far as the reachable site is concerned. Counting the campaign page would
    // report 67% and describe the legacy backlog instead.
    assert.equal(result.stats.coverage.pageCoverage.percent, 100);
    assert.equal(result.stats.coverage.pageCoverage.total, 2);
  });

  it('keeps its findings out of the run totals and out of the gate', () => {
    const orphanFindings = result.findings.filter((f) => f.path === '/campaigns/spring-2019');
    assert.ok(orphanFindings.length > 0, 'the orphan page should still be compared');
    assert.ok(
      orphanFindings.some((f) => f.severity === 'error'),
      'it is missing on the target, which is an error',
    );

    // ...yet the run is clean, and a build cannot fail on it.
    assert.equal(result.stats.findings.bySeverity.error, 0);
    assert.equal(exitCodeFor(result.stats, config), 0);
  });

  it('still reports it, tagged, so nothing is silently dropped', async () => {
    const orphan = result.findings.find((f) => f.path === '/campaigns/spring-2019');
    assert.equal(orphan?.details?.['orphanPage'], true);

    const html = await readFile(join(reportDir, 'coverage-report.html'), 'utf8');
    assert.match(html, /Unreachable source pages/);
    assert.match(html, /campaigns\/spring-2019/);
    assert.match(html, /cannot fail a build/);
  });

  it('holds every page to the same standard when the option is off', async () => {
    const strict = parseConfig({
      source: { name: 'legacy', baseUrl: 'https://legacy.test' },
      target: { name: 'modern', baseUrl: 'https://new.test' },
      crawl: { startUrls: ['/'], checkExternalLinks: false, treatUnlinkedAsOrphans: false },
      viewports: ['desktop'],
      output: { dir: outDir },
    });

    const strictResult = await compareRun({
      store,
      config: strict,
      logger: silentLogger,
      runId: store.runId,
      startedAt: new Date().toISOString(),
    });

    assert.deepEqual(strictResult.stats.coverage.orphanPages, []);
    assert.ok(strictResult.stats.findings.bySeverity.error > 0, 'the missing page now counts');
    assert.equal(exitCodeFor(strictResult.stats, strict), 1);
  });
});
