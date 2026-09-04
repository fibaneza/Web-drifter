import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCssValue,
  normalizeCssValue,
  normalizeEmbeddedColors,
  splitCompoundValue,
} from '../../src/compare/css-normalize.js';
import { COLOR_VALUED_PROPERTIES } from '../../src/extract/css-properties.js';

/**
 * Colours inside compound values.
 *
 * `box-shadow` and `background-image` are where a rewrite most often changes a
 * brand colour, and they were compared as raw strings: a gradient whose colour
 * moved by one channel reported identically to one that went from navy to
 * orange, and neither carried a perceptual distance. Both are colour
 * differences and are now judged as such.
 */

const options = { lengthTolerancePx: 1, colorTolerance: 0.03 };
const compare = (property: string, source: string, target: string) =>
  compareCssValue(property, source, target, options);

describe('splitCompoundValue', () => {
  it('separates a shadow into its structure and its colour', () => {
    const { skeleton, colors } = splitCompoundValue('0 1px 2px rgba(0, 0, 0, 0.5)');
    assert.deepEqual(colors, ['rgba(0, 0, 0, 0.5)']);
    assert.ok(!skeleton.includes('rgba'));
  });

  it('keeps every stop of a gradient, in order', () => {
    const { colors } = splitCompoundValue('linear-gradient(to right, #ff0000, rgb(0, 0, 255))');
    assert.deepEqual(colors, ['#ff0000', 'rgb(0, 0, 255)']);
  });

  it('finds nothing in a value that carries no colour', () => {
    assert.deepEqual(splitCompoundValue('translateX(10px)').colors, []);
  });
});

describe('normalizeEmbeddedColors', () => {
  it('canonicalises a hex colour inside a shadow', () => {
    assert.equal(normalizeEmbeddedColors('0 1px 2px #000'), '0 1px 2px rgba(0, 0, 0, 1)');
  });

  it('leaves the structure of the value alone', () => {
    assert.match(normalizeEmbeddedColors('inset 0 0 4px #fff'), /^inset 0 0 4px /);
  });
});

describe('compareCssValue - embedded colours', () => {
  it('treats the same shadow written two ways as equal', () => {
    // The false positive this removes: two stylesheets expressing one shadow.
    const result = compare('box-shadow', '0 1px 2px #000000', '0 1px 2px rgb(0, 0, 0)');
    assert.equal(result.equal, true);
  });

  it('ignores a colour shift below the threshold of vision', () => {
    const result = compare('box-shadow', '0 1px 2px rgb(0, 0, 0)', '0 1px 2px rgb(1, 1, 1)');
    assert.equal(result.equal, true);
  });

  it('reports a real colour change as a colour difference, with a distance', () => {
    const result = compare(
      'background-image',
      'linear-gradient(to right, rgb(0, 0, 128), rgb(0, 0, 200))',
      'linear-gradient(to right, rgb(255, 140, 0), rgb(0, 0, 200))',
    );
    assert.equal(result.equal, false);
    assert.equal(result.kind, 'color');
    assert.ok((result.deltaE ?? 0) > 0.03, 'no perceptual distance reported');
  });

  it('reports the worst stop, not the first', () => {
    const result = compare(
      'background-image',
      'linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0))',
      'linear-gradient(rgb(0, 0, 1), rgb(255, 255, 255))',
    );
    assert.equal(result.kind, 'color');
    assert.ok((result.deltaE ?? 0) > 0.5, 'reported the smaller of the two shifts');
  });

  it('does not call a structural change a colour change', () => {
    // A gradient that gained a stop, or a shadow that moved, is not a colour
    // difference - saying so would hide the structural change behind a delta.
    const movedShadow = compare('box-shadow', '0 1px 2px #000', '0 8px 2px #000');
    assert.equal(movedShadow.kind, 'value');

    const extraStop = compare(
      'background-image',
      'linear-gradient(#000, #fff)',
      'linear-gradient(#000, #888, #fff)',
    );
    assert.equal(extraStop.kind, 'value');
  });

  it('leaves colourless compound values comparing exactly as before', () => {
    assert.equal(compare('transform', 'none', 'translateX(10px)').kind, 'value');
    assert.equal(compare('transform', 'translateX(10px)', 'translateX(10px)').equal, true);
  });
});

describe('SVG paint', () => {
  it('compares fill and stroke, which nothing else can see', () => {
    // An inline icon recoloured in the rewrite changes no other property: the
    // element's `color` is the same, its box is the same, and the markup IS the
    // asset so there is no asset key to differ.
    for (const property of ['fill', 'stroke']) {
      assert.ok(COLOR_VALUED_PROPERTIES.has(property), `${property} is not colour-valued`);
      const result = compare(property, 'rgb(0, 0, 128)', 'rgb(255, 140, 0)');
      assert.equal(result.equal, false);
      assert.equal(result.kind, 'color');
    }
  });

  it('judges them perceptually, so a rounded channel is not drift', () => {
    assert.equal(compare('fill', 'rgb(0, 0, 0)', 'rgb(1, 0, 0)').equal, true);
  });

  it('normalises them like any other colour', () => {
    assert.equal(normalizeCssValue('fill', '#fff'), 'rgba(255, 255, 255, 1)');
  });
});
