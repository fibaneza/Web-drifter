import { z } from 'zod';
import { DEFAULT_VIEWPORT_IDS, PRIMARY_VIEWPORT_ID } from './devices.js';

/**
 * The user-facing configuration surface, defined once as a Zod schema so that
 * validation, TypeScript types and the documented defaults can never drift
 * apart. Validation errors are reported with the exact failing path.
 */

const httpUrl = z
  .string()
  .url()
  .refine((v) => /^https?:/i.test(v), { message: 'must be an http(s) URL' });

/** Accepts a RegExp literal, or a string that is compiled as a RegExp. */
const regexLike = z
  .union([z.instanceof(RegExp), z.string()])
  .transform((v) => (typeof v === 'string' ? new RegExp(v) : v));

export const siteSchema = z.object({
  /** Label used in reports, e.g. "legacy" / "react". */
  name: z.string().min(1),
  /** Origin + optional base path. All crawling is confined to this origin. */
  baseUrl: httpUrl,
  /** Extra headers sent with every request (e.g. a preview bypass token). */
  headers: z.record(z.string()).default({}),
});

export const deviceProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().default(1),
  isMobile: z.boolean().default(false),
  hasTouch: z.boolean().default(false),
  userAgent: z.string().optional(),
  playwrightDevice: z.string().optional(),
});

export const crawlSchema = z
  .object({
    /** Seeds, relative to baseUrl. These are depth 0. */
    startUrls: z.array(z.string()).default(['/']),
    /** Also seed from /sitemap.xml (and any sitemap index it points at). */
    useSitemap: z.boolean().default(true),
    /**
     * How many link hops to follow from a seed.
     *
     * depth 0 = seeds, depth 1 = linked from seeds, depth 2 = linked from those.
     * Pages at `maxDepth` are captured but their links are NOT followed, so
     * `maxDepth: 2` captures three tiers of pages.
     */
    maxDepth: z.number().int().min(0).default(2),
    /** Hard ceiling on captured pages per side. */
    maxPages: z.number().int().positive().default(1000),
    /** Parallel page captures per side. */
    concurrency: z.number().int().positive().max(32).default(4),
    /** Minimum delay between requests to one origin, in ms. */
    politenessDelayMs: z.number().int().min(0).default(0),
    /** Navigation timeout per page, in ms. Generous by default: a cold CMS
     *  page or a hydrating SPA behind a slow API can legitimately take a while,
     *  and a premature timeout is reported as drift on the whole page. */
    navigationTimeoutMs: z.number().int().positive().default(45_000),
    /** Re-attempt a page whose navigation or readiness gate timed out. */
    retries: z.number().int().min(0).max(5).default(1),
    /**
     * Never render another origin. Leaving this on is what stops the crawler
     * wandering off into the public internet.
     */
    sameOriginOnly: z.boolean().default(true),
    /** Additional origins that count as "ours" (subdomains, CDN app hosts). */
    additionalOrigins: z.array(httpUrl).default([]),
    /**
     * External links are never rendered. When true they are still HEAD-checked
     * so dead outbound links show up in the broken-link report.
     */
    checkExternalLinks: z.boolean().default(true),
    respectRobotsTxt: z.boolean().default(true),
    /**
     * Treat two URLs that render identical content as one page (session ids,
     * print variants, alias paths). Turn off if the site has URLs that
     * legitimately render the same on one side but differ on the other.
     */
    dedupeIdenticalContent: z.boolean().default(true),
    /** Paths matching any of these are never enqueued. */
    excludePatterns: z.array(regexLike).default([]),
    /** When non-empty, only paths matching one of these are enqueued. */
    includePatterns: z.array(regexLike).default([]),
    /**
     * Treat a source page nothing else links to as an orphan.
     *
     * A long-lived CMS accumulates published-but-unreachable pages - old campaign
     * landing pages, print catalogues, URLs only ever sent by email - which the
     * sitemap still lists. Counting them against page coverage measures the size
     * of that backlog rather than the quality of the migration, and lets a 2019
     * landing page fail today's build. They are still crawled, compared and
     * reported; they are simply reported separately.
     *
     * Turn off to hold every published page to the same standard.
     */
    treatUnlinkedAsOrphans: z.boolean().default(true),
    /** Crawler-trap guards. */
    traps: z
      .object({
        maxPathSegments: z.number().int().positive().default(12),
        maxQueryParams: z.number().int().min(0).default(8),
        /** Reject /a/b/a/b/a style cycles once a segment repeats this often. */
        maxRepeatedSegment: z.number().int().positive().default(3),
        maxUrlLength: z.number().int().positive().default(2048),
      })
      .default({}),
  })
  .default({});

