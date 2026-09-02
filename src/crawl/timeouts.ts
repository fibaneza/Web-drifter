/**
 * Per-page timeout resolution.
 *
 * Some pages are legitimately slow: a cold CMS render, a search page fronting
 * a slow upstream, a dashboard that fans out to a dozen APIs. Applying one
 * global timeout to those means the capture is cut short and the whole page is
 * reported as drift - the single most misleading kind of false positive,
 * because it looks like catastrophic content loss.
 *
 * Rather than raise the global timeout for everything (which makes a full
 * crawl crawl), slow paths get their own budget.
 */

export interface PageTimeouts {
  navigationTimeoutMs: number;
  readyTimeoutMs: number;
  quietMs: number;
  minWaitMs: number;
  awaitFirstRenderMs: number;
}

export interface SlowPageRule {
  pattern: RegExp;
  navigationTimeoutMs?: number | undefined;
  readyTimeoutMs?: number | undefined;
  quietMs?: number | undefined;
}

export interface TimeoutDefaults {
  navigationTimeoutMs: number;
  readyTimeoutMs: number;
  quietMs: number;
  minWaitMs?: number | undefined;
  awaitFirstRenderMs: number;
}

/**
 * Resolve the timeouts for one path. The first matching rule wins, so order
 * rules most-specific first.
 */
export function resolveTimeouts(
  path: string,
  defaults: TimeoutDefaults,
  slowPages: readonly SlowPageRule[] = [],
): PageTimeouts {
  const base: PageTimeouts = {
    navigationTimeoutMs: defaults.navigationTimeoutMs,
    readyTimeoutMs: defaults.readyTimeoutMs,
    quietMs: defaults.quietMs,
    minWaitMs: defaults.minWaitMs ?? defaults.quietMs,
    awaitFirstRenderMs: defaults.awaitFirstRenderMs,
  };

  const rule = slowPages.find((r) => r.pattern.test(path));
  if (!rule) return base;

  const quietMs = rule.quietMs ?? base.quietMs;
  return {
    navigationTimeoutMs: rule.navigationTimeoutMs ?? base.navigationTimeoutMs,
    readyTimeoutMs: rule.readyTimeoutMs ?? base.readyTimeoutMs,
    quietMs,
    // A longer quiet window implies a longer settle floor unless pinned.
    minWaitMs: defaults.minWaitMs ?? quietMs,
    awaitFirstRenderMs: defaults.awaitFirstRenderMs,
  };
}
