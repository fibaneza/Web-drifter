import type { DrifterConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import type { Side } from '../core/types.js';
import { BrowserPool } from './browser-pool.js';
import { probeInitScript } from './readiness.js';
import { buildInitScripts } from './stabilize.js';

/**
 * Build a browser pool wired with the stabilisation and readiness
 * instrumentation.
 *
 * Script order is load-bearing: the readiness instrumentation must be
 * registered before anything else so it captures the pristine `fetch` and
 * `XMLHttpRequest`, and the clock rewrite must come last. {@link buildInitScripts}
 * owns that ordering; this only appends the readiness probe, which depends on
 * nothing.
 */
export async function createCrawlPool(
  config: DrifterConfig,
  side: Side,
  logger: Logger,
): Promise<BrowserPool> {
  const site = side === 'source' ? config.source : config.target;

  const pool = await BrowserPool.launch({
    headless: config.browser.headless,
    args: config.browser.args,
    ignoreHttpsErrors: config.browser.ignoreHttpsErrors,
    locale: config.stabilization.locale,
    timezoneId: config.stabilization.timezoneId,
    extraHeaders: site.headers,
    logger,
    ...(config.browser.executablePath === undefined
      ? {}
      : { executablePath: config.browser.executablePath }),
  });

  for (const script of [...buildInitScripts(config.stabilization), probeInitScript()]) {
    pool.addInitScript(script);
  }
  pool.setBlockedHosts(config.ignore.blockHosts);

  return pool;
}
