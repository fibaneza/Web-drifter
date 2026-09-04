import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderOverview } from '../../src/report/html/pages.js';
import { aggregate } from '../../src/report/aggregate.js';
import type { Finding, PageStats, Region, RunStats, Severity } from '../../src/core/types.js';

/**
 * Findings by section.
 *
 * "Which page drifted" and "which section drifted" are different questions with
 * different answers. Fifty findings spread across `main` on fifty pages is a
 * page-by-page content job; the same fifty in `header` is one shared-chrome fix
 * that clears every page at once. Only the second is visible from a per-page
 * breakdown, and it was not reported at all.
 */

function finding(region: Region | undefined, severity: Severity = 'error'): Finding {
  return {
    id: Math.random().toString(36).slice(2),
    category: 'content.drift',
    severity,
    path: '/about',
    label: 'text changed',
    confidence: 1,
    ...(region === undefined ? {} : { region }),
  };
}

function statsFor(findings: readonly Finding[]): RunStats['findings'] {
  const byRegion: Record<Region | 'none', number> = {
    header: 0,
    nav: 0,
    main: 0,
    footer: 0,
    aside: 0,
    other: 0,
    none: 0,
  };
  for (const f of findings) byRegion[f.region ?? 'none'] += 1;
  return {
    total: findings.length,
    bySeverity: { error: findings.length, warning: 0, info: 0 },
    byCategory: { 'content.drift': findings.length },
    byRegion,
  };
}

/** A RunStats with only the fields the overview actually reads. */
function runStats(findings: readonly Finding[]): RunStats {
  const empty = { matched: 0, total: 0, percent: 100 };
  return {
    runId: 'r1',
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:01:00.000Z',
    durationMs: 60_000,
    sourceBaseUrl: 'https://legacy.test',
    targetBaseUrl: 'https://new.test',
    viewports: ['desktop'],
    crawl: {
      source: { pagesCaptured: 1, pagesFailed: 0 },
      target: { pagesCaptured: 1, pagesFailed: 0 },
    },
    coverage: {
      sourcePages: 1,
      targetPages: 1,
      missingOnTarget: 0,
      extraOnTarget: 0,
      statusMismatches: 0,
      aliasPages: 0,
      pageCoverage: empty,
    },
    content: { contentParity: empty },
    images: { imageParity: empty },
    prices: { priceParity: empty },
    css: { styleParity: empty, topProperties: [] },
    links: { linkParity: empty, brokenLinks: 0 },
    findings: statsFor(findings),
    pages: { total: 1, clean: 0, withFindings: 1, cleanRate: empty },
    topPages: [],
  } as unknown as RunStats;
}

function overviewFor(findings: readonly Finding[]): string {
  const pageStats: PageStats[] = [];
  const model = aggregate({
    findings,
    stats: runStats(findings),
    pageStats,
    viewports: ['desktop'],
  });
  return renderOverview({ model, evidence: new Map(), targetPathOf: (p) => p });
}

describe('findings by section', () => {
  it('counts every region a finding can carry', () => {
    const stats = statsFor([
      finding('header'),
      finding('header'),
      finding('nav'),
      finding('main'),
      finding('footer'),
      finding('aside'),
      finding('other'),
    ]);

    assert.equal(stats.byRegion.header, 2);
    assert.equal(stats.byRegion.nav, 1);
    assert.equal(stats.byRegion.aside, 1);
  });

  it('counts a finding with no region rather than dropping it', () => {
    // Coverage, links and whole-page CSS carry no region. Dropping them would
    // make the section table disagree with the headline total.
    const stats = statsFor([finding(undefined), finding('main')]);

    assert.equal(stats.byRegion.none, 1);
    assert.equal(
      Object.values(stats.byRegion).reduce((a, b) => a + b, 0),
      stats.total,
    );
  });

  it('renders a section table on the overview', () => {
    const html = overviewFor([finding('header'), finding('header'), finding('main')]);
    assert.match(html, /Findings by section/);
    assert.match(html, /<code>header<\/code>/);
  });

  it('shows the share, so a dominant section is obvious at a glance', () => {
    const html = overviewFor([
      finding('header'),
      finding('header'),
      finding('header'),
      finding('main'),
    ]);
    assert.match(html, /75%/);
    assert.match(html, /25%/);
  });

  it('lists a region with no findings rather than omitting it', () => {
    // "nav: 0" is a result. A table that hides it leaves the reader unsure
    // whether the navigation was even compared.
    const html = overviewFor([finding('main')]);
    assert.match(html, /<code>nav<\/code>/);
  });

  it('names the region-less bucket in words a reader can act on', () => {
    const html = overviewFor([finding(undefined)]);
    assert.match(html, /page-level/);
  });
});
