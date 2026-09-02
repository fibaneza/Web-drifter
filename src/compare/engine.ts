import type { DrifterConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import type {
  ContentStats,
  CssStats,
  Finding,
  FindingCategory,
  ImageStats,
  LinkStats,
  PageSnapshot,
  PageStats,
  PriceStats,
  RunStats,
  Severity,
} from '../core/types.js';
import { percentStat } from '../core/types.js';
import { resolveCssProperties } from '../extract/css-properties.js';
import { createPathMapping } from '../map/path-map.js';
import type { ArtifactStore } from '../store/artifact-store.js';
import { compareImages, comparePrices } from './assets.js';
import { compareContent } from './content.js';
import { buildPageIndex, compareCoverage, type PagePair } from './coverage.js';
import { applySuppression, createFinding, severityFor, sortFindings } from './findings.js';
import { compareStyles } from './styles.js';

/**
 * Comparison orchestration.
 *
 * Runs entirely off the artifact store, never the network. That is what makes
 * `drifter compare` re-runnable in seconds against a crawl that took twenty
 * minutes - which is the only way tuning ignore rules is bearable.
 *
 * Order matters: coverage first (so we know which pages can be compared at
 * all), then content (which produces the node pairings), then styles (which
 * consume those pairings and must never invent their own).
 */

export interface CompareRunOptions {
  store: ArtifactStore;
  config: DrifterConfig;
  logger: Logger;
  runId: string;
  startedAt: string;
}

export interface CompareRunResult {
  findings: Finding[];
  stats: RunStats;
  pageStats: PageStats[];
}

export async function compareRun(options: CompareRunOptions): Promise<CompareRunResult> {
  const { store, config, logger } = options;
  const severities = config.severities as Partial<Record<FindingCategory, Severity>>;

  const mapping = createPathMapping(config.urlMapping);
  const [sourceIndex, targetIndex] = await Promise.all([
    buildPageIndex(store, 'source'),
    buildPageIndex(store, 'target'),
  ]);

  logger.info(
    { sourcePages: sourceIndex.size, targetPages: targetIndex.size },
    'comparing snapshots',
  );

  const coverage = compareCoverage({ sourceIndex, targetIndex, mapping, severities });
  const findings: Finding[] = [...coverage.findings];

  const content = emptyContentStats();
  const images = emptyImageStats();
  const prices = emptyPriceStats();
  const css = emptyCssStats();
  const pageStats: PageStats[] = [];

  const cssProperties = resolveCssProperties(config.ignore.cssProperties);

  for (const pair of coverage.pairs) {
    const pageFindings = await comparePage(pair, store, config, cssProperties, severities);
    findings.push(...pageFindings.findings);

    accumulateContent(content, pageFindings.content);
    accumulateImages(images, pageFindings.images);
    accumulatePrices(prices, pageFindings.prices);
    accumulateCss(css, pageFindings.css);
  }

  const suppressed = applySuppression(findings, {
    ignoreFindingIds: config.ignore.findingIds,
    downgradeCategories: config.ignore.categories,
  });
  const sorted = sortFindings(suppressed);

  // Page roll-ups are built from the FINAL findings, after suppression, so the
  // per-page counts in the report always match what the report actually shows.
  const byPath = new Map<string, Finding[]>();
  for (const finding of sorted) {
    const bucket = byPath.get(finding.path);
    if (bucket) bucket.push(finding);
    else byPath.set(finding.path, [finding]);
  }

  for (const pair of coverage.pairs) {
    pageStats.push(buildPageStats(pair, byPath.get(pair.path) ?? []));
  }

  const finishedAt = new Date().toISOString();
  const stats = buildRunStats({
    options,
    finishedAt,
    coverage: coverage.stats,
    content,
    images,
    prices,
    css,
    findings: sorted,
    pageStats,
  });

  return { findings: sorted, stats, pageStats };
}

interface PageComparison {
  findings: Finding[];
  content: ContentStats;
  images: ImageStats;
  prices: PriceStats;
  css: CssStats;
}

async function comparePage(
  pair: PagePair,
  store: ArtifactStore,
  config: DrifterConfig,
  cssProperties: readonly string[],
  severities: Partial<Record<FindingCategory, Severity>>,
): Promise<PageComparison> {
  const [source, target] = await Promise.all([
    store.readSnapshot('source', pair.path),
    store.readSnapshot('target', pair.targetPath),
  ]);

  if (!source || !target) {
    return {
      findings: [],
      content: emptyContentStats(),
      images: emptyImageStats(),
      prices: emptyPriceStats(),
      css: emptyCssStats(),
    };
  }

  const findings: Finding[] = [];

  const content = compareContent(source, target, {
    textSimilarity: config.thresholds.textSimilarity,
    minMatchConfidence: config.thresholds.minMatchConfidence,
    severities,
  });
  findings.push(...content.findings);

  findings.push(...compareMeta(source, target, severities));

  const assetOptions = {
    priceEpsilon: config.thresholds.priceEpsilon,
    imageSizePercent: config.thresholds.imageSizePercent,
    textSimilarity: config.thresholds.textSimilarity,
    severities,
  };
  const images = compareImages(source, target, assetOptions);
  const prices = comparePrices(source, target, assetOptions);
  findings.push(...images.findings, ...prices.findings);

  const styles = compareStyles(source, target, content.matchedNodes, {
    cssProperties,
    lengthTolerancePx: config.thresholds.cssLengthPx,
    geometryPx: config.thresholds.geometryPx,
    geometryPercent: config.thresholds.geometryPercent,
    minMatchConfidence: config.thresholds.minMatchConfidence,
    severities,
  });
  findings.push(...styles.findings);

  return {
    findings,
    content: content.stats,
    images: images.stats,
    prices: prices.stats,
    css: styles.stats,
  };
}

/**
 * Page metadata.
 *
 * Title and description are content in the sense that matters commercially -
 * they are what search engines and social previews show - so a migration that
 * silently drops them is a real regression even though nothing on the page
 * looks different.
 */
function compareMeta(
  source: PageSnapshot,
  target: PageSnapshot,
  severities: Partial<Record<FindingCategory, Severity>>,
): Finding[] {
  const findings: Finding[] = [];

  const fields: Array<[string, string | null, string | null]> = [
    ['title', source.title, target.title],
    ['description', source.meta.description, target.meta.description],
    ['og:title', source.meta.ogTitle, target.meta.ogTitle],
    ['og:description', source.meta.ogDescription, target.meta.ogDescription],
    ['lang', source.meta.lang, target.meta.lang],
  ];

  for (const [field, sourceValue, targetValue] of fields) {
    const a = (sourceValue ?? '').trim();
    const b = (targetValue ?? '').trim();
    if (a === b) continue;

    findings.push(
      createFinding({
        category: 'meta.drift',
        severity: severityFor('meta.drift', severities),
        path: source.path,
        sourceUrl: source.finalUrl,
        targetUrl: target.finalUrl,
        subject: 'meta',
        facet: field,
        label: b === '' ? `${field} is missing on target` : `${field} differs`,
        expected: a,
        actual: b,
      }),
    );
  }

  return findings;
}

function buildPageStats(pair: PagePair, findings: readonly Finding[]): PageStats {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const countsByCategory: Partial<Record<FindingCategory, number>> = {};

  for (const finding of findings) {
    counts[finding.severity] += 1;
    countsByCategory[finding.category] = (countsByCategory[finding.category] ?? 0) + 1;
  }

  return {
    path: pair.path,
    sourceUrl: pair.source.url,
    targetUrl: pair.target.url,
    clean: findings.length === 0,
    counts,
    countsByCategory,
    totalFindings: findings.length,
    slowCapture: pair.source.slowCapture || pair.target.slowCapture,
  };
}

function buildRunStats(input: {
  options: CompareRunOptions;
  finishedAt: string;
  coverage: RunStats['coverage'];
  content: ContentStats;
  images: ImageStats;
  prices: PriceStats;
  css: CssStats;
  findings: readonly Finding[];
  pageStats: readonly PageStats[];
}): RunStats {
  const { options, findings, pageStats } = input;

  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const byCategory: Partial<Record<FindingCategory, number>> = {};
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
  }

  const clean = pageStats.filter((p) => p.clean).length;

  return {
    runId: options.runId,
    startedAt: options.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Date.parse(input.finishedAt) - Date.parse(options.startedAt),
    sourceBaseUrl: options.config.source.baseUrl,
    targetBaseUrl: options.config.target.baseUrl,
    viewports: [...options.config.viewports],
    crawl: {
      source: emptyCrawlStats(),
      target: emptyCrawlStats(),
    },
    coverage: input.coverage,
    content: recomputeParity(input.content),
    images: input.images,
    prices: input.prices,
    css: input.css,
    links: emptyLinkStats(),
    findings: { total: findings.length, bySeverity, byCategory },
    pages: {
      total: pageStats.length,
      clean,
      withFindings: pageStats.length - clean,
      cleanRate: percentStat(clean, pageStats.length),
    },
    // Worst offenders first: this is the "where do we start" list.
    topPages: [...pageStats]
      .filter((p) => !p.clean)
      .sort(
        (a, b) =>
          b.counts.error - a.counts.error ||
          b.counts.warning - a.counts.warning ||
          b.totalFindings - a.totalFindings,
      )
      .slice(0, 25),
  };
}

