import type { Logger } from '../core/logger.js';
import type {
  Finding,
  FindingCategory,
  LinkRecord,
  LinkStats,
  PageSnapshot,
  Severity,
  Side,
} from '../core/types.js';
import { percentStat } from '../core/types.js';
import type { PathMapping } from '../map/path-map.js';
import type { ArtifactStore } from '../store/artifact-store.js';
import type { PageIndex } from './coverage.js';
import { createFinding, severityFor } from './findings.js';
import { LinkChecker } from './link-checker.js';

/**
 * Link and URL checking - Phase 3.5.
 *
 * Answers two different questions that are easy to conflate:
 *
 *   1. **Does it work?** Every link, on both sides, should resolve. External
 *      links are never crawled but are still checked, because a dead outbound
 *      link is a real defect.
 *   2. **Does it still point at the same place?** A link the source shows must
 *      have a counterpart on the target. This is the migration-specific check,
 *      and it is the one that catches a rewrite quietly dropping a route.
 *
 * Only **visible** links are held to the parity requirement. A hidden link in a
 * collapsed menu is not something a user can follow, and treating it as a
 * broken promise generates noise on every page that has a mega-menu.
 */

export interface LinkCompareOptions {
  checkExternalLinks: boolean;
  concurrency: number;
  timeoutMs: number;
  severities?: Partial<Record<FindingCategory, Severity>>;
  logger: Logger;
}

export interface LinkCompareResult {
  findings: Finding[];
  stats: LinkStats;
}

interface LinkOccurrence {
  link: LinkRecord;
  /** Page the link was found on. */
  path: string;
  pageUrl: string;
  side: Side;
}

