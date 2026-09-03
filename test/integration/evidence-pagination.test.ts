import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/config/load.js';
import { silentLogger } from '../../src/core/logger.js';
import { runAll } from '../../src/pipeline.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

/**
 * The evidence gallery is paginated.
 *
 * It opens its cards on purpose - the whole point is seeing the screenshots
 * without clicking - which defeats `loading="lazy"`. One page holding every
 * finding therefore decodes every image at once, and on a real migration with
 * several hundred findings that locks the browser up. This pins the split.
 */

describe('evidence gallery pagination', () => {
  let legacy: FixtureServer;
  let modern: FixtureServer;
  let outDir: string;
  let reportDir: string;
  let evidenceCount: number;

  const read = (name: string): Promise<string> => readFile(join(reportDir, name), 'utf8');

  before(async () => {
    legacy = await startFixtureServer({ site: 'legacy' });
    modern = await startFixtureServer({ site: 'modern' });
    outDir = await mkdtemp(join(tmpdir(), 'drifter-evidence-'));

    const config = parseConfig({
      source: { name: 'legacy', baseUrl: legacy.origin },
      target: { name: 'modern', baseUrl: modern.origin },
      crawl: {
        startUrls: ['/'],
        useSitemap: false,
        maxDepth: 1,
        maxPages: 10,
        concurrency: 2,
        respectRobotsTxt: false,
      },
      viewports: ['desktop'],
      stabilization: { quietMs: 200, readyTimeoutMs: 8000 },
      // Lowered so the fixture pair produces more than one page of evidence;
      // at the default `error` floor it would fit on a single page and this
      // test would pass without exercising anything.
      output: { dir: outDir, evidenceMinSeverity: 'warning' },
    });

    const result = await runAll({ config, logger: silentLogger });
    reportDir = result.store.dir;
    evidenceCount = result.report.evidenceCount;
  });

  after(async () => {
    await legacy?.close();
    await modern?.close();
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  it('splits the gallery across numbered pages', async () => {
    assert.ok(evidenceCount > 20, `need more than one page of evidence, got ${evidenceCount}`);

    const files = (await readdir(reportDir)).filter((name) => name.startsWith('evidence'));
    assert.ok(files.includes('evidence.html'), 'page one must keep the name the nav links to');
    assert.ok(files.includes('evidence-2.html'), 'no second page was written');
  });

  it('caps how many cards, and therefore images, one page loads', async () => {
    const html = await read('evidence.html');
    const cards = (html.match(/class="finding"/g) ?? []).length;

    assert.ok(cards <= 20, `page one holds ${cards} cards, which is the bug being fixed`);
    assert.ok(cards > 0, 'page one is empty');
  });

  it('links between pages in both directions', async () => {
    const first = await read('evidence.html');
    const second = await read('evidence-2.html');

    assert.match(first, /class="pager"/);
    assert.match(first, /href="evidence-2\.html"/, 'no way forward from page one');
    assert.match(second, /href="evidence\.html"/, 'no way back from page two');
    assert.match(second, /page 2 of/);
  });

  it('lets images decode off the critical path', async () => {
    const html = await read('evidence.html');
    const images = (html.match(/<img /g) ?? []).length;
    const async_ = (html.match(/decoding="async"/g) ?? []).length;

    assert.equal(async_, images, 'every evidence image should decode asynchronously');
  });
});
