import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Frontier, type FrontierOptions } from '../../src/crawl/frontier.js';
import { createOriginGuard } from '../../src/crawl/origin-guard.js';
import { DEFAULT_NORMALIZE_OPTIONS } from '../../src/map/url-normalize.js';
import { DEFAULT_TRAP_OPTIONS } from '../../src/crawl/traps.js';

const BASE = 'https://legacy.test';

function makeFrontier(over: Partial<FrontierOptions> = {}): Frontier {
  return new Frontier({
    guard: createOriginGuard(BASE),
    normalize: DEFAULT_NORMALIZE_OPTIONS,
    traps: DEFAULT_TRAP_OPTIONS,
    maxDepth: 2,
    maxPages: 1000,
    ...over,
  });
}

const u = (path: string): URL => new URL(path, BASE);

/** Capture with a unique content hash, i.e. no content-level duplication. */
let hashCounter = 0;
function captureUnique(frontier: Frontier, entry: { canonical: { href: string } }): void {
  frontier.markCaptured(entry as never, {
    finalUrl: new URL(entry.canonical.href),
    contentHash: `hash-${(hashCounter += 1)}`,
  });
}

describe('Frontier - depth limiting', () => {
  it('accepts seeds at depth 0', () => {
    const f = makeFrontier();
    const result = f.seed(u('/'));
    assert.ok(result.accepted);
    assert.equal(result.entry.depth, 0);
  });

  it('follows links up to maxDepth and refuses beyond it', () => {
    const f = makeFrontier({ maxDepth: 2 });
    assert.ok(f.offer(u('/a'), 0, null).accepted);
    assert.ok(f.offer(u('/b'), 1, '/a').accepted);
    assert.ok(f.offer(u('/c'), 2, '/b').accepted);

    const tooDeep = f.offer(u('/d'), 3, '/c');
    assert.ok(!tooDeep.accepted);
    assert.equal(tooDeep.reason, 'depth-exceeded');
  });

  it('maxDepth 2 means three tiers of pages are captured', () => {
    const f = makeFrontier({ maxDepth: 2 });
    const depths = [0, 1, 2].map((d) => f.offer(u(`/tier-${d}`), d, null).accepted);
    assert.deepEqual(depths, [true, true, true]);
    assert.ok(!f.offer(u('/tier-3'), 3, null).accepted);
  });

  it('maxDepth 0 crawls seeds only', () => {
    const f = makeFrontier({ maxDepth: 0 });
    assert.ok(f.seed(u('/')).accepted);
    assert.ok(!f.offer(u('/child'), 1, '/').accepted);
  });

  it('promotes a URL when a shorter route to it is found later', () => {
    // Under concurrency a page can be discovered via a long route first.
    const f = makeFrontier({ maxDepth: 2 });
    const deep = f.offer(u('/shared'), 3, '/long/way');
    assert.ok(!deep.accepted);
    assert.equal(deep.reason, 'depth-exceeded');

    // The same page later turns up one hop from a seed: it must be crawled.
    const shallow = f.offer(u('/shared'), 1, '/');
    assert.ok(shallow.accepted);
    assert.equal(shallow.entry.depth, 1);
  });

  it('keeps the minimum depth when a queued URL is re-offered more shallowly', () => {
    const f = makeFrontier();
    const first = f.offer(u('/x'), 2, '/a');
    assert.ok(first.accepted);
    const second = f.offer(u('/x'), 1, '/b');
    assert.ok(second.accepted);
    assert.ok(second.promoted);
    assert.equal(second.entry.depth, 1);
    // Promotion must not queue the page twice.
    assert.ok(f.next());
    assert.equal(f.next(), undefined);
  });
});

