/**
 * Origin guard - the hard boundary that stops the crawler leaving the site.
 *
 * "Same origin" is evaluated per side against that side's own configured
 * `baseUrl`, because source and target deliberately live on different hosts.
 * Widening the boundary is always explicit: subdomains, `www` vs apex and any
 * extra host must be listed in `crawl.additionalOrigins`. Nothing is inferred,
 * so a stray link to a marketing microsite can never pull the crawler off-site.
 */

export interface OriginGuard {
  /** True when the URL may be navigated to and rendered. */
  isAllowed(url: URL): boolean;
  /** The origins this guard admits, for logging and reports. */
  readonly origins: readonly string[];
  /** The primary origin (from `baseUrl`). */
  readonly baseOrigin: string;
  /** Base path prefix, when baseUrl points at a sub-path. `''` when at root. */
  readonly basePath: string;
}

function originOf(url: URL): string {
  const protocol = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return url.port ? `${protocol}//${hostname}:${url.port}` : `${protocol}//${hostname}`;
}

/**
 * @param baseUrl            the side's configured base URL
 * @param additionalOrigins  extra origins that count as "ours"
 * @param sameOriginOnly     when false, every http(s) origin is allowed - only
 *                           useful for deliberately unbounded diagnostic runs
 */
export function createOriginGuard(
  baseUrl: string,
  additionalOrigins: readonly string[] = [],
  sameOriginOnly = true,
): OriginGuard {
  const base = new URL(baseUrl);
  const baseOrigin = originOf(base);

  // A baseUrl of https://host/en-gb/ confines the crawl to that sub-path too.
  const rawBasePath = base.pathname.replace(/\/+$/, '');
  const basePath = rawBasePath === '' ? '' : rawBasePath.toLowerCase();

  const allowed = new Set<string>([baseOrigin]);
  for (const extra of additionalOrigins) {
    try {
      allowed.add(originOf(new URL(extra)));
    } catch {
      // Schema validation already rejects malformed origins; ignore defensively.
    }
  }

  const origins = [...allowed];

  return {
    origins,
    baseOrigin,
    basePath,
    isAllowed(url: URL): boolean {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      if (!sameOriginOnly) return true;
      if (!allowed.has(originOf(url))) return false;

      if (basePath !== '') {
        const path = url.pathname.toLowerCase();
        if (path !== basePath && !path.startsWith(`${basePath}/`)) return false;
      }
      return true;
    },
  };
}
