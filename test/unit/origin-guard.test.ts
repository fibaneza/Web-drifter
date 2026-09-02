import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOriginGuard } from '../../src/crawl/origin-guard.js';

const allows = (guard: ReturnType<typeof createOriginGuard>, url: string): boolean =>
  guard.isAllowed(new URL(url));

describe('createOriginGuard', () => {
  const guard = createOriginGuard('https://legacy.test');

  it('allows the configured origin', () => {
    assert.ok(allows(guard, 'https://legacy.test/'));
    assert.ok(allows(guard, 'https://legacy.test/deep/page?x=1#frag'));
  });

  it('never leaves the origin - the core crawl boundary', () => {
    assert.ok(!allows(guard, 'https://elsewhere.test/'));
    assert.ok(!allows(guard, 'https://cdn.example.com/asset'));
  });

  it('treats www and the apex as different origins unless opted in', () => {
    assert.ok(!allows(guard, 'https://www.legacy.test/'));
    const widened = createOriginGuard('https://legacy.test', ['https://www.legacy.test']);
    assert.ok(allows(widened, 'https://www.legacy.test/'));
  });

  it('treats a subdomain as off-origin unless opted in', () => {
    assert.ok(!allows(guard, 'https://shop.legacy.test/'));
    const widened = createOriginGuard('https://legacy.test', ['https://shop.legacy.test']);
    assert.ok(allows(widened, 'https://shop.legacy.test/x'));
    // Widening for one subdomain must not admit another.
    assert.ok(!allows(widened, 'https://blog.legacy.test/x'));
  });

  it('distinguishes scheme and port', () => {
    assert.ok(!allows(guard, 'http://legacy.test/'));
    const ported = createOriginGuard('http://localhost:3000');
    assert.ok(allows(ported, 'http://localhost:3000/a'));
    assert.ok(!allows(ported, 'http://localhost:3001/a'));
  });

  it('rejects non-http schemes outright', () => {
    assert.ok(!allows(guard, 'ftp://legacy.test/x'));
    assert.ok(!allows(guard, 'file:///etc/passwd'));
  });

  it('confines the crawl to a base sub-path when baseUrl has one', () => {
    const scoped = createOriginGuard('https://legacy.test/en-gb/');
    assert.ok(allows(scoped, 'https://legacy.test/en-gb'));
    assert.ok(allows(scoped, 'https://legacy.test/en-gb/products'));
    assert.ok(!allows(scoped, 'https://legacy.test/fr-fr/products'));
    // Must not match a sibling path that merely shares the prefix string.
    assert.ok(!allows(scoped, 'https://legacy.test/en-gb-legacy/x'));
  });

  it('can be disabled for deliberately unbounded diagnostic runs', () => {
    const open = createOriginGuard('https://legacy.test', [], false);
    assert.ok(allows(open, 'https://anywhere.test/'));
    assert.ok(!allows(open, 'ftp://anywhere.test/'));
  });

  it('reports the origins it admits', () => {
    const widened = createOriginGuard('https://legacy.test', ['https://www.legacy.test']);
    assert.deepEqual(widened.origins, ['https://legacy.test', 'https://www.legacy.test']);
    assert.equal(widened.baseOrigin, 'https://legacy.test');
  });
});
