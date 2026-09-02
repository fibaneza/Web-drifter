/**
 * Crawler-trap detection.
 *
 * Infinite URL spaces are the classic way a crawler never terminates: calendar
 * widgets that always link to "next month", faceted search that permutes
 * filters forever, and relative-link bugs that nest a path inside itself. The
 * depth cap alone does not save you, because a single page can mint thousands
 * of distinct depth-1 URLs.
 */

export interface TrapOptions {
  maxPathSegments: number;
  maxQueryParams: number;
  /** Reject once any single segment appears this many times in one path. */
  maxRepeatedSegment: number;
  maxUrlLength: number;
}

export const DEFAULT_TRAP_OPTIONS: TrapOptions = {
  maxPathSegments: 12,
  maxQueryParams: 8,
  maxRepeatedSegment: 3,
  maxUrlLength: 2048,
};

export interface TrapVerdict {
  trapped: boolean;
  /** Why it was rejected, for the crawl log. */
  reason?: string;
}

const OK: TrapVerdict = { trapped: false };

/**
 * Detect a segment repeating too often in one path.
 *
 * Catches the self-nesting produced by a bad relative link, e.g.
 * `/shop/cat/shop/cat/shop/cat/...`, which is otherwise a perfectly valid
 * sequence of distinct URLs.
 */
export function hasRepeatedSegments(pathname: string, maxRepeats: number): boolean {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return false;

  const counts = new Map<string, number>();
  for (const segment of segments) {
    const next = (counts.get(segment) ?? 0) + 1;
    if (next >= maxRepeats) return true;
    counts.set(segment, next);
  }
  return false;
}

/** Decide whether a URL looks like part of an infinite space and must not be enqueued. */
export function detectTrap(url: URL, options: TrapOptions = DEFAULT_TRAP_OPTIONS): TrapVerdict {
  if (url.href.length > options.maxUrlLength) {
    return { trapped: true, reason: `URL longer than ${options.maxUrlLength} characters` };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > options.maxPathSegments) {
    return { trapped: true, reason: `more than ${options.maxPathSegments} path segments` };
  }

  const paramCount = [...url.searchParams.keys()].length;
  if (paramCount > options.maxQueryParams) {
    return { trapped: true, reason: `more than ${options.maxQueryParams} query parameters` };
  }

  if (hasRepeatedSegments(url.pathname, options.maxRepeatedSegment)) {
    return {
      trapped: true,
      reason: `path segment repeats ${options.maxRepeatedSegment}+ times (self-nesting link)`,
    };
  }

  return OK;
}
