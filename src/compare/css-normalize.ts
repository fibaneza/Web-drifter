import { colord, extend, type Plugin } from 'colord';
import labPluginImport from 'colord/plugins/lab';
import namesPluginImport from 'colord/plugins/names';
import { COLOR_VALUED_PROPERTIES, LENGTH_PROPERTIES } from '../extract/css-properties.js';

/**
 * colord ships an ESM build (which Node actually loads) alongside CommonJS type
 * declarations. Under NodeNext resolution TypeScript therefore types the
 * default import as the module namespace, while at runtime it is the plugin
 * function itself. Unwrap whichever we were given rather than asserting a shape
 * that is only correct in one of the two worlds.
 */
const namesPlugin: Plugin =
  typeof namesPluginImport === 'function' ? namesPluginImport : namesPluginImport.default;
const labPlugin: Plugin =
  typeof labPluginImport === 'function' ? labPluginImport : labPluginImport.default;

// names: lets `white` and `transparent` parse. Computed styles are always
// returned as rgb() by the browser, but config-supplied and embedded values may
// not be.
// lab: provides `delta()`, the perceptual distance that decides whether a colour
// difference is worth a warning or is invisible to a human.
extend([namesPlugin, labPlugin]);

/**
 * Computed-CSS value normalisation.
 *
 * Without this the CSS report is unusable. Two engines - or two stylesheets
 * expressing the same intent - routinely produce values that are textually
 * different and visually identical:
 *
 *   `#fff` vs `rgb(255, 255, 255)` vs `white`
 *   `16px` vs `16.0000px` vs `15.9998px`
 *   `"Helvetica Neue", Arial` vs `Helvetica Neue, Arial`
 *
 * Reporting those as drift would bury the handful of real differences under
 * thousands of rows, and the report would be abandoned. Every normalisation
 * here exists to remove a specific class of false positive.
 */

export type CssDifferenceKind =
  | 'equal'
  | 'value'
  | 'length'
  /** A colour difference, carrying its perceptual distance. */
  | 'color'
  /** Same first font, different fallbacks - visually identical in practice. */
  | 'font-fallback';

export interface CssComparison {
  equal: boolean;
  kind: CssDifferenceKind;
  /** Values after normalisation, which is what the report should show. */
  normalizedSource: string;
  normalizedTarget: string;
  /** Difference in pixels, for length properties. */
  deltaPx?: number;
  /**
   * Perceptual distance 0..1 for colour properties, where 0 is identical and 1
   * is black against white. Around 0.03 is the threshold of visibility.
   */
  deltaE?: number;
}

