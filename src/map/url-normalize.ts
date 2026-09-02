/**
 * URL canonicalisation.
 *
 * Everything that bounds the crawl depends on reducing a URL to a stable
 * canonical form: revisit detection, loop avoidance, and the join key that
 * pairs a source page with its target counterpart.
 *
 * Two distinct keys come out of this module:
 *
 * - `href` - the full canonical URL including origin. Used to decide "have we
 *   already fetched this?" within one side.
 * - `key`  - path + normalised query, origin removed. Used to join a source
 *   page to a target page, which by definition live on different hosts.
 */

/**
 * Analytics parameters that never change what a page renders. Dropped from the
 * canonical form so `/p?utm_source=x` and `/p` are recognised as one page.
 *
 * Deliberately conservative: ambiguous names like `ref` or `source` are left
 * alone because some sites route on them. Add site-specific ones via
 * `urlMapping.dropParams`.
 */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'oly_enc_id',
  'oly_anon_id',
  'mkt_tok',
  'trk',
  'trkCampaign',
]);

function isTrackingParam(name: string): boolean {
  return TRACKING_PARAMS.has(name) || name.toLowerCase().startsWith('utm_');
}

/**
 * How to treat the URL fragment.
 *
 * A client-side router may put the whole route in the fragment
 * (`/#/products/hats`). Stripping it would collapse an entire hash-routed SPA
 * into a single page, so the fragment sometimes IS the identity.
 *
 * - `auto` (default): a fragment starting with `/` or `!` is a route and is
 *   kept; anything else (`#pricing`) is an in-page anchor and is dropped.
 * - `always`: keep every fragment. Use when routes do not start with `/`.
 * - `never`: drop every fragment.
 */
export type HashRouting = 'auto' | 'always' | 'never';

/** A fragment that looks like a client-side route rather than an anchor. */
export function isRouteFragment(hash: string): boolean {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  return value.startsWith('/') || value.startsWith('!');
}

export function shouldKeepHash(hash: string, mode: HashRouting): boolean {
  if (hash === '' || hash === '#') return false;
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return isRouteFragment(hash);
}

export interface UrlNormalizeOptions {
  trailingSlash: 'strip' | 'keep' | 'add';
  lowercasePath: boolean;
  /**
   * When non-empty, ONLY these query parameters survive canonicalisation.
   * When empty (the default) every parameter survives except tracking ones -
   * dropping all query state by default would collapse genuinely distinct
   * pages like `/search?q=a` and `/search?q=b` into one.
   */
  queryAllowlist: readonly string[];
  dropParams: readonly string[];
  indexFileNames: readonly string[];
  /** Whether the fragment is part of the page's identity. */
  hashRouting?: HashRouting;
}

export const DEFAULT_NORMALIZE_OPTIONS: UrlNormalizeOptions = {
  trailingSlash: 'strip',
  lowercasePath: true,
  queryAllowlist: [],
  dropParams: [],
  indexFileNames: ['index.html', 'index.htm', 'default.aspx'],
  hashRouting: 'auto',
};

export interface CanonicalUrl {
  /** Canonical absolute URL (origin + path + query). Fragment always removed. */
  href: string;
  /** Origin-independent join key: `path` + normalised query. */
  key: string;
  origin: string;
  path: string;
  /** Normalised query string including the leading `?`, or `''`. */
  search: string;
  /** Kept fragment including the leading `#`, or `''` when it is an anchor. */
  hash: string;
}

/** Collapse `//` runs and strip a configured index filename. */
function normalizePathname(
  pathname: string,
  { indexFileNames, trailingSlash, lowercasePath }: UrlNormalizeOptions,
): string {
  let path = pathname.replace(/\/{2,}/g, '/');

  if (lowercasePath) path = path.toLowerCase();

  // Strip an index filename so `/about/index.html` === `/about/`.
  const lastSlash = path.lastIndexOf('/');
  const lastSegment = path.slice(lastSlash + 1);
  if (lastSegment && indexFileNames.some((n) => n.toLowerCase() === lastSegment.toLowerCase())) {
    path = path.slice(0, lastSlash + 1);
  }

  if (path === '') path = '/';

  // The site root is always exactly '/' regardless of the trailing-slash policy.
  if (path === '/') return '/';

  switch (trailingSlash) {
    case 'strip':
      return path.replace(/\/+$/, '') || '/';
    case 'add':
      return path.endsWith('/') ? path : `${path}/`;
    case 'keep':
      return path;
  }
}

