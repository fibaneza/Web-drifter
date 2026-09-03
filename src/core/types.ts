/**
 * Core domain types shared by every stage of the pipeline.
 *
 * The single most important type here is {@link ContentNode}. Legacy CMS markup
 * and a React rewrite share no class names, no wrapper structure and no tag
 * choices, so any diff keyed on CSS selectors or raw HTML is meaningless. Both
 * sides are instead reduced to an ordered stream of `ContentNode`s - the
 * *canonical page model* - and every comparison happens on that.
 */

/** Which of the two sites a piece of data came from. */
export type Side = 'source' | 'target';

/** Increment when the on-disk snapshot shape changes incompatibly. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Canonical page model                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Landmark region a node lives in. Matching is partitioned by region so a
 * footer paragraph can never be paired with a body paragraph.
 */
export type Region = 'header' | 'nav' | 'main' | 'footer' | 'aside' | 'other';

export const REGIONS: readonly Region[] = [
  'header',
  'nav',
  'main',
  'footer',
  'aside',
  'other',
] as const;

/** Semantic kind of a content node. Nodes only ever match within the same kind. */
export type NodeKind =
  'heading' | 'paragraph' | 'listItem' | 'link' | 'image' | 'control' | 'tableCell' | 'price';

/**
 * The comparable family a node kind belongs to.
 *
 * `paragraph`, `listItem` and `tableCell` all mean "a block of text" and are
 * treated as one family, because moving from table layout to semantic markup is
 * the single most common change in a legacy-to-modern migration. Without this,
 * `<td>Product name</td>` and `<span>Product name</span>` would never match and
 * the entire body of every table-built page would report as missing plus added.
 *
 * Headings stay distinct (their level is meaningful), as do links, images and
 * controls, where the kind carries information the text does not.
 */
export function kindFamily(kind: NodeKind): string {
  switch (kind) {
    case 'paragraph':
    case 'listItem':
    case 'tableCell':
      return 'text';
    default:
      return kind;
  }
}

/** Kind-specific payload. Every field is optional; presence depends on `kind`. */
export interface ContentNodeAttrs {
  /** heading: 1-6 */
  level?: number | undefined;
  /** link: raw href exactly as authored */
  href?: string | undefined;
  /** link: canonical path, when the link is same-origin */
  path?: string | undefined;
  /** link: true when the href points off-origin */
  external?: boolean | undefined;
  /** image: environment-independent identity (CDN host and hashes stripped) */
  assetKey?: string | undefined;
  /** image: resolved src */
  src?: string | undefined;
  /** image: alt text */
  alt?: string | undefined;
  /** image: intrinsic dimensions as decoded by the browser */
  naturalWidth?: number | undefined;
  naturalHeight?: number | undefined;
  /** price: parsed numeric value */
  amount?: number | undefined;
  /** price: ISO-4217 code when determinable */
  currency?: string | undefined;
  /** price: the text exactly as displayed */
  raw?: string | undefined;
  /** control: ARIA role or input type */
  role?: string | undefined;
  /** listItem: nesting depth */
  depth?: number | undefined;
  /** tableCell: position */
  row?: number | undefined;
  col?: number | undefined;
}

/**
 * One semantic unit of a page.
 *
 * `key` is a content hash and is the primary matching handle; `ordinal`
 * disambiguates repeated identical nodes (e.g. three "Read more" links).
 * `selectorHint` exists purely so a human reading the report can find the
 * element - it is never used for matching.
 */
export interface ContentNode {
  key: string;
  ordinal: number;
  region: Region;
  kind: NodeKind;
  text: string;
  attrs: ContentNodeAttrs;
  selectorHint: string;
}

/* -------------------------------------------------------------------------- */
/* Per-viewport capture                                                       */
/* -------------------------------------------------------------------------- */

