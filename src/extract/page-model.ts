import type { Page } from 'playwright';
import type { DeviceProfile } from '../config/devices.js';
import type {
  ContentNode,
  ImageRecord,
  LinkRecord,
  NodeKind,
  PageMeta,
  PriceRecord,
  Region,
  ViewportCapture,
} from '../core/types.js';
import { kindFamily } from '../core/types.js';
import {
  canonicalizeUrl,
  classifyHref,
  resolveHref,
  type UrlNormalizeOptions,
} from '../map/url-normalize.js';
import { extractInPage, type ExtractOptions, type RawPageModel } from './browser-extract.js';
import { DEFAULT_REGION_HINTS } from './regions.js';
import { buildImageRecords } from './images.js';
import { buildPriceRecords } from './prices.js';
import { contentHash, nodeKey, normalizeText } from './text.js';

/**
 * Assembles the canonical page model from raw in-page output.
 *
 * The split matters: the browser does DOM work, and everything requiring
 * determinism - normalisation, hashing, node identity, URL canonicalisation -
 * happens here in Node, where it is unit tested and cannot vary with browser
 * behaviour or timing.
 */

export interface CaptureModelOptions {
  pageUrl: string;
  viewport: DeviceProfile;
  ignoreSelectors: readonly string[];
  priceSelectors: readonly string[];
  cssProperties: readonly string[];
  /** Applied to text before hashing: timestamps, counters, session ids. */
  ignorePatterns: readonly RegExp[];
  normalize: UrlNormalizeOptions;
  isAllowedOrigin: (url: URL) => boolean;
  maxElementScan?: number;
}

export interface CapturedModel {
  title: string;
  meta: PageMeta;
  content: ContentNode[];
  links: LinkRecord[];
  images: ImageRecord[];
  prices: PriceRecord[];
  viewport: ViewportCapture;
  /** Hash of the content stream, for cross-URL duplicate detection. */
  contentHash: string;
}

const VALID_KINDS: ReadonlySet<string> = new Set<NodeKind>([
  'heading',
  'paragraph',
  'listItem',
  'link',
  'image',
  'control',
  'tableCell',
  'price',
]);

const VALID_REGIONS: ReadonlySet<string> = new Set<Region>([
  'header',
  'nav',
  'main',
  'footer',
  'aside',
  'other',
]);

/** Run the extractor in the page and assemble the typed model. */
export async function capturePageModel(
  page: Page,
  options: CaptureModelOptions,
): Promise<CapturedModel> {
  const extractOptions: ExtractOptions = {
    ignoreSelectors: [...options.ignoreSelectors],
    priceSelectors: [...options.priceSelectors],
    cssProperties: [...options.cssProperties],
    maxElementScan: options.maxElementScan ?? 5000,
    // Only consulted for a document that declares no landmark of its own.
    regionHints: DEFAULT_REGION_HINTS.map((hint) => [hint.region, hint.pattern]),
  };

  const raw = await page.evaluate(extractInPage, extractOptions);
  return assembleModel(raw, options);
}

/**
 * Pure assembly step, separated from the browser call so it can be tested with
 * a hand-written {@link RawPageModel}.
 */