export const urlMappingSchema = z
  .object({
    /** How to canonicalise a trailing slash before comparing paths. */
    trailingSlash: z.enum(['strip', 'keep', 'add']).default('strip'),
    /** Lowercase the path before comparing. */
    lowercasePath: z.boolean().default(true),
    /**
     * Query parameters kept in the canonical key.
     *
     * By default this is EMPTY, which means every parameter is kept except
     * known tracking ones - so `/search?q=hammer` and `/search?q=saw` are
     * correctly treated as two different pages.
     *
     * WARNING: setting this switches to strict allowlist mode, where every
     * parameter NOT listed is discarded. `queryAllowlist: ['page']` collapses
     * `/search?q=hammer` and `/search?q=saw` into a single `/search`, and one
     * of them is silently never compared. Prefer `dropParams` to remove
     * specific noisy parameters, and reach for the allowlist only to tame a
     * faceted-search URL explosion.
     */
    queryAllowlist: z.array(z.string()).default([]),
    /** Params always dropped, on top of the built-in tracking-param list. */
    dropParams: z.array(z.string()).default([]),
    /**
     * Whether the URL fragment is part of a page's identity.
     *
     * A client-side router may carry the whole route in the fragment
     * (`/#/products/hats`). `auto` keeps a fragment that starts with `/` or
     * `!` (a route) and drops anything else (`#pricing`, an in-page anchor).
     */
    hashRouting: z.enum(['auto', 'always', 'never']).default('auto'),
    /** Filenames stripped from the end of a path. */
    indexFileNames: z.array(z.string()).default(['index.html', 'index.htm', 'default.aspx']),
    /** Explicit source path -> target path overrides, applied before rules. */
    overrides: z.record(z.string()).default({}),
    /** Regex rewrites applied to a source path to derive the target path. */
    rewrites: z.array(z.object({ from: regexLike, to: z.string() })).default([]),
  })
  .default({});

export const ignoreSchema = z
  .object({
    /** Elements removed before the page model is built (chat widgets, ads). */
    selectors: z.array(z.string()).default([]),
    /** Matches are blanked in text before hashing (timestamps, counters). */
    textPatterns: z.array(regexLike).default([]),
    /** Computed CSS properties never compared. */
    cssProperties: z.array(z.string()).default([]),
    /** Canonical paths never crawled or compared. */
    paths: z.array(regexLike).default([]),
    /** Finding ids accepted as known differences. */
    findingIds: z.array(z.string()).default([]),
    /** Whole categories downgraded to `info`. */
    categories: z.array(z.string()).default([]),
    /** Third-party hosts blocked at the network layer during capture. */
    blockHosts: z
      .array(z.string())
      .default([
        'google-analytics.com',
        'googletagmanager.com',
        'doubleclick.net',
        'facebook.net',
        'hotjar.com',
        'clarity.ms',
      ]),
  })
  .default({});

