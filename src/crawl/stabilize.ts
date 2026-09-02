/**
 * Page stabilisation.
 *
 * Real sites are non-deterministic: animations mid-flight, carousels on a
 * timer, A/B buckets from `Math.random`, rendered timestamps, lazily-loaded
 * images. Capture the same page twice without stabilising and the two
 * snapshots differ - which would drown every real finding in noise.
 *
 * Everything here is applied identically to source and target, so it can only
 * remove noise, never introduce a difference between the two sides.
 */

import type { Page } from 'playwright';

export interface StabilizationOptions {
  quietMs: number;
  readyTimeoutMs: number;
  freezeAnimations: boolean;
  freezeClock: boolean;
  fixedTime: string;
  seedRandom: boolean;
  randomSeed: number;
  scrollThroughPage: boolean;
}

/** Global the instrumentation hangs off. Deliberately unlikely to collide. */
export const DRIFTER_GLOBAL = '__drifterReadiness';

/**
 * Shim for bundler name-preservation helpers.
 *
 * Functions handed to `page.evaluate` are serialised with `Function.prototype
 * .toString()` and re-evaluated inside the browser. Bundlers that preserve
 * function names (esbuild, and therefore tsx and vitest) rewrite named function
 * expressions to call an injected `__name` helper - which exists in the Node
 * module scope but NOT in the page, so the serialised function dies with
 * "ReferenceError: __name is not defined".
 *
 * Defining an identity `__name` in the page makes the injected call harmless.
 * It is a no-op for a plain `tsc` build, which emits no such helper, so this is
 * safe to install unconditionally rather than only in development.
 */
export function bundlerShimInitScript(): string {
  return `(() => {
  if (typeof globalThis.__name !== 'function') {
    globalThis.__name = (target) => target;
  }
})();`;
}

/**
 * Instrumentation for the readiness gate.
 *
 * Registered FIRST so it captures the pristine `fetch` / `XMLHttpRequest`
 * before any site code (or later init script) can wrap them.
 *
 * Timing uses `performance.now()`, never `Date.now()`, because the clock script
 * below rewrites `Date` - measuring quiet periods with a rewritten clock would
 * be self-defeating.
 */
export function readinessInitScript(): string {
  return `(() => {
  if (window.${DRIFTER_GLOBAL}) return;
  const state = {
    inflight: 0,
    lastMutationAt: performance.now(),
    lastRequestAt: performance.now(),
    observing: false,
    // Null until the load event fires. The readiness gate measures its minimum
    // settle window from here, not from script injection, so an app that
    // starts rendering shortly after load is not mistaken for a settled page.
    loadAt: null,
    mutationCount: 0,
    // Snapshot of mutationCount when load fired. Parsing the document itself
    // generates mutations, so only those AFTER load indicate that client-side
    // rendering has actually begun.
    mutationsAtLoad: 0,
  };
  window.${DRIFTER_GLOBAL} = state;

  const markLoaded = () => {
    state.loadAt = performance.now();
    state.mutationsAtLoad = state.mutationCount;
  };
  if (document.readyState === 'complete') markLoaded();
  else window.addEventListener('load', markLoaded, { once: true });

  const touchRequest = () => { state.lastRequestAt = performance.now(); };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      state.inflight += 1;
      touchRequest();
      return originalFetch.apply(this, args).finally(() => {
        state.inflight -= 1;
        touchRequest();
      });
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    window.XMLHttpRequest = function () {
      const xhr = new OriginalXHR();
      let counted = false;
      xhr.addEventListener('loadstart', () => {
        if (counted) return;
        counted = true;
        state.inflight += 1;
        touchRequest();
      });
      const settle = () => {
        if (!counted) return;
        counted = false;
        state.inflight -= 1;
        touchRequest();
      };
      xhr.addEventListener('loadend', settle);
      return xhr;
    };
    window.XMLHttpRequest.prototype = OriginalXHR.prototype;
  }

  // Observe the Document node itself, NOT document.documentElement. Parsing a
  // navigation (and document.open/write) REPLACES documentElement, which would
  // leave an observer bound to a detached node - silently reporting every page
  // as permanently quiet and defeating the whole readiness gate. The Document
  // node survives, so an observer on it keeps seeing the live tree.
  const startObserving = () => {
    if (state.observing) return;
    state.observing = true;
    new MutationObserver(() => {
      state.lastMutationAt = performance.now();
      state.mutationCount += 1;
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  };

  startObserving();
})();`;
}

/**
 * Pin the clock epoch.
 *
 * NOTE this deliberately does NOT stop time. A hard freeze (`Date.now()`
 * always returning one value) hangs any code that polls for time to advance -
 * spinners, debounces, animation loops - which would prevent the page ever
 * going quiet. Instead the epoch is pinned and time advances normally from it,
 * so a page rendering a date or a time-to-minute is stable across runs while
 * time-dependent code still makes progress.
 *
 * `performance.now()` is left untouched: the readiness gate measures with it.
 */
export function clockInitScript(fixedTimeIso: string): string {
  const fixed = Date.parse(fixedTimeIso);
  return `(() => {
  const FIXED = ${Number.isFinite(fixed) ? fixed : 0};
  const RealDate = Date;
  const started = performance.now();
  const currentTime = () => FIXED + Math.floor(performance.now() - started);

  class PinnedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(currentTime());
      else super(...args);
    }
    static now() { return currentTime(); }
  }
  PinnedDate.parse = RealDate.parse;
  PinnedDate.UTC = RealDate.UTC;
  window.Date = PinnedDate;
})();`;
}