describe('Frontier - revisit and loop avoidance', () => {
  it('rejects an exact repeat', () => {
    const f = makeFrontier();
    assert.ok(f.offer(u('/a'), 0, null).accepted);
    const again = f.offer(u('/a'), 0, null);
    assert.ok(!again.accepted);
    assert.equal(again.reason, 'duplicate');
  });

  it('treats URL variants that canonicalise together as one page', () => {
    const f = makeFrontier();
    assert.ok(f.offer(u('/about'), 0, null).accepted);
    for (const variant of [
      '/about/',
      '/About',
      '/about#team',
      '/about?utm_source=news',
      '/about/index.html',
      '//about',
    ]) {
      const result = f.offer(u(variant), 0, null);
      assert.ok(!result.accepted, `${variant} should be a duplicate`);
    }
    assert.equal(f.pendingCount, 1);
  });

  it('treats the same path with different query values as DIFFERENT pages', () => {
    // Pagination, search and filter URLs share a path but are distinct pages.
    // Collapsing them would silently drop most of a catalogue from the crawl.
    const f = makeFrontier();
    assert.ok(f.offer(u('/search?q=hammer'), 0, null).accepted);
    assert.ok(f.offer(u('/search?q=saw'), 0, null).accepted, 'second query value must be crawled');
    assert.ok(f.offer(u('/products?page=1'), 0, null).accepted);
    assert.ok(f.offer(u('/products?page=2'), 0, null).accepted);
    assert.ok(f.offer(u('/products'), 0, null).accepted, 'no-param variant is its own page');
    assert.equal(f.pendingCount, 5);
  });

  it('still collapses URLs differing only in parameter order or tracking noise', () => {
    const f = makeFrontier();
    assert.ok(f.offer(u('/p?a=1&b=2'), 0, null).accepted);
    assert.ok(!f.offer(u('/p?b=2&a=1'), 0, null).accepted, 'parameter order is not identity');
    assert.ok(!f.offer(u('/p?a=1&b=2&utm_source=news'), 0, null).accepted);
    assert.equal(f.pendingCount, 1);
  });

  it('collapses query variants ONLY when an allowlist is configured', () => {
    // Documented footgun: a non-empty allowlist discards every other parameter,
    // so /search?q=a and /search?q=b become one page and one is never compared.
    const f = makeFrontier({
      normalize: { ...DEFAULT_NORMALIZE_OPTIONS, queryAllowlist: ['page'] },
    });
    assert.ok(f.offer(u('/search?q=hammer'), 0, null).accepted);
    assert.ok(!f.offer(u('/search?q=saw'), 0, null).accepted);
  });

  it('never re-queues a page that has already been captured', () => {
    const f = makeFrontier();
    const first = f.offer(u('/a'), 0, null);
    assert.ok(first.accepted);
    const entry = f.next();
    assert.ok(entry);
    captureUnique(f, entry);

    const again = f.offer(u('/a'), 1, '/b');
    assert.ok(!again.accepted);
    assert.equal(again.reason, 'already-captured');
  });

  it('breaks a two-page link cycle', () => {
    // /a links to /b, /b links back to /a - the simplest infinite loop.
    const f = makeFrontier();
    f.seed(u('/a'));
    const a = f.next();
    assert.ok(a);
    captureUnique(f, a);

    assert.ok(f.offer(u('/b'), 1, '/a').accepted);
    const b = f.next();
    assert.ok(b);
    captureUnique(f, b);

    assert.ok(!f.offer(u('/a'), 2, '/b').accepted);
    assert.equal(f.next(), undefined);
    assert.equal(f.capturedCount, 2);
  });

  it('dedups on the post-redirect URL', () => {
    const f = makeFrontier();
    f.seed(u('/canonical'));
    const canonical = f.next();
    assert.ok(canonical);
    captureUnique(f, canonical);

    // /alias 301s to /canonical: capturing it must not produce a second page.
    f.offer(u('/alias'), 1, '/canonical');
    const alias = f.next();
    assert.ok(alias);
    const result = f.markCaptured(alias, {
      finalUrl: u('/canonical'),
      contentHash: 'irrelevant',
    });
    assert.equal(result.duplicateOf, 'https://legacy.test/canonical');
  });

  it('can be told not to dedup on content, so query variants are always kept', () => {
    const f = makeFrontier({ dedupeIdenticalContent: false });
    f.seed(u('/list?sort=asc'));
    const first = f.next();
    assert.ok(first);
    f.markCaptured(first, { finalUrl: u('/list?sort=asc'), contentHash: 'identical' });

    f.offer(u('/list?sort=desc'), 1, '/list?sort=asc');
    const second = f.next();
    assert.ok(second);
    const result = f.markCaptured(second, {
      finalUrl: u('/list?sort=desc'),
      contentHash: 'identical',
    });
    assert.equal(result.duplicateOf, null, 'both variants must be kept for comparison');
  });

  it('dedups distinct URLs that render identical content', () => {
    const f = makeFrontier();
    f.seed(u('/page'));
    const first = f.next();
    assert.ok(first);
    f.markCaptured(first, { finalUrl: u('/page'), contentHash: 'same-content' });

    f.offer(u('/page-print'), 1, '/page');
    const second = f.next();
    assert.ok(second);
    const result = f.markCaptured(second, {
      finalUrl: u('/page-print'),
      contentHash: 'same-content',
    });
    assert.equal(result.duplicateOf, 'https://legacy.test/page');
    assert.deepEqual(f.aliasesOf('https://legacy.test/page'), ['https://legacy.test/page-print']);
  });
});