export const thresholdsSchema = z
  .object({
    /** Trigram Dice coefficient above which two texts count as "the same node". */
    textSimilarity: z.number().min(0).max(1).default(0.6),
    /** Match confidence below which a pair is reported as low-confidence only. */
    minMatchConfidence: z.number().min(0).max(1).default(0.5),
    /** Absolute geometry tolerance in CSS pixels. */
    geometryPx: z.number().min(0).default(2),
    /** Relative geometry tolerance as a fraction of viewport width. */
    geometryPercent: z.number().min(0).max(1).default(0.01),
    /** Length tolerance for computed CSS values, in pixels. */
    cssLengthPx: z.number().min(0).default(1),
    /**
     * Perceptual colour distance (0..1) below which a colour difference is not
     * reported at all. Roughly 0.01 is imperceptible; 0.03 is where a difference
     * becomes visible side by side.
     */
    cssColorTolerance: z.number().min(0).max(1).default(0.01),
    /**
     * CSS drift is graded rather than flat: a difference at or above the
     * matching `*Warn*` threshold is a warning, anything smaller is information.
     * Grading is what makes a restyle survivable - a report where a 1px nudge
     * and a redesign read identically gets ignored wholesale.
     */
    cssColorDeltaWarn: z.number().min(0).max(1).default(0.03),
    /** Absolute length change, in pixels, that makes a drift a warning. */
    cssLengthWarnPx: z.number().min(0).default(4),
    /**
     * Relative length change that makes a drift a warning. Paired with the
     * absolute threshold so 4px reads as serious on a 12px body font and minor
     * on a 48px heading.
     */
    cssLengthWarnPercent: z.number().min(0).default(0.15),
    /**
     * Multiple of the geometry tolerance at which a layout drift becomes a
     * warning. Expressed as a factor rather than a pixel count because the
     * tolerance itself scales with viewport width - a fixed threshold would sit
     * below the reporting gate on desktop and above it on mobile, making the
     * information band unreachable at one end or the other.
     */
    cssGeometryWarnFactor: z.number().min(1).default(2),
    /** Absolute tolerance when comparing parsed price amounts. */
    priceEpsilon: z.number().min(0).default(0.001),
    /** Image dimension tolerance as a fraction. */
    imageSizePercent: z.number().min(0).max(1).default(0.02),
    /** Run exits non-zero when counts exceed these budgets. */
    failOn: z
      .object({
        error: z.number().int().min(0).default(0),
        warning: z.number().int().min(0).nullable().default(null),
      })
      .default({}),
  })
  .default({});

export const stabilizationSchema = z
  .object({
    /** Quiet period with no DOM mutations and no in-flight requests, in ms. */
    quietMs: z.number().int().positive().default(500),
    /** Hard ceiling on waiting for the page to settle, in ms. */
    readyTimeoutMs: z.number().int().positive().default(30_000),
    /**
     * Minimum wait after the load event before a page may be declared ready.
     * Quiescence cannot distinguish "finished rendering" from "not started
     * yet", so this floor gives a late-hydrating framework time to begin.
     * Defaults to `quietMs` when omitted.
     */
    minWaitMs: z.number().int().min(0).optional(),
    /**
     * How long to wait after load for a page that has not mutated the DOM at
     * all to render something.
     *
     * A client-side router fetches, then renders; until it does, the page is
     * perfectly quiet and looks "settled" while still showing a placeholder.
     * Capturing then records the placeholder - and can make two different
     * routes hash identically, so one is discarded as a duplicate.
     *
     * Only pages that never mutate pay this cost, so a fully server-rendered
     * site can set it to 0.
     */
    awaitFirstRenderMs: z.number().int().min(0).default(1000),
    /**
     * Per-path timeout overrides for pages known to be slow - report builders,
     * search result pages, anything fronting a slow upstream. The first
     * matching entry wins.
     */
    slowPages: z
      .array(
        z.object({
          pattern: regexLike,
          navigationTimeoutMs: z.number().int().positive().optional(),
          readyTimeoutMs: z.number().int().positive().optional(),
          quietMs: z.number().int().positive().optional(),
        }),
      )
      .default([]),
    /** Disable CSS animations and transitions before capture. */
    freezeAnimations: z.boolean().default(true),
    /** Pin Date/performance so rendered timestamps are stable. */
    freezeClock: z.boolean().default(true),
    /** Fixed wall-clock used when freezeClock is on. */
    fixedTime: z.string().datetime().default('2024-01-01T12:00:00.000Z'),
    /** Replace Math.random with a seeded PRNG to stabilise A/B bucketing. */
    seedRandom: z.boolean().default(true),
    randomSeed: z.number().int().default(1),
    /** Scroll to the bottom and back to trigger lazy-loaded content. */
    scrollThroughPage: z.boolean().default(true),
    locale: z.string().default('en-US'),
    timezoneId: z.string().default('UTC'),
  })
  .default({});

