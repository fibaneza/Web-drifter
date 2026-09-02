import {
  canonicalizeUrl,
  type CanonicalUrl,
  type UrlNormalizeOptions,
} from '../map/url-normalize.js';
import type { OriginGuard } from './origin-guard.js';
import { detectTrap, type TrapOptions } from './traps.js';

/**
 * The URL frontier: a breadth-first queue that enforces every crawl bound.
 *
 * Four rules live here, and nowhere else:
 *
 *  1. Same-origin only     - delegated to the {@link OriginGuard}.
 *  2. Depth limit          - `maxDepth` hops from a seed (seeds are depth 0).
 *  3. Never revisit        - canonical URL, post-redirect URL, and content hash.
 *  4. No infinite spaces   - trap detection plus a hard page cap.
 *
 * Breadth-first order means a URL is normally first reached at its minimum
 * depth. Under concurrency that ordering can be violated slightly, so the
 * frontier also tracks the best depth seen per URL and promotes an entry if a
 * shorter route to it turns up later - otherwise a page legitimately reachable
 * in two hops could be discarded because a slower worker happened to find it
 * at three first.
 */

export interface FrontierEntry {
  url: URL;
  canonical: CanonicalUrl;
  /** Hops from the nearest seed. Mutable: a shorter route may be found later. */
  depth: number;
  /** Page this URL was discovered on; null for seeds. */
  discoveredOn: string | null;
}

export type RejectReason =
  | 'duplicate'
  | 'already-captured'
  | 'depth-exceeded'
  | 'off-origin'
  | 'trap'
  | 'excluded'
  | 'not-included'
  | 'ignored-path'
  | 'unparseable';

export type OfferResult =
  | { accepted: true; entry: FrontierEntry; promoted: boolean }
  | { accepted: false; reason: RejectReason; detail?: string };

export interface FrontierOptions {
  guard: OriginGuard;
  normalize: UrlNormalizeOptions;
  traps: TrapOptions;
  maxDepth: number;
  maxPages: number;
  excludePatterns?: readonly RegExp[];
  includePatterns?: readonly RegExp[];
  ignorePaths?: readonly RegExp[];
}

export interface FrontierStats {
  queued: number;
  captured: number;
  seen: number;
  aliases: number;
  rejected: Record<RejectReason, number>;
}

const EMPTY_REJECTIONS = (): Record<RejectReason, number> => ({
  duplicate: 0,
  'already-captured': 0,
  'depth-exceeded': 0,
  'off-origin': 0,
  trap: 0,
  excluded: 0,
  'not-included': 0,
  'ignored-path': 0,
  unparseable: 0,
});

export class Frontier {
  readonly #options: FrontierOptions;

  /** Canonical href -> best (lowest) depth at which it has been offered. */
  readonly #seenDepth = new Map<string, number>();
  /** Canonical href -> queued entry, so a promotion can update it in place. */
  readonly #queuedEntries = new Map<string, FrontierEntry>();
  /** FIFO queue giving breadth-first order. */
  readonly #queue: FrontierEntry[] = [];
  #head = 0;

  readonly #captured = new Set<string>();
  /** Content hash -> canonical href of the page first seen with that content. */
  readonly #byContentHash = new Map<string, string>();
  /** Alias canonical href -> canonical href of the page it duplicates. */
  readonly #aliases = new Map<string, string>();

  readonly #rejected = EMPTY_REJECTIONS();

  constructor(options: FrontierOptions) {
    this.#options = options;
  }

  /** Add a seed URL at depth 0. */
  seed(url: URL): OfferResult {
    return this.offer(url, 0, null);
  }

