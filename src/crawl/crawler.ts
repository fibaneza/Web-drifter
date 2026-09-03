import pLimit from 'p-limit';
import type { Response } from 'playwright';
import type { DeviceProfile } from '../config/devices.js';
import type { DrifterConfig } from '../config/schema.js';
import { CaptureError, toMessage } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type CrawlStats,
  type PageSnapshot,
  type RedirectHop,
  type Side,
  type ViewportCapture,
} from '../core/types.js';
import { resolveCssProperties } from '../extract/css-properties.js';
import { capturePageModel, type CapturedModel } from '../extract/page-model.js';
import { canonicalizeUrl, resolveHref } from '../map/url-normalize.js';
import type { ArtifactStore } from '../store/artifact-store.js';
import type { BrowserPool } from './browser-pool.js';
import { Frontier } from './frontier.js';
import { createOriginGuard } from './origin-guard.js';
import { waitForReady } from './readiness.js';
import { fetchRobots, allowAllRobots, type RobotsChecker } from './robots.js';
import { discoverSitemapUrls } from './sitemap.js';
import { scrollThroughPage, settleImages, stabilizeAfterNavigation } from './stabilize.js';
import { resolveTimeouts } from './timeouts.js';

/**
 * Crawl orchestration for one side.
 *
 * Each page is captured once per enabled viewport, because layout, computed
 * styles and visibility genuinely differ per screen size - and because a legacy
 * CMS (Sitecore especially) may do server-side device detection and return
 * different markup entirely for a mobile user agent. Resizing a single page
 * would miss that.
 *
 * Viewport-independent data (content, links, images, prices, meta) is taken
 * from the primary viewport only. A paragraph either changed or it did not;
 * recording it four times would inflate every count fourfold.
 */

export interface CrawlSideOptions {
  side: Side;
  config: DrifterConfig;
  devices: DeviceProfile[];
  primaryDevice: DeviceProfile;
  pool: BrowserPool;
  store: ArtifactStore;
  logger: Logger;
  /** Capture a full-page screenshot per viewport, used as report evidence. */
  captureScreenshots?: boolean;
}

