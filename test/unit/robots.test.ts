import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChecker, parseRobots } from '../../src/crawl/robots.js';

/**
 * robots.txt parsing.
 *
 * Reached over the network in normal use, but the parsing rules - which group
 * wins, which directives are group-scoped - are pure and worth pinning here.
 */

const check = (text: string, userAgent = '*') => createChecker(parseRobots(text, userAgent));

describe('parseRobots - groups', () => {
  it('applies the wildcard group when no group names us', () => {
    assert.ok(!check('User-agent: *\nDisallow: /admin').isAllowed('/admin'));
  });

  it('lets a group naming us supersede the wildcard group', () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: drifter\nDisallow: /admin';
    const checker = check(text, 'drifter');
    assert.ok(checker.isAllowed('/products'));
    assert.ok(!checker.isAllowed('/admin'));
  });

  it('reads crawl-delay in seconds', () => {
    assert.equal(check('User-agent: *\nCrawl-delay: 1.5').crawlDelayMs, 1500);
  });
});

describe('parseRobots - rule matching', () => {
  it('lets a longer Allow override a shorter Disallow', () => {
    const checker = check('User-agent: *\nDisallow: /admin\nAllow: /admin/public');
    assert.ok(!checker.isAllowed('/admin/secret'));
    assert.ok(checker.isAllowed('/admin/public/page'));
  });

  it('supports the * wildcard and the $ anchor', () => {
    const wildcard = check('User-agent: *\nDisallow: /*.pdf');
    assert.ok(!wildcard.isAllowed('/files/report.pdf'));
    assert.ok(wildcard.isAllowed('/files/report.html'));

    const anchored = check('User-agent: *\nDisallow: /page$');
    assert.ok(!anchored.isAllowed('/page'));
    assert.ok(anchored.isAllowed('/page/child'));
  });

  it('ignores comments and unknown directives', () => {
    const checker = check('# note\nUser-agent: *  # us\nDisallow: /x\nHost: example.com');
    assert.ok(!checker.isAllowed('/x'));
    assert.ok(checker.isAllowed('/y'));
  });
});

describe('parseRobots - sitemaps', () => {
  it('collects Sitemap directives, which are not group-scoped', () => {
    // Declared before any User-agent line and after one: both must be read, or
    // a site whose sitemap is not at /sitemap.xml contributes no seeds at all.
    const checker = check(
      'Sitemap: https://a.test/sitemap_index.xml\n' +
        'User-agent: *\n' +
        'Disallow: /admin\n' +
        'Sitemap: https://a.test/news-sitemap.xml',
    );

    assert.deepEqual(checker.sitemaps, [
      'https://a.test/sitemap_index.xml',
      'https://a.test/news-sitemap.xml',
    ]);
  });

  it('reads sitemaps declared under a group that does not apply to us', () => {
    const checker = check('User-agent: googlebot\nSitemap: https://a.test/s.xml', 'drifter');
    assert.deepEqual(checker.sitemaps, ['https://a.test/s.xml']);
  });

  it('is empty when none are declared', () => {
    assert.deepEqual(check('User-agent: *\nDisallow: /x').sitemaps, []);
  });
});
