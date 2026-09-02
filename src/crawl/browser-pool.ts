import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { DeviceProfile } from '../config/devices.js';
import { BrowserError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

/**
 * Locate a usable Chromium binary.
 *
 * Playwright pins an exact browser revision per release, so a CI image that
 * ships its own browser build (or a slightly older one) makes Playwright's
 * default lookup fail even though a perfectly good Chromium is present. Rather
 * than downloading a second copy on every run, fall back to whatever is on
 * disk, in order of decreasing explicitness:
 *
 *   1. `browser.executablePath` in the config
 *   2. `DRIFTER_CHROMIUM_EXECUTABLE`
 *   3. Playwright's own resolution, when that path actually exists
 *   4. Any `chromium-*` build under `PLAYWRIGHT_BROWSERS_PATH`
 *
 * Returns undefined to mean "let Playwright decide".
 */
export function resolveChromiumExecutable(explicit?: string): string | undefined {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new BrowserError(`Configured Chromium executable does not exist: ${explicit}`);
    }
    return explicit;
  }

  const fromEnv = process.env['DRIFTER_CHROMIUM_EXECUTABLE'];
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new BrowserError(`DRIFTER_CHROMIUM_EXECUTABLE does not exist: ${fromEnv}`);
    }
    return fromEnv;
  }

  try {
    const preferred = chromium.executablePath();
    if (preferred && existsSync(preferred)) return undefined; // Playwright is happy.
  } catch {
    // Not installed through Playwright at all - fall through to the scan.
  }

  const discovered = scanForChromium(process.env['PLAYWRIGHT_BROWSERS_PATH']);
  if (discovered) return discovered;

  return undefined;
}

/** Look for `<root>/chromium-<rev>/chrome-linux[64]/chrome` and platform equivalents. */
function scanForChromium(root: string | undefined): string | undefined {
  if (!root || !existsSync(root)) return undefined;

  const candidateSuffixes = [
    join('chrome-linux', 'chrome'),
    join('chrome-linux64', 'chrome'),
    join('chrome-win', 'chrome.exe'),
    join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ];

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }

  // Prefer a full chromium build over the headless shell, and newer revisions first.
  const builds = entries
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1] ?? 0) - Number(a.split('-')[1] ?? 0));

  for (const build of builds) {
    for (const suffix of candidateSuffixes) {
      const candidate = join(root, build, suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface BrowserPoolOptions {
  headless: boolean;
  executablePath?: string | undefined;
  args: readonly string[];
  ignoreHttpsErrors: boolean;
  locale: string;
  timezoneId: string;
  extraHeaders: Record<string, string>;
  logger: Logger;
}

/**
 * Owns the browser and one {@link BrowserContext} per device profile.
 *
 * Contexts are reused across pages because creating one per page is
 * significantly slower and the crawl is read-only, so there is no cookie state
 * worth isolating. Pages themselves are created and closed per capture.
 */
export class BrowserPool {
  readonly #browser: Browser;
  readonly #options: BrowserPoolOptions;
  readonly #contexts = new Map<string, BrowserContext>();
  /** Init scripts applied to every new context, in registration order. */
  readonly #initScripts: string[] = [];
  /** Hosts whose requests are aborted (analytics, ads, chat widgets). */
  #blockedHosts: readonly string[] = [];

  private constructor(browser: Browser, options: BrowserPoolOptions) {
    this.#browser = browser;
    this.#options = options;
  }

  static async launch(options: BrowserPoolOptions): Promise<BrowserPool> {
    const executablePath = resolveChromiumExecutable(options.executablePath);
    if (executablePath) {
      options.logger.debug({ executablePath }, 'using discovered Chromium binary');
    }

    try {
      const browser = await chromium.launch({
        headless: options.headless,
        args: [...options.args],
        ...(executablePath ? { executablePath } : {}),
      });
      return new BrowserPool(browser, options);
    } catch (cause) {
      throw new BrowserError(
        'Could not launch Chromium. Install it with `npx playwright install chromium`, ' +
          'or point DRIFTER_CHROMIUM_EXECUTABLE at an existing binary.',
        { cause },
      );
    }
  }

  /** Register a script evaluated in every page before any site script runs. */
  addInitScript(script: string): void {
    this.#initScripts.push(script);
  }

  setBlockedHosts(hosts: readonly string[]): void {
    this.#blockedHosts = hosts;
  }

  /** Get (creating on first use) the context for a device profile. */
  async context(profile: DeviceProfile): Promise<BrowserContext> {
    const existing = this.#contexts.get(profile.id);
    if (existing) return existing;

    const context = await this.#browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: profile.deviceScaleFactor,
      isMobile: profile.isMobile,
      hasTouch: profile.hasTouch,
      locale: this.#options.locale,
      timezoneId: this.#options.timezoneId,
      ignoreHTTPSErrors: this.#options.ignoreHttpsErrors,
      // Suppresses carousels, parallax and entrance animations at the source.
      reducedMotion: 'reduce',
      ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
      ...(Object.keys(this.#options.extraHeaders).length > 0
        ? { extraHTTPHeaders: this.#options.extraHeaders }
        : {}),
    });

    for (const script of this.#initScripts) {
      await context.addInitScript({ content: script });
    }

    if (this.#blockedHosts.length > 0) {
      const blocked = this.#blockedHosts;
      await context.route('**/*', (route) => {
        const host = safeHostname(route.request().url());
        const isBlocked =
          host !== null && blocked.some((b) => host === b || host.endsWith(`.${b}`));
        return isBlocked ? route.abort() : route.continue();
      });
    }

    this.#contexts.set(profile.id, context);
    return context;
  }

  async newPage(profile: DeviceProfile): Promise<Page> {
    const context = await this.context(profile);
    return context.newPage();
  }

  async close(): Promise<void> {
    for (const context of this.#contexts.values()) {
      await context.close().catch(() => undefined);
    }
    this.#contexts.clear();
    await this.#browser.close().catch(() => undefined);
  }
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
