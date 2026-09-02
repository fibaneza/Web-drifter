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
