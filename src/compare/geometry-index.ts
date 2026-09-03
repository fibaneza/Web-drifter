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
 * Pairs `content[i]` with `styles[i]` positionally rather than by key. The
 * extractor appends to both arrays in the same pass over the same elements, so
 * position is an exact correspondence where the key is only an approximate one.
 * A length mismatch means that assumption no longer holds, so the index is
 * empty rather than wrong - findings then simply carry no evidence.
 */
export function buildGeometryIndex(snapshot: PageSnapshot, viewport: string): GeometryIndex {
  const index = new Map<string, BoxGeometry>();

  const capture = snapshot.viewports.find((entry) => entry.viewport === viewport);
  if (!capture || capture.styles.length !== snapshot.content.length) return index;

  for (const [position, node] of snapshot.content.entries()) {
    const style = capture.styles[position];
    if (!style) continue;
    // A zero-area box cannot be cropped, and an element that is not rendered has
    // no location to point at.
    if (style.box.width <= 0 || style.box.height <= 0) continue;
    index.set(geometryKey(node), style.box);
  }

  return index;
}

/**
 * Box per image or price, keyed the way those comparators identify them.
 *
 * Images and prices are compared as their own records rather than as content
 * nodes, so they cannot be looked up by node identity. They are still extracted
 * as content nodes, though, carrying the same discriminator in `attrs` - the
 * asset key for an image, the displayed text for a price - which is enough to
 * find the box. First occurrence wins: two prices reading "$9.99" in one region
 * are indistinguishable to the comparator too.
 */
export function buildRecordGeometryIndex(
  snapshot: PageSnapshot,
  viewport: string,
  kind: 'image' | 'price',
  attr: 'assetKey' | 'raw',
): GeometryIndex {
  const index = new Map<string, BoxGeometry>();

  const capture = snapshot.viewports.find((entry) => entry.viewport === viewport);
  if (!capture || capture.styles.length !== snapshot.content.length) return index;

  for (const [position, node] of snapshot.content.entries()) {
    if (node.kind !== kind) continue;
    const discriminator = node.attrs[attr];
    if (discriminator === undefined || discriminator === '') continue;

    const style = capture.styles[position];
    if (!style || style.box.width <= 0 || style.box.height <= 0) continue;

    const key = recordGeometryKey(node.region, discriminator);
    if (!index.has(key)) index.set(key, style.box);
  }

  return index;
}

/** Key for {@link buildRecordGeometryIndex}, from a record's own fields. */
export function recordGeometryKey(region: string, discriminator: string): string {
  return `${region}|${discriminator}`;
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