/** Drop tracking/ignored params, apply the allowlist, and sort deterministically. */
function normalizeSearch(params: URLSearchParams, options: UrlNormalizeOptions): string {
  const drop = new Set(options.dropParams.map((p) => p.toLowerCase()));
  const allow = new Set(options.queryAllowlist.map((p) => p.toLowerCase()));
  const useAllowlist = allow.size > 0;

  const kept: Array<[string, string]> = [];
  for (const [name, value] of params) {
    const lower = name.toLowerCase();
    if (isTrackingParam(name) || drop.has(lower)) continue;
    if (useAllowlist && !allow.has(lower)) continue;
    kept.push([name, value]);
  }

  if (kept.length === 0) return '';

  // Sort by name then value so parameter order never creates a false duplicate.
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const out = new URLSearchParams();
  for (const [name, value] of kept) out.append(name, value);
  return `?${out.toString()}`;
}

/**
 * Reduce a URL to canonical form.
 *
 * Lowercases scheme and host, removes default ports and the fragment,
 * normalises the path, and filters + sorts the query.
 */
export function canonicalizeUrl(
  url: URL,
  options: UrlNormalizeOptions = DEFAULT_NORMALIZE_OPTIONS,
): CanonicalUrl {
  const protocol = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();

  // URL already omits the port when it is the protocol default.
  const port = url.port;
  const origin = port ? `${protocol}//${hostname}:${port}` : `${protocol}//${hostname}`;

  const path = normalizePathname(url.pathname, options);
  const search = normalizeSearch(url.searchParams, options);
  const hash = shouldKeepHash(url.hash, options.hashRouting ?? 'auto') ? url.hash : '';

  return {
    href: `${origin}${path}${search}${hash}`,
    key: `${path}${search}${hash}`,
    origin,
    path,
    search,
    hash,
  };
}

/**
 * Resolve a possibly-relative href against a page URL.
 *
 * Returns null for hrefs that are not navigable resources (`mailto:`,
 * `javascript:`, `data:`, empty, bare fragments) or that fail to parse.
 * Protocol-relative hrefs (`//host/x`) resolve against the page's scheme.
 */
export function resolveHref(
  href: string,
  pageUrl: string,
  hashRouting: HashRouting = 'auto',
): URL | null {
  const trimmed = href.trim();
  if (trimmed === '') return null;

  // `#/products` is a client-side route and must resolve to a crawlable URL;
  // `#pricing` is an in-page anchor and must not.
  if (trimmed.startsWith('#')) {
    return shouldKeepHash(trimmed, hashRouting) ? safeParse(trimmed, pageUrl) : null;
  }

  return safeParse(trimmed, pageUrl);
}

function safeParse(href: string, pageUrl: string): URL | null {
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

export type LinkClass = 'internal' | 'external' | 'mailto' | 'tel' | 'anchor' | 'unsupported';

/** Classify a raw href for the links report. Does not resolve or fetch. */
export function classifyHref(
  href: string,
  pageUrl: string,
  isAllowedOrigin: (u: URL) => boolean,
  hashRouting: HashRouting = 'auto',
): LinkClass {
  const trimmed = href.trim();
  if (trimmed === '') return 'unsupported';
  // A hash route (`#/products`) is a real destination and must be followed;
  // a bare anchor (`#pricing`) points inside the page we are already on.
  if (trimmed.startsWith('#')) {
    return shouldKeepHash(trimmed, hashRouting) ? 'internal' : 'anchor';
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('mailto:')) return 'mailto';
  if (lower.startsWith('tel:')) return 'tel';
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('about:')
  ) {
    return 'unsupported';
  }

  const resolved = resolveHref(trimmed, pageUrl, hashRouting);
  if (!resolved) return 'unsupported';

  return isAllowedOrigin(resolved) ? 'internal' : 'external';
}