export async function crawlSide(options: CrawlSideOptions): Promise<CrawlStats> {
  const { side, config, devices, primaryDevice, pool, store, logger } = options;
  const site = side === 'source' ? config.source : config.target;
  const startedAt = Date.now();

  const guard = createOriginGuard(
    site.baseUrl,
    config.crawl.additionalOrigins,
    config.crawl.sameOriginOnly,
  );

  const frontier = new Frontier({
    guard,
    normalize: config.urlMapping,
    traps: config.crawl.traps,
    maxDepth: config.crawl.maxDepth,
    maxPages: config.crawl.maxPages,
    excludePatterns: config.crawl.excludePatterns,
    includePatterns: config.crawl.includePatterns,
    ignorePaths: config.ignore.paths,
    dedupeIdenticalContent: config.crawl.dedupeIdenticalContent,
  });

  const robots: RobotsChecker = config.crawl.respectRobotsTxt
    ? await fetchRobots(site.baseUrl, '*', site.headers)
    : allowAllRobots;

  if (config.crawl.respectRobotsTxt && !robots.absent) {
    logger.debug({ side, crawlDelayMs: robots.crawlDelayMs }, 'robots.txt loaded');
  }

  // Seeds.
  for (const start of config.crawl.startUrls) {
    const url = resolveHref(start, site.baseUrl) ?? safeUrl(start, site.baseUrl);
    if (url) frontier.seed(url);
  }

  if (config.crawl.useSitemap) {
    const sitemapUrls = await discoverSitemapUrls(site.baseUrl, logger, {
      headers: site.headers,
      declared: robots.sitemaps,
    });
    for (const url of sitemapUrls) frontier.seed(url);
    logger.info({ side, count: sitemapUrls.length }, 'seeded from sitemap');
  }

  const cssProperties = resolveCssProperties(config.ignore.cssProperties);
  const stats: CrawlStats = {
    pagesCaptured: 0,
    pagesFailed: 0,
    slowPages: 0,
    retriedPages: 0,
    aliasesFound: 0,
    rejected: {},
    maxDepthReached: 0,
    durationMs: 0,
  };

  const limit = pLimit(config.crawl.concurrency);
  const politenessMs = Math.max(config.crawl.politenessDelayMs, robots.crawlDelayMs);

  // Drain the frontier in waves. Links discovered while capturing a wave are
  // enqueued for the next one, which preserves breadth-first depth ordering
  // even though pages within a wave complete out of order.
  while (frontier.hasCapacity()) {
    const wave: ReturnType<Frontier['next']>[] = [];
    for (let entry = frontier.next(); entry; entry = frontier.next()) {
      wave.push(entry);
      if (wave.length >= config.crawl.concurrency * 4) break;
    }
    if (wave.length === 0) break;

    await Promise.all(
      wave.map((entry) =>
        limit(async () => {
          if (!entry) return;
          if (!robots.isAllowed(entry.canonical.path)) {
            logger.debug({ path: entry.canonical.path }, 'blocked by robots.txt');
            return;
          }
          if (politenessMs > 0) await sleep(politenessMs);

          stats.maxDepthReached = Math.max(stats.maxDepthReached, entry.depth);

          try {
            const attempt = await capturePageWithRetries(config.crawl.retries, logger, {
              url: entry.url,
              depth: entry.depth,
              side,
              config,
              devices,
              primaryDevice,
              pool,
              guard,
              cssProperties,
              logger,
              store,
              captureScreenshots: options.captureScreenshots ?? true,
            });
            const snapshot = attempt.snapshot;
            if (attempt.attempts > 1) stats.retriedPages += 1;

            const duplicate = frontier.markCaptured(entry, {
              finalUrl: new URL(snapshot.finalUrl),
              contentHash: snapshot.contentHash,
            });

            if (duplicate.duplicateOf) {
              stats.aliasesFound += 1;
              logger.debug(
                { path: entry.canonical.key, duplicateOf: duplicate.duplicateOf },
                'duplicate page, recorded as alias',
              );
              return;
            }

            snapshot.aliases = frontier.aliasesOf(entry.canonical.href);
            await store.writeSnapshot(snapshot);
            stats.pagesCaptured += 1;
            if (snapshot.errors.some((e) => e.startsWith('readiness'))) stats.slowPages += 1;

            // Only follow links found on the page we actually captured.
            for (const link of snapshot.links) {
              if (link.kind !== 'internal' || !link.resolved) continue;
              const target = safeUrl(link.resolved, site.baseUrl);
              if (target) frontier.offer(target, entry.depth + 1, snapshot.path);
            }

            logger.info(
              { side, path: snapshot.path, depth: entry.depth, status: snapshot.status },
              'captured',
            );
          } catch (error) {
            stats.pagesFailed += 1;
            logger.warn({ side, url: entry.url.href, error: toMessage(error) }, 'capture failed');
          }
        }),
      ),
    );
  }

  const frontierStats = frontier.stats();
  stats.rejected = frontierStats.rejected;
  stats.durationMs = Date.now() - startedAt;

  logger.info(
    { side, captured: stats.pagesCaptured, failed: stats.pagesFailed, rejected: stats.rejected },
    'crawl complete',
  );
  return stats;
}

interface CapturePageOptions {
  url: URL;
  depth: number;
  side: Side;
  config: DrifterConfig;
  devices: DeviceProfile[];
  primaryDevice: DeviceProfile;
  pool: BrowserPool;
  guard: ReturnType<typeof createOriginGuard>;
  cssProperties: string[];
  logger: Logger;
  store: ArtifactStore;
  captureScreenshots: boolean;
}

/**
 * Capture a page, re-attempting when it fails or never settles.
 *
 * Two different failures are worth another try, and they look nothing alike:
 * a navigation that threw (transient network or browser fault), and a capture
 * that succeeded but whose readiness gate timed out - the page rendered, but
 * possibly not completely.
 *
 * A retry can never make the result worse. Every attempt is kept and the best
 * one wins, so a second attempt that fails outright still leaves the first
 * attempt's partial capture in place rather than losing the page entirely.
 */
