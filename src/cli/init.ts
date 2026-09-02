import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../core/errors.js';

/**
 * Config scaffolding.
 *
 * The template is deliberately opinionated and heavily commented: the settings
 * that matter here are the ones that decide whether the report is trustworthy,
 * and a user who does not know they exist will not go looking for them.
 */

const TEMPLATE = `import { defineConfig } from 'web-drifter';

export default defineConfig({
  source: { name: 'legacy', baseUrl: 'https://legacy.example.com' },
  target: { name: 'modern', baseUrl: 'https://new.example.com' },

  crawl: {
    startUrls: ['/'],
    useSitemap: true,

    // Link hops from a seed. depth 0 = seeds, so the default captures three
    // tiers of pages and follows links two hops.
    maxDepth: 2,
    maxPages: 1000,
    concurrency: 4,

    // The crawler never renders another origin. Subdomains and www-vs-apex
    // must be opted in explicitly - nothing is inferred.
    sameOriginOnly: true,
    additionalOrigins: [],

    // External links are never rendered, only status-checked, so a dead
    // outbound link still shows up in the links report.
    checkExternalLinks: true,

    // A staging site commonly ships "Disallow: /" to stay out of search
    // results, which would stop the crawl dead. You own both sites.
    respectRobotsTxt: true,
  },

  // Compared like-for-like: source at mobile-sm against target at mobile-sm,
  // never against desktop. Run \`drifter --viewports desktop\` for a quick pass.
  viewports: ['desktop', 'tablet', 'mobile-md', 'mobile-sm'],

  urlMapping: {
    trailingSlash: 'strip',

    // Remove specific noisy parameters. Prefer this over \`queryAllowlist\`,
    // which discards every parameter NOT listed and would collapse
    // /search?q=hammer and /search?q=saw into a single page.
    dropParams: [],

    // Legacy path -> modern path, for the routes a migration deliberately moved.
    overrides: {
      // '/products.aspx': '/products',
    },
  },

  ignore: {
    // Removed before the page model is built.
    selectors: [
      // '#chat-widget',
      // '.ad-slot',
    ],

    // Blanked in text before comparison: timestamps, counters, session ids.
    textPatterns: [
      // /\\d{2}\\/\\d{2}\\/\\d{4}/,
    ],

    // Accepted differences, by finding id. \`drifter doctor\` suggests these.
    findingIds: [],
  },

  thresholds: {
    // Exit non-zero when the budget is exceeded. null means never fail.
    failOn: { error: 0, warning: null },
  },
});
`;

const FILENAME = 'drifter.config.ts';

export async function writeInitConfig(cwd: string, force = false): Promise<string> {
  const file = join(cwd, FILENAME);

  if (existsSync(file) && !force) {
    throw new ConfigError(`${FILENAME} already exists. Pass --force to overwrite it.`);
  }

  await writeFile(file, TEMPLATE, 'utf8');
  return file;
}

/** Exported for tests, so the template cannot silently drift from the schema. */
export const INIT_TEMPLATE = TEMPLATE;
