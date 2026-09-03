import type {
  BoxGeometry,
  Finding,
  FindingCategory,
  ImageRecord,
  ImageStats,
  PageSnapshot,
  PriceRecord,
  PriceStats,
  Severity,
} from '../core/types.js';
import { percentStat } from '../core/types.js';
import { trigramSimilarity, truncate } from '../extract/text.js';
import { align } from './align.js';
import { createFinding, severityFor } from './findings.js';

/**
 * Image and price comparison - Phase 3.3.
 *
 * Both share a problem: the thing being compared is rendered differently on the
 * two sides even when it is unchanged. An image is served through a different
 * CDN with a different content hash; a price is formatted by a different
 * library in a different locale. Comparing the rendered strings would report
 * every image and every price on the site as drift.
 *
 * So both are compared on a *normalised* identity - the asset key and the
 * parsed numeric amount - and the presentational difference is reported
 * separately, at a severity that reflects that it is usually not a defect.
 */

export interface AssetCompareOptions {
  /** Absolute tolerance when comparing parsed price amounts. */
  priceEpsilon: number;
  /** Image dimension tolerance as a fraction of the source dimension. */
  imageSizePercent: number;
  /** Trigram similarity above which two price contexts are the same item. */
  textSimilarity: number;
  severities?: Partial<Record<FindingCategory, Severity>>;
}

/**
 * Box details for a record pair, either side of which may be absent.
 *
 * Images and prices carry their own geometry from extraction rather than being
 * looked up by identity. Neither is part of the content node stream - images are
 * matched on an environment-independent asset key, prices come from JSON-LD,
 * microdata, configured selectors and a text scan - so there is no node identity
 * to join on.
 *
 * A one-sided box is the point rather than a shortcoming: an image missing from
 * the target yields a source-only crop, which is exactly the evidence a reviewer
 * needs - "here is what should be there". A JSON-LD price has no box at all,
 * which is also correct: it is metadata with nothing on screen to crop.
 */
function recordBoxes(
  source: { box?: BoxGeometry | undefined } | null | undefined,
  target: { box?: BoxGeometry | undefined } | null | undefined,
): Record<string, BoxGeometry> {
  const details: Record<string, BoxGeometry> = {};
  if (source?.box) details['sourceBox'] = source.box;
  if (target?.box) details['targetBox'] = target.box;
  return details;
}

/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

export interface ImageCompareResult {
  findings: Finding[];
  stats: ImageStats;
}