async function capturePageWithRetries(
  retries: number,
  logger: Logger,
  options: CapturePageOptions,
): Promise<{ snapshot: PageSnapshot; attempts: number }> {
  let best: PageSnapshot | null = null;
  let lastError: unknown = null;
  // Counted rather than derived from `retries`: the loop can exit early on a
  // clean capture, and a statistic that reports attempts nobody made is worse
  // than no statistic at all.
  let attempts = 0;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      // Linear backoff. A page that timed out is usually under load, and
      // retrying instantly mostly succeeds in reproducing the timeout.
      await sleep(500 * attempt);
      logger.debug({ url: options.url.href, attempt }, 'retrying capture');
    }

    attempts += 1;
    try {
      const snapshot = await capturePage(options);
      // A clean capture is final; nothing is gained by trying again.
      if (!readinessTimedOut(snapshot)) return { snapshot, attempts };
      best = preferredCapture(best, snapshot);
    } catch (error) {
      lastError = error;
    }
  }

  if (best) return { snapshot: best, attempts };

  // Every attempt threw. Surface the last cause, wrapped so the URL travels
  // with it - a bare rejection value here loses which page failed.
  throw new CaptureError(
    `capture failed after ${attempts} attempt(s): ${toMessage(lastError)}`,
    options.url.href,
    { cause: lastError },
  );
}

function readinessTimedOut(snapshot: PageSnapshot): boolean {
  return snapshot.errors.some((error) => error.startsWith('readiness'));
}

/** Fewer problems wins; on a tie, the attempt that saw more content. */
function preferredCapture(a: PageSnapshot | null, b: PageSnapshot): PageSnapshot {
  if (!a) return b;
  if (a.errors.length !== b.errors.length) return b.errors.length < a.errors.length ? b : a;
  return b.content.length > a.content.length ? b : a;
}

