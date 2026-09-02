import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectTrap, hasRepeatedSegments, DEFAULT_TRAP_OPTIONS } from '../../src/crawl/traps.js';

const trapped = (url: string): boolean => detectTrap(new URL(url)).trapped;

describe('hasRepeatedSegments', () => {
  it('detects a segment repeating at or above the limit', () => {
    assert.ok(hasRepeatedSegments('/shop/cat/shop/cat/shop', 3));
    assert.ok(!hasRepeatedSegments('/shop/cat/shop', 3));
  });

  it('ignores ordinary paths', () => {
    assert.ok(!hasRepeatedSegments('/products/hats/wide-brim', 3));
    assert.ok(!hasRepeatedSegments('/', 3));
  });
});

describe('detectTrap', () => {
  it('accepts normal URLs', () => {
    assert.ok(!trapped('https://a.test/'));
    assert.ok(!trapped('https://a.test/products/hats?page=2'));
  });

  it('rejects self-nesting paths from a bad relative link', () => {
    const verdict = detectTrap(new URL('https://a.test/shop/cat/shop/cat/shop/cat'));
    assert.ok(verdict.trapped);
    assert.match(verdict.reason ?? '', /self-nesting/);
  });

  it('rejects excessively deep paths', () => {
    const deep = `https://a.test/${Array.from({ length: 20 }, (_, i) => `s${i}`).join('/')}`;
    assert.ok(trapped(deep));
  });

  it('rejects faceted-search parameter explosions', () => {
    const params = Array.from({ length: 12 }, (_, i) => `f${i}=1`).join('&');
    assert.ok(trapped(`https://a.test/search?${params}`));
  });

  it('rejects absurdly long URLs', () => {
    assert.ok(trapped(`https://a.test/${'x'.repeat(DEFAULT_TRAP_OPTIONS.maxUrlLength)}`));
  });

  it('honours custom limits', () => {
    const url = new URL('https://a.test/a/b/c');
    assert.ok(!detectTrap(url).trapped);
    assert.ok(detectTrap(url, { ...DEFAULT_TRAP_OPTIONS, maxPathSegments: 2 }).trapped);
  });
});