/* ------------------------------- accumulators ----------------------------- */

function accumulateContent(total: ContentStats, page: ContentStats): void {
  total.sourceNodes += page.sourceNodes;
  total.targetNodes += page.targetNodes;
  total.matchedNodes += page.matchedNodes;
  total.driftedNodes += page.driftedNodes;
  total.missingNodes += page.missingNodes;
  total.addedNodes += page.addedNodes;
  total.reorderedNodes += page.reorderedNodes;
}

function recomputeParity(stats: ContentStats): ContentStats {
  return {
    ...stats,
    contentParity: percentStat(stats.matchedNodes - stats.driftedNodes, stats.sourceNodes),
  };
}

function accumulateImages(total: ImageStats, page: ImageStats): void {
  total.sourceImages += page.sourceImages;
  total.targetImages += page.targetImages;
  total.matchedImages += page.matchedImages;
  total.missingImages += page.missingImages;
  total.addedImages += page.addedImages;
  total.altDrifts += page.altDrifts;
  total.sizeDrifts += page.sizeDrifts;
  total.imageParity = percentStat(
    total.matchedImages - total.altDrifts - total.sizeDrifts,
    total.sourceImages,
  );
}

function accumulatePrices(total: PriceStats, page: PriceStats): void {
  total.sourcePrices += page.sourcePrices;
  total.targetPrices += page.targetPrices;
  total.matchedPrices += page.matchedPrices;
  total.valueDrifts += page.valueDrifts;
  total.currencyDrifts += page.currencyDrifts;
  total.formatDrifts += page.formatDrifts;
  total.missingPrices += page.missingPrices;
  total.addedPrices += page.addedPrices;
  total.priceParity = percentStat(
    total.matchedPrices - total.valueDrifts - total.currencyDrifts,
    total.sourcePrices,
  );
}