/** Replace `Math.random` with a seeded PRNG so A/B bucketing is reproducible. */
export function randomInitScript(seed: number): string {
  return `(() => {
  // mulberry32: tiny, fast, good enough distribution for bucketing.
  let a = ${seed >>> 0};
  Math.random = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;
}

/**
 * Kill animations and transitions.
 *
 * Injected as an init script that installs the stylesheet as soon as the
 * document exists, so an entrance animation cannot already be mid-flight by
 * the time we would otherwise add a style tag.
 */
export const FREEZE_STYLE_ID = 'drifter-freeze';

/** Snaps animations and transitions to their end state instead of running them. */
export const FREEZE_CSS = `*,*::before,*::after{
  animation-delay:-1ms!important;
  animation-duration:1ms!important;
  animation-iteration-count:1!important;
  transition-delay:0s!important;
  transition-duration:0s!important;
  scroll-behavior:auto!important;
  caret-color:transparent!important;
}`;

export function animationInitScript(): string {
  const css = FREEZE_CSS;
  return `(() => {
  const install = () => {
    if (document.getElementById('${FREEZE_STYLE_ID}')) return;
    const style = document.createElement('style');
    style.id = '${FREEZE_STYLE_ID}';
    style.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.head || document.documentElement) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
})();`;
}

/** All init scripts, in the order they must be registered. */
export function buildInitScripts(options: StabilizationOptions): string[] {
  // Shim first: everything after it may itself be bundler-transformed.
  // Readiness second: it must capture the untouched fetch/XHR.
  const scripts = [bundlerShimInitScript(), readinessInitScript()];
  if (options.freezeAnimations) scripts.push(animationInitScript());
  if (options.seedRandom) scripts.push(randomInitScript(options.randomSeed));
  // Clock last: it rewrites Date, which nothing above depends on.
  if (options.freezeClock) scripts.push(clockInitScript(options.fixedTime));
  return scripts;
}

/**
 * Scroll to the bottom and back to the top to trigger lazy-loaded content.
 *
 * Without this, everything below the fold is missing from the model on both
 * sides - and worse, missing *inconsistently*, since the two sites lazy-load
 * at different scroll offsets.
 */
export async function scrollThroughPage(page: Page, stepPx = 800): Promise<void> {
  await page.evaluate(async (step: number) => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const maxScroll = (): number =>
      Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight) -
      window.innerHeight;

    let position = 0;
    // Bounded so a page that grows as you scroll (infinite feed) still ends.
    for (let i = 0; i < 100 && position < maxScroll(); i += 1) {
      position += step;
      window.scrollTo(0, position);
      await sleep(50);
    }
    window.scrollTo(0, 0);
    await sleep(50);
  }, stepPx);
}

/** Force every lazy `<img>` to load, and wait for decoding to finish. */
export async function settleImages(page: Page, timeoutMs = 5000): Promise<void> {
  await page
    .evaluate(async (timeout: number) => {
      const images = [...document.images];
      for (const img of images) {
        if (img.loading === 'lazy') img.loading = 'eager';
      }
      const pending = images
        .filter((img) => !img.complete)
        .map(
          (img) =>
            new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }),
        );
      const timer = new Promise<void>((resolve) => setTimeout(resolve, timeout));
      await Promise.race([Promise.all(pending), timer]);
    }, timeoutMs)
    .catch(() => undefined);
}

/**
 * Re-inject the freeze stylesheet after navigation.
 *
 * The init-script copy is a best-effort early guard, but it does not survive
 * the document being parsed (or replaced): the browser builds a fresh document
 * and the injected `<style>` goes with the old one.
 *
 * This only prevents animations that have not started yet. Anything already
 * running needs {@link settleAnimations} - per the CSS Transitions spec, a
 * running transition keeps the timing it captured when it started, so lowering
 * `transition-duration` afterwards does not cancel it.
 */
export async function applyFreezeStyles(page: Page): Promise<void> {
  await page.addStyleTag({ content: FREEZE_CSS }).catch(() => undefined);
}

/**
 * Snap in-flight CSS transitions and animations to their end state.
 *
 * Uses the Web Animations API, which exposes CSS transitions and animations as
 * `Animation` objects. Finishing them jumps straight to the final computed
 * value, so a capture cannot land mid-transition and report a half-slid panel
 * or a partly-faded colour as drift.
 *
 * Infinite animations (spinners, marquees) cannot be finished, so they are
 * paused at time zero instead - deterministic, and the same on both sides.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const animations =
        typeof document.getAnimations === 'function' ? document.getAnimations() : [];
      for (const animation of animations) {
        try {
          const iterations = animation.effect?.getTiming().iterations ?? 1;
          if (iterations === Infinity) {
            animation.pause();
            animation.currentTime = 0;
          } else {
            animation.finish();
          }
        } catch {
          // An animation may be cancelled or detached between listing and use.
        }
      }
    })
    .catch(() => undefined);
}

/**
 * The full post-navigation stabilisation sequence, in the order that matters:
 * freeze first so nothing new starts, then settle whatever is already running.
 */
export async function stabilizeAfterNavigation(page: Page): Promise<void> {
  await applyFreezeStyles(page);
  await settleAnimations(page);
}
