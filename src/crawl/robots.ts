import { request } from 'undici';

/**
 * Minimal robots.txt support.
 *
 * Deliberately small: this is a comparison tool pointed at sites its operator
 * owns, so the goal is to be a well-behaved client on staging infrastructure -
 * not to implement the full Robots Exclusion Protocol. It honours `Disallow`,
 * `Allow` and `Crawl-delay` for the most specific matching user-agent group.
 *
 * A legacy staging site commonly ships `Disallow: /` to keep it out of search
 * results. That would stop the crawl dead, so `respectRobotsTxt: false` is a
 * supported and often necessary setting - the operator owns both sites.
 */

export interface RobotsRules {
  /** Longest-match-wins rules, per the de-facto standard. */
  disallow: string[];
  allow: string[];
  crawlDelayMs: number;
}

export interface RobotsChecker {
  isAllowed(path: string): boolean;
  readonly crawlDelayMs: number;
  /** True when no robots.txt was found or it could not be read. */
  readonly absent: boolean;
}

const ALLOW_ALL: RobotsChecker = {
  isAllowed: () => true,
  crawlDelayMs: 0,
  absent: true,
};

export function parseRobots(text: string, userAgent = '*'): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], crawlDelayMs: 0 };
  const wanted = userAgent.toLowerCase();

  let inScope = false;
  let matchedSpecificAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      const isExact = agent === wanted;
      // A group naming us specifically supersedes the wildcard group.
      if (isExact && !matchedSpecificAgent) {
        matchedSpecificAgent = true;
        rules.disallow.length = 0;
        rules.allow.length = 0;
      }
      inScope = isExact || (agent === '*' && !matchedSpecificAgent);
      continue;
    }

    if (!inScope) continue;

    if (field === 'disallow' && value !== '') rules.disallow.push(value);
    else if (field === 'allow' && value !== '') rules.allow.push(value);
    else if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds > 0) rules.crawlDelayMs = seconds * 1000;
    }
  }

  return rules;
}

/** Build a checker from parsed rules. Longest matching pattern wins; ties go to Allow. */
export function createChecker(rules: RobotsRules, absent = false): RobotsChecker {
  return {
    crawlDelayMs: rules.crawlDelayMs,
    absent,
    isAllowed(path: string): boolean {
      const longestAllow = longestMatch(rules.allow, path);
      const longestDisallow = longestMatch(rules.disallow, path);
      if (longestDisallow === -1) return true;
      return longestAllow >= longestDisallow;
    },
  };
}

function longestMatch(patterns: readonly string[], path: string): number {
  let best = -1;
  for (const pattern of patterns) {
    if (matches(pattern, path) && pattern.length > best) best = pattern.length;
  }
  return best;
}

/** Supports the `*` wildcard and the `$` end-anchor. */
function matches(pattern: string, path: string): boolean {
  if (!pattern.includes('*') && !pattern.endsWith('$')) return path.startsWith(pattern);

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

/** Fetch and parse robots.txt. Never throws: an unreachable file allows everything. */
export async function fetchRobots(baseUrl: string, userAgent = '*'): Promise<RobotsChecker> {
  try {
    const url = new URL('/robots.txt', baseUrl).href;
    const response = await request(url, {
      method: 'GET',
      headersTimeout: 5000,
      bodyTimeout: 5000,
    });

    if (response.statusCode !== 200) {
      response.body.dump().catch(() => undefined);
      return ALLOW_ALL;
    }
    return createChecker(parseRobots(await response.body.text(), userAgent));
  } catch {
    return ALLOW_ALL;
  }
}

export { ALLOW_ALL as allowAllRobots };
