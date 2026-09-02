import type { ImageRecord, Region } from '../core/types.js';
import type { RawImage } from './browser-extract.js';

/**
 * Image identity across two environments.
 *
 * Comparing image URLs directly is hopeless in a migration: the host differs by
 * definition, a legacy CMS serves `/-/media/root/hero.ashx?h=400&w=800` while
 * the rewrite serves `/_next/image?url=%2Fimg%2Fhero.a1b2c3d4.webp&w=828`, and
 * build tooling injects a content hash that changes on every deploy. Every one
 * of those is the *same picture*.
 *
 * So images are matched on an `assetKey`: the filename stem, with the host,
 * query, CDN transform segments, content hash and extension all removed.
 *
 * Trade-off: the stem alone can collide (`/a/hero.jpg` and `/b/hero.jpg` both
 * key as `hero`). Path prefixes are deliberately NOT included because they are
 * exactly what a migration restructures. Collisions are tolerable because the
 * key is not used alone - matching also considers the region the image sits in
 * and its alt text, and a mismatch surfaces as a reviewable finding rather than
 * a silent error.
 */

/** Content hashes appended by build tooling: `hero.a1b2c3d4.png`, `hero-a1b2c3d4.png`. */
const CONTENT_HASH = /[.\-_][0-9a-f]{8,40}$/i;

/** Cloudinary-style transform segments: `w_300`, `c_fill,g_auto`, `f_auto`. */
const TRANSFORM_SEGMENT = /^[a-z]{1,3}_[^/]+$/i;

/** Image extensions stripped so a png -> webp conversion still matches. */
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp|ashx)$/i;

/** Query parameters that wrap a real image URL inside a resizing proxy. */
const NESTED_URL_PARAMS = ['url', 'src', 'image', 'path'] as const;

/**
 * Derive an environment-independent key for an image.
 *
 * Returns a lowercase stem, or the original string when nothing usable can be
 * extracted (so the value is still comparable, just less forgiving).
 */
export function imageAssetKey(src: string, pageUrl?: string): string {
  const trimmed = src.trim();
  if (trimmed === '') return '';

  // Inline data URIs have no filename; key them by a prefix of the payload so
  // two identical inline images still match.
  if (trimmed.startsWith('data:')) {
    return `data:${trimmed.slice(0, 64)}`;
  }

  let url: URL;
  try {
    url = new URL(trimmed, pageUrl ?? 'https://placeholder.invalid');
  } catch {
    return trimmed.toLowerCase();
  }

  // Image proxies (Next.js, Cloudflare, imgix) carry the real asset in a query
  // parameter. Unwrap it, bounded so a self-referential URL cannot loop.
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = NESTED_URL_PARAMS.map((p) => url.searchParams.get(p)).find(
      (value) => value && /\.[a-z]{2,5}(?:$|[?#])/i.test(value),
    );
    if (!nested) break;
    try {
      url = new URL(nested, pageUrl ?? 'https://placeholder.invalid');
    } catch {
      break;
    }
  }

  const segments = url.pathname.split('/').filter(Boolean);

  // Drop CDN transform segments so `/upload/w_300,c_fill/hero.jpg` keys the
  // same as `/upload/hero.jpg`.
  const meaningful = segments.filter((segment) => !TRANSFORM_SEGMENT.test(segment));

  const basename = meaningful.at(-1) ?? segments.at(-1) ?? '';
  if (basename === '') return url.pathname.toLowerCase() || trimmed.toLowerCase();

  let stem = decodeSafely(basename).replace(IMAGE_EXTENSION, '');
  stem = stem.replace(CONTENT_HASH, '');

  return stem.toLowerCase() || basename.toLowerCase();
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Turn raw in-page images into records with a stable cross-environment key. */
export function buildImageRecords(images: readonly RawImage[], pageUrl: string): ImageRecord[] {
  return images.map((image) => ({
    assetKey: imageAssetKey(image.src, pageUrl),
    src: image.src,
    alt: image.alt,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    region: image.region as Region,
    visible: image.visible,
    isBackground: image.isBackground,
  }));
}