export function compareImages(
  source: PageSnapshot,
  target: PageSnapshot,
  options: AssetCompareOptions,
): ImageCompareResult {
  const { severities = {} } = options;
  const findings: Finding[] = [];

  // Only visible images are compared. A hidden `<img>` behind a carousel or a
  // preload placeholder is not something a user can miss.
  const sourceImages = source.images.filter((i) => i.visible);
  const targetImages = target.images.filter((i) => i.visible);

  const pairs = align(sourceImages, targetImages, {
    // Region is part of the key so a logo in the header cannot pair with the
    // same logo in the footer.
    keyOf: (image) => `${image.region}:${image.assetKey}`,
    similarity: imageSimilarity,
    threshold: 0.5,
  });

  let matched = 0;
  let missing = 0;
  let added = 0;
  let altDrifts = 0;
  let sizeDrifts = 0;
  let identical = 0;

  for (const pair of pairs) {
    if (pair.source && !pair.target) {
      missing += 1;
      findings.push(
        createFinding({
          category: 'image.missing',
          severity: severityFor('image.missing', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: pair.source.region,
          nodeKind: 'image',
          subject: pair.source.assetKey,
          label: `Image missing on target: ${describeImage(pair.source)}`,
          expected: pair.source.src,
          actual: null,
          details: recordBoxes(pair.source, null),
        }),
      );
      continue;
    }

    if (!pair.source && pair.target) {
      added += 1;
      findings.push(
        createFinding({
          category: 'image.added',
          severity: severityFor('image.added', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: pair.target.region,
          nodeKind: 'image',
          subject: pair.target.assetKey,
          label: `Image only on target: ${describeImage(pair.target)}`,
          expected: null,
          actual: pair.target.src,
          details: recordBoxes(null, pair.target),
        }),
      );
      continue;
    }

    if (!pair.source || !pair.target) continue;
    matched += 1;
    let clean = true;

    if (pair.source.alt !== pair.target.alt) {
      clean = false;
      altDrifts += 1;
      findings.push(
        createFinding({
          category: 'image.alt-drift',
          severity: severityFor('image.alt-drift', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: pair.source.region,
          nodeKind: 'image',
          subject: pair.source.assetKey,
          facet: 'alt',
          label: `Alt text changed on image "${pair.source.assetKey}"`,
          expected: pair.source.alt,
          actual: pair.target.alt,
          details: recordBoxes(pair.source, pair.target),
        }),
      );
    }

    // Intrinsic dimensions, not rendered ones: rendered size is a styling
    // question and belongs to the CSS report, whereas a different intrinsic
    // size means a genuinely different asset was served.
    const sizeDrift = compareDimensions(pair.source, pair.target, options.imageSizePercent);
    if (sizeDrift) {
      clean = false;
      sizeDrifts += 1;
      findings.push(
        createFinding({
          category: 'image.size-drift',
          severity: severityFor('image.size-drift', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: pair.source.region,
          nodeKind: 'image',
          subject: pair.source.assetKey,
          facet: 'dimensions',
          label: `Intrinsic size changed on image "${pair.source.assetKey}"`,
          expected: sizeDrift.expected,
          actual: sizeDrift.actual,
          details: recordBoxes(pair.source, pair.target),
        }),
      );
    }

    if (clean) identical += 1;
  }

  return {
    findings,
    stats: {
      sourceImages: sourceImages.length,
      targetImages: targetImages.length,
      matchedImages: matched,
      missingImages: missing,
      addedImages: added,
      altDrifts,
      sizeDrifts,
      imageParity: percentStat(identical, sourceImages.length),
    },
  };
}

function imageSimilarity(a: ImageRecord, b: ImageRecord): number {
  if (a.region !== b.region) return 0;
  if (a.assetKey === b.assetKey) return 1;
  // Different asset key but identical alt text: very likely the same image
  // renamed by the build. Worth pairing so it reports as a source change rather
  // than as one image vanishing and an unrelated one appearing.
  if (a.alt !== '' && a.alt === b.alt) return 0.8;
  return 0;
}

function compareDimensions(
  a: ImageRecord,
  b: ImageRecord,
  tolerance: number,
): { expected: string; actual: string } | null {
  // A background image or an SVG has no intrinsic size to compare.
  if (a.naturalWidth === 0 || b.naturalWidth === 0) return null;

  const widthDelta = Math.abs(b.naturalWidth - a.naturalWidth) / a.naturalWidth;
  const heightDelta =
    a.naturalHeight === 0 ? 0 : Math.abs(b.naturalHeight - a.naturalHeight) / a.naturalHeight;

  if (widthDelta <= tolerance && heightDelta <= tolerance) return null;
  return {
    expected: `${a.naturalWidth}x${a.naturalHeight}`,
    actual: `${b.naturalWidth}x${b.naturalHeight}`,
  };
}

function describeImage(image: ImageRecord): string {
  const alt = image.alt === '' ? '' : ` ("${truncate(image.alt, 40)}")`;
  return `${image.assetKey}${alt}`;
}

/* -------------------------------------------------------------------------- */
/* Prices                                                                     */
/* -------------------------------------------------------------------------- */

export interface PriceCompareResult {
  findings: Finding[];
  stats: PriceStats;
}

export function comparePrices(
  source: PageSnapshot,
  target: PageSnapshot,
  options: AssetCompareOptions,
): PriceCompareResult {
  const { severities = {} } = options;
  const findings: Finding[] = [];

  const pairs = align(source.prices, target.prices, {
    // Anchor on the exact amount within a region: a price is most reliably
    // identified by its value, and its surrounding text resolves ties.
    keyOf: (price) => `${price.region}:${price.amount}:${price.currency ?? ''}`,
    similarity: (a, b) => priceSimilarity(a, b, options),
    threshold: 0.5,
  });

  let matched = 0;
  let valueDrifts = 0;
  let currencyDrifts = 0;
  let formatDrifts = 0;
  let missing = 0;
  let added = 0;
  let valueMatches = 0;

  for (const pair of pairs) {
    if (pair.source && !pair.target) {
      missing += 1;
      findings.push(
        createFinding({
          category: 'price.missing',
          severity: severityFor('price.missing', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: pair.source.region,
          nodeKind: 'price',
          subject: priceSubject(pair.source),
          label: `Price ${pair.source.raw} not found on target (${truncate(pair.source.context, 50)})`,
          expected: pair.source.amount,
          actual: null,
          details: recordBoxes(pair.source, null),
        }),
      );
      continue;
    }

    if (!pair.source && pair.target) {
      added += 1;
      findings.push(
        createFinding({
          category: 'price.added',
          severity: severityFor('price.added', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: pair.target.region,
          nodeKind: 'price',
          subject: priceSubject(pair.target),
          label: `Price ${pair.target.raw} only on target (${truncate(pair.target.context, 50)})`,
          expected: null,
          actual: pair.target.amount,
          details: recordBoxes(null, pair.target),
        }),
      );
      continue;
    }

    if (!pair.source || !pair.target) continue;
    matched += 1;

    const amountDiffers = Math.abs(pair.source.amount - pair.target.amount) > options.priceEpsilon;
    if (amountDiffers) {
      valueDrifts += 1;
      findings.push(
        createFinding({
          category: 'price.value-drift',
          severity: severityFor('price.value-drift', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: pair.source.region,
          nodeKind: 'price',
          subject: priceSubject(pair.source),
          confidence: pair.confidence,
          label: `Price changed from ${pair.source.raw} to ${pair.target.raw} (${truncate(
            pair.source.context,
            50,
          )})`,
          expected: pair.source.amount,
          actual: pair.target.amount,
          details: {
            sourceRaw: pair.source.raw,
            targetRaw: pair.target.raw,
            ...recordBoxes(pair.source, pair.target),
          },
        }),
      );
    } else {
      valueMatches += 1;
    }

    const bothHaveCurrency = pair.source.currency !== null && pair.target.currency !== null;
    if (bothHaveCurrency && pair.source.currency !== pair.target.currency) {
      currencyDrifts += 1;
      findings.push(
        createFinding({
          category: 'price.currency-drift',
          severity: severityFor('price.currency-drift', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: pair.source.region,
          nodeKind: 'price',
          subject: priceSubject(pair.source),
          facet: 'currency',
          label: `Currency changed from ${pair.source.currency} to ${pair.target.currency}`,
          expected: pair.source.currency,
          actual: pair.target.currency,
          details: recordBoxes(pair.source, pair.target),
        }),
      );
    }

    // Same value, different presentation. Not a defect - but a migration team
    // usually wants to know, because it is often an unintended locale change.
    if (!amountDiffers && pair.source.raw !== pair.target.raw) {
      formatDrifts += 1;
      findings.push(
        createFinding({
          category: 'price.format-drift',
          severity: severityFor('price.format-drift', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: pair.source.region,
          nodeKind: 'price',
          subject: priceSubject(pair.source),
          facet: 'format',
          label: `Same price displayed differently: ${pair.source.raw} vs ${pair.target.raw}`,
          expected: pair.source.raw,
          actual: pair.target.raw,
          details: recordBoxes(pair.source, pair.target),
        }),
      );
    }
  }

  return {
    findings,
    stats: {
      sourcePrices: source.prices.length,
      targetPrices: target.prices.length,
      matchedPrices: matched,
      valueDrifts,
      currencyDrifts,
      formatDrifts,
      missingPrices: missing,
      addedPrices: added,
      priceParity: percentStat(valueMatches, source.prices.length),
    },
  };
}

/**
 * Similarity between two prices.
 *
 * The surrounding context carries most of the signal: on a listing page every
 * price looks alike, and only the product it belongs to distinguishes them. An
 * equal amount reinforces a match but cannot make one on its own - otherwise
 * two unrelated items that happen to cost the same would pair up, and a genuine
 * price change would be reported against the wrong product.
 */
function priceSimilarity(a: PriceRecord, b: PriceRecord, options: AssetCompareOptions): number {
  if (a.region !== b.region) return 0;

  const contextScore = trigramSimilarity(a.context, b.context);
  const sameAmount = Math.abs(a.amount - b.amount) <= options.priceEpsilon;

  if (contextScore >= options.textSimilarity) return 0.6 + contextScore * 0.4;
  if (sameAmount && a.currency === b.currency) return 0.55;
  return contextScore * 0.5;
}

function priceSubject(price: PriceRecord): string {
  // Context, not amount: the subject must stay stable when the price changes,
  // or a suppression would stop applying the moment the value drifted.
  return truncate(price.context, 60) || price.raw;
}
