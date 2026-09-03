import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type ContentNode,
  type NodeStyle,
  type PageSnapshot,
  type Region,
  type Side,
} from '../../src/core/types.js';
import { compareStyles, type MatchedNode } from '../../src/compare/styles.js';

/**
 * Which element a computed style belongs to.
 *
 * Node ordinals count within `region|key` (see `src/extract/page-model.ts`), so
 * a "Home" link in the nav and one in the footer are both ordinal 0 and share a
 * key. Identity that ignores the region therefore resolves both to whichever
 * was indexed last, which misattributes CSS drift AND crops the wrong element
 * into the screenshot evidence. A picture of the wrong element is worse than no
 * picture, because a reviewer trusts what it shows.
 */

const NAV_BOX = { x: 0, y: 0, width: 80, height: 20 };
const FOOTER_BOX = { x: 0, y: 900, width: 80, height: 20 };

/** Same text, same kind, different region: identical key, identical ordinal. */
function homeLink(region: Region): ContentNode {
  return {
    key: 'sharedkey',
    ordinal: 0,
    region,
    kind: 'link',
    text: 'Home',
    attrs: { path: '/' },
    selectorHint: `${region} a`,
  };
}

function style(region: Region, color: string, box: typeof NAV_BOX): NodeStyle {
  return {
    nodeKey: 'sharedkey',
    ordinal: 0,
    region,
    props: { color },
    box,
    visible: true,
  };
}

function snapshot(side: Side, navColor: string, footerColor: string): PageSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    side,
    requestedUrl: `https://${side}.test/`,
    finalUrl: `https://${side}.test/`,
    path: '/',
    depth: 0,
    status: 200,
    redirectChain: [],
    aliases: [],
    contentHash: 'hash',
    title: 'Page',
    meta: {
      description: null,
      canonical: null,
      robots: null,
      lang: 'en',
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
    },
    content: [homeLink('nav'), homeLink('footer')],
    links: [],
    images: [],
    prices: [],
    viewports: [
      {
        viewport: 'desktop',
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        documentHeight: 2000,
        hasHorizontalOverflow: false,
        styles: [style('nav', navColor, NAV_BOX), style('footer', footerColor, FOOTER_BOX)],
      },
    ],
    capturedAt: new Date().toISOString(),
    timings: { navMs: 1, readyMs: 1, totalMs: 1 },
    errors: [],
  };
}

const OPTIONS = {
  cssProperties: ['color'],
  lengthTolerancePx: 1,
  colorTolerance: 0.01,
  colorDeltaWarn: 0.03,
  lengthWarnPx: 4,
  lengthWarnPercent: 0.15,
  geometryWarnFactor: 2,
  geometryPx: 2,
  geometryPercent: 0.01,
  minMatchConfidence: 0.5,
};

describe('node style identity', () => {
  it('resolves each region to its own element, not whichever was indexed last', () => {
    // Only the footer link changed colour. The nav link is untouched, so exactly
    // one finding should come back, and it must be the footer's.
    const source = snapshot('source', 'rgb(0, 0, 255)', 'rgb(0, 0, 255)');
    const target = snapshot('target', 'rgb(0, 0, 255)', 'rgb(200, 40, 40)');

    const matched: MatchedNode[] = [
      { source: homeLink('nav'), target: homeLink('nav'), confidence: 1 },
      { source: homeLink('footer'), target: homeLink('footer'), confidence: 1 },
    ];

    const findings = compareStyles(source, target, matched, OPTIONS).findings.filter(
      (f) => f.category === 'css.property-drift',
    );

    assert.equal(findings.length, 1, 'only the footer link changed colour');
    assert.equal(findings[0]?.region, 'footer', 'drift attributed to the wrong region');
    assert.equal(findings[0]?.actual, 'rgba(200, 40, 40, 1)');
  });

  it('crops evidence from the element the finding is actually about', () => {
    // The boxes are 900px apart, so a misattributed box is a crop of a
    // completely different part of the page.
    const source = snapshot('source', 'rgb(0, 0, 255)', 'rgb(0, 0, 255)');
    const target = snapshot('target', 'rgb(0, 0, 255)', 'rgb(200, 40, 40)');

    const matched: MatchedNode[] = [
      { source: homeLink('nav'), target: homeLink('nav'), confidence: 1 },
      { source: homeLink('footer'), target: homeLink('footer'), confidence: 1 },
    ];

    const finding = compareStyles(source, target, matched, OPTIONS).findings.find(
      (f) => f.category === 'css.property-drift',
    );

    assert.deepEqual(
      finding?.details?.['sourceBox'],
      FOOTER_BOX,
      'the crop would show the nav link instead of the footer link that drifted',
    );
  });

  it('keeps the two regions apart when both drift', () => {
    const source = snapshot('source', 'rgb(0, 0, 255)', 'rgb(0, 0, 255)');
    const target = snapshot('target', 'rgb(10, 200, 10)', 'rgb(200, 40, 40)');

    const matched: MatchedNode[] = [
      { source: homeLink('nav'), target: homeLink('nav'), confidence: 1 },
      { source: homeLink('footer'), target: homeLink('footer'), confidence: 1 },
    ];

    const byRegion = new Map(
      compareStyles(source, target, matched, OPTIONS)
        .findings.filter((f) => f.category === 'css.property-drift')
        .map((f) => [f.region, f.actual]),
    );

    assert.deepEqual(
      [...byRegion.entries()].sort(),
      [
        ['footer', 'rgba(200, 40, 40, 1)'],
        ['nav', 'rgba(10, 200, 10, 1)'],
      ],
      'each region must report its own colour',
    );
  });
});
