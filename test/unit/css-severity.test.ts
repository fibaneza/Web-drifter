import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type BoxGeometry,
  type ContentNode,
  type PageSnapshot,
  type Side,
} from '../../src/core/types.js';
import { compareStyles, type MatchedNode } from '../../src/compare/styles.js';

/**
 * Distance-graded CSS severity.
 *
 * The point of grading is that a report full of equal-looking rows gets ignored
 * wholesale. A 1px nudge and a redesign must not read the same, and CSS must
 * never reach `error` - some restyling is intentional in a rewrite, and a gate
 * that fails the build over a shifted margin gets switched off on day one, at
 * which point it catches nothing at all.
 */

const BOX: BoxGeometry = { x: 0, y: 0, width: 200, height: 40 };

const node = (): ContentNode => ({
  key: 'k1',
  ordinal: 0,
  region: 'main',
  kind: 'paragraph',
  text: 'Add to basket',
  attrs: {},
  selectorHint: 'main > p',
});

function snapshot(side: Side, props: Record<string, string>, box: BoxGeometry = BOX): PageSnapshot {
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
    content: [node()],
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
        styles: [{ nodeKey: 'k1', ordinal: 0, props, box, visible: true }],
      },
    ],
    capturedAt: new Date().toISOString(),
    timings: { navMs: 1, readyMs: 1, totalMs: 1 },
    errors: [],
  };
}

const OPTIONS = {
  cssProperties: ['color', 'font-size', 'margin-top'],
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

function drift(
  sourceProps: Record<string, string>,
  targetProps: Record<string, string>,
  boxes?: { source: BoxGeometry; target: BoxGeometry },
) {
  const source = snapshot('source', sourceProps, boxes?.source);
  const target = snapshot('target', targetProps, boxes?.target);
  const matched: MatchedNode[] = [{ source: node(), target: node(), confidence: 1 }];
  return compareStyles(source, target, matched, OPTIONS).findings;
}

const propertyDrift = (facet: string, findings: ReturnType<typeof drift>) =>
  findings.find((f) => f.category === 'css.property-drift' && f.facet === facet);

describe('CSS severity grading', () => {
  it('never reaches error, whatever the magnitude', () => {
    // Black text becoming white is as blatant as CSS drift gets, and it is
    // still a warning: CSS alone must not be able to fail a build.
    const findings = drift({ color: 'rgb(0, 0, 0)' }, { color: 'rgb(255, 255, 255)' });
    const colour = propertyDrift('color', findings);

    assert.ok(colour, 'a black-to-white change must be reported');
    assert.equal(colour.severity, 'warning');
    assert.ok(
      findings.every((f) => f.severity !== 'error'),
      'no CSS finding may be an error',
    );
  });

  it('grades a subtle colour shift below a blatant one', () => {
    const subtle = propertyDrift(
      'color',
      drift({ color: 'rgb(26, 29, 33)' }, { color: 'rgb(33, 36, 41)' }),
    );
    const blatant = propertyDrift(
      'color',
      drift({ color: 'rgb(26, 29, 33)' }, { color: 'rgb(200, 40, 40)' }),
    );

    assert.ok(subtle && blatant);
    assert.equal(subtle.severity, 'info', 'a barely visible shift is information');
    assert.equal(blatant.severity, 'warning');

    const subtleMagnitude = subtle.details?.['magnitude'];
    const blatantMagnitude = blatant.details?.['magnitude'];
    assert.ok(typeof subtleMagnitude === 'number' && typeof blatantMagnitude === 'number');
    assert.ok(
      blatantMagnitude > subtleMagnitude,
      `magnitude must rank drifts: got ${blatantMagnitude} vs ${subtleMagnitude}`,
    );
  });

  it('weighs a font-size change against the size it started from', () => {
    // The whole reason the relative term exists: the same 3px is most of a
    // caption and a rounding error on a hero heading.
    const onCaption = propertyDrift(
      'font-size',
      drift({ 'font-size': '12px' }, { 'font-size': '15px' }),
    );
    const onHeading = propertyDrift(
      'font-size',
      drift({ 'font-size': '48px' }, { 'font-size': '51px' }),
    );

    assert.ok(onCaption && onHeading);
    assert.equal(onCaption.severity, 'warning', '3px on a 12px font is a quarter of it');
    assert.equal(onHeading.severity, 'info', '3px on a 48px heading is barely visible');
  });

  it('grades a layout shift against the tolerance in force at that viewport', () => {
    // At 1440px the tolerance is max(2, 1440 * 0.01) = 14.4px, so anything at
    // or below that is not drift at all; twice it is a warning. Bands are
    // expressed as multiples for exactly this reason - a fixed pixel threshold
    // would land below the reporting gate here and above it on a phone.
    const unreported = drift({}, {}, { source: BOX, target: { ...BOX, x: 10 } });
    assert.equal(
      unreported.find((f) => f.category === 'css.layout-drift'),
      undefined,
      'a shift inside the tolerance is not reported at all',
    );

    const nudged = drift({}, {}, { source: BOX, target: { ...BOX, x: 20 } }).find(
      (f) => f.category === 'css.layout-drift',
    );
    const displaced = drift({}, {}, { source: BOX, target: { ...BOX, x: 140 } }).find(
      (f) => f.category === 'css.layout-drift',
    );

    assert.ok(nudged && displaced);
    assert.equal(nudged.severity, 'info', '20px is over the gate but under twice it');
    assert.equal(displaced.severity, 'warning');
  });

  it('lets an explicit config override win outright', () => {
    // The escape hatch has to stay honest: someone who deliberately raises CSS
    // to error should get an error, not a silently capped warning.
    const source = snapshot('source', { color: 'rgb(0, 0, 0)' });
    const target = snapshot('target', { color: 'rgb(255, 255, 255)' });
    const matched: MatchedNode[] = [{ source: node(), target: node(), confidence: 1 }];

    const findings = compareStyles(source, target, matched, {
      ...OPTIONS,
      severities: { 'css.property-drift': 'error' },
    }).findings;

    assert.equal(propertyDrift('color', findings)?.severity, 'error');
  });
});
