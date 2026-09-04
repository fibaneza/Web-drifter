import type { Region } from '../core/types.js';

/**
 * Landmark inference for markup that has no landmarks.
 *
 * Alignment is partitioned by region before anything else, so a footer
 * paragraph can never be matched against a body paragraph. That guarantee is
 * only as good as the region assignment - and `regionOf` recognises just ARIA
 * roles and HTML5 sectioning elements.
 *
 * A migration is exactly where that breaks. The rewrite emits `<header>`,
 * `<main>` and `<footer>`; the CMS it replaces emits `<div class="sc-header">`
 * and nothing else. Every legacy node then lands in `other` while every target
 * node lands in a real region, alignment never crosses a region, and a perfect
 * migration reports as total content loss on both sides at once.
 *
 * So when a page declares no landmarks at all, region is inferred from `id` and
 * `class` instead. The rules live here rather than in the in-page extractor for
 * two reasons: they are the part worth testing, and the extractor must stay
 * self-contained, so it receives them as data.
 */

export interface RegionHint {
  region: Region;
  /** Regex source, applied to the element's space-separated identity tokens. */
  pattern: string;
}

/**
 * Ordered most-specific first. The first hint to match an element wins, which
 * is what makes `class="footer-content"` a footer rather than main content.
 *
 * Short words are matched as whole tokens (`main`, never `domain`); longer
 * distinctive ones also match as substrings, so `siteFooter` and `sc-footer`
 * both resolve without enumerating every naming convention in existence.
 */
export const DEFAULT_REGION_HINTS: readonly RegionHint[] = [
  { region: 'nav', pattern: '(^| )(nav|navbar|menu|topnav|mainnav)( |$)|navigation|breadcrumb' },
  { region: 'footer', pattern: '(^| )(footer|foot)( |$)|footer|colophon' },
  { region: 'aside', pattern: '(^| )(aside|rail|secondary)( |$)|sidebar|complementary' },
  { region: 'header', pattern: '(^| )(header|banner|topbar)( |$)|header|masthead' },
  { region: 'main', pattern: '(^| )(main|content|body|primary|article)( |$)|maincontent' },
];

/**
 * An element's identity, as the hints expect it.
 *
 * Non-alphanumerics become spaces so `sc-header`, `sc_header` and `scHeader`
 * (lowercased to `scheader`) all present their words for matching.
 */
export function identityTokens(className: string, id: string): string {
  return `${className} ${id}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Reference implementation of the hint match.
 *
 * The in-page extractor applies the same patterns in the same order; this
 * exists so the rules can be asserted without a browser. Keep the two in step -
 * the patterns are shared, so only the three lines of matching can drift.
 */
export function regionFromIdentity(
  className: string,
  id: string,
  hints: readonly RegionHint[] = DEFAULT_REGION_HINTS,
): Region | null {
  const identity = identityTokens(className, id);
  if (identity === '') return null;

  for (const hint of hints) {
    if (new RegExp(hint.pattern).test(identity)) return hint.region;
  }
  return null;
}
