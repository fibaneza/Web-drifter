import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeUrl,
  classifyHref,
  resolveHref,
  DEFAULT_NORMALIZE_OPTIONS,
  type UrlNormalizeOptions,
} from '../../src/map/url-normalize.js';

const opts = (over: Partial<UrlNormalizeOptions> = {}): UrlNormalizeOptions => ({
  ...DEFAULT_NORMALIZE_OPTIONS,
  ...over,
});

const key = (url: string, over: Partial<UrlNormalizeOptions> = {}): string =>
  canonicalizeUrl(new URL(url), opts(over)).key;

describe('canonicalizeUrl', () => {
  it('strips the fragment', () => {
    assert.equal(key('https://a.test/about#team'), '/about');
  });

  it('removes default ports but keeps explicit non-default ones', () => {
    assert.equal(canonicalizeUrl(new URL('https://a.test:443/x')).origin, 'https://a.test');
    assert.equal(canonicalizeUrl(new URL('http://a.test:80/x')).origin, 'http://a.test');
    assert.equal(canonicalizeUrl(new URL('http://a.test:8080/x')).origin, 'http://a.test:8080');
  });

  it('lowercases the host always and the path when configured', () => {
    assert.equal(canonicalizeUrl(new URL('https://A.TEST/About')).href, 'https://a.test/about');
    assert.equal(key('https://a.test/About', { lowercasePath: false }), '/About');
  });

  it('collapses duplicate slashes', () => {
    assert.equal(key('https://a.test//news///2024//'), '/news/2024');
  });

  it('applies the trailing-slash policy but never mangles the root', () => {
    assert.equal(key('https://a.test/about/', { trailingSlash: 'strip' }), '/about');
    assert.equal(key('https://a.test/about', { trailingSlash: 'add' }), '/about/');
    assert.equal(key('https://a.test/about/', { trailingSlash: 'keep' }), '/about/');
    for (const trailingSlash of ['strip', 'keep', 'add'] as const) {
      assert.equal(key('https://a.test/', { trailingSlash }), '/', trailingSlash);
    }
  });

  it('strips index filenames so /about/index.html === /about', () => {
    assert.equal(key('https://a.test/about/index.html'), key('https://a.test/about'));
    assert.equal(key('https://a.test/products/default.aspx'), '/products');
  });

  it('drops tracking parameters including any utm_*', () => {
    assert.equal(key('https://a.test/p?utm_source=x&utm_medium=y'), '/p');
    assert.equal(key('https://a.test/p?gclid=1&fbclid=2&msclkid=3'), '/p');
  });

  it('keeps meaningful parameters by default, so distinct pages stay distinct', () => {
    assert.notEqual(key('https://a.test/search?q=a'), key('https://a.test/search?q=b'));
    assert.equal(key('https://a.test/search?q=a'), '/search?q=a');
  });

  it('sorts parameters so ordering never creates a false duplicate', () => {
    assert.equal(key('https://a.test/p?b=2&a=1'), key('https://a.test/p?a=1&b=2'));
  });

  it('keeps only allowlisted parameters when an allowlist is given', () => {
    const withAllow = { queryAllowlist: ['page'] };
    assert.equal(key('https://a.test/p?page=2&sessionid=abc', withAllow), '/p?page=2');
  });

  it('drops explicitly configured parameters', () => {
    assert.equal(key('https://a.test/p?sid=abc&keep=1', { dropParams: ['sid'] }), '/p?keep=1');
  });

  it('separates the origin-independent join key from the full href', () => {
    const c = canonicalizeUrl(new URL('https://legacy.test/about?x=1'));
    assert.equal(c.key, '/about?x=1');
    assert.equal(c.href, 'https://legacy.test/about?x=1');
    assert.equal(c.origin, 'https://legacy.test');
  });

  it('produces an identical join key across two different hosts', () => {
    assert.equal(key('https://legacy.test/products/hat'), key('https://new.test/products/hat'));
  });
});

describe('hash routing', () => {
  it('drops an in-page anchor', () => {
    assert.equal(key('https://a.test/about#team'), '/about');
  });

  it('keeps a client-side route in the fragment', () => {
    // A HashRouter SPA carries the whole route after the '#'. Stripping it
    // would collapse the entire site into a single page.
    assert.equal(key('https://a.test/#/products/hats'), '/#/products/hats');
    assert.notEqual(key('https://a.test/#/products'), key('https://a.test/#/basket'));
  });

  it('keeps a hashbang route', () => {
    assert.equal(key('https://a.test/#!/products'), '/#!/products');
  });

  it('can be forced on or off', () => {
    assert.equal(key('https://a.test/about#team', { hashRouting: 'always' }), '/about#team');
    assert.equal(key('https://a.test/#/products', { hashRouting: 'never' }), '/');
  });

  it('classifies a hash route as internal but a bare anchor as an anchor', () => {
    const page = 'https://a.test/';
    const isOurs = (u: URL): boolean => u.hostname === 'a.test';
    assert.equal(classifyHref('#/products', page, isOurs), 'internal');
    assert.equal(classifyHref('#pricing', page, isOurs), 'anchor');
  });

  it('resolves a hash route to a crawlable URL', () => {
    assert.equal(resolveHref('#/products', 'https://a.test/')?.href, 'https://a.test/#/products');
    assert.equal(resolveHref('#pricing', 'https://a.test/'), null);
  });
});

describe('resolveHref', () => {
  const page = 'https://a.test/shop/cats/';

  it('resolves relative, root-relative and absolute hrefs', () => {
    assert.equal(resolveHref('hats', page)?.href, 'https://a.test/shop/cats/hats');
    assert.equal(resolveHref('/hats', page)?.href, 'https://a.test/hats');
    assert.equal(resolveHref('https://b.test/x', page)?.href, 'https://b.test/x');
  });

  it('resolves protocol-relative hrefs against the page scheme', () => {
    assert.equal(resolveHref('//b.test/x', page)?.href, 'https://b.test/x');
  });

  it('resolves dot segments', () => {
    assert.equal(resolveHref('../dogs', page)?.href, 'https://a.test/shop/dogs');
  });

  it('returns null for non-navigable hrefs', () => {
    for (const href of [
      '',
      '   ',
      '#top',
      'mailto:a@b.test',
      'tel:+1',
      'javascript:void(0)',
      'data:text/plain,x',
    ]) {
      assert.equal(resolveHref(href, page), null, href);
    }
  });
});

describe('classifyHref', () => {
  const page = 'https://a.test/';
  const isOurs = (u: URL): boolean => u.hostname === 'a.test';

  it('classifies every href kind the links report needs', () => {
    const cases: Array<[string, string]> = [
      ['/about', 'internal'],
      ['https://a.test/about', 'internal'],
      ['https://elsewhere.test/', 'external'],
      ['//elsewhere.test/', 'external'],
      ['mailto:hi@a.test', 'mailto'],
      ['tel:+441234', 'tel'],
      ['#section', 'anchor'],
      ['javascript:void(0)', 'unsupported'],
      ['', 'unsupported'],
    ];
    for (const [href, expected] of cases) {
      assert.equal(classifyHref(href, page, isOurs), expected, href);
    }
  });
});
