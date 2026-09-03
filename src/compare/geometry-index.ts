import type { BoxGeometry, ContentNode, PageSnapshot } from '../core/types.js';

/**
 * Where each content node sits on the rendered page.
 *
 * This is what lets a text or price finding carry a screenshot. The crop is cut
 * from the stored full-page capture using this box, so evidence always shows the
 * element that was actually compared - re-navigating at report time would render
 * a different page (a rotated carousel, a ticked clock) and, because the two
 * sites share no markup, there is no stable selector to re-find the element
 * with anyway.
 *
 * Keyed by region as well as node identity. `ContentNode.ordinal` counts within
 * `region|key` (see `src/extract/page-model.ts`), so `key#ordinal` alone is
 * ambiguous: a "Home" link in the nav and one in the footer are both ordinal 0.
 * Cropping the wrong one is worse than cropping nothing, since a reviewer trusts
 * what the picture shows.
 */

export type GeometryIndex = ReadonlyMap<string, BoxGeometry>;

/** Region-qualified node identity. */
export function geometryKey(node: Pick<ContentNode, 'region' | 'key' | 'ordinal'>): string {
  return `${node.region}|${node.key}#${node.ordinal}`;
}

/**
 * Box per content node at one viewport.
 *
 * Keyed by region-qualified node identity, matching how the style comparator
 * resolves a node. Works at any viewport: each viewport runs its own extraction,
 * so there is no positional correspondence with the primary viewport's content
 * to rely on.
 */
export function buildGeometryIndex(snapshot: PageSnapshot, viewport: string): GeometryIndex {
  const index = new Map<string, BoxGeometry>();

  const capture = snapshot.viewports.find((entry) => entry.viewport === viewport);
  if (!capture) return index;

  for (const style of capture.styles) {
    // A snapshot captured before styles carried a region cannot be resolved
    // unambiguously, and a box attributed to the wrong element is worse than no
    // evidence at all. Re-crawl to get evidence for those runs.
    if (style.region === undefined) continue;
    // A zero-area box cannot be cropped, and an element that is not rendered has
    // no location to point at.
    if (style.box.width <= 0 || style.box.height <= 0) continue;
    index.set(`${style.region}|${style.nodeKey}#${style.ordinal}`, style.box);
  }

  return index;
}

/**
 * Evidence geometry for one node pair, shaped for a finding's `details`.
 *
 * Both sides are optional on purpose: a node missing from the target has only a
 * source box, and the resulting one-sided crop is exactly the right evidence -
 * "here is what should be there".
 */
export function boxDetails(
  source: ContentNode | null | undefined,
  target: ContentNode | null | undefined,
  geometry: { source?: GeometryIndex | undefined; target?: GeometryIndex | undefined },
): Record<string, BoxGeometry> {
  const details: Record<string, BoxGeometry> = {};

  const sourceBox = source ? geometry.source?.get(geometryKey(source)) : undefined;
  if (sourceBox) details['sourceBox'] = sourceBox;

  const targetBox = target ? geometry.target?.get(geometryKey(target)) : undefined;
  if (targetBox) details['targetBox'] = targetBox;

  return details;
}
