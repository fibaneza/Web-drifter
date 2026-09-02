import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, nodeKey, trigramSimilarity, truncate } from '../../src/extract/text.js';
import { kindFamily } from '../../src/core/types.js';

describe('normalizeText', () => {
  it('collapses every kind of whitespace, including nbsp', () => {
    assert.equal(normalizeText('  Hello   world \n\t here  '), 'Hello world here');
  });

  it('normalises typographic quotes and dashes', () => {
    // The same sentence authored in a CMS rich-text editor vs a JSX string.
    assert.equal(normalizeText('“Don’t” — really'), '"Don\'t" - really');
  });

  it('strips zero-width and soft-hyphen characters', () => {
    assert.equal(normalizeText('Hy­phen​ation'), 'Hyphenation');
  });

  it('folds Unicode compatibility forms so visually identical text matches', () => {
    assert.equal(normalizeText('Ｈｅｌｌｏ'), 'Hello');
  });

  it('removes configured ignore patterns', () => {
    const out = normalizeText('Updated 02/09/2026 by admin', {
      ignorePatterns: [/\d{2}\/\d{2}\/\d{4}/],
    });
    assert.equal(out, 'Updated by admin');
  });

  it('does not let a stateful global regex skip later matches', () => {
    // A /g regex reused across calls carries lastIndex, which would make
    // normalisation depend on call order - a nightmare to debug from a report.
    const pattern = /\d+/g;
    const first = normalizeText('a1 b2', { ignorePatterns: [pattern] });
    const second = normalizeText('a1 b2', { ignorePatterns: [pattern] });
    assert.equal(first, second);
    assert.equal(first, 'a b');
  });

  it('preserves punctuation and case, which carry meaning', () => {
    assert.equal(normalizeText('Buy Now!'), 'Buy Now!');
  });

  it('can lowercase on request', () => {
    assert.equal(normalizeText('Buy Now', { lowercase: true }), 'buy now');
  });

  it('returns empty for empty input', () => {
    assert.equal(normalizeText(''), '');
    assert.equal(normalizeText('   \n  '), '');
  });
});

describe('nodeKey', () => {
  it('is stable for the same kind and text', () => {
    assert.equal(nodeKey('heading', 'About us'), nodeKey('heading', 'About us'));
  });

  it('separates families, so a heading never matches body text', () => {
    assert.notEqual(nodeKey('heading', 'About us'), nodeKey('text', 'About us'));
  });

  it('gives table cells, list items and paragraphs one identity', () => {
    // Moving from table layout to semantic markup is the most common change in
    // a legacy-to-modern migration; it must not read as lost content.
    assert.equal(
      nodeKey(kindFamily('tableCell'), 'Steel toolbox'),
      nodeKey(kindFamily('paragraph'), 'Steel toolbox'),
    );
    assert.equal(nodeKey(kindFamily('listItem'), 'Home'), nodeKey(kindFamily('paragraph'), 'Home'));
    assert.notEqual(
      nodeKey(kindFamily('heading'), 'Home'),
      nodeKey(kindFamily('paragraph'), 'Home'),
    );
  });

  it('matches across differently-authored but equivalent markup', () => {
    const legacy = normalizeText('“Free”  shipping');
    const modern = normalizeText('"Free" shipping');
    assert.equal(nodeKey('paragraph', legacy), nodeKey('paragraph', modern));
  });
});

describe('trigramSimilarity', () => {
  it('scores identical strings 1', () => {
    assert.equal(trigramSimilarity('Buy now', 'Buy now'), 1);
  });

  it('scores unrelated strings near 0', () => {
    assert.ok(trigramSimilarity('Buy now', 'Contact support') < 0.2);
  });

  it('scores a small reword highly, so the node still pairs up', () => {
    assert.ok(trigramSimilarity('Buy now', 'Buy it now') > 0.6);
  });

  it('is symmetric', () => {
    const a = trigramSimilarity('Free delivery', 'Free UK delivery');
    const b = trigramSimilarity('Free UK delivery', 'Free delivery');
    assert.equal(a, b);
  });

  it('handles empty input without dividing by zero', () => {
    assert.equal(trigramSimilarity('', 'x'), 0);
    assert.equal(trigramSimilarity('', ''), 1);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    assert.equal(truncate('short', 20), 'short');
  });

  it('cuts on a word boundary', () => {
    assert.equal(truncate('the quick brown fox jumps', 16), 'the quick brown...');
  });
});
