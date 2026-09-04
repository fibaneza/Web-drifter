import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext } from 'playwright';
import { capturePageModel } from '../../src/extract/page-model.js';
import { getBuiltInDevice, type DeviceProfile } from '../../src/config/devices.js';
import { DEFAULT_NORMALIZE_OPTIONS } from '../../src/map/url-normalize.js';
import type { Region } from '../../src/core/types.js';
import {
  launchTestBrowser,
  newStabilizedContext,
  setStabilizedContent,
} from '../helpers/browser.js';

/**
 * Region assignment, in a real browser.
 *
 * The unit tests pin the inference rules; this pins the thing that actually
 * matters - that a legacy page built from `div`s and a rewrite built from
 * landmarks put the same content in the same region. If they do not, alignment
 * (which never crosses a region) matches nothing and a perfect migration is
 * reported as total content loss on both sides at once.
 */

/** Resolved through a function so the profile is non-optional at every use. */
function desktopProfile(): DeviceProfile {
  const device = getBuiltInDevice('desktop');
  if (!device) throw new Error('no desktop device profile');
  return device;
}

const desktop = desktopProfile();

/** The same page, as a legacy CMS emits it: divs, no roles, no landmarks. */
const LEGACY = `
<div class="sc-header"><h1>Acme Tools</h1></div>
<div class="sc-nav"><a href="/products">Products</a></div>
<div class="sc-body"><h2>Our history</h2><p>Founded in Sheffield in 1952.</p></div>
<div class="sc-footer"><p>Copyright Acme Tools</p></div>`;

/** The same page as a rewrite emits it. */
const MODERN = `
<header><h1>Acme Tools</h1></header>
<nav><a href="/products">Products</a></nav>
<main><h2>Our history</h2><p>Founded in Sheffield in 1952.</p></main>
<footer><p>Copyright Acme Tools</p></footer>`;

describe('landmark region assignment', () => {
  let browser: Browser;
  let context: BrowserContext;

  before(async () => {
    browser = await launchTestBrowser();
    context = await newStabilizedContext(browser);
  });

  after(async () => {
    await context?.close();
    await browser?.close();
  });

  async function regionsOf(html: string): Promise<Map<string, Region>> {
    const page = await context.newPage();
    try {
      await setStabilizedContent(page, html);
      const model = await capturePageModel(page, {
        pageUrl: 'https://a.test/',
        viewport: desktop,
        ignoreSelectors: [],
        priceSelectors: [],
        cssProperties: [],
        ignorePatterns: [],
        normalize: DEFAULT_NORMALIZE_OPTIONS,
        isAllowedOrigin: () => true,
      });

      const byText = new Map<string, Region>();
      for (const node of model.content) {
        if (node.text !== '') byText.set(node.text, node.region);
      }
      return byText;
    } finally {
      await page.close();
    }
  }

  it('assigns landmark markup by its landmarks', async () => {
    const regions = await regionsOf(MODERN);
    assert.equal(regions.get('Acme Tools'), 'header');
    assert.equal(regions.get('Products'), 'nav');
    assert.equal(regions.get('Our history'), 'main');
    assert.equal(regions.get('Copyright Acme Tools'), 'footer');
  });

  it('infers regions for a page that declares no landmarks', async () => {
    const regions = await regionsOf(LEGACY);
    assert.equal(regions.get('Acme Tools'), 'header');
    assert.equal(regions.get('Products'), 'nav');
    assert.equal(regions.get('Our history'), 'main');
    assert.equal(regions.get('Copyright Acme Tools'), 'footer');
  });

  it('puts the same content in the same region on both sides', async () => {
    // The whole point. Before inference the legacy side answered `other` for
    // every node while the rewrite answered a real region, so nothing aligned.
    const [legacy, modern] = await Promise.all([regionsOf(LEGACY), regionsOf(MODERN)]);

    for (const [text, region] of modern) {
      assert.equal(legacy.get(text), region, `"${text}" landed in a different region`);
    }
  });

  it('never overrides a landmark with a misleading class name', async () => {
    // A page that marked itself up properly is trusted completely: inference
    // could only make it worse, so it does not run at all.
    const regions = await regionsOf(`
      <header><h1>Site title</h1></header>
      <main><div class="sc-footer"><p>Body text in a badly named div</p></div></main>`);

    assert.equal(regions.get('Body text in a badly named div'), 'main');
  });

  it('leaves genuinely unmarked content in other', async () => {
    const regions = await regionsOf('<div class="wrapper"><p>Loose text</p></div>');
    assert.equal(regions.get('Loose text'), 'other');
  });
});
