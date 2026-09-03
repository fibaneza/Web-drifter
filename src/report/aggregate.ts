import {
  COVERAGE_CATEGORIES,
  CSS_CATEGORIES,
  LINK_CATEGORIES,
  SEVERITY_ORDER,
  type Finding,
  type FindingCategory,
  type PageStats,
  type RunStats,
  type Severity,
} from '../core/types.js';

/**
 * Report aggregation.
 *
 * Every renderer - HTML, Markdown, JUnit - reads from the model built here, so
 * the two navigation axes and the machine-readable output can never disagree
 * about what was found. One pass over the findings; no renderer re-derives
 * anything.
 *
 * The organising distinction is **viewport-independent vs viewport-specific**
 * (see `docs/reports.md`). A paragraph either changed or it did not - that is
 * not a per-device fact, and repeating it under all four viewports would
 * inflate every count fourfold and bury the findings that genuinely are
 * per-device.
 */

/** A finding tied to one screen size, rather than to the page as a whole. */
export function isViewportSpecific(finding: Finding): boolean {
  return finding.viewport !== undefined;
}

export interface SubjectGroup {
  /** Stable handle for the element, or `''` when the finding has no subject. */
  subject: string;
  /** Human label for the group, taken from the first finding. */
  label: string;
  findings: Finding[];
  worst: Severity;
}

export interface PageReport {
  path: string;
  sourceUrl: string | null;
  targetUrl: string | null;
  stats: PageStats;
  /** Findings that apply to the page regardless of screen size. */
  shared: Finding[];
  /** Viewport id -> findings seen only at that size. */
  byViewport: Map<string, Finding[]>;
  /** Shared findings grouped by element, so one element reads as one block. */
  groups: SubjectGroup[];
  total: number;
}

export interface DeviceReport {
  viewport: string;
  findings: Finding[];
  /** Path -> findings at this viewport. */
  byPath: Map<string, Finding[]>;
  counts: Record<Severity, number>;
  total: number;
}

/** One row of the headline matrix: how a page fares at each screen size. */
export interface MatrixRow {
  path: string;
  /** Viewport-independent findings, which apply to every column. */
  shared: number;
  /** Viewport id -> count. */
  byViewport: Record<string, number>;
  total: number;
  worst: Severity | null;
}

export interface ReportModel {
  stats: RunStats;
  findings: Finding[];
  viewports: string[];
  pages: PageReport[];
  devices: DeviceReport[];
  matrix: MatrixRow[];
  /** Category slices backing the separate reports. */
  css: Finding[];
  links: Finding[];
  coverage: Finding[];
  /** Everything that is not css/links/coverage: content, images, prices, meta. */
  content: Finding[];
  /**
   * Findings on source pages nothing links to.
   *
   * Excluded from `stats` entirely, so they are reported without diluting any
   * percentage or failing a build.
   */
  orphans: Finding[];
  countsByCategory: Array<{ category: FindingCategory; count: number }>;
}

export interface AggregateInput {
  findings: readonly Finding[];
  stats: RunStats;
  pageStats: readonly PageStats[];
  viewports: readonly string[];
}