export interface BoxGeometry {
  /** Document-relative, not viewport-relative: immune to scroll position. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Computed style + geometry + visibility for one node at one viewport. */
export interface NodeStyle {
  nodeKey: string;
  ordinal: number;
  /** Allowlisted computed properties, already normalised for comparison. */
  props: Record<string, string>;
  box: BoxGeometry;
  /** False when the element is display:none, visibility:hidden or zero-area. */
  visible: boolean;
}

export interface ViewportCapture {
  /** Device profile id, e.g. `desktop`, `mobile-sm`. */
  viewport: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  styles: NodeStyle[];
  documentHeight: number;
  /** A common responsive regression: content wider than the viewport. */
  hasHorizontalOverflow: boolean;
}

/* -------------------------------------------------------------------------- */
/* Links, images, prices                                                      */
/* -------------------------------------------------------------------------- */

export type LinkKind = 'internal' | 'external' | 'mailto' | 'tel' | 'anchor' | 'unsupported';

export interface LinkRecord {
  /** Raw href exactly as authored. */
  href: string;
  /** Absolute URL resolved against the page, or null when unresolvable. */
  resolved: string | null;
  /** Canonical path, only for same-origin links. */
  path: string | null;
  text: string;
  kind: LinkKind;
  region: Region;
  /** Only visible links are required to have a counterpart on the target. */
  visible: boolean;
  rel?: string | undefined;
  target?: string | undefined;
}

export interface ImageRecord {
  assetKey: string;
  src: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
  region: Region;
  visible: boolean;
  /** True for CSS background images rather than <img>/<picture>. */
  isBackground: boolean;
}

export type PriceSource = 'jsonld' | 'microdata' | 'selector' | 'text';

export interface PriceRecord {
  amount: number;
  currency: string | null;
  /** Exactly as displayed, e.g. "$1,299.00". */
  raw: string;
  source: PriceSource;
  region: Region;
  /** Nearby text used to pair prices across the two sites. */
  context: string;
  /**
   * Where the price is rendered, for screenshot evidence. Absent when the price
   * came from JSON-LD, which has nothing on screen to crop, and on snapshots
   * captured before prices carried geometry.
   */
  box?: BoxGeometry | undefined;
}

/* -------------------------------------------------------------------------- */
/* Snapshots                                                                  */
/* -------------------------------------------------------------------------- */

export interface RedirectHop {
  url: string;
  status: number;
}

export interface PageMeta {
  description: string | null;
  canonical: string | null;
  robots: string | null;
  lang: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
}

/** Everything captured for one page on one side. Written to disk as JSON. */
export interface PageSnapshot {
  schemaVersion: number;
  side: Side;
  /** URL we asked for. */
  requestedUrl: string;
  /** URL we ended on after redirects. */
  finalUrl: string;
  /** Canonical path key - the join key between source and target. */
  path: string;
  /** Hops from the nearest seed. 0 = seed. */
  depth: number;
  status: number;
  redirectChain: RedirectHop[];
  /** Other canonical keys that resolved to this same page. */
  aliases: string[];
  /** Hash of the canonical model; used for cross-URL duplicate detection. */
  contentHash: string;
  title: string;
  meta: PageMeta;
  content: ContentNode[];
  links: LinkRecord[];
  images: ImageRecord[];
  prices: PriceRecord[];
  viewports: ViewportCapture[];
  capturedAt: string;
  timings: { navMs: number; readyMs: number; totalMs: number };
  /** Non-fatal problems encountered while capturing. */
  errors: string[];
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export type Severity = 'error' | 'warning' | 'info';

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export type FindingCategory =
  // page coverage (Phase 3.1)
  | 'page.missing-on-target'
  | 'page.extra-on-target'
  | 'page.status-mismatch'
  | 'page.redirected'
  | 'page.alias'
  // content (Phase 3.2)
  | 'content.drift'
  | 'content.missing'
  | 'content.added'
  | 'content.order-changed'
  | 'meta.drift'
  // images & prices (Phase 3.3)
  | 'image.missing'
  | 'image.added'
  | 'image.alt-drift'
  | 'image.size-drift'
  | 'price.value-drift'
  | 'price.currency-drift'
  | 'price.format-drift'
  | 'price.missing'
  | 'price.added'
  // css & layout (Phase 3.4)
  | 'css.property-drift'
  | 'css.layout-drift'
  | 'css.visibility-drift'
  | 'css.responsive-visibility-drift'
  | 'css.horizontal-overflow'
  // links (Phase 3.5)
  | 'link.broken'
  | 'link.redirect-chain'
  | 'link.path-mismatch'
  | 'link.mixed-content';

/** Findings whose natural home is the separate CSS report. */
export const CSS_CATEGORIES: readonly FindingCategory[] = [
  'css.property-drift',
  'css.layout-drift',
  'css.visibility-drift',
  'css.responsive-visibility-drift',
  'css.horizontal-overflow',
] as const;

/** Findings whose natural home is the separate links report. */
export const LINK_CATEGORIES: readonly FindingCategory[] = [
  'link.broken',
  'link.redirect-chain',
  'link.path-mismatch',
  'link.mixed-content',
] as const;

/** Findings whose natural home is the coverage report. */
export const COVERAGE_CATEGORIES: readonly FindingCategory[] = [
  'page.missing-on-target',
  'page.extra-on-target',
  'page.status-mismatch',
  'page.redirected',
  'page.alias',
] as const;

/**
 * A single reported difference.
 *
 * `id` is a deterministic hash of the identifying fields, so a finding keeps
 * the same id across runs. That is what lets teams suppress an accepted
 * difference permanently without suppressing a whole category.
 */
export interface Finding {
  id: string;
  category: FindingCategory;
  severity: Severity;
  /** Canonical path the finding belongs to. */
  path: string;
  sourceUrl?: string | undefined;
  targetUrl?: string | undefined;
  /** Set only for viewport-specific findings (CSS, layout, visibility). */
  viewport?: string | undefined;
  region?: Region | undefined;
  nodeKind?: NodeKind | undefined;
  /**
   * Stable handle for the element or item this finding is about - a node key,
   * an asset key, a link URL. Persisted (not just hashed into `id`) so reports
   * can group every finding about one element together: "these six CSS
   * properties all drifted on this one heading" is far more useful than six
   * unrelated rows.
   */
  subject?: string | undefined;
  /**
   * Distinguishes several findings sharing a subject - the CSS property name,
   * `size` vs `position` for layout, the meta field. Together with `subject`
   * this is what makes a finding addressable in a report.
   */
  facet?: string | undefined;
  /** One-line human summary. */
  label: string;
  expected?: unknown;
  actual?: unknown;
  /** Match confidence 0..1 for the node pair this finding came from. */
  confidence: number;
  details?: Record<string, unknown> | undefined;
}

/* -------------------------------------------------------------------------- */
/* Run statistics                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Headline numbers for a run.
 *
 * Every percentage here is a *parity* measure - how much of the source was
 * faithfully reproduced on the target - so 100% means "no drift detected" and
 * the number moves in the intuitive direction as a migration is fixed. Each
 * one names its own denominator, because "coverage" means nothing without it.
 */

export interface PercentStat {
  /** Numerator: the part that matched. */
  matched: number;
  /** Denominator: the total on the source side. */
  total: number;
  /** `matched / total * 100`, rounded to 1dp. 100 when total is 0. */
  percent: number;
}

export interface CoverageStats {
  sourcePages: number;
  targetPages: number;
  /** Source pages with a reachable counterpart on the target. */
  matchedPages: number;
  missingOnTarget: number;
  extraOnTarget: number;
  /** Source pages found to duplicate another source page. */
  aliasPages: number;
  /** Pages that answered, but not with the status the source gave. */
  statusMismatches: number;
  /** Source pages reachable on target, as a share of all source pages. */
  pageCoverage: PercentStat;
}

export interface ContentStats {
  sourceNodes: number;
  targetNodes: number;
  matchedNodes: number;
  driftedNodes: number;
  /** Present on source, absent on target. */
  missingNodes: number;
  /** Present only on target. */
  addedNodes: number;
  reorderedNodes: number;
  /** Source nodes matched with identical text, as a share of source nodes. */
  contentParity: PercentStat;
}

export interface ImageStats {
  sourceImages: number;
  targetImages: number;
  matchedImages: number;
  missingImages: number;
  addedImages: number;
  altDrifts: number;
  sizeDrifts: number;
  imageParity: PercentStat;
}

export interface PriceStats {
  sourcePrices: number;
  targetPrices: number;
  matchedPrices: number;
  valueDrifts: number;
  currencyDrifts: number;
  formatDrifts: number;
  missingPrices: number;
  addedPrices: number;
  /** Prices whose numeric value matched, as a share of source prices. */
  priceParity: PercentStat;
}

export interface CssViewportStats {
  viewport: string;
  comparedNodes: number;
  comparedProperties: number;
  propertyDrifts: number;
  layoutDrifts: number;
  visibilityDrifts: number;
  horizontalOverflowPages: number;
}

export interface CssStats {
  comparedNodes: number;
  /** Total property comparisons performed across all nodes and viewports. */
  comparedProperties: number;
  propertyDrifts: number;
  layoutDrifts: number;
  visibilityDrifts: number;
  /** Elements visible on one side but hidden on the other at some viewport. */
  responsiveVisibilityDrifts: number;
  /** Property comparisons that agreed, as a share of all comparisons. */
  styleParity: PercentStat;
  byViewport: CssViewportStats[];
  /** Most frequently drifting properties - where to start fixing. */
  topProperties: Array<{ property: string; count: number }>;
}

export interface LinkStats {
  totalLinks: number;
  internalLinks: number;
  externalLinks: number;
  checkedLinks: number;
  brokenLinks: number;
  redirectedLinks: number;
  mixedContentLinks: number;
  /** Source link paths that also resolve on the target. */
  pathMismatches: number;
  linkParity: PercentStat;
}

/** Per-page roll-up, so reports can be organised and sorted by page. */
export interface PageStats {
  path: string;
  sourceUrl: string | null;
  targetUrl: string | null;
  /** True when the page produced no findings at all. */
  clean: boolean;
  counts: Record<Severity, number>;
  countsByCategory: Partial<Record<FindingCategory, number>>;
  totalFindings: number;
  /** Set when the readiness gate timed out, so the page is lower confidence. */
  slowCapture: boolean;
}

export interface CrawlStats {
  pagesCaptured: number;
  pagesFailed: number;
  /** Pages whose readiness gate timed out - findings there are less reliable. */
  slowPages: number;
  /** Pages that needed more than one attempt to capture. */
  retriedPages: number;
  aliasesFound: number;
  /** Why URLs were not crawled, so a missing page can always be explained. */
  rejected: Record<string, number>;
  maxDepthReached: number;
  durationMs: number;
}

/** The complete statistics payload backing the summary report. */
export interface RunStats {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sourceBaseUrl: string;
  targetBaseUrl: string;
  viewports: string[];

  crawl: Record<Side, CrawlStats>;

  coverage: CoverageStats;
  content: ContentStats;
  images: ImageStats;
  prices: PriceStats;
  css: CssStats;
  links: LinkStats;

  findings: {
    total: number;
    bySeverity: Record<Severity, number>;
    byCategory: Partial<Record<FindingCategory, number>>;
  };

  pages: {
    total: number;
    clean: number;
    withFindings: number;
    /** Pages with zero findings, as a share of compared pages. */
    cleanRate: PercentStat;
  };

  /** Worst-offending pages first, for the "where to start" section. */
  topPages: PageStats[];
}

/** Build a {@link PercentStat}, treating an empty denominator as full parity. */
export function percentStat(matched: number, total: number): PercentStat {
  const percent = total === 0 ? 100 : Math.round((matched / total) * 1000) / 10;
  return { matched, total, percent };
}
