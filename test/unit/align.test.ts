import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { align, type AlignedPair } from '../../src/compare/align.js';
import { trigramSimilarity } from '../../src/extract/text.js';

/** Align plain strings, the way content nodes are aligned by their text. */
function alignWords(source: string[], target: string[], threshold = 0.6): AlignedPair<string>[] {
  return align(source, target, {
    keyOf: (s) => s,
    similarity: (a, b) => trigramSimilarity(a, b),
    threshold,
  });
}

const matched = (pairs: AlignedPair<string>[]): Array<[string, string]> =>
  pairs
    .filter((p) => p.source !== null && p.target !== null)
    .map((p) => [p.source as string, p.target as string]);

const sourceOnly = (pairs: AlignedPair<string>[]): string[] =>
  pairs.filter((p) => p.source !== null && p.target === null).map((p) => p.source as string);

const targetOnly = (pairs: AlignedPair<string>[]): string[] =>
  pairs.filter((p) => p.source === null && p.target !== null).map((p) => p.target as string);

describe('align', () => {
  it('matches identical sequences one to one', () => {
    const pairs = alignWords(['a', 'b', 'c'], ['a', 'b', 'c']);
    assert.deepEqual(matched(pairs), [
      ['a', 'a'],
      ['b', 'b'],
      ['c', 'c'],
    ]);
    assert.equal(sourceOnly(pairs).length, 0);
    assert.equal(targetOnly(pairs).length, 0);
    assert.ok(pairs.every((p) => p.confidence === 1));
  });

  it('reports a deletion as source-only', () => {
    const pairs = alignWords(['alpha', 'beta', 'gamma'], ['alpha', 'gamma']);
    assert.deepEqual(sourceOnly(pairs), ['beta']);
    assert.equal(targetOnly(pairs).length, 0);
  });

  it('reports an insertion as target-only', () => {
    const pairs = alignWords(['alpha', 'gamma'], ['alpha', 'beta', 'gamma']);
    assert.deepEqual(targetOnly(pairs), ['beta']);
    assert.equal(sourceOnly(pairs).length, 0);
  });

  it('pairs a reworded item rather than reporting a delete plus an insert', () => {
    // The whole point of the similarity pass: "Buy now" -> "Buy it now" is an
    // edit to one node, not the loss of one node and the arrival of another.
    const pairs = alignWords(['Buy now', 'Contact us'], ['Buy it now', 'Contact us']);
    const pair = pairs.find((p) => p.source === 'Buy now');
    assert.ok(pair);
    assert.equal(pair.target, 'Buy it now');
    assert.ok(pair.confidence > 0.6 && pair.confidence < 1);
  });

  it('refuses to pair items that are merely both present', () => {
    // Below threshold these are two different things; pairing them would
    // produce a confident but meaningless "drift" finding.
    const pairs = alignWords(['Delivery information'], ['Careers at Acme']);
    assert.deepEqual(sourceOnly(pairs), ['Delivery information']);
    assert.deepEqual(targetOnly(pairs), ['Careers at Acme']);
  });

  it('keeps unique items anchored when content around them changes', () => {
    const pairs = alignWords(
      ['header', 'one', 'two', 'three', 'footer'],
      ['header', 'ONE ITEM', 'two', 'footer'],
    );
    // 'header', 'two' and 'footer' are unique on both sides and must anchor.
    const pairsBySource = new Map(matched(pairs));
    assert.equal(pairsBySource.get('header'), 'header');
    assert.equal(pairsBySource.get('two'), 'two');
    assert.equal(pairsBySource.get('footer'), 'footer');
  });

  it('handles repeated items, which cannot be anchored', () => {
    // "Read more" three times says nothing about which instance is which, so
    // the similarity pass has to resolve them by position.
    const pairs = alignWords(['Read more', 'Read more', 'Read more'], ['Read more', 'Read more']);
    assert.equal(matched(pairs).length, 2);
    assert.equal(sourceOnly(pairs).length, 1);
  });

  it('handles an empty side', () => {
    assert.deepEqual(sourceOnly(alignWords(['a', 'b'], [])), ['a', 'b']);
    assert.deepEqual(targetOnly(alignWords([], ['a', 'b'])), ['a', 'b']);
    assert.deepEqual(alignWords([], []), []);
  });

  it('preserves order in the output', () => {
    const pairs = alignWords(['one', 'two', 'three'], ['one', 'three']);
    const order = pairs.map((p) => p.source ?? p.target);
    assert.deepEqual(order, ['one', 'two', 'three']);
  });

  it('detects moved content as a delete plus an insert, not a silent match', () => {
    // Anchors that would cross are dropped by the increasing-subsequence pass,
    // so a genuinely moved block is visible rather than quietly reordered away.
    const pairs = alignWords(['alpha', 'beta', 'gamma'], ['gamma', 'alpha', 'beta']);
    assert.ok(matched(pairs).length >= 2, 'the stable majority should still match');
    assert.ok(
      sourceOnly(pairs).length > 0 || targetOnly(pairs).length > 0,
      'the moved item should surface',
    );
  });

  it('falls back to key matching when a gap is too large to align quadratically', () => {
    const source = Array.from({ length: 400 }, (_, i) => `s-${i % 7}`);
    const target = Array.from({ length: 400 }, (_, i) => `s-${i % 7}`);
    const pairs = align(source, target, {
      keyOf: (s) => s,
      similarity: (a, b) => (a === b ? 1 : 0),
      threshold: 0.6,
      maxProduct: 1000,
    });
    assert.equal(matched(pairs).length, 400);
    assert.equal(sourceOnly(pairs).length, 0);
  });

  it('completes a realistic page-sized alignment quickly', () => {
    const source = Array.from({ length: 600 }, (_, i) => `paragraph number ${i}`);
    const target = source.filter((_, i) => i !== 250);
    const started = Date.now();
    const pairs = alignWords(source, target);
    const elapsed = Date.now() - started;

    assert.equal(sourceOnly(pairs).length, 1);
    assert.ok(elapsed < 2000, `alignment took ${elapsed}ms`);
  });
});
