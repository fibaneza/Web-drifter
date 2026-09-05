/**
 * The SPA readiness gate.
 *
 * Playwright's `networkidle` is the obvious choice and the wrong one for a
 * React app: analytics beacons, long-poll connections, websockets and
 * background refresh timers mean the network may never be idle for 500ms, so
 * the wait either times out or fires at an arbitrary moment. Capturing a
 * half-hydrated page produces spectacular false positives.
 *
 * What reliably indicates "this page has finished rendering" is **DOM
 * quiescence**: the document stopped changing. This gate waits for all of:
 *
 *   - `document.readyState === 'complete'`
 *   - web fonts resolved (otherwise text metrics shift under us)
 *   - no in-flight `fetch`/XHR started by the page
 *   - no DOM mutation for `quietMs`
 *   - no request activity for `quietMs`
 *
 * Instrumentation is installed by {@link readinessInitScript} before any site
 * script runs, and measures with `performance.now()` so a pinned `Date` cannot
 * distort it.
 */

import type { Page } from 'playwright';
import { DRIFTER_GLOBAL } from './stabilize.js';

export interface ReadinessOptions {
  quietMs: number;
  timeoutMs: number;
  /**
   * Minimum time to wait after the load event before the page may be declared
   * ready, even if it has been perfectly quiet throughout.
   *
   * Quiescence alone cannot distinguish "finished rendering" from "has not
   * started yet": a framework that begins hydrating 400ms after load looks
   * identical to a static page for those first 400ms. This floor gives late
   * starters a chance to touch the DOM before we decide. Defaults to `quietMs`.
   */
  minWaitMs?: number;
  /**
   * How long to wait after load for the page to render something, when it has
   * not mutated the DOM at all since load.
   *
   * A client-side router fetches, then renders - so for a while after load the
   * page shows a placeholder and is perfectly quiet. Quiescence alone declares
   * that "settled" and captures "Loading...", which is then reported as total
   * content loss (or, worse, makes two different routes hash identically and
   * one gets discarded as a duplicate).
   *
   * Waiting for the first post-load mutation fixes that. The cost is paid only
   * by pages that never mutate - a fully server-rendered page waits this long
   * once - so set it to 0 for a purely static site.
   */
  awaitFirstRenderMs?: number;
  /**
   * A visible element that proves the route content, rather than its shell,
   * has rendered. This is deliberately optional: static pages and React apps
   * that mutate once with their real content do not need an implementation
   * hint, while a skeleton-first app can opt in without globally slowing down
   * the legacy side.
   */
  readySelector?: string | undefined;
  /** How often to re-check. */
  pollMs?: number;
}

export interface ReadinessResult {
  ready: boolean;
  waitedMs: number;
  /** When not ready, the condition still unsatisfied at timeout. */
  blockedBy: string | null;
}

interface ProbeResult {
  ready: boolean;
  blockedBy: string | null;
}

