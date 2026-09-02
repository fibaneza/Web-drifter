import pLimit from 'p-limit';
import { request } from 'undici';

/**
 * HTTP link checking.
 *
 * Two details matter more than they look.
 *
 * **HEAD then GET.** HEAD is the right request - it avoids downloading a body
 * we will not read - but a surprising number of servers, CDNs and WAFs reject
 * it with 405, 403 or 501 while serving the same URL happily over GET.
 * Treating those as broken links would fill the report with false positives
 * pointing at perfectly working pages, so a non-2xx HEAD is retried as a GET
 * before any verdict is reached.
 *
 * **Cache by URL.** A site-wide navigation or footer links the same handful of
 * URLs from every page. Without a cache, a thousand-page crawl would issue a
 * thousand identical requests, which is both slow and rude to the server.
 */

export type LinkStatusKind = 'ok' | 'broken' | 'redirected' | 'error' | 'skipped';

export interface LinkStatus {
  url: string;
  kind: LinkStatusKind;
  /** HTTP status of the final response, or 0 when the request never completed. */
  status: number;
  /** Final URL after redirects, when it differs from the requested one. */
  finalUrl?: string;
  redirectCount: number;
  /** Failure reason for `error`: DNS failure, timeout, TLS problem. */
  reason?: string;
  timingMs: number;
}

export interface LinkCheckerOptions {
  concurrency?: number;
  timeoutMs?: number;
  /** Sent so a server can identify the traffic and an operator can allowlist it. */
  userAgent?: string;
  maxRedirects?: number;
}

export class LinkChecker {
  readonly #limit: ReturnType<typeof pLimit>;
  readonly #cache = new Map<string, Promise<LinkStatus>>();
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #maxRedirects: number;

  constructor(options: LinkCheckerOptions = {}) {
    this.#limit = pLimit(options.concurrency ?? 8);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#userAgent = options.userAgent ?? 'web-drifter link checker';
    this.#maxRedirects = options.maxRedirects ?? 5;
  }

  /** Check a URL, reusing an in-flight or completed result for the same URL. */
  check(url: string): Promise<LinkStatus> {
    const cached = this.#cache.get(url);
    if (cached) return cached;

    const pending = this.#limit(() => this.#perform(url));
    this.#cache.set(url, pending);
    return pending;
  }

  get checkedCount(): number {
    return this.#cache.size;
  }

  async #perform(url: string): Promise<LinkStatus> {
    const started = Date.now();

    const head = await this.#send(url, 'HEAD');
    // A rejected HEAD says nothing about whether the page exists.
    if (head.kind === 'ok' || head.kind === 'redirected') {
      return { ...head, timingMs: Date.now() - started };
    }
    if (head.kind === 'error' || methodLikelyUnsupported(head.status)) {
      const get = await this.#send(url, 'GET');
      return { ...get, timingMs: Date.now() - started };
    }

    return { ...head, timingMs: Date.now() - started };
  }

  async #send(url: string, method: 'HEAD' | 'GET'): Promise<Omit<LinkStatus, 'timingMs'>> {
    try {
      const response = await request(url, {
        method,
        headers: { 'user-agent': this.#userAgent, accept: '*/*' },
        headersTimeout: this.#timeoutMs,
        bodyTimeout: this.#timeoutMs,
        maxRedirections: this.#maxRedirects,
      });

      // The body must be consumed or the connection is never released back to
      // the pool, and a long crawl would eventually stall on socket exhaustion.
      await response.body.dump();

      const redirectCount = countRedirects(response.context);
      const finalUrl = finalUrlOf(response.context) ?? url;
      const status = response.statusCode;

      if (status >= 200 && status < 300) {
        return redirectCount > 0
          ? { url, kind: 'redirected', status, finalUrl, redirectCount }
          : { url, kind: 'ok', status, redirectCount: 0 };
      }
      return { url, kind: 'broken', status, finalUrl, redirectCount };
    } catch (error) {
      return {
        url,
        kind: 'error',
        status: 0,
        redirectCount: 0,
        reason: describeNetworkError(error),
      };
    }
  }
}

/** Status codes that mean "not this method", rather than "not this URL". */
function methodLikelyUnsupported(status: number): boolean {
  return status === 400 || status === 403 || status === 405 || status === 501;
}

interface UndiciContext {
  history?: URL[];
}

function countRedirects(context: unknown): number {
  const history = (context as UndiciContext | undefined)?.history;
  return Array.isArray(history) ? Math.max(0, history.length - 1) : 0;
}

function finalUrlOf(context: unknown): string | undefined {
  const history = (context as UndiciContext | undefined)?.history;
  return Array.isArray(history) ? history.at(-1)?.toString() : undefined;
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOTFOUND':
      return 'DNS lookup failed';
    case 'ECONNREFUSED':
      return 'connection refused';
    case 'ECONNRESET':
      return 'connection reset';
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'timed out';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `TLS error (${code})`;
    default:
      return code ? `${code}: ${error.message}` : error.message;
  }
}