export function aggregate(input: AggregateInput): ReportModel {
  const { findings, stats, pageStats } = input;
  const viewports = [...input.viewports];

  const byPath = groupBy(findings, (f) => f.path);

  const pages: PageReport[] = pageStats
    .map((page) => buildPageReport(page, byPath.get(page.path) ?? []))
    .sort(byWorstFirst);

  // A finding can land on a path that has no PageStats entry - a page that is
  // missing on the target has no pair, so coverage reports it against a path
  // that was never compared. Those must still appear somewhere.
  const known = new Set(pageStats.map((p) => p.path));
  for (const [path, pathFindings] of byPath) {
    if (known.has(path)) continue;
    pages.push(buildPageReport(syntheticPageStats(path, pathFindings), pathFindings));
  }

  const devices: DeviceReport[] = viewports.map((viewport) => {
    const forViewport = findings.filter((f) => f.viewport === viewport);
    return {
      viewport,
      findings: forViewport,
      byPath: groupBy(forViewport, (f) => f.path),
      counts: countBySeverity(forViewport),
      total: forViewport.length,
    };
  });

  const matrix: MatrixRow[] = pages
    .map((page) => {
      const byViewport: Record<string, number> = {};
      for (const viewport of viewports) {
        byViewport[viewport] = page.byViewport.get(viewport)?.length ?? 0;
      }
      return {
        path: page.path,
        shared: page.shared.length,
        byViewport,
        total: page.total,
        worst: worstSeverity(page.shared.concat(...page.byViewport.values())),
      };
    })
    .filter((row) => row.total > 0);

  const inCategories = (categories: readonly FindingCategory[]): Finding[] => {
    const set = new Set<string>(categories);
    return findings.filter((f) => set.has(f.category));
  };

  const css = inCategories(CSS_CATEGORIES);
  const links = inCategories(LINK_CATEGORIES);
  const coverage = inCategories(COVERAGE_CATEGORIES);
  const specialised = new Set([...css, ...links, ...coverage]);

  return {
    stats,
    findings: [...findings],
    viewports,
    pages,
    devices,
    matrix,
    css,
    links,
    coverage,
    content: findings.filter((f) => !specialised.has(f)),
    orphans: findings.filter((f) => f.details?.['orphanPage'] === true),
    countsByCategory: Object.entries(stats.findings.byCategory)
      .map(([category, count]) => ({ category: category as FindingCategory, count: count ?? 0 }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
  };
}

function buildPageReport(page: PageStats, findings: readonly Finding[]): PageReport {
  const shared = findings.filter((f) => !isViewportSpecific(f));
  const byViewport = new Map<string, Finding[]>();

  for (const finding of findings) {
    if (finding.viewport === undefined) continue;
    const bucket = byViewport.get(finding.viewport);
    if (bucket) bucket.push(finding);
    else byViewport.set(finding.viewport, [finding]);
  }

  return {
    path: page.path,
    sourceUrl: page.sourceUrl,
    targetUrl: page.targetUrl,
    stats: page,
    shared,
    byViewport,
    groups: groupBySubject(shared),
    total: findings.length,
  };
}

/**
 * Group findings by the element they concern.
 *
 * Without this a heading whose colour, size and weight all changed reads as
 * three disconnected rows; grouped, it reads as one element that needs one fix.
 * Findings with no subject each form their own group so nothing is hidden.
 */
export function groupBySubject(findings: readonly Finding[]): SubjectGroup[] {
  const groups = new Map<string, Finding[]>();

  for (const finding of findings) {
    // Ungrouped findings get a unique key so they are never merged together.
    const key = finding.subject ?? `~${finding.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(finding);
    else groups.set(key, [finding]);
  }

  return [...groups.entries()]
    .map(([subject, items]) => ({
      subject: subject.startsWith('~') ? '' : subject,
      label: items[0]?.label ?? subject,
      findings: items,
      worst: worstSeverity(items) ?? 'info',
    }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.worst] - SEVERITY_ORDER[b.worst] || b.findings.length - a.findings.length,
    );
}

/** A page that produced findings but was never paired (e.g. missing on target). */
function syntheticPageStats(path: string, findings: readonly Finding[]): PageStats {
  const first = findings[0];
  const countsByCategory: Partial<Record<FindingCategory, number>> = {};
  for (const finding of findings) {
    countsByCategory[finding.category] = (countsByCategory[finding.category] ?? 0) + 1;
  }

  return {
    path,
    sourceUrl: first?.sourceUrl ?? null,
    targetUrl: first?.targetUrl ?? null,
    clean: findings.length === 0,
    counts: countBySeverity(findings),
    countsByCategory,
    totalFindings: findings.length,
    slowCapture: false,
  };
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function worstSeverity(findings: readonly Finding[]): Severity | null {
  let worst: Severity | null = null;
  for (const finding of findings) {
    if (worst === null || SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[worst]) {
      worst = finding.severity;
    }
  }
  return worst;
}

function byWorstFirst(a: PageReport, b: PageReport): number {
  return (
    b.stats.counts.error - a.stats.counts.error ||
    b.stats.counts.warning - a.stats.counts.warning ||
    b.total - a.total ||
    a.path.localeCompare(b.path)
  );
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}
