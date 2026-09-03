import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCssValue,
  geometryTolerance,
  normalizeColor,
  normalizeCssValue,
  normalizeFontFamily,
  parsePx,
  primaryFont,
} from '../../src/compare/css-normalize.js';

const opts = { lengthTolerancePx: 1, colorTolerance: 0 };
const cmp = (p: string, a: string, b: string, o = opts): ReturnType<typeof compareCssValue> =>
  compareCssValue(p, a, b, o);

describe('normalizeColor', () => {
  it('canonicalises every notation for the same colour', () => {
    const white = normalizeColor('#fff');
    assert.equal(normalizeColor('#ffffff'), white);
    assert.equal(normalizeColor('rgb(255, 255, 255)'), white);
    assert.equal(normalizeColor('rgb(255 255 255)'), white);
    assert.equal(normalizeColor('white'), white);
  });

  it('keeps genuinely different colours apart', () => {
    assert.notEqual(normalizeColor('#fff'), normalizeColor('#eee'));
  });

  it('rounds alpha so float noise is not a difference', () => {
    assert.equal(normalizeColor('rgba(0,0,0,0.8)'), normalizeColor('rgba(0, 0, 0, 0.800000012)'));
  });

  it('leaves non-colour keywords alone', () => {
    assert.equal(normalizeColor('currentcolor'), 'currentcolor');
  });
});

describe('normalizeFontFamily', () => {
  it('ignores quoting and casing, which have no rendered effect', () => {
    assert.equal(
      normalizeFontFamily('"Helvetica Neue", Arial, sans-serif'),
      normalizeFontFamily('Helvetica Neue, arial, SANS-SERIF'),
    );
  });

  it('extracts the family that actually renders', () => {
    assert.equal(primaryFont('"Helvetica Neue", Arial, sans-serif'), 'helvetica neue');
  });
});

describe('parsePx', () => {
  it('parses pixel values including negatives and decimals', () => {
    assert.equal(parsePx('16px'), 16);
    assert.equal(parsePx('-4.5px'), -4.5);
  });

  it('returns null for keywords and other units', () => {
    for (const value of ['auto', 'normal', 'none', '1em', '50%']) {
      assert.equal(parsePx(value), null, value);
    }
  });
});

describe('normalizeCssValue', () => {
  it('rounds lengths so sub-pixel layout noise is not drift', () => {
    assert.equal(normalizeCssValue('font-size', '16.0000px'), '16px');
    assert.equal(normalizeCssValue('margin-top', '7.999px'), '8px');
  });

  it('collapses whitespace in compound values', () => {
    assert.equal(
      normalizeCssValue('box-shadow', 'rgba(0,0,0,.5)   0   1px    2px'),
      normalizeCssValue('box-shadow', 'rgba(0, 0, 0, .5) 0 1px 2px'),
    );
  });
});

describe('compareCssValue', () => {
  it('treats equivalent colour notations as equal', () => {
    assert.equal(cmp('color', '#ffffff', 'rgb(255, 255, 255)').equal, true);
  });

  it('reports a real colour change, carrying how far apart the colours are', () => {
    const result = cmp('background-color', '#12355b', '#1a4a7a');
    assert.equal(result.equal, false);
    assert.equal(result.kind, 'color');
    assert.ok(
      result.deltaE !== undefined && result.deltaE > 0,
      'a colour difference must carry its perceptual distance, or severity cannot be graded',
    );
  });

  it('absorbs a colour difference below the threshold of vision', () => {
    // Rounding one channel by one is something every rewrite does and nobody
    // can see. Reporting it identically to black becoming white is how a CSS
    // report ends up with thousands of rows that get ignored wholesale.
    const invisible = cmp('color', 'rgb(0, 0, 0)', 'rgb(1, 1, 1)', {
      lengthTolerancePx: 1,
      colorTolerance: 0.01,
    });
    assert.equal(invisible.equal, true);

    const visible = cmp('color', 'rgb(26, 29, 33)', 'rgb(40, 44, 50)', {
      lengthTolerancePx: 1,
      colorTolerance: 0.01,
    });
    assert.equal(visible.equal, false, 'a visible difference must still be reported');
  });

  it('absorbs sub-pixel length differences within tolerance', () => {
    assert.equal(cmp('font-size', '16px', '16.4px').equal, true);
    assert.equal(cmp('font-size', '16px', '15.6px').equal, true);
  });

  it('reports a length change beyond tolerance, with the delta', () => {
    const result = cmp('font-size', '32px', '28px');
    assert.equal(result.equal, false);
    assert.equal(result.kind, 'length');
    assert.equal(result.deltaPx, -4);
  });

  it('classifies a fallback-only font difference separately', () => {
    // Both render in Helvetica Neue wherever it exists. Reporting this as drift
    // would flag every text node on the site over an invisible difference.
    const result = cmp('font-family', '"Helvetica Neue", Arial', 'Helvetica Neue, Helvetica');
    assert.equal(result.equal, false);
    assert.equal(result.kind, 'font-fallback');
  });

  it('reports a genuine font change as a value difference', () => {
    const result = cmp('font-family', 'Arial, sans-serif', 'Georgia, serif');
    assert.equal(result.equal, false);
    assert.equal(result.kind, 'value');
  });

  it('honours a stricter tolerance', () => {
    assert.equal(
      cmp('margin-top', '8px', '8.4px', { lengthTolerancePx: 0, colorTolerance: 0 }).equal,
      false,
    );
  });
});

describe('geometryTolerance', () => {
  it('uses the absolute floor on a wide viewport', () => {
    assert.equal(geometryTolerance(1440, 2, 0.001), 2);
  });

  it('scales up on a narrow viewport, where 2px is a bigger share of the screen', () => {
    assert.equal(geometryTolerance(360, 2, 0.01), 3.6);
  });
});
