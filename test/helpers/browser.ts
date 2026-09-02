import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { resolveChromiumExecutable } from '../../src/crawl/browser-pool.js';
import {
  stabilizeAfterNavigation,
  buildInitScripts,
  type StabilizationOptions,
} from '../../src/crawl/stabilize.js';
import { probeInitScript } from '../../src/crawl/readiness.js';

export const TEST_STABILIZATION: StabilizationOptions = {
  quietMs: 500,
  readyTimeoutMs: 8000,
  freezeAnimations: true,
  freezeClock: true,
  fixedTime: '2024-01-01T12:00:00.000Z',
  seedRandom: true,
  randomSeed: 1,
  scrollThroughPage: true,
};

export async function launchTestBrowser(): Promise<Browser> {
  const executablePath = resolveChromiumExecutable(undefined);
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
}

/** A context wired with the same init scripts the real crawler uses. */
export async function newStabilizedContext(
  browser: Browser,
  options: StabilizationOptions = TEST_STABILIZATION,
): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  for (const script of [...buildInitScripts(options), probeInitScript()]) {
    await context.addInitScript({ content: script });
  }
  return context;
}

/**
 * Set page content the way the crawler navigates: content first, then the
 * post-navigation stabilisation that an init script cannot provide.
 */
export async function setStabilizedContent(page: Page, html: string): Promise<void> {
  await page.setContent(html);
  await stabilizeAfterNavigation(page);
}