/** Parse a CSS length to pixels. Returns null for non-lengths (`auto`, `normal`). */
export function parsePx(value: string): number | null {
  const match = /^(-?\d*\.?\d+)px$/.exec(value.trim());
  if (!match?.[1]) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Canonicalise a colour to `rgba(r, g, b, a)`.
 *
 * Returns the input unchanged when it is not a colour, so keywords like
 * `currentcolor` and `transparent` still compare sensibly.
 */
export function normalizeColor(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return trimmed;

  const parsed = colord(trimmed);
  if (!parsed.isValid()) return trimmed.toLowerCase();

  const { r, g, b, a } = parsed.toRgb();
  // Round alpha rather than compare floats: 0.8 and 0.800000011920929 are the
  // same colour, and Chromium reports the latter for some inputs.
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/**
 * Normalise a font stack: lowercase, unquote, single-space after commas.
 *
 * Whether a family is quoted is a stylesheet authoring detail with no rendered
 * consequence, and the two sites will not agree on it.
 */
export function normalizeFontFamily(value: string): string {
  return value
    .split(',')
    .map((family) =>
      family
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase(),
    )
    .filter((family) => family !== '')
    .join(', ');
}

/** The first family in a stack - the one that actually renders, if available. */
export function primaryFont(value: string): string {
  return normalizeFontFamily(value).split(',')[0]?.trim() ?? '';
}

/** Collapse whitespace so `0 1px 2px rgba(0,0,0,.5)` compares stably. */
function normalizeCompound(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .toLowerCase();
}

/**
 * Colour tokens embedded in a compound value.
 *
 * Matches function and hex forms only. Computed styles are what actually get
 * compared and Chromium resolves every colour in a gradient or shadow to
 * `rgb()`/`rgba()`, so named colours are not worth the risk of rewriting a
 * keyword that merely looks like one - `linear-gradient(to right, ...)` has no
 * shortage of bare words.
 */
const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi;

export interface CompoundValue {
  /** The value with every colour replaced by a placeholder. */
  skeleton: string;
  /** The colours, in the order they appeared. */
  colors: string[];
}

/**
 * Split a compound value into its structure and its colours.
 *
 * This is what lets `box-shadow` and `background-image` be judged the way a
 * flat colour property is. A gradient whose brand colour changed differs only
 * in its colours, and comparing the whole string means the report can say no
 * more than "these two strings differ" - about the single most visible kind of
 * change a rewrite can make.
 */
export function splitCompoundValue(value: string): CompoundValue {
  const colors: string[] = [];
  const skeleton = value.replace(COLOR_TOKEN, (match) => {
    colors.push(match);
    return '\u0000';
  });
  return { skeleton, colors };
}

/** Canonicalise every colour embedded in a compound value. */
export function normalizeEmbeddedColors(value: string): string {
  return value.replace(COLOR_TOKEN, (match) => normalizeColor(match));
}

/** Normalise a computed value for display and comparison. */
export function normalizeCssValue(property: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return trimmed;

  if (property === 'font-family') return normalizeFontFamily(trimmed);
  if (COLOR_VALUED_PROPERTIES.has(property)) return normalizeColor(trimmed);

  if (LENGTH_PROPERTIES.has(property)) {
    const px = parsePx(trimmed);
    // Round to 2dp: sub-pixel layout rounding is not a styling difference.
    if (px !== null) return `${Math.round(px * 100) / 100}px`;
  }

  // Shadows, transforms, gradients and background images all embed colours and
  // lengths. Normalising whitespace and case removes most spurious differences
  // without needing a full CSS value parser; canonicalising the colours inside
  // removes the rest, so `#000` and `rgb(0, 0, 0)` in a shadow are one value.
  return normalizeCompound(normalizeEmbeddedColors(trimmed));
}

export interface CompareCssOptions {
  /** Pixel tolerance for length properties. */
  lengthTolerancePx: number;
  /** Perceptual distance below which a colour difference is not reported at all. */
  colorTolerance: number;
}

/**
 * Compare one computed property between the two sides.
 *
 * `font-family` is treated specially: when the first family agrees and only the
 * fallbacks differ, the rendered text is identical on any machine that has the
 * primary font. Reporting that as drift would flag every text node on the site
 * over a difference nobody can see, so it is classified separately and
 * downgraded by the caller.
 */
/**
 * Perceptual distance between two colours, or null when either does not parse.
 *
 * Computed styles arrive as rgb()/rgba(), so this normally succeeds; `none`,
 * `currentcolor` and gradient values do not parse and fall through to an exact
 * string comparison, which is the right answer for them.
 */
export function colorDelta(sourceValue: string, targetValue: string): number | null {
  const source = colord(sourceValue);
  const target = colord(targetValue);
  if (!source.isValid() || !target.isValid()) return null;
  return source.delta(target);
}

export function compareCssValue(
  property: string,
  sourceValue: string,
  targetValue: string,
  options: CompareCssOptions,
): CssComparison {
  const normalizedSource = normalizeCssValue(property, sourceValue);
  const normalizedTarget = normalizeCssValue(property, targetValue);

  if (normalizedSource === normalizedTarget) {
    return { equal: true, kind: 'equal', normalizedSource, normalizedTarget };
  }

  if (property === 'font-family') {
    if (primaryFont(sourceValue) === primaryFont(targetValue)) {
      return { equal: false, kind: 'font-fallback', normalizedSource, normalizedTarget };
    }
    return { equal: false, kind: 'value', normalizedSource, normalizedTarget };
  }

  if (COLOR_VALUED_PROPERTIES.has(property)) {
    const deltaE = colorDelta(normalizedSource, normalizedTarget);
    if (deltaE !== null) {
      // A colour difference below the threshold of human vision is not drift.
      // Without this, rounding a channel by one - which no user can see and
      // every rewrite does - reports identically to black becoming white.
      if (deltaE <= options.colorTolerance) {
        return { equal: true, kind: 'equal', normalizedSource, normalizedTarget, deltaE };
      }
      return { equal: false, kind: 'color', normalizedSource, normalizedTarget, deltaE };
    }
  }

  // A compound value differing only in its colours is a colour difference, and
  // deserves the same perceptual judgement as `color` itself rather than being
  // reported as two opaque strings.
  const embedded = compareEmbeddedColors(normalizedSource, normalizedTarget, options);
  if (embedded) return { ...embedded, normalizedSource, normalizedTarget };

  if (LENGTH_PROPERTIES.has(property)) {
    const sourcePx = parsePx(normalizedSource);
    const targetPx = parsePx(normalizedTarget);
    if (sourcePx !== null && targetPx !== null) {
      const deltaPx = Math.round((targetPx - sourcePx) * 100) / 100;
      if (Math.abs(deltaPx) <= options.lengthTolerancePx) {
        return { equal: true, kind: 'equal', normalizedSource, normalizedTarget, deltaPx };
      }
      return { equal: false, kind: 'length', normalizedSource, normalizedTarget, deltaPx };
    }
  }

  return { equal: false, kind: 'value', normalizedSource, normalizedTarget };
}

/**
 * Compare two compound values that may differ only in their colours.
 *
 * Returns null when they differ structurally too - a gradient that gained a
 * stop, a shadow that moved - because that is not a colour difference and
 * pretending otherwise would hide the structural change behind a delta.
 */
function compareEmbeddedColors(
  normalizedSource: string,
  normalizedTarget: string,
  options: CompareCssOptions,
): Omit<CssComparison, 'normalizedSource' | 'normalizedTarget'> | null {
  const source = splitCompoundValue(normalizedSource);
  const target = splitCompoundValue(normalizedTarget);

  if (source.colors.length === 0) return null;
  if (source.colors.length !== target.colors.length) return null;
  if (source.skeleton !== target.skeleton) return null;

  let worst = 0;
  for (let i = 0; i < source.colors.length; i += 1) {
    const delta = colorDelta(source.colors[i] ?? '', target.colors[i] ?? '');
    // An unparseable colour means this is not a comparison we can make.
    if (delta === null) return null;
    worst = Math.max(worst, delta);
  }

  if (worst <= options.colorTolerance) {
    return { equal: true, kind: 'equal', deltaE: worst };
  }
  return { equal: false, kind: 'color', deltaE: worst };
}

/**
 * Geometry tolerance for one viewport.
 *
 * Scales with viewport width, because a 2px absolute tolerance is generous at
 * 1440px and punitive at 360px, where it is over half a percent of the screen.
 */
export function geometryTolerance(
  viewportWidth: number,
  absolutePx: number,
  relativeFraction: number,
): number {
  return Math.max(absolutePx, viewportWidth * relativeFraction);
}
