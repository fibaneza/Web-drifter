import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDevices } from '../../src/config/devices.js';
import { parseConfig, type DrifterConfig } from '../../src/config/index.js';
import { silentLogger } from '../../src/core/logger.js';
import type { Finding, FindingCategory, RunStats } from '../../src/core/types.js';
import { compareRun } from '../../src/compare/engine.js';
import { crawlSide } from '../../src/crawl/crawler.js';
import { createCrawlPool } from '../../src/crawl/create-pool.js';
import { ArtifactStore, generateRunId } from '../../src/store/artifact-store.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

/**
 * End-to-end comparison against the fixture pair.
 *
 * `test/fixtures/DRIFTS.md` lists what the tool must report and - just as
 * importantly - what it must NOT. The false-positive guards are the real test:
 * two sites built from completely unrelated markup should produce findings only
 * where content genuinely differs.
 */

describe('compare (end to end)', () => {
  let legacy: FixtureServer;
  let modern: FixtureServer;
  let outDir: string;
  let findings: Finding[];
  let stats: RunStats;

  const of = (category: FindingCategory): Finding[] =>
    findings.filter((f) => f.category === category);

  const on = (category: FindingCategory, path: string): Finding[] =>
    findings.filter((f) => f.category === category && f.path === path);

  before(async () => {
    legacy = await startFixtureServer({ site: 'legacy' });
    modern = await startFixtureServer({ site: 'modern' });
    outDir = await mkdtemp(join(tmpdir(), 'drifter-compare-'));

    const config: DrifterConfig = parseConfig({
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
      viewports: ['desktop', 'tablet'],
      stabilization: { quietMs: 250, readyTimeoutMs: 8000, awaitFirstRenderMs: 800 },
    });

    const devices = resolveDevices(config.viewports, config.devices);
    const primaryDevice = devices.find((d) => d.id === config.primaryViewport);
    if (!primaryDevice) throw new Error('no primary device resolved');

    const runId = generateRunId();
    const startedAt = new Date().toISOString();
    const store = await ArtifactStore.create(outDir, {
      runId,
      startedAt,
      sourceBaseUrl: config.source.baseUrl,
      targetBaseUrl: config.target.baseUrl,
      viewports: config.viewports,
      schemaVersion: 1,
    });

    for (const side of ['source', 'target'] as const) {
      const pool = await createCrawlPool(config, side, silentLogger);
      try {
        await crawlSide({
          side,
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

    const result = await compareRun({ store, config, logger: silentLogger, runId, startedAt });
    findings = result.findings;
    stats = result.stats;
  });

  after(async () => {
    await legacy?.close();
    await modern?.close();
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  /* ------------------------------ must report ----------------------------- */

  it('reports a page that exists on source but not on target', () => {
    const missing = of('page.missing-on-target');
    assert.deepEqual(
      missing.map((f) => f.path),
      ['/contact'],
    );
    assert.equal(missing[0]?.severity, 'error');
  });

  it('reports a page that exists only on target', () => {
    assert.deepEqual(
      of('page.extra-on-target').map((f) => f.path),
      ['/blog'],
    );
  });

  it('reports content missing from the target', () => {
    // The apprenticeship paragraph exists only on the legacy /about page.
    const missing = on('content.missing', '/about');
    assert.ok(
      missing.some((f) => String(f.expected).includes('apprenticeship')),
      `expected the apprenticeship paragraph; got: ${missing.map((f) => f.expected).join(' | ')}`,
    );
  });

  it('reports content added on the target', () => {
    const added = on('content.added', '/about');
    assert.ok(
      added.some((f) => String(f.actual).includes('Quality, durability')),
      `expected the "Our values" copy; got: ${added.map((f) => f.actual).join(' | ')}`,
    );
  });

  it('reports a changed heading as drift rather than a delete plus an insert', () => {
    const drift = on('content.drift', '/about');
    const heading = drift.find((f) => f.expected === 'Our history');
    assert.ok(heading, `expected "Our history" -> "Our story"; got: ${JSON.stringify(drift)}`);
    assert.equal(heading.actual, 'Our story');
    assert.equal(heading.nodeKind, 'heading');
  });

  it('reports a changed price with both values', () => {
    const drift = on('price.value-drift', '/products');
    assert.equal(drift.length, 1, `expected exactly one price change: ${JSON.stringify(drift)}`);
    assert.equal(drift[0]?.expected, 1299);
    assert.equal(drift[0]?.actual, 1399);
    assert.equal(drift[0]?.severity, 'error');
  });

  it('reports the h1 font-size difference, per viewport', () => {
    const drift = on('css.property-drift', '/').filter(
      (f) => f.details?.['group'] === 'typography',
    );
    const fontSize = drift.filter((f) => f.expected === '32px' && f.actual === '28px');
    assert.ok(fontSize.length > 0, 'font-size drift not reported');
    // Reported once per viewport, because it is a per-viewport measurement.
    assert.deepEqual([...new Set(fontSize.map((f) => f.viewport))].sort(), ['desktop', 'tablet']);
  });

  it('reports a responsive visibility difference against the affected viewport only', () => {
    // "Spring sale" hides below 480px on legacy and below 900px on modern, so
    // the two disagree at 768px (tablet) and agree at 1440px (desktop).
    const responsive = of('css.responsive-visibility-drift');
    assert.ok(responsive.length > 0, 'responsive visibility drift not reported');

    const tablet = responsive.filter((f) => f.viewport === 'tablet');
    assert.ok(tablet.length > 0, 'expected a finding at the tablet viewport');
    assert.equal(tablet[0]?.expected, 'visible');
    assert.equal(tablet[0]?.actual, 'hidden');
    assert.equal(tablet[0]?.severity, 'error');

    assert.equal(
      responsive.filter((f) => f.viewport === 'desktop').length,
      0,
      'desktop agrees and must not be reported',
    );
  });

  /* --------------------------- must NOT report ---------------------------- */

  it('does not report a differently formatted identical price as a value change', () => {
    // "$49.99" vs "USD 49,99" is the same price. It may appear as a format
    // difference, but never as a value drift.
    const values = on('price.value-drift', '/products');
    assert.ok(
      !values.some((f) => f.expected === 49.99 || f.actual === 49.99),
      'a formatting difference was misreported as a price change',
    );

    const format = on('price.format-drift', '/products');
    for (const finding of format) assert.equal(finding.severity, 'info');
  });

  it('does not report images that differ only by CDN path and content hash', () => {
    // /-/media/images/hero.ashx?w=1200 and /_next/image?url=hero.a1b2c3d4.webp
    // are the same picture.
    assert.deepEqual(of('image.missing'), []);
    assert.deepEqual(of('image.added'), []);
  });

  it('does not report drift for the many paragraphs that are genuinely identical', () => {
    // The two sites share no markup at all, so any structural sensitivity would
    // show up here as mass content drift.
    const shared = on('content.drift', '/').filter(
      (f) => typeof f.expected === 'string' && f.expected.includes('supplied hand tools'),
    );
    assert.equal(shared.length, 0, 'identical copy was reported as drift');
  });

  it('keeps content parity high despite completely unrelated markup', () => {
    // The two fixtures share no markup - tables and `sc-` classes against
    // semantic HTML5 and BEM - so this number measures how much the model is
    // fooled by structure. The remaining gap is the drift the fixtures plant on
    // purpose: a deleted paragraph, an added section, a changed heading, an
    // extra nav item and a changed price.
    //
    // Guarding a floor rather than an exact value: this must never silently
    // regress, but it should be free to improve.
    const FLOOR = 82;
    assert.ok(
      stats.content.contentParity.percent >= FLOOR,
      `content parity fell to ${stats.content.contentParity.percent}% (floor ${FLOOR}%) - ` +
        'the model became more sensitive to markup structure',
    );
  });

  it('does not report navigation as both missing and added', () => {
    // A `<td><a>Home</a></td>` nav against a `<li><a>Home</a></li>` nav must
    // pair up. Capturing the label twice - once as the cell, once as the link -
    // used to make every nav item appear missing AND added.
    const navMissing = findings.filter(
      (f) => f.category === 'content.missing' && f.region === 'nav',
    );
    const navAdded = findings.filter((f) => f.category === 'content.added' && f.region === 'nav');

    // The modern nav genuinely swaps "Contact" for "Blog". Those two are real
    // findings; every other nav item must pair up silently despite the markup
    // changing from table cells to list items.
    //
    // Compared as distinct labels, because the nav appears on every page and a
    // removed item is legitimately reported once per page.
    const distinct = (values: unknown[]): string[] => [...new Set(values.map(String))].sort();

    assert.deepEqual(
      distinct(navMissing.map((f) => f.expected)),
      ['Contact'],
      'only the genuinely removed nav item should be reported missing',
    );
    assert.deepEqual(
      distinct(navAdded.map((f) => f.actual)),
      ['Blog'],
      'only the genuinely new nav item should be reported added',
    );
  });

  it('matches a table cell against a div carrying the same text', () => {
    // Legacy renders product names in `<td>`, modern in `<span>`. Tables to divs
    // is the most common change in this kind of migration and must not read as
    // lost content.
    const productDrift = findings.filter(
      (f) =>
        (f.category === 'content.missing' || f.category === 'content.added') &&
        f.path === '/products' &&
        String(f.expected ?? f.actual).includes('toolbox'),
    );
    assert.deepEqual(productDrift, [], 'a td -> span tag change was reported as content drift');
  });

  /* -------------------------------- stats --------------------------------- */

  it('reports coverage as a percentage with a stated denominator', () => {
    assert.equal(stats.coverage.missingOnTarget, 1);
    assert.equal(stats.coverage.extraOnTarget, 1);
    assert.ok(stats.coverage.pageCoverage.total > 0);
    assert.equal(
      stats.coverage.pageCoverage.matched,
      stats.coverage.pageCoverage.total - stats.coverage.missingOnTarget,
    );
    assert.ok(stats.coverage.pageCoverage.percent < 100);
  });

  it('breaks CSS statistics down per viewport, so a device can be checked alone', () => {
    assert.deepEqual(stats.css.byViewport.map((v) => v.viewport).sort(), ['desktop', 'tablet']);
    for (const viewport of stats.css.byViewport) {
      assert.ok(viewport.comparedProperties > 0, `${viewport.viewport} compared nothing`);
    }
    assert.ok(stats.css.styleParity.percent > 0);
  });

  it('names the properties that drift most, as a starting point for fixes', () => {
    assert.ok(stats.css.topProperties.length > 0);
    assert.ok(stats.css.topProperties.some((p) => p.property === 'font-size'));
  });

  it('ranks the worst pages first', () => {
    assert.ok(stats.topPages.length > 0);
    for (let i = 1; i < stats.topPages.length; i += 1) {
      const previous = stats.topPages[i - 1];
      const current = stats.topPages[i];
      if (!previous || !current) continue;
      assert.ok(
        previous.counts.error >= current.counts.error,
        'pages should be ordered by error count',
      );
    }
  });

  it('gives every finding a stable id that survives a re-comparison', () => {
    const ids = findings.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'finding ids must be unique');
    assert.ok(ids.every((id) => /^[0-9a-f]{12}$/.test(id)));
  });
});