/** Capture one page at every enabled viewport and assemble its snapshot. */
async function capturePage(options: CapturePageOptions): Promise<PageSnapshot> {
  const { url, config, devices, primaryDevice, pool, guard, side } = options;
  const startedAt = Date.now();

  const pathKey = canonicalizeUrl(url, config.urlMapping).key;
  const timeouts = resolveTimeouts(
    pathKey,
    {
      navigationTimeoutMs: config.crawl.navigationTimeoutMs,
      readyTimeoutMs: config.stabilization.readyTimeoutMs,
      quietMs: config.stabilization.quietMs,
      awaitFirstRenderMs: config.stabilization.awaitFirstRenderMs,
      ...(config.stabilization.minWaitMs === undefined
        ? {}
        : { minWaitMs: config.stabilization.minWaitMs }),
    },
    config.stabilization.slowPages,
  );

  const errors: string[] = [];
  const viewportCaptures: ViewportCapture[] = [];
  let primaryModel: CapturedModel | null = null;
  let status = 0;
  let finalUrl = url.href;
  let redirectChain: RedirectHop[] = [];
  let navMs = 0;
  let readyMs = 0;

  // Primary first: if it fails there is no model, and the other viewports are
  // pointless work.
  const ordered = [primaryDevice, ...devices.filter((d) => d.id !== primaryDevice.id)];

  for (const device of ordered) {
    const page = await pool.newPage(device);
    try {
      page.setDefaultTimeout(timeouts.navigationTimeoutMs);
      const navStart = Date.now();
      const response = await page.goto(url.href, {
        waitUntil: 'domcontentloaded',
        timeout: timeouts.navigationTimeoutMs,
      });
      const deviceNavMs = Date.now() - navStart;

      await stabilizeAfterNavigation(page);

      const readyStart = Date.now();
      const readiness = await waitForReady(page, {
        quietMs: timeouts.quietMs,
        timeoutMs: timeouts.readyTimeoutMs,
        minWaitMs: timeouts.minWaitMs,
        awaitFirstRenderMs: timeouts.awaitFirstRenderMs,
      });
      const deviceReadyMs = Date.now() - readyStart;

      if (!readiness.ready) {
        errors.push(
          `readiness gate timed out at ${device.id} after ${readiness.waitedMs}ms ` +
            `(blocked by: ${readiness.blockedBy ?? 'unknown'})`,
        );
      }

      if (config.stabilization.scrollThroughPage) {
        await scrollThroughPage(page);
        await settleImages(page);
        // Scrolling triggers lazy loading, and lazily-loaded content is NEW
        // content: it must go through the readiness gate again, or a page that
        // renders its lower half on scroll is extracted half-built and reported
        // as catastrophic content loss. Freezing runs again too, since the
        // newly-inserted nodes carry their own entrance animations.
        await stabilizeAfterNavigation(page);
        const settled = await waitForReady(page, {
          quietMs: timeouts.quietMs,
          timeoutMs: timeouts.readyTimeoutMs,
          minWaitMs: 0,
          // The page has already rendered once; do not re-wait for a first render.
          awaitFirstRenderMs: 0,
        });
        if (!settled.ready) {
          errors.push(
            `readiness gate timed out after lazy-load at ${device.id} ` +
              `(blocked by: ${settled.blockedBy ?? 'unknown'})`,
          );
        }
      }

      // Re-read the URL: a client-side router may have changed it during load.
      const model = await capturePageModel(page, {
        pageUrl: page.url(),
        viewport: device,
        ignoreSelectors: config.ignore.selectors,
        priceSelectors: config.priceSelectors,
        cssProperties: options.cssProperties,
        ignorePatterns: config.ignore.textPatterns,
        normalize: config.urlMapping,
        isAllowedOrigin: (candidate) => guard.isAllowed(candidate),
      });

      viewportCaptures.push(model.viewport);

      if (device.id === primaryDevice.id) {
        primaryModel = model;
        status = response?.status() ?? 0;
        finalUrl = page.url();
        redirectChain = await buildRedirectChain(response);
        navMs = deviceNavMs;
        readyMs = deviceReadyMs;
      }

      if (options.captureScreenshots) {
        // One full-page screenshot per viewport. Element crops for individual
        // findings are cut from it later, so no extra navigation is needed.
        const image = await page.screenshot({ fullPage: true, animations: 'disabled' });
        await options.store.writeScreenshot(side, pathKey, device.id, image);
      }
    } catch (error) {
      errors.push(`${device.id}: ${toMessage(error)}`);
      if (device.id === primaryDevice.id) throw error;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  if (!primaryModel) {
    throw new Error(`no model captured for ${url.href}`);
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    side,
    requestedUrl: url.href,
    finalUrl,
    path: pathKey,
    depth: options.depth,
    status,
    redirectChain,
    aliases: [],
    contentHash: primaryModel.contentHash,
    title: primaryModel.title,
    meta: primaryModel.meta,
    content: primaryModel.content,
    links: primaryModel.links,
    images: primaryModel.images,
    prices: primaryModel.prices,
    viewports: viewportCaptures,
    capturedAt: new Date().toISOString(),
    timings: { navMs, readyMs, totalMs: Date.now() - startedAt },
    errors,
  };
}

/**
 * Walk `redirectedFrom` back to the original request.
 *
 * The chain matters for the coverage report: a target path that only answers
 * after a 301 is not the same as one that answers directly, and a long chain is
 * worth flagging even when the final status is 200.
 */
async function buildRedirectChain(response: Response | null): Promise<RedirectHop[]> {
  if (!response) return [];
  const hops: RedirectHop[] = [];
  let current = response.request().redirectedFrom();
  let guard = 0;

  while (current && guard < 20) {
    guard += 1;
    const hopResponse = await current.response();
    hops.unshift({ url: current.url(), status: hopResponse?.status() ?? 0 });
    current = current.redirectedFrom();
  }
  return hops;
}

function safeUrl(value: string, base: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