export async function compareLinks(
  store: ArtifactStore,
  sourceIndex: PageIndex,
  targetIndex: PageIndex,
  mapping: PathMapping,
  options: LinkCompareOptions,
): Promise<LinkCompareResult> {
  const { severities = {} } = options;
  const findings: Finding[] = [];

  const occurrences: LinkOccurrence[] = [];
  for (const side of ['source', 'target'] as const) {
    for await (const snapshot of store.iterateSnapshots(side)) {
      for (const link of snapshot.links) {
        occurrences.push({ link, path: snapshot.path, pageUrl: snapshot.finalUrl, side });
      }
    }
  }

  const internal = occurrences.filter((o) => o.link.kind === 'internal');
  const external = occurrences.filter((o) => o.link.kind === 'external');

  /* ----------------------------- path parity ---------------------------- */

  // Every visible internal link on the source must have a counterpart on the
  // target. Reported once per distinct destination rather than once per
  // occurrence: a footer link that is missing is one defect, not one per page.
  const sourceLinkPaths = new Map<string, LinkOccurrence>();
  for (const occurrence of internal) {
    if (occurrence.side !== 'source' || !occurrence.link.visible) continue;
    const path = occurrence.link.path;
    if (path === null || sourceLinkPaths.has(path)) continue;
    sourceLinkPaths.set(path, occurrence);
  }

  let pathMismatches = 0;
  for (const [path, occurrence] of sourceLinkPaths) {
    const expected = mapping.toTarget(path);
    if (targetIndex.has(expected)) continue;

    pathMismatches += 1;
    findings.push(
      createFinding({
        category: 'link.path-mismatch',
        severity: severityFor('link.path-mismatch', severities),
        path: occurrence.path,
        sourceUrl: occurrence.pageUrl,
        subject: path,
        label: `Source links to ${path}, which has no counterpart on the target`,
        expected,
        actual: null,
        details: { linkText: occurrence.link.text, region: occurrence.link.region },
      }),
    );
  }

  /* ---------------------------- mixed content --------------------------- */

  let mixedContentLinks = 0;
  for (const occurrence of occurrences) {
    const resolved = occurrence.link.resolved;
    if (!resolved || !resolved.startsWith('http://')) continue;
    if (!occurrence.pageUrl.startsWith('https://')) continue;

    mixedContentLinks += 1;
    findings.push(
      createFinding({
        category: 'link.mixed-content',
        severity: severityFor('link.mixed-content', severities),
        path: occurrence.path,
        subject: resolved,
        label: `Insecure http:// link on an https:// page`,
        expected: resolved.replace('http://', 'https://'),
        actual: resolved,
        details: { side: occurrence.side },
      }),
    );
  }

  /* ------------------------------- checking ----------------------------- */

  // Internal links are only fetched when the crawl did not already visit them -
  // beyond the depth limit, excluded by config, or capped by maxPages. Anything
  // already captured has a known status and re-fetching it would be waste.
  const toCheck = new Map<string, LinkOccurrence>();
  for (const occurrence of internal) {
    const resolved = occurrence.link.resolved;
    const path = occurrence.link.path;
    if (!resolved || path === null) continue;
    const index = occurrence.side === 'source' ? sourceIndex : targetIndex;
    if (index.has(path)) continue;
    if (!toCheck.has(resolved)) toCheck.set(resolved, occurrence);
  }

  if (options.checkExternalLinks) {
    for (const occurrence of external) {
      const resolved = occurrence.link.resolved;
      // External links are NEVER rendered - only their status is requested.
      if (resolved && !toCheck.has(resolved)) toCheck.set(resolved, occurrence);
    }
  }

  const checker = new LinkChecker({
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
  });

  options.logger.info({ links: toCheck.size }, 'checking links');

  let brokenLinks = 0;
  let redirectedLinks = 0;

  const results = await Promise.all(
    [...toCheck.entries()].map(async ([url, occurrence]) => ({
      occurrence,
      status: await checker.check(url),
    })),
  );

  for (const { occurrence, status } of results) {
    if (status.kind === 'broken' || status.kind === 'error') {
      brokenLinks += 1;
      findings.push(
        createFinding({
          category: 'link.broken',
          severity: severityFor('link.broken', severities),
          path: occurrence.path,
          ...(occurrence.side === 'source'
            ? { sourceUrl: occurrence.pageUrl }
            : { targetUrl: occurrence.pageUrl }),
          subject: status.url,
          label:
            status.kind === 'error'
              ? `Link failed: ${status.url} (${status.reason ?? 'unknown error'})`
              : `Link returns ${status.status}: ${status.url}`,
          expected: '2xx',
          actual: status.status === 0 ? (status.reason ?? 'request failed') : status.status,
          details: {
            side: occurrence.side,
            linkText: occurrence.link.text,
            linkKind: occurrence.link.kind,
            region: occurrence.link.region,
          },
        }),
      );
      continue;
    }

    if (status.kind === 'redirected') {
      redirectedLinks += 1;
      findings.push(
        createFinding({
          category: 'link.redirect-chain',
          severity: severityFor('link.redirect-chain', severities),
          path: occurrence.path,
          subject: status.url,
          label: `Link redirects ${status.redirectCount} time(s): ${status.url}`,
          expected: status.url,
          actual: status.finalUrl ?? status.url,
          details: { side: occurrence.side, redirectCount: status.redirectCount },
        }),
      );
    }
  }

  // Broken links found by the crawl itself: a page linked from the target that
  // answered non-2xx was captured, so its status is already known.
  for (const occurrence of internal) {
    const path = occurrence.link.path;
    if (path === null) continue;
    const index = occurrence.side === 'source' ? sourceIndex : targetIndex;
    const entry = index.get(path);
    if (!entry || entry.status < 400) continue;

    brokenLinks += 1;
    findings.push(
      createFinding({
        category: 'link.broken',
        severity: severityFor('link.broken', severities),
        path: occurrence.path,
        ...(occurrence.side === 'source'
          ? { sourceUrl: occurrence.pageUrl }
          : { targetUrl: occurrence.pageUrl }),
        subject: path,
        label: `Link returns ${entry.status}: ${path}`,
        expected: '2xx',
        actual: entry.status,
        details: {
          side: occurrence.side,
          linkText: occurrence.link.text,
          region: occurrence.link.region,
        },
      }),
    );
  }

  const internalSourceLinks = sourceLinkPaths.size;
  return {
    findings,
    stats: {
      totalLinks: occurrences.length,
      internalLinks: internal.length,
      externalLinks: external.length,
      checkedLinks: checker.checkedCount,
      brokenLinks,
      redirectedLinks,
      mixedContentLinks,
      pathMismatches,
      linkParity: percentStat(internalSourceLinks - pathMismatches, internalSourceLinks),
    },
  };
}

/** Distinct destinations linked from a snapshot, for the links report. */
export function distinctDestinations(snapshot: PageSnapshot): string[] {
  return [...new Set(snapshot.links.map((l) => l.resolved).filter((v): v is string => v !== null))];
}