export function assembleModel(raw: RawPageModel, options: CaptureModelOptions): CapturedModel {
  const { ignorePatterns, pageUrl } = options;

  const content: ContentNode[] = [];
  const styles: ViewportCapture['styles'] = [];
  /** `region|key` -> how many nodes with that identity have been seen. */
  const ordinals = new Map<string, number>();
  const hashParts: string[] = [];

  for (const node of raw.nodes) {
    const kind: NodeKind = VALID_KINDS.has(node.kind) ? (node.kind as NodeKind) : 'paragraph';
    const region: Region = VALID_REGIONS.has(node.region) ? (node.region as Region) : 'other';

    const text = normalizeText(node.text, { ignorePatterns });
    // An image node is identified by its asset, not its (often empty) alt text.
    if (text === '' && kind !== 'image') continue;

    const key = nodeKey(
      kindFamily(kind),
      kind === 'image' ? String(node.attrs['src'] ?? '') : text,
    );
    const identity = `${region}|${key}`;
    const ordinal = ordinals.get(identity) ?? 0;
    ordinals.set(identity, ordinal + 1);

    content.push({
      key,
      ordinal,
      region,
      kind,
      text,
      attrs: buildAttrs(kind, node.attrs, options),
      selectorHint: node.selectorHint,
    });

    styles.push({
      nodeKey: key,
      ordinal,
      region,
      props: node.styles,
      box: node.box,
      visible: node.visible,
    });

    hashParts.push(`${region}:${kindFamily(kind)}:${text}`);
  }

  const links = buildLinkRecords(raw, options);
  const images = buildImageRecords(raw.images, pageUrl);
  const prices = buildPriceRecords(raw.prices);

  return {
    title: normalizeText(raw.title, { ignorePatterns }),
    meta: raw.meta,
    content,
    links,
    images,
    prices,
    viewport: {
      viewport: options.viewport.id,
      width: raw.viewportWidth,
      height: raw.viewportHeight,
      styles,
      documentHeight: raw.documentHeight,
      hasHorizontalOverflow: raw.hasHorizontalOverflow,
      deviceScaleFactor: options.viewport.deviceScaleFactor,
    },
    contentHash: contentHash(hashParts),
  };
}

function buildAttrs(
  kind: NodeKind,
  raw: Record<string, string | number | boolean | undefined>,
  options: CaptureModelOptions,
): ContentNode['attrs'] {
  switch (kind) {
    case 'heading':
      return { level: typeof raw['level'] === 'number' ? raw['level'] : 1 };
    case 'link': {
      const href = String(raw['href'] ?? '');
      const resolved = resolveHref(href, options.pageUrl, options.normalize.hashRouting);
      const internal = resolved !== null && options.isAllowedOrigin(resolved);
      return {
        href,
        external: resolved !== null && !internal,
        ...(internal && resolved ? { path: canonicalizeUrl(resolved, options.normalize).key } : {}),
      };
    }
    case 'image':
      return {
        src: String(raw['src'] ?? ''),
        alt: String(raw['alt'] ?? ''),
        naturalWidth: typeof raw['naturalWidth'] === 'number' ? raw['naturalWidth'] : 0,
        naturalHeight: typeof raw['naturalHeight'] === 'number' ? raw['naturalHeight'] : 0,
      };
    case 'listItem':
      return { depth: typeof raw['depth'] === 'number' ? raw['depth'] : 0 };
    case 'tableCell':
      return {
        row: typeof raw['row'] === 'number' ? raw['row'] : -1,
        col: typeof raw['col'] === 'number' ? raw['col'] : -1,
      };
    default:
      return {};
  }
}

function buildLinkRecords(raw: RawPageModel, options: CaptureModelOptions): LinkRecord[] {
  const records: LinkRecord[] = [];
  const seen = new Set<string>();

  for (const link of raw.links) {
    const kind = classifyHref(
      link.href,
      options.pageUrl,
      options.isAllowedOrigin,
      options.normalize.hashRouting,
    );
    const resolved = resolveHref(link.href, options.pageUrl, options.normalize.hashRouting);
    const path =
      resolved && kind === 'internal' ? canonicalizeUrl(resolved, options.normalize).key : null;

    // One page routinely links the same destination many times (nav, footer,
    // inline). Collapse them, but keep visible over hidden - only visible links
    // are required to have a counterpart on the target.
    const dedupeKey = `${link.href}|${link.region}`;
    if (seen.has(dedupeKey)) {
      if (link.visible) {
        const existing = records.find((r) => `${r.href}|${r.region}` === dedupeKey);
        if (existing) existing.visible = true;
      }
      continue;
    }
    seen.add(dedupeKey);

    records.push({
      href: link.href,
      resolved: resolved?.href ?? null,
      path,
      text: normalizeText(link.text, { ignorePatterns: options.ignorePatterns }),
      kind,
      region: (VALID_REGIONS.has(link.region) ? link.region : 'other') as Region,
      visible: link.visible,
      ...(link.rel ? { rel: link.rel } : {}),
      ...(link.target ? { target: link.target } : {}),
    });
  }

  return records;
}
