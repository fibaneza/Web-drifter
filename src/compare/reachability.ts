import type { ArtifactStore } from '../store/artifact-store.js';

/**
 * Source pages nothing else links to.
 *
 * A Sitecore estate accumulates pages that are still published but no longer
 * reachable: 2019 campaign landing pages, print catalogues, URLs only ever sent
 * in an email. They turn up in the sitemap, so the crawler finds them, and they
 * are then counted against page coverage and can fail a build - which makes the
 * headline number describe the size of the legacy backlog rather than the
 * quality of the migration.
 *
 * Reachability is derived from the stored snapshots rather than from the
 * crawler. That is not a shortcut: the frontier does record where a URL was
 * discovered, but it rejects a re-offer at equal-or-worse depth before updating
 * it, and every sitemap URL is seeded at depth 0 - so a sitemap page that IS
 * linked would still look orphaned. Link paths and page paths share one key
 * space (both are `canonicalizeUrl(...).key`), so the snapshots answer the
 * question exactly, work on runs captured before this existed, and are
 * recomputed by `drifter compare` without a re-crawl.
 */

export interface Reachability {
  /** Captured source paths that no other crawled source page links to. */
  orphans: Set<string>;
  /** Distinct internal link destinations seen across the source crawl. */
  linkedPaths: number;
}

export async function findOrphanPages(
  store: ArtifactStore,
  startUrls: readonly string[],
): Promise<Reachability> {
  const linked = new Set<string>();
  const captured: string[] = [];

  for await (const snapshot of store.iterateSnapshots('source')) {
    captured.push(snapshot.path);
    for (const link of snapshot.links) {
      // Visibility is irrelevant here: a link in a collapsed menu still makes
      // the page reachable, and this is a question about the site's shape
      // rather than about what a visitor can click.
      if (link.kind === 'internal' && link.path !== null) linked.add(link.path);
    }
  }

  // A page named in `startUrls` was chosen deliberately, so it is never an
  // orphan - otherwise `/` becomes one on any site whose home page is reached
  // only through a logo image.
  const seeds = new Set(startUrls.map(startUrlPath));

  const orphans = new Set(captured.filter((path) => !linked.has(path) && !seeds.has(path)));

  return { orphans, linkedPaths: linked.size };
}

/**
 * Path portion of a configured start URL.
 *
 * `startUrls` accepts both absolute URLs and bare paths, and the crawler
 * canonicalises them, so this only needs to reach the same shape for the
 * comparison above.
 */
function startUrlPath(startUrl: string): string {
  try {
    return new URL(startUrl).pathname;
  } catch {
    return startUrl.startsWith('/') ? startUrl : `/${startUrl}`;
  }
}