function accumulateCss(total: CssStats, page: CssStats): void {
  total.comparedNodes += page.comparedNodes;
  total.comparedProperties += page.comparedProperties;
  total.propertyDrifts += page.propertyDrifts;
  total.layoutDrifts += page.layoutDrifts;
  total.visibilityDrifts += page.visibilityDrifts;
  total.responsiveVisibilityDrifts += page.responsiveVisibilityDrifts;

  for (const viewport of page.byViewport) {
    const existing = total.byViewport.find((v) => v.viewport === viewport.viewport);
    if (!existing) {
      total.byViewport.push({ ...viewport });
      continue;
    }
    existing.comparedNodes += viewport.comparedNodes;
    existing.comparedProperties += viewport.comparedProperties;
    existing.propertyDrifts += viewport.propertyDrifts;
    existing.layoutDrifts += viewport.layoutDrifts;
    existing.visibilityDrifts += viewport.visibilityDrifts;
    existing.horizontalOverflowPages += viewport.horizontalOverflowPages;
  }

  const counts = new Map(total.topProperties.map((p) => [p.property, p.count]));
  for (const { property, count } of page.topProperties) {
    counts.set(property, (counts.get(property) ?? 0) + count);
  }
  total.topProperties = [...counts.entries()]
    .map(([property, count]) => ({ property, count }))
    .sort((a, b) => b.count - a.count || a.property.localeCompare(b.property))
    .slice(0, 20);

  total.styleParity = percentStat(
    total.comparedProperties - total.propertyDrifts,
    total.comparedProperties,
  );
}

/* --------------------------------- empties -------------------------------- */

const emptyContentStats = (): ContentStats => ({
  sourceNodes: 0,
  targetNodes: 0,
  matchedNodes: 0,
  driftedNodes: 0,
  missingNodes: 0,
  addedNodes: 0,
  reorderedNodes: 0,
  contentParity: percentStat(0, 0),
});

const emptyImageStats = (): ImageStats => ({
  sourceImages: 0,
  targetImages: 0,
  matchedImages: 0,
  missingImages: 0,
  addedImages: 0,
  altDrifts: 0,
  sizeDrifts: 0,
  imageParity: percentStat(0, 0),
});

const emptyPriceStats = (): PriceStats => ({
  sourcePrices: 0,
  targetPrices: 0,
  matchedPrices: 0,
  valueDrifts: 0,
  currencyDrifts: 0,
  formatDrifts: 0,
  missingPrices: 0,
  addedPrices: 0,
  priceParity: percentStat(0, 0),
});

const emptyCssStats = (): CssStats => ({
  comparedNodes: 0,
  comparedProperties: 0,
  propertyDrifts: 0,
  layoutDrifts: 0,
  visibilityDrifts: 0,
  responsiveVisibilityDrifts: 0,
  styleParity: percentStat(0, 0),
  byViewport: [],
  topProperties: [],
});

const emptyLinkStats = (): LinkStats => ({
  totalLinks: 0,
  internalLinks: 0,
  externalLinks: 0,
  checkedLinks: 0,
  brokenLinks: 0,
  redirectedLinks: 0,
  mixedContentLinks: 0,
  pathMismatches: 0,
  linkParity: percentStat(0, 0),
});

const emptyCrawlStats = (): RunStats['crawl']['source'] => ({
  pagesCaptured: 0,
  pagesFailed: 0,
  slowPages: 0,
  aliasesFound: 0,
  rejected: {},
  maxDepthReached: 0,
  durationMs: 0,
});
