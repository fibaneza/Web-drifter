import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext } from 'playwright';
import { waitForReady } from '../../src/crawl/readiness.js';
import {
  launchTestBrowser,
  newStabilizedContext,
  setStabilizedContent,
  TEST_STABILIZATION,
} from '../helpers/browser.js';

describe('readiness gate', () => {
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

  it('waits for content rendered after the load event', async () => {
    // Regression test. Quiescence alone cannot tell "finished rendering" from
    // "has not started yet", so a naive gate reports ready before a framework
    // that hydrates late has touched the DOM - capturing the pre-hydration page
    // and reporting the entire body as drift.
    const page = await context.newPage();
    try {
      await page.setContent(`<div id="app">loading</div><script>
        setTimeout(() => { document.getElementById('app').textContent = 'hydrated'; }, 400);
      </script>`);

      const result = await waitForReady(page, {
        quietMs: TEST_STABILIZATION.quietMs,
        timeoutMs: TEST_STABILIZATION.readyTimeoutMs,
      });

      assert.equal(result.ready, true, `gate should settle: ${result.blockedBy}`);
      assert.equal(
        await page.textContent('#app'),
        'hydrated',
        'gate returned before late-rendered content appeared',
      );
    } finally {
      await page.close();
    }
  });

  it('waits for content appended by a chain of deferred renders', async () => {
    const page = await context.newPage();
    try {
      await page.setContent(`<ul id="list"></ul><script>
        let n = 0;
        const tick = () => {
          const li = document.createElement('li');
          li.textContent = 'item-' + (++n);
          document.getElementById('list').appendChild(li);
          if (n < 5) setTimeout(tick, 120);
        };
        setTimeout(tick, 100);
      </script>`);

      const result = await waitForReady(page, {
        quietMs: TEST_STABILIZATION.quietMs,
        timeoutMs: TEST_STABILIZATION.readyTimeoutMs,
      });

      assert.equal(result.ready, true, `gate should settle: ${result.blockedBy}`);
      assert.equal(await page.locator('#list li').count(), 5, 'gate returned mid-render');
    } finally {
      await page.close();
    }
  });

  it('reports what blocked it instead of throwing when a page never settles', async () => {
    const page = await context.newPage();
    try {
      // Mutates forever: this page can never be quiet, by construction.
      await page.setContent(`<div id="x"></div><script>
        setInterval(() => {
          document.getElementById('x').setAttribute('data-n', String(Math.random()));
        }, 30);
      </script>`);

      const result = await waitForReady(page, { quietMs: 500, timeoutMs: 1500 });

      assert.equal(result.ready, false);
      assert.ok(result.blockedBy, 'must explain what blocked it');
      assert.match(result.blockedBy, /dom-mutated/);
    } finally {
      await page.close();
    }
  });

  it('settles a static page quickly', async () => {
    const page = await context.newPage();
    try {
      await page.setContent('<h1>static</h1>');
      const result = await waitForReady(page, { quietMs: 300, timeoutMs: 5000 });
      assert.equal(result.ready, true);
      assert.ok(result.waitedMs < 3000, `took ${result.waitedMs}ms`);
    } finally {
      await page.close();
    }
  });
});

describe('stabilization', () => {
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

  it('pins the clock epoch but lets time advance', async () => {
    // A hard freeze would hang any code polling for time to pass, which would
    // stop the page ever going quiet.
    const page = await context.newPage();
    try {
      await page.setContent('<p>x</p>');
      const epoch = Date.parse(TEST_STABILIZATION.fixedTime);
      const now = await page.evaluate(() => Date.now());
      assert.ok(now >= epoch && now < epoch + 60_000, `clock not pinned near epoch: ${now}`);

      const advanced = await page.evaluate(async () => {
        const a = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        return Date.now() - a;
      });
      assert.ok(advanced >= 40, `clock did not advance: ${advanced}ms`);
    } finally {
      await page.close();
    }
  });

  it('makes Math.random reproducible across pages', async () => {
    const first = await context.newPage();
    const second = await context.newPage();
    try {
      await first.setContent('<p>a</p>');
      await second.setContent('<p>b</p>');
      const a = await first.evaluate(() => [Math.random(), Math.random()]);
      const b = await second.evaluate(() => [Math.random(), Math.random()]);
      assert.deepEqual(a, b, 'seeded PRNG must produce the same sequence');
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('disables transitions so a mid-animation capture is impossible', async () => {
    const page = await context.newPage();
    try {
      await setStabilizedContent(
        page,
        `<style>
        #box { width: 10px; transition: width 5s linear; }
      </style><div id="box"></div><script>
        requestAnimationFrame(() => { document.getElementById('box').style.width = '500px'; });
      </script>`,
      );
      await page.waitForTimeout(100);
      const width = await page.evaluate(() => {
        const box = document.getElementById('box');
        return box ? getComputedStyle(box).width : 'missing';
      });
      assert.equal(width, '500px', 'transition should complete instantly, not animate');
    } finally {
      await page.close();
    }
  });
});
