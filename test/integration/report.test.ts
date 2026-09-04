import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { parseConfig, resolveDevices, type DrifterConfig } from '../../src/config/index.js';
import { silentLogger } from '../../src/core/logger.js';
import type { Finding, RunStats } from '../../src/core/types.js';
import { compareRun } from '../../src/compare/engine.js';
import { crawlSide } from '../../src/crawl/crawler.js';
import { createCrawlPool } from '../../src/crawl/create-pool.js';
import { writeReport, exitCodeFor, type WriteReportResult } from '../../src/report/write.js';
import { ArtifactStore, generateRunId, pathSlug } from '../../src/store/artifact-store.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

/**
 * End-to-end report generation.
 *
 * The report is the half of this tool a person actually consumes, so it gets the
 * same treatment as the detection engine: run the real pipeline against the
 * fixture pair and assert the output is complete, navigable by both axes, and
 * usable offline.
 */

describe('report (end to end)', () => {
  let legacy: FixtureServer;
  let modern: FixtureServer;
  let workDir: string;
  let reportDir: string;
  let result: WriteReportResult;
  let findings: Finding[];
  let stats: RunStats;
  let config: DrifterConfig;

  const read = (name: string): Promise<string> => readFile(join(reportDir, name), 'utf8');
  const exists = (name: string): boolean => existsSync(join(reportDir, name));

  before(async () => {
    legacy = await startFixtureServer({ site: 'legacy' });
    modern = await startFixtureServer({ site: 'modern' });
    workDir = await mkdtemp(join(tmpdir(), 'drifter-report-'));
    reportDir = join(workDir, 'report');

    config = parseConfig({
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
    const store = await ArtifactStore.create(join(workDir, 'runs'), {
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
          // Screenshots ON: the evidence path is part of what this suite tests.
          captureScreenshots: true,
        });
      } finally {
        await pool.close();
      }
    }

    const comparison = await compareRun({
      store,
      config,
      logger: silentLogger,
      runId,
      startedAt,
    });
    findings = comparison.findings;
    stats = comparison.stats;

    result = await writeReport({
      outDir: reportDir,
      store,
      config,
      logger: silentLogger,
      findings,
      stats,
      pageStats: comparison.pageStats,
    });
  });

  after(async () => {
    await legacy?.close();
    await modern?.close();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  /* ------------------------------ completeness ---------------------------- */

  it('writes every top-level report', () => {
    for (const file of [
      'index.html',
      'report.json',
      'stats.json',
      'summary.md',
      'junit.xml',
      'css-report.html',
      'css-report.json',
      'links-report.html',
      'links-report.json',
      'coverage-report.html',
      'coverage-report.json',
      'pages/index.html',
    ]) {
      assert.ok(exists(file), `missing ${file}`);
    }
  });

  it('writes one page under both navigation axes', () => {
    // By page...
    assert.ok(exists(join('pages', `${pathSlug('/about')}.html`)), 'missing page detail');
    // ...and by device.
    for (const viewport of config.viewports) {
      assert.ok(exists(join('devices', viewport, 'index.html')), `missing ${viewport} report`);
      assert.ok(exists(join('css', `${viewport}.html`)), `missing CSS report for ${viewport}`);
    }
  });

  /* -------------------------------- content ------------------------------- */

  it('round-trips report.json', async () => {
    const parsed = JSON.parse(await read('report.json')) as {
      schemaVersion: number;
      findings: Finding[];
      stats: RunStats;
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.findings.length, findings.length);
    assert.equal(parsed.stats.findings.total, stats.findings.total);

    // Identity fields must survive serialisation, or the report cannot group
    // findings by element and a suppression rule cannot be written from it.
    const withSubject = parsed.findings.find((f) => f.subject !== undefined);
    assert.ok(withSubject, 'no finding carried a subject through report.json');
    assert.ok(parsed.findings.every((f) => /^[0-9a-f]{12}$/.test(f.id)));
  });

  it('keeps the separate CSS report to CSS findings only', async () => {
    const parsed = JSON.parse(await read('css-report.json')) as { findings: Finding[] };
    assert.ok(parsed.findings.length > 0, 'expected CSS findings');
    assert.ok(
      parsed.findings.every((f) => f.category.startsWith('css.')),
      'the CSS report must not contain non-CSS categories',
    );
  });

  it('places a responsive finding in the affected device column only', async () => {
    // "Spring sale" disagrees at tablet and agrees at desktop, so the tablet
    // report must contain it and the desktop report must not.
    const tablet = await read(join('devices', 'tablet', 'index.html'));
    const desktop = await read(join('devices', 'desktop', 'index.html'));

    assert.match(tablet, /responsive-visibility-drift/);
    assert.ok(
      !desktop.includes('responsive-visibility-drift'),
      'desktop agrees and must not list a responsive finding',
    );
  });

  it('produces a device matrix on the overview', async () => {
    const index = await read('index.html');
    assert.match(index, /Findings by page and device/);
    for (const viewport of config.viewports) {
      assert.ok(index.includes(viewport), `matrix missing the ${viewport} column`);
    }
  });

  it('writes a JUnit file a CI server can parse', async () => {
    const xml = await read('junit.xml');
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
      testsuites?: { '@_tests'?: string };
    };
    assert.ok(parsed.testsuites, 'junit.xml has no <testsuites> root');
    assert.equal(Number(parsed.testsuites['@_tests']), stats.findings.total);
  });

  it('writes a Markdown summary with a stated denominator for every percentage', async () => {
    const markdown = await read('summary.md');
    assert.match(markdown, /# web-drifter report/);
    assert.match(markdown, /Page coverage/);
    assert.match(markdown, /Content parity/);
    // A percentage with no denominator is not a statistic.
    assert.match(markdown, /\d+ \/ \d+ source pages reachable on target/);
  });

  /* ------------------------------- offline -------------------------------- */

  it('references nothing over the network, so a downloaded artifact still works', async () => {
    const htmlFiles = await collectHtml(reportDir);
    assert.ok(htmlFiles.length > 5, 'expected several HTML files');

    for (const file of htmlFiles) {
      const html = await readFile(file, 'utf8');
      // Crawled URLs legitimately appear as link text and hrefs; what must not
      // appear is a remote ASSET the page needs in order to render.
      const remoteAssets = [
        ...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"/gi),
      ];
      assert.deepEqual(
        remoteAssets.map((m) => m[1]),
        [],
        `${file} loads a remote asset`,
      );
    }
  });

  it('escapes crawled content rather than trusting it', async () => {
    const html = await read('index.html');
    // Page content is untrusted input as far as the report document is concerned.
    assert.ok(!/<script>(?!\s*\n?\(function)/.test(html.replace(/<script>[\s\S]*?<\/script>/, '')));
  });

  /* ------------------------------- evidence ------------------------------- */

  it('gives text and price findings evidence, not only CSS ones', () => {
    // The regression this guards: evidence used to require `details.sourceBox`,
    // which only the two CSS comparators set, so the findings a migration team
    // actually acts on could never have a picture.
    const boxed = findings.filter(
      (f) => f.details?.['sourceBox'] !== undefined || f.details?.['targetBox'] !== undefined,
    );
    const categories = new Set(boxed.map((f) => f.category));

    assert.ok(
      [...categories].some((category) => category.startsWith('content.')),
      `no content finding carries geometry; got ${[...categories].join(', ')}`,
    );
  });

  it('publishes an evidence gallery with the screenshots already visible', async () => {
    const html = await read('evidence.html');

    assert.ok(/<img /.test(html), 'the gallery shows no images');
    // Findings are collapsed everywhere else so a long report stays scannable,
    // which is precisely why the gallery has to open its own cards.
    assert.ok(/<details[^>]* open>/.test(html), 'gallery cards are collapsed');
  });

  it('marks findings that have screenshots so they can be found', async () => {
    const html = await read('index.html');

    assert.ok(/data-evidence="1"/.test(html), 'no finding is marked as having evidence');
    assert.ok(/badge shot/.test(html), 'no visible badge on a finding with evidence');
    assert.ok(/id="filter-evidence"/.test(html), 'no way to filter to findings with evidence');
  });

  it('shows findings on the overview, not only statistics', async () => {
    // Opening index.html used to show stats and nothing else, so the first page
    // anyone looked at contained no findings and therefore no screenshots.
    const html = await read('index.html');
    assert.ok(/class="finding"/.test(html), 'the overview lists no findings');
  });

  it('grades CSS by magnitude and never raises it to an error', () => {
    const css = findings.filter((f) => f.category.startsWith('css.'));
    assert.ok(css.length > 0, 'the fixture pair should produce CSS drift');

    const graded = css.filter((f) => typeof f.details?.['magnitude'] === 'number');
    assert.ok(graded.length > 0, 'no CSS finding carries a magnitude');

    // Visibility loss is exempt in both its forms: an element that vanished is a
    // missing component, not a styling opinion, so it stays an error.
    const visibilityLoss = new Set(['css.visibility-drift', 'css.responsive-visibility-drift']);
    const errors = css.filter((f) => f.severity === 'error' && !visibilityLoss.has(f.category));
    assert.deepEqual(
      errors.map((f) => f.category),
      [],
      'styling must not be able to fail a build on its own',
    );
  });

  it('shows the whole page as evidence when a page is missing entirely', async () => {
    // A missing page has no element to crop, but the stored capture of the side
    // that does have it answers exactly the question being asked.
    const missing = findings.find((f) => f.category === 'page.missing-on-target');
    assert.ok(missing, 'the fixture pair should report a missing page');

    const shots = await collectFiles(join(reportDir, 'assets', 'shots'), '.png');
    const mine = shots.filter((file) => file.includes(missing.id));

    assert.equal(mine.length, 1, `expected one whole-page shot, got ${mine.length}`);
    // The side is load-bearing: page.missing-on-target holds the SOURCE path, so
    // running it through the source-to-target mapping would find the wrong page.
    assert.ok(
      mine[0]?.endsWith('-source.png'),
      `a page missing from the target must show the source capture, got ${mine[0]}`,
    );
  });

  it('says what was compared, so a selector is not mistaken for the basis', async () => {
    // The report showed one CSS selector under "Where", which reads as though
    // selectors were being diffed. They cannot be - the two sites share no
    // markup - so the card now shows both sides and says so.
    const drift = findings.find((f) => f.category === 'content.drift');
    assert.ok(drift, 'the fixture pair should produce content drift');

    assert.ok(
      typeof drift.details?.['targetSelectorHint'] === 'string',
      'the target-side element path is not stored, so only one side can be shown',
    );

    const html = await read(join('pages', `${pathSlug(drift.path)}.html`));
    assert.match(html, /Matched by/, 'no pairing basis on the card');
    assert.match(html, /never compared/, 'the card does not say selectors are not compared');
  });

  it('explains the comparison on the first page a reader opens', async () => {
    assert.match(await read('index.html'), /How the comparison works/);
  });

  it('offers a way to reorder findings, not only filter them', async () => {
    const html = await read('index.html');

    assert.ok(/id="sort-by"/.test(html), 'no sort control');
    // Sorting happens in the browser, so the keys have to be on the cards.
    assert.ok(/data-magnitude="/.test(html), 'no magnitude to sort by');
    assert.ok(/data-path="/.test(html), 'no page to sort by');
  });

  it('crops screenshot evidence for findings that carry geometry', async () => {
    assert.ok(result.evidenceCount > 0, 'no screenshot evidence was generated');

    const shots = join(reportDir, 'assets', 'shots');
    assert.ok(existsSync(shots), 'no evidence directory');

    const files = await collectFiles(shots, '.png');
    assert.ok(files.length > 0, 'no PNG evidence written');

    for (const file of files.slice(0, 10)) {
      const info = await stat(file);
      assert.ok(info.size > 0, `${file} is empty`);
    }

    // Source, target and the pixel overlay should all appear.
    const names = files.map((f) => f.split('/').pop() ?? '');
    assert.ok(
      names.some((n) => n.endsWith('-source.png')),
      'no source crop',
    );
    assert.ok(
      names.some((n) => n.endsWith('-target.png')),
      'no target crop',
    );
    assert.ok(
      names.some((n) => n.endsWith('-diff.png')),
      'no pixel overlay',
    );
  });

  it('breaks findings down by section, and the parts sum to the whole', async () => {
    const html = await read('index.html');
    assert.match(html, /Findings by section/);

    const byRegion = result.model.stats.findings.byRegion;
    const summed = Object.values(byRegion).reduce((a, b) => a + b, 0);
    assert.equal(
      summed,
      result.model.stats.findings.total,
      'the section breakdown disagrees with the headline total',
    );
  });

  /* ----------------------------- visual map ------------------------------- */

  it('maps visible differences onto the full-page captures', async () => {
    const html = await read('visual.html');

    // One pair of images per affected page, and a legend entry per marker.
    const pairs = (html.match(/class="visual-pair"/g) ?? []).length;
    const legend = (html.match(/<li value=/g) ?? []).length;
    assert.ok(pairs > 0, 'no page was mapped');
    assert.ok(legend >= pairs, 'fewer legend entries than mapped pages');

    const dir = join(reportDir, 'assets', 'visual');
    assert.ok(existsSync(dir), 'no visual directory');

    const files = await collectFiles(dir, '.png');
    assert.ok(files.length > 0, 'no annotated images written');
    for (const file of files.slice(0, 6)) {
      assert.ok((await stat(file)).size > 0, `${file} is empty`);
    }

    // Both sides are annotated, so a marker present on one and absent on the
    // other reads as "this exists only on the legacy site".
    const names = files.map((f) => f.split('/').pop() ?? '');
    assert.ok(
      names.some((n) => n.endsWith('-source.png')),
      'no annotated source capture',
    );
    assert.ok(
      names.some((n) => n.endsWith('-target.png')),
      'no annotated target capture',
    );
  });

  it('gives each marker a sentence rather than only a colour', async () => {
    const html = await read('visual.html');
    // The whole point of driving the map from findings instead of from pixels.
    assert.match(html, /<code>(content|price|image|css)\.[a-z-]+<\/code>/);
  });

  it('reaches the visual map from the standard navigation', async () => {
    assert.match(await read('index.html'), /href="visual\.html"/);
  });

  /* ------------------------------ exit code ------------------------------- */

  it('exits non-zero when errors exceed the configured budget', () => {
    assert.ok(stats.findings.bySeverity.error > 0, 'fixtures should produce errors');
    assert.equal(exitCodeFor(stats, config), 1);
  });

  it('exits zero when the budget accommodates the findings', () => {
    const lenient = parseConfig({
      source: { name: 'legacy', baseUrl: legacy.origin },
      target: { name: 'modern', baseUrl: modern.origin },
      thresholds: { failOn: { error: 1000, warning: null } },
    });
    assert.equal(exitCodeFor(stats, lenient), 0);
  });
});

async function collectHtml(dir: string): Promise<string[]> {
  return collectFiles(dir, '.html');
}

async function collectFiles(dir: string, extension: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(full, extension)));
    else if (entry.name.endsWith(extension)) out.push(full);
  }
  return out;
}