export const browserSchema = z
  .object({
    headless: z.boolean().default(true),
    /**
     * Explicit Chromium binary. Useful on CI images that ship a browser build
     * whose revision does not match the installed Playwright version.
     * Falls back to `DRIFTER_CHROMIUM_EXECUTABLE`, then autodetection, then
     * Playwright's own resolution.
     */
    executablePath: z.string().optional(),
    args: z.array(z.string()).default([]),
    /** Ignore TLS errors - needed for self-signed certs on internal envs. */
    ignoreHttpsErrors: z.boolean().default(false),
  })
  .default({});

export const outputSchema = z
  .object({
    dir: z.string().default('drifter-out'),
    formats: z
      .array(z.enum(['json', 'html', 'markdown', 'junit']))
      .default(['json', 'html', 'markdown', 'junit']),
    /** Keep raw page snapshots so `drifter compare` can re-diff without re-crawling. */
    keepSnapshots: z.boolean().default(true),
    /**
     * Keep the full-page captures after the report is written.
     *
     * These are the largest thing a run produces - on a two-viewport fixture run
     * the snapshots come to 72 KB and the screenshots to 1.5 MB - and once the
     * evidence crops are cut, the report does not read them again. They are only
     * needed to re-render evidence later, so a pipeline that publishes a report
     * and moves on is paying the bulk of its artifact size for nothing.
     *
     * Pruning happens after reporting, so the crops the report displays survive.
     */
    keepScreenshots: z.boolean().default(true),
    /**
     * Lowest severity that earns a screenshot crop.
     *
     * Cropping is the slowest part of writing a report and most findings are
     * never opened, so the default keeps evidence on the ones people act on.
     * Raise it to `warning` to also get crops for extra components and for CSS
     * drift, which is graded no higher than a warning by design.
     */
    evidenceMinSeverity: z.enum(['error', 'warning', 'info']).default('error'),
  })
  .default({});

export const configSchema = z
  .object({
    source: siteSchema,
    target: siteSchema,
    crawl: crawlSchema,
    /** Viewport ids to compare at. Always compared like-for-like. */
    viewports: z
      .array(z.string())
      .min(1)
      .default([...DEFAULT_VIEWPORT_IDS]),
    /** The viewport at which viewport-independent content is extracted once. */
    primaryViewport: z.string().default(PRIMARY_VIEWPORT_ID),
    /** Custom device profiles; may override a built-in by reusing its id. */
    devices: z.array(deviceProfileSchema).default([]),
    urlMapping: urlMappingSchema,
    ignore: ignoreSchema,
    thresholds: thresholdsSchema,
    stabilization: stabilizationSchema,
    browser: browserSchema,
    output: outputSchema,
    /**
     * Per-category severity overrides, e.g. `{ 'css.property-drift': 'info' }`.
     *
     * Teams tune this as a migration matures: a redesign that intentionally
     * changed spacing everywhere can demote `css.layout-drift` without losing
     * the findings, while a site where price accuracy is critical can promote
     * `price.format-drift` to an error.
     */
    severities: z.record(z.enum(['error', 'warning', 'info'])).default({}),
    /** Selectors that identify a displayed price, checked after JSON-LD/microdata. */
    priceSelectors: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.viewports.includes(cfg.primaryViewport)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['primaryViewport'],
        message:
          `primaryViewport "${cfg.primaryViewport}" must be one of the enabled ` +
          `viewports: ${cfg.viewports.join(', ')}`,
      });
    }
    if (cfg.source.baseUrl === cfg.target.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target', 'baseUrl'],
        message: 'source and target baseUrl are identical - nothing to compare',
      });
    }
  });

/** Fully-resolved configuration, with every default applied. */
export type DrifterConfig = z.output<typeof configSchema>;
/** What a user actually writes in a config file. */
export type DrifterConfigInput = z.input<typeof configSchema>;

/**
 * Identity helper giving editor autocomplete and inline type errors in a
 * `drifter.config.ts`. Validation still happens at load time.
 */
export function defineConfig(config: DrifterConfigInput): DrifterConfigInput {
  return config;
}
