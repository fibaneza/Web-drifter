import { groupOf } from '../extract/css-properties.js';
import type { BoxGeometry, Finding, FindingCategory } from '../core/types.js';

/**
 * Which findings belong on a page-level visual map.
 *
 * The question this answers is not "did something change" - the comparison
 * already decided that - but "would a person looking at the rendered page see
 * it". Three things are therefore excluded on purpose:
 *
 *  - **Typography.** A font-size or letter-spacing difference is real drift and
 *    belongs in the CSS report, but boxing every text node on the page buries
 *    the handful of differences someone can actually point at.
 *  - **Markup annotation.** `alt` text, link targets, meta fields. Invisible in
 *    a screenshot by definition, so a box over them means nothing.
 *  - **Sub-perceptual movement.** A box that shifted a pixel or two is noise on
 *    any real migration; see {@link DEFAULT_MIN_SHIFT_PX}.
 */

/** Movement below this, in CSS pixels, is not worth marking. */
export const DEFAULT_MIN_SHIFT_PX = 8;

/**
 * Boxes smaller than this, in CSS pixels squared, are not worth marking.
 *
 * Roughly a 9x9 element. Below that the marker is larger than the thing it
 * points at, and a page of such markers reads as damage rather than as a map.
 */
export const DEFAULT_MIN_AREA_PX = 80;

/** Categories that describe something a viewer can see on the page. */
const VISUAL_CATEGORIES: ReadonlySet<FindingCategory> = new Set<FindingCategory>([
  'content.drift',
  // A fee, date, contact detail, negation or obligation that moved is the
  // content change a reviewer most needs to see in context.
  'content.value-drift',
  'content.missing',
  'content.added',
  'content.order-changed',
  'image.missing',
  'image.added',
  'image.size-drift',
  'price.value-drift',
  'price.currency-drift',
  // Format drift is rendered text - "$1,299.00" against "$1299" is visible.
  'price.format-drift',
  'price.missing',
  'price.added',
  'css.visibility-drift',
  'css.responsive-visibility-drift',
  'css.layout-drift',
  'css.property-drift',
]);

/**
 * Computed properties whose drift shows up as a change in appearance.
 *
 * `color` covers text, background, border and outline colour; `effects` covers
 * shadows, gradients, transforms and filters. Typography is excluded by intent,
 * and box spacing is excluded because the same difference already arrives as
 * `css.layout-drift` with a box to point at.
 */
const VISIBLE_CSS_GROUPS = new Set(['color', 'effects']);

/** Properties in a visible group that still cannot be seen in a screenshot. */
const UNPHOTOGRAPHABLE = new Set(['cursor']);

export interface VisualFilterOptions {
  minShiftPx?: number | undefined;
  minAreaPx?: number | undefined;
}

/** Read a geometry box out of a finding's details. */
export function boxOf(finding: Finding, key: 'sourceBox' | 'targetBox'): BoxGeometry | null {
  const raw = finding.details?.[key];
  if (raw === null || typeof raw !== 'object') return null;

  const box = raw as Partial<BoxGeometry>;
  if (
    typeof box.x !== 'number' ||
    typeof box.y !== 'number' ||
    typeof box.width !== 'number' ||
    typeof box.height !== 'number'
  ) {
    return null;
  }
  if (box.width <= 0 || box.height <= 0) return null;
  return box as BoxGeometry;
}

/** Largest of the four edge movements between two boxes, in CSS pixels. */
export function boxShift(source: BoxGeometry | null, target: BoxGeometry | null): number {
  if (!source || !target) return Number.POSITIVE_INFINITY;
  return Math.max(
    Math.abs(source.x - target.x),
    Math.abs(source.y - target.y),
    Math.abs(source.width - target.width),
    Math.abs(source.height - target.height),
  );
}

/**
 * Is this finding worth drawing a box for?
 *
 * A finding with no geometry on either side is not rejected as uninteresting -
 * there is simply nowhere to put the marker.
 */
export function isVisualMark(finding: Finding, options: VisualFilterOptions = {}): boolean {
  if (!VISUAL_CATEGORIES.has(finding.category)) return false;

  if (finding.category === 'css.property-drift') {
    const property = finding.facet ?? '';
    if (UNPHOTOGRAPHABLE.has(property)) return false;
    if (!VISIBLE_CSS_GROUPS.has(groupOf(property))) return false;
  }

  const source = boxOf(finding, 'sourceBox');
  const target = boxOf(finding, 'targetBox');
  if (!source && !target) return false;

  const minArea = options.minAreaPx ?? DEFAULT_MIN_AREA_PX;
  const largest = Math.max(area(source), area(target));
  if (largest < minArea) return false;

  // Only movement is thresholded. A colour change on a stationary element has a
  // shift of zero and must still be marked.
  if (finding.category === 'css.layout-drift') {
    return boxShift(source, target) >= (options.minShiftPx ?? DEFAULT_MIN_SHIFT_PX);
  }

  return true;
}

function area(box: BoxGeometry | null): number {
  return box ? box.width * box.height : 0;
}

/** Findings worth marking, most serious first, capped. */
export function selectVisualMarks(
  findings: readonly Finding[],
  options: VisualFilterOptions & { max?: number | undefined } = {},
): Finding[] {
  const severityRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  return findings
    .filter((finding) => isVisualMark(finding, options))
    .sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3))
    .slice(0, options.max ?? Number.POSITIVE_INFINITY);
}