  /**
   * Offer a discovered URL at `depth`.
   *
   * Depth-exceeded URLs are still recorded, so that if the same URL turns up
   * later via a shorter route it can be promoted rather than rejected as a
   * duplicate.
   */
  offer(url: URL, depth: number, discoveredOn: string | null): OfferResult {
    const { guard, normalize, traps, maxDepth } = this.#options;

    if (!guard.isAllowed(url)) {
      this.#rejected['off-origin'] += 1;
      return { accepted: false, reason: 'off-origin', detail: url.origin };
    }

    const trap = detectTrap(url, traps);
    if (trap.trapped) {
      this.#rejected.trap += 1;
      return { accepted: false, reason: 'trap', detail: trap.reason ?? '' };
    }

    const canonical = canonicalizeUrl(url, normalize);
    const { href, path } = canonical;

    const excluded = this.#options.excludePatterns?.find((re) => re.test(path));
    if (excluded) {
      this.#rejected.excluded += 1;
      return { accepted: false, reason: 'excluded', detail: String(excluded) };
    }

    const ignored = this.#options.ignorePaths?.find((re) => re.test(path));
    if (ignored) {
      this.#rejected['ignored-path'] += 1;
      return { accepted: false, reason: 'ignored-path', detail: String(ignored) };
    }

    const include = this.#options.includePatterns;
    if (include && include.length > 0 && !include.some((re) => re.test(path))) {
      this.#rejected['not-included'] += 1;
      return { accepted: false, reason: 'not-included' };
    }

    const previousDepth = this.#seenDepth.get(href);
    if (previousDepth !== undefined && previousDepth <= depth) {
      const reason: RejectReason = this.#captured.has(href) ? 'already-captured' : 'duplicate';
      this.#rejected[reason] += 1;
      return { accepted: false, reason };
    }

    this.#seenDepth.set(href, depth);

    if (depth > maxDepth) {
      this.#rejected['depth-exceeded'] += 1;
      return { accepted: false, reason: 'depth-exceeded', detail: `depth ${depth} > ${maxDepth}` };
    }

    // Already fetched via a longer route - the content is identical, so there is
    // nothing to gain by fetching it again.
    if (this.#captured.has(href)) {
      this.#rejected['already-captured'] += 1;
      return { accepted: false, reason: 'already-captured' };
    }

    // Queued at a worse depth: promote in place rather than queueing twice.
    const queued = this.#queuedEntries.get(href);
    if (queued) {
      queued.depth = depth;
      return { accepted: true, entry: queued, promoted: true };
    }

    const entry: FrontierEntry = { url, canonical, depth, discoveredOn };
    this.#queuedEntries.set(href, entry);
    this.#queue.push(entry);
    return { accepted: true, entry, promoted: false };
  }

  /** Take the next URL to capture, or undefined when the queue is drained. */
  next(): FrontierEntry | undefined {
    if (this.#captured.size >= this.#options.maxPages) return undefined;

    while (this.#head < this.#queue.length) {
      const entry = this.#queue[this.#head];
      this.#head += 1;
      if (!entry) continue;
      this.#queuedEntries.delete(entry.canonical.href);
      // A promotion may have queued it a second time; capture set guards that.
      if (this.#captured.has(entry.canonical.href)) continue;
      return entry;
    }
    return undefined;
  }

  /**
   * Record a completed capture.
   *
   * @returns `duplicateOf` when this page turned out to be another page under a
   * different URL (post-redirect collision or identical content). The caller
   * should record an alias rather than persisting a second snapshot.
   */
  markCaptured(
    entry: FrontierEntry,
    result: { finalUrl: URL; contentHash: string },
  ): { duplicateOf: string | null } {
    const requestedHref = entry.canonical.href;
    this.#captured.add(requestedHref);

    // Layer 2 - post-redirect dedup. `/a` and `/a/` may both land on `/a`.
    const finalCanonical = canonicalizeUrl(result.finalUrl, this.#options.normalize);
    const finalHref = finalCanonical.href;

    if (finalHref !== requestedHref) {
      if (this.#captured.has(finalHref)) {
        this.#aliases.set(requestedHref, finalHref);
        return { duplicateOf: finalHref };
      }
      // Claim the destination too, so a later direct link to it is skipped.
      this.#captured.add(finalHref);
      this.#seenDepth.set(finalHref, entry.depth);
      this.#aliases.set(finalHref, requestedHref);
    }

    // Layer 3 - content dedup. Distinct URLs rendering an identical page
    // (session ids, alias paths, print variants) are recorded, not re-processed.
    const existing = this.#byContentHash.get(result.contentHash);
    if (existing && existing !== requestedHref) {
      this.#aliases.set(requestedHref, existing);
      return { duplicateOf: existing };
    }
    this.#byContentHash.set(result.contentHash, requestedHref);

    return { duplicateOf: null };
  }

  /** Canonical hrefs that were found to duplicate `href`. */
  aliasesOf(href: string): string[] {
    const out: string[] = [];
    for (const [alias, target] of this.#aliases) {
      if (target === href) out.push(alias);
    }
    return out;
  }

  hasCapacity(): boolean {
    return this.#captured.size < this.#options.maxPages;
  }

  get capturedCount(): number {
    return this.#captured.size;
  }

  get pendingCount(): number {
    return this.#queue.length - this.#head;
  }

  stats(): FrontierStats {
    return {
      queued: this.pendingCount,
      captured: this.#captured.size,
      seen: this.#seenDepth.size,
      aliases: this.#aliases.size,
      rejected: { ...this.#rejected },
    };
  }
}