describe('Frontier - origin and trap enforcement', () => {
  it('refuses to queue another origin', () => {
    const f = makeFrontier();
    const result = f.offer(new URL('https://elsewhere.test/page'), 1, '/');
    assert.ok(!result.accepted);
    assert.equal(result.reason, 'off-origin');
  });

  it('refuses crawler traps', () => {
    const f = makeFrontier();
    const result = f.offer(u('/a/b/a/b/a/b'), 1, '/');
    assert.ok(!result.accepted);
    assert.equal(result.reason, 'trap');
  });

  it('applies exclude patterns', () => {
    const f = makeFrontier({ excludePatterns: [/^\/admin/] });
    const result = f.offer(u('/admin/users'), 1, '/');
    assert.ok(!result.accepted);
    assert.equal(result.reason, 'excluded');
    assert.ok(f.offer(u('/public'), 1, '/').accepted);
  });

  it('applies an include allowlist when given', () => {
    const f = makeFrontier({ includePatterns: [/^\/shop/] });
    assert.ok(f.offer(u('/shop/hats'), 1, '/').accepted);
    const result = f.offer(u('/blog/post'), 1, '/');
    assert.ok(!result.accepted);
    assert.equal(result.reason, 'not-included');
  });
});

describe('Frontier - ordering and limits', () => {
  it('drains breadth-first, so pages arrive in depth order', () => {
    const f = makeFrontier();
    f.seed(u('/root'));
    f.offer(u('/child-1'), 1, '/root');
    f.offer(u('/child-2'), 1, '/root');
    f.offer(u('/grandchild'), 2, '/child-1');

    const order: string[] = [];
    for (let entry = f.next(); entry; entry = f.next()) order.push(entry.canonical.path);
    assert.deepEqual(order, ['/root', '/child-1', '/child-2', '/grandchild']);
  });

  it('stops handing out work once maxPages is reached', () => {
    const f = makeFrontier({ maxPages: 2 });
    for (const p of ['/a', '/b', '/c']) f.offer(u(p), 0, null);

    const first = f.next();
    assert.ok(first);
    captureUnique(f, first);
    const second = f.next();
    assert.ok(second);
    captureUnique(f, second);

    assert.equal(f.next(), undefined, 'must not exceed maxPages');
    assert.ok(!f.hasCapacity());
  });

  it('reports why URLs were rejected, so a missing page can be explained', () => {
    const f = makeFrontier({ maxDepth: 1 });
    f.offer(new URL('https://elsewhere.test/x'), 1, '/');
    f.offer(u('/deep'), 5, '/');
    f.offer(u('/a/b/a/b/a/b'), 1, '/');

    const stats = f.stats();
    assert.equal(stats.rejected['off-origin'], 1);
    assert.equal(stats.rejected['depth-exceeded'], 1);
    assert.equal(stats.rejected.trap, 1);
  });
});
