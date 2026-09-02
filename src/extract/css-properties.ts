/**
 * The computed-CSS property allowlist.
 *
 * Why computed styles and not stylesheets: across a rewrite the two sites share
 * no selectors, no class names and no cascade structure, so diffing CSS source
 * is meaningless. Computed style is the only common ground - it is what the
 * browser resolved and therefore what the user actually sees.
 *
 * Why an allowlist and not "every property": `getComputedStyle` exposes ~350
 * properties, the vast majority of which are defaults that never differ, or are
 * derived from others and would double-report the same difference. Comparing
 * everything produces a report nobody reads. These are the properties that
 * change what a page looks like.
 *
 * Only longhands are listed. Shorthands (`margin`, `border`, `font`) are
 * deliberately excluded: `getComputedStyle` resolves them inconsistently across
 * engines, and a longhand difference would otherwise be reported twice.
 */

export const TYPOGRAPHY_PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-decoration-line',
  'text-align',
  'white-space',
  'text-overflow',
] as const;

export const COLOR_PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'opacity',
] as const;

export const BOX_PROPERTIES = [
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'box-sizing',
] as const;

export const LAYOUT_PROPERTIES = [
  'display',
  'position',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-self',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'float',
  'clear',
  'z-index',
  'overflow-x',
  'overflow-y',
  'vertical-align',
] as const;

export const EFFECT_PROPERTIES = [
  'box-shadow',
  'text-shadow',
  'transform',
  'filter',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'visibility',
  'cursor',
] as const;

export type CssPropertyGroup = 'typography' | 'color' | 'box' | 'layout' | 'effects';

export const CSS_PROPERTY_GROUPS: Record<CssPropertyGroup, readonly string[]> = {
  typography: TYPOGRAPHY_PROPERTIES,
  color: COLOR_PROPERTIES,
  box: BOX_PROPERTIES,
  layout: LAYOUT_PROPERTIES,
  effects: EFFECT_PROPERTIES,
};

/** Every allowlisted property, deduplicated and in a stable order. */
export const DEFAULT_CSS_PROPERTIES: readonly string[] = [
  ...TYPOGRAPHY_PROPERTIES,
  ...COLOR_PROPERTIES,
  ...BOX_PROPERTIES,
  ...LAYOUT_PROPERTIES,
  ...EFFECT_PROPERTIES,
];

const GROUP_BY_PROPERTY = new Map<string, CssPropertyGroup>();
for (const [group, properties] of Object.entries(CSS_PROPERTY_GROUPS)) {
  for (const property of properties) {
    GROUP_BY_PROPERTY.set(property, group as CssPropertyGroup);
  }
}

/** Which group a property belongs to, for grouping the CSS report. */
export function groupOf(property: string): CssPropertyGroup | 'other' {
  return GROUP_BY_PROPERTY.get(property) ?? 'other';
}

/**
 * Properties compared as lengths, with a pixel tolerance.
 *
 * Sub-pixel differences are endemic: a percentage width resolves against a
 * container that differs by a fraction of a pixel, and every descendant then
 * differs too. Reporting those as drift would bury the real findings.
 */
export const LENGTH_PROPERTIES: ReadonlySet<string> = new Set([
  'font-size',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'gap',
]);

/** Properties compared as colours, normalised to a canonical rgba() form. */
export const COLOR_VALUED_PROPERTIES: ReadonlySet<string> = new Set(COLOR_PROPERTIES);

/**
 * Resolve the effective property list.
 *
 * `ignore` removes properties a team has accepted as legitimately different -
 * `font-family` is the usual one, when the rewrite intentionally changed the
 * font stack and every text node would otherwise report drift.
 */
export function resolveCssProperties(ignore: readonly string[] = []): string[] {
  const ignored = new Set(ignore.map((p) => p.toLowerCase()));
  return DEFAULT_CSS_PROPERTIES.filter((p) => !ignored.has(p));
}
