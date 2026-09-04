import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REGION_HINTS,
  identityTokens,
  regionFromIdentity,
} from '../../src/extract/regions.js';

/**
 * Landmark inference.
 *
 * These rules only ever run against a document that declares no landmark at
 * all, which in practice means the legacy half of a migration. Getting them
 * wrong is expensive in one specific direction: if legacy nodes land in `other`
 * while the rewrite's land in `header`/`main`/`footer`, alignment - which never
 * crosses a region - matches nothing, and a perfect migration reports as total
 * content loss on both sides at once.
 */

const region = (className: string, id = ''): string | null => regionFromIdentity(className, id);

describe('identityTokens', () => {
  it('splits every common naming convention into words', () => {
    assert.equal(identityTokens('sc-header', ''), 'sc header');
    assert.equal(identityTokens('sc_header', ''), 'sc header');
    assert.equal(identityTokens('', 'siteHeader'), 'siteheader');
    assert.equal(identityTokens('a  b', 'c'), 'a b c');
  });

  it('is empty for an element with no identity at all', () => {
    assert.equal(identityTokens('', ''), '');
  });
});

describe('regionFromIdentity - the shapes a legacy CMS emits', () => {
  it('recognises Sitecore-style prefixed classes', () => {
    assert.equal(region('sc-header'), 'header');
    assert.equal(region('sc-nav'), 'nav');
    assert.equal(region('sc-footer'), 'footer');
    assert.equal(region('sc-body'), 'main');
  });

  it('recognises the conventional names', () => {
    assert.equal(region('masthead'), 'header');
    assert.equal(region('navbar'), 'nav');
    assert.equal(region('breadcrumbs'), 'nav');
    assert.equal(region('sidebar'), 'aside');
    assert.equal(region('colophon'), 'footer');
  });

  it('reads an id as readily as a class', () => {
    assert.equal(region('', 'footer'), 'footer');
    assert.equal(region('', 'main-content'), 'main');
  });

  it('handles concatenated names, not only hyphenated ones', () => {
    assert.equal(region('siteFooter'), 'footer');
    assert.equal(region('pageHeader'), 'header');
    assert.equal(region('mainNavigation'), 'nav');
  });
});

describe('regionFromIdentity - precision', () => {
  it('does not match a short word inside an unrelated one', () => {
    // The reason short words are matched as whole tokens: "domain" is not main.
    assert.equal(region('domain-picker'), null);
    assert.equal(region('maintenance-notice'), null);
    assert.equal(region('menuisier'), null);
  });

  it('resolves an ambiguous name to the more specific region', () => {
    // Checked most-specific first, so a footer's content wrapper is a footer.
    assert.equal(region('footer-content'), 'footer');
    assert.equal(region('header-nav'), 'nav');
  });

  it('returns null for an element with nothing to go on', () => {
    assert.equal(region(''), null);
    assert.equal(region('wrapper'), null);
    assert.equal(region('col-md-6'), null);
  });
});

describe('DEFAULT_REGION_HINTS', () => {
  it('compiles, so the in-page extractor cannot be handed a bad pattern', () => {
    for (const hint of DEFAULT_REGION_HINTS) {
      assert.doesNotThrow(() => new RegExp(hint.pattern), `${hint.region} pattern is invalid`);
    }
  });

  it('is ordered with main last, since its words are the least distinctive', () => {
    assert.equal(DEFAULT_REGION_HINTS[DEFAULT_REGION_HINTS.length - 1]?.region, 'main');
  });
});