/** Evaluated in the page; returns which readiness condition is unsatisfied. */
function probe(
  quietMs: number,
  minWaitMs: number,
  awaitFirstRenderMs: number,
  readySelector: string | null,
  globalName: string,
): ProbeResult {
  if (document.readyState !== 'complete') {
    return { ready: false, blockedBy: `readyState=${document.readyState}` };
  }

  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts && fonts.status !== 'loaded') {
    return { ready: false, blockedBy: `fonts=${fonts.status}` };
  }

  if (readySelector !== null) {
    let element: Element | null;
    try {
      element = document.querySelector(readySelector);
    } catch {
      // Keep the invalid selector in the diagnostic. The caller records the
      // timeout as a snapshot error rather than failing an entire crawl over a
      // single misconfigured path.
      return { ready: false, blockedBy: `readySelector is invalid: ${readySelector}` };
    }

    if (element === null) {
      return { ready: false, blockedBy: `readySelector not found: ${readySelector}` };
    }

    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.contentVisibility === 'hidden' ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      return { ready: false, blockedBy: `readySelector is not visible: ${readySelector}` };
    }
  }

  const state = (window as unknown as Record<string, unknown>)[globalName] as
    | {
        inflight: number;
        lastMutationAt: number;
        lastRequestAt: number;
        loadAt: number | null;
        mutationCount: number;
        mutationsAtLoad: number;
      }
    | undefined;

  // No instrumentation (e.g. a document that replaced the global): readyState
  // and fonts are the best signal available, so accept them.
  if (!state) return { ready: true, blockedBy: null };

  if (state.inflight > 0) {
    return { ready: false, blockedBy: `inflight=${state.inflight}` };
  }

  const now = performance.now();

  // Give a late-starting framework its chance to touch the DOM.
  if (state.loadAt === null) {
    return { ready: false, blockedBy: 'load event not fired' };
  }
  const sinceLoad = now - state.loadAt;
  if (sinceLoad < minWaitMs) {
    return { ready: false, blockedBy: `settling (${Math.round(sinceLoad)}/${minWaitMs}ms)` };
  }

  // The page has been quiet since load - but a client-side router that has not
  // rendered yet looks exactly the same as a finished static page. Give it a
  // bounded chance to touch the DOM before believing it is done.
  const renderedSinceLoad = state.mutationCount > state.mutationsAtLoad;
  if (!renderedSinceLoad && sinceLoad < awaitFirstRenderMs) {
    return {
      ready: false,
      blockedBy: `awaiting first render (${Math.round(sinceLoad)}/${awaitFirstRenderMs}ms)`,
    };
  }
  const sinceMutation = now - state.lastMutationAt;
  if (sinceMutation < quietMs) {
    return { ready: false, blockedBy: `dom-mutated ${Math.round(sinceMutation)}ms ago` };
  }

  const sinceRequest = now - state.lastRequestAt;
  if (sinceRequest < quietMs) {
    return { ready: false, blockedBy: `request ${Math.round(sinceRequest)}ms ago` };
  }

  return { ready: true, blockedBy: null };
}

/**
 * Wait until the page settles.
 *
 * Never throws: a timeout returns `ready: false` with the blocking condition,
 * because a slow page is still worth capturing - the caller records it as a
 * non-fatal snapshot error so the report can flag lower confidence.
 */
export async function waitForReady(
  page: Page,
  {
    quietMs,
    timeoutMs,
    minWaitMs = quietMs,
    awaitFirstRenderMs = 1000,
    readySelector,
    pollMs = 100,
  }: ReadinessOptions,
): Promise<ReadinessResult> {
  const started = Date.now();
  let blockedBy: string | null = 'not yet evaluated';

  while (Date.now() - started < timeoutMs) {
    let result: ProbeResult;
    try {
      result = await page.evaluate<ProbeResult, [number, number, number, string | null, string]>(
        ([quiet, minWait, firstRender, selector, globalName]) => {
          // Installed by probeInitScript; see `probe` above for the source.
          return (
            window as unknown as {
              __drifterProbe: (
                q: number,
                m: number,
                r: number,
                s: string | null,
                g: string,
              ) => ProbeResult;
            }
          ).__drifterProbe(quiet, minWait, firstRender, selector, globalName);
        },
        [quietMs, minWaitMs, awaitFirstRenderMs, readySelector ?? null, DRIFTER_GLOBAL],
      );
    } catch {
      // Navigation raced us (client-side route change). Retry.
      await sleep(pollMs);
      continue;
    }

    if (result.ready) {
      return { ready: true, waitedMs: Date.now() - started, blockedBy: null };
    }
    blockedBy = result.blockedBy;
    await sleep(pollMs);
  }

  return { ready: false, waitedMs: Date.now() - started, blockedBy };
}

/** Init script exposing {@link probe} inside the page. */
export function probeInitScript(): string {
  return `(() => {
  if (window.__drifterProbe) return;
  window.__drifterProbe = ${probe.toString()};
})();`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
