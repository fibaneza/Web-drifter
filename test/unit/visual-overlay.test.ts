import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drawBoxes, overlaySvg, type NumberedBox } from '../../src/report/visual.js';
import { renderVisualReport } from '../../src/report/html/visual-page.js';
import type { VisualPageMap } from '../../src/report/visual.js';

/**
 * Marker placement.
 *
 * Asserted on the SVG rather than by decoding pixels out of a rendered PNG:
 * the latter tests sharp's compositor, not whether a box lands over the element
 * it describes. A marker in the wrong place is worse than no marker, because a
 * reviewer trusts what the picture points at.
 */

const mark = (overrides: Partial<NumberedBox> = {}): NumberedBox => ({
  n: 1,
  box: { x: 10, y: 40, width: 100, height: 20 },
  severity: 'error',
  ...overrides,
});

describe('overlaySvg', () => {
  it('sizes the layer to the image, so it composites at the origin', () => {
    const svg = overlaySvg([mark()], 1, 800, 600);
    assert.match(svg, /<svg[^>]*width="800"[^>]*height="600"/);
  });

  it('places a box at its CSS coordinates when the scale is 1', () => {
    const svg = overlaySvg([mark()], 1, 800, 600);
    assert.match(svg, /<rect x="10" y="40" width="100" height="20"/);
  });

  it('multiplies by the device scale, since captures are in device pixels', () => {
    // At deviceScaleFactor 2 an unscaled box lands in the top-left quadrant and
    // points at the wrong element entirely.
    const svg = overlaySvg([mark()], 2, 1600, 1200);
    assert.match(svg, /<rect x="20" y="80" width="200" height="40"/);
  });

  it('clamps a box that runs past the edge of the capture', () => {
    const svg = overlaySvg([mark({ box: { x: 700, y: 10, width: 400, height: 20 } })], 1, 800, 600);
    assert.match(svg, /<rect x="700" y="10" width="100" height="20"/);
  });

  it('skips a box that lies entirely outside the capture', () => {
    const svg = overlaySvg([mark({ box: { x: 900, y: 10, width: 50, height: 20 } })], 1, 800, 600);
    assert.doesNotMatch(svg, /<rect/);
  });

  it('draws the badge inside the box when there is no room above it', () => {
    // y=0 leaves nowhere to hang a badge; drawn outside it would be clipped and
    // the marker would lose its number.
    const svg = overlaySvg([mark({ box: { x: 0, y: 0, width: 100, height: 20 } })], 1, 800, 600);
    const badge = /<rect x="0" y="(\d+)" width="\d+" height="18" fill="#[0-9a-f]+" \/>/.exec(svg);
    assert.equal(badge?.[1], '0');
  });

  it('colours by severity', () => {
    const svg = overlaySvg(
      [mark({ n: 1, severity: 'error' }), mark({ n: 2, severity: 'info' })],
      1,
      800,
      600,
    );
    assert.match(svg, /#d92d20/);
    assert.match(svg, /#2970ff/);
  });

  it('labels each box with its number', () => {
    const svg = overlaySvg([mark({ n: 7 })], 1, 800, 600);
    assert.match(svg, />7<\/text>/);
  });
});

describe('drawBoxes', () => {
  it('returns the image untouched when there is nothing to mark', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    assert.equal(await drawBoxes(png, [], 1), png);
  });
});

describe('renderVisualReport', () => {
  const baseMark: VisualPageMap['marks'][number] = {
    n: 1,
    findingId: 'abc',
    category: 'content.drift',
    severity: 'error',
    label: 'heading text changed',
    oneSided: false,
  };

  const map: VisualPageMap = {
    path: '/about',
    targetPath: '/about-us',
    viewport: 'desktop',
    sourceImage: 'assets/visual/about@desktop-source.png',
    targetImage: 'assets/visual/about@desktop-target.png',
    marks: [baseMark],
  };

  it('shows both captures and the legend', () => {
    const html = renderVisualReport([map]);
    assert.match(html, /about@desktop-source\.png/);
    assert.match(html, /about@desktop-target\.png/);
    assert.match(html, /heading text changed/);
  });

  it('shows both paths when the rewrite moved the page', () => {
    const html = renderVisualReport([map]);
    assert.match(html, /\/about</);
    assert.match(html, /\/about-us</);
  });

  it('says which side is missing rather than emitting a broken image', () => {
    const html = renderVisualReport([{ ...map, targetImage: null }]);
    assert.match(html, /No capture for this side/);
  });

  it('flags a mark that exists on only one side', () => {
    const html = renderVisualReport([{ ...map, marks: [{ ...baseMark, oneSided: true }] }]);
    assert.match(html, /one side only/);
  });

  it('explains itself when there is nothing to show', () => {
    const html = renderVisualReport([]);
    assert.match(html, /No visible differences to map/);
  });
});
