import { XMLParser } from 'fast-xml-parser';
import { request } from 'undici';
import type { Logger } from '../core/logger.js';

/**
 * Sitemap seeding.
 *
 * Link-following alone reaches only what is linked from the seeds within the
 * depth limit. A sitemap lists pages the site itself considers important,
 * including ones buried deeper than `maxDepth` would ever reach - so seeding
 * from it materially improves coverage without relaxing the depth bound.
 *
 * Every sitemap URL is seeded at depth 0. That is deliberate: these are
 * entry points the site advertises, not pages we discovered by wandering.
 */

const SITEMAP_TIMEOUT_MS = 10_000;
const MAX_SITEMAPS = 20;
const MAX_URLS = 10_000;

interface SitemapEntry {
  loc?: string;
}

interface SitemapDocument {
  urlset?: { url?: SitemapEntry | SitemapEntry[] };
  sitemapindex?: { sitemap?: SitemapEntry | SitemapEntry[] };
}

/**
 * Fetch `/sitemap.xml`, following one level of sitemap index.
 *
 * Never throws: a missing or malformed sitemap is normal and simply yields no
 * extra seeds.
 */
export async function discoverSitemapUrls(baseUrl: string, logger: Logger): Promise<URL[]> {
  const found = new Map<string, URL>();
  const queue: string[] = [new URL('/sitemap.xml', baseUrl).href];
  const visited = new Set<string>();

  while (queue.length > 0 && visited.size < MAX_SITEMAPS && found.size < MAX_URLS) {
    const target = queue.shift();
    if (!target || visited.has(target)) continue;
    visited.add(target);

    const document = await fetchSitemap(target, logger);
    if (!document) continue;

    // A sitemap index points at more sitemaps rather than pages.
    for (const entry of toArray(document.sitemapindex?.sitemap)) {
      if (entry.loc && queue.length + visited.size < MAX_SITEMAPS) queue.push(entry.loc.trim());
    }

    for (const entry of toArray(document.urlset?.url)) {
      if (!entry.loc) continue;
      try {
        const url = new URL(entry.loc.trim());
        found.set(url.href, url);
      } catch {
        // Skip malformed <loc> entries rather than failing the whole sitemap.
      }
      if (found.size >= MAX_URLS) break;
    }
  }

  return [...found.values()];
}

async function fetchSitemap(url: string, logger: Logger): Promise<SitemapDocument | null> {
  try {
    const response = await request(url, {
      method: 'GET',
      headersTimeout: SITEMAP_TIMEOUT_MS,
      bodyTimeout: SITEMAP_TIMEOUT_MS,
      maxRedirections: 3,
    });

    if (response.statusCode !== 200) {
      await response.body.dump();
      return null;
    }

    const parser = new XMLParser({
      ignoreAttributes: true,
      trimValues: true,
      // Never coerce <loc> to a number or boolean; URLs must stay strings.
      parseTagValue: false,
    });
    return parser.parse(await response.body.text()) as SitemapDocument;
  } catch (error) {
    logger.debug({ url, error: String(error) }, 'sitemap unavailable');
    return null;
  }
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
