import type {
  CoverageStats,
  Finding,
  FindingCategory,
  PageSnapshot,
  RedirectHop,
  Severity,
  Side,
} from '../core/types.js';
import { percentStat } from '../core/types.js';
import type { PathMapping } from '../map/path-map.js';
import type { ArtifactStore } from '../store/artifact-store.js';
import { createFinding, severityFor } from './findings.js';

/**
 * Page coverage: does every source page exist and work on the target?
 *
 * This runs first and answers the question that matters most. Content drift on
 * a page is a defect; a page that does not exist at all is a broken migration,
 * and reporting the two at the same weight would bury the second.
 *
 * Coverage works from a lightweight index rather than whole snapshots, because
 * a full crawl with styles at four viewports is far too large to hold in memory
 * at once.
 */

export interface PageIndexEntry {
  path: string;
  url: string;
  status: number;
  redirectChain: RedirectHop[];
  aliases: string[];
  depth: number;
  /** True when the readiness gate timed out, so findings here are less certain. */
  slowCapture: boolean;
}

export type PageIndex = Map<string, PageIndexEntry>;

export async function buildPageIndex(store: ArtifactStore, side: Side): Promise<PageIndex> {
  const index: PageIndex = new Map();
  for await (const snapshot of store.iterateSnapshots(side)) {
    index.set(snapshot.path, toIndexEntry(snapshot));
  }
  return index;
}

export function toIndexEntry(snapshot: PageSnapshot): PageIndexEntry {
  return {
    path: snapshot.path,
    url: snapshot.finalUrl,
    status: snapshot.status,
    redirectChain: snapshot.redirectChain,
    aliases: snapshot.aliases,
    depth: snapshot.depth,
    slowCapture: snapshot.errors.some((e) => e.startsWith('readiness')),
  };
}

/** A source page and the target page it should be compared against. */
export interface PagePair {
  /** Canonical source path - the identity used throughout the reports. */
  path: string;
  targetPath: string;
  source: PageIndexEntry;
  target: PageIndexEntry;
}

export interface CoverageResult {
  /** Pages present and usable on both sides, ready for deeper comparison. */
  pairs: PagePair[];
  findings: Finding[];
  stats: CoverageStats;
}

export interface CoverageOptions {
  sourceIndex: PageIndex;
  targetIndex: PageIndex;
  mapping: PathMapping;
  severities?: Partial<Record<FindingCategory, Severity>>;
}

const isOk = (status: number): boolean => status >= 200 && status < 300;

export function compareCoverage({
  sourceIndex,
  targetIndex,
  mapping,
  severities = {},
}: CoverageOptions): CoverageResult {
  const findings: Finding[] = [];
  const pairs: PagePair[] = [];
  const claimedTargets = new Set<string>();

  let missingOnTarget = 0;
  let statusMismatches = 0;
  let aliasPages = 0;

  for (const source of sourceIndex.values()) {
    // A source page that itself failed to load cannot tell us anything about
    // the target, so it is reported once and excluded from the denominators.
    if (!isOk(source.status)) {
      findings.push(
        createFinding({
          category: 'page.status-mismatch',
          severity: 'warning',
          path: source.path,
          subject: 'source-status',
          label: `Source page returned ${source.status}; excluded from comparison`,
          sourceUrl: source.url,
          expected: '2xx',
          actual: source.status,
        }),
      );
      continue;
    }

    for (const alias of source.aliases) {
      aliasPages += 1;
      findings.push(
        createFinding({
          category: 'page.alias',
          severity: severityFor('page.alias', severities),
          path: source.path,
          subject: alias,
          label: `${alias} is a duplicate of this page and was not crawled separately`,
          sourceUrl: source.url,
        }),
      );
    }

    const targetPath = mapping.toTarget(source.path);
    const target = targetIndex.get(targetPath);
    claimedTargets.add(targetPath);

    if (!target) {
      missingOnTarget += 1;
      findings.push(
        createFinding({
          category: 'page.missing-on-target',
          severity: severityFor('page.missing-on-target', severities),
          path: source.path,
          subject: targetPath,
          label: `Page exists on source but was not found on target at ${targetPath}`,
          sourceUrl: source.url,
          expected: targetPath,
          actual: null,
          ...(mapping.isRemapped(source.path) ? { details: { remappedFrom: source.path } } : {}),
        }),
      );
      continue;
    }

    if (!isOk(target.status)) {
      statusMismatches += 1;
      findings.push(
        createFinding({
          category: 'page.status-mismatch',
          severity: severityFor('page.status-mismatch', severities),
          path: source.path,
          subject: 'target-status',
          label: `Target returned ${target.status} where source returned ${source.status}`,
          sourceUrl: source.url,
          targetUrl: target.url,
          expected: source.status,
          actual: target.status,
        }),
      );
      continue;
    }

    // A path that only answers after a redirect is reachable but not identical:
    // it costs a round trip, can break deep links, and often signals that the
    // rewrite changed a URL it was supposed to preserve.
    if (target.redirectChain.length > 0 && source.redirectChain.length === 0) {
      findings.push(
        createFinding({
          category: 'page.redirected',
          severity: severityFor('page.redirected', severities),
          path: source.path,
          subject: 'redirect',
          label:
            `Target reaches this page only after ${target.redirectChain.length} ` +
            `redirect(s); the source serves it directly`,
          sourceUrl: source.url,
          targetUrl: target.url,
          expected: 'direct response',
          actual: target.redirectChain.map((h) => `${h.status} ${h.url}`),
        }),
      );
    }

    pairs.push({ path: source.path, targetPath, source, target });
  }

  // Extra pages: reachable on the target with no source counterpart. Non-2xx
  // target pages are excluded - a 404 the target links to is a broken link, not
  // an extra page, and belongs in the links report.
  let extraOnTarget = 0;
  for (const target of targetIndex.values()) {
    if (claimedTargets.has(target.path) || !isOk(target.status)) continue;
    extraOnTarget += 1;
    findings.push(
      createFinding({
        category: 'page.extra-on-target',
        severity: severityFor('page.extra-on-target', severities),
        path: target.path,
        subject: 'extra',
        label: 'Page exists on target but has no counterpart on source',
        targetUrl: target.url,
        expected: null,
        actual: target.path,
      }),
    );
  }

  const comparableSourcePages = [...sourceIndex.values()].filter((p) => isOk(p.status)).length;

  const stats: CoverageStats = {
    sourcePages: sourceIndex.size,
    targetPages: targetIndex.size,
    matchedPages: pairs.length,
    missingOnTarget,
    extraOnTarget,
    aliasPages,
    statusMismatches,
    pageCoverage: percentStat(pairs.length, comparableSourcePages),
  };

  return { pairs, findings, stats };
}
