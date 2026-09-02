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
  /** One-line human summary. */
  label: string;
  expected?: unknown;
  actual?: unknown;
  /** Match confidence 0..1 for the node pair this finding came from. */
  confidence: number;
  details?: Record<string, unknown> | undefined;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  sourceBaseUrl: string;
  targetBaseUrl: string;
  pagesCrawled: Record<Side, number>;
  pagesCompared: number;
  viewports: string[];
  counts: Record<Severity, number>;
  countsByCategory: Partial<Record<FindingCategory, number>>;
}
