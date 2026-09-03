import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import type { Logger } from '../core/logger.js';
import {
  SEVERITY_ORDER,
  type BoxGeometry,
  type Finding,
  type Severity,
  type Side,
} from '../core/types.js';
import type { PathMapping } from '../map/path-map.js';
import { pathSlug } from '../store/artifact-store.js';
import type { ArtifactStore } from '../store/artifact-store.js';
import type { Evidence } from './html/components.js';

/**
 * Screenshot evidence.
 *
 * **Evidence, not detection.** Nothing is ever reported because pixels differ -
 * anti-aliasing, font hinting and a one-pixel scroll offset make pixel
 * comparison far too noisy to gate on. But once a finding exists, a side-by-side
 * crop of the offending element is by far the fastest route from "there is a
 * difference" to "I can fix it". The pixel overlay is safe here precisely
 * because it is illustrating a verdict something else already reached.
 *
 * Crops are cut offline from the full-page screenshot the crawler already
 * stored, using the geometry already recorded on the finding. One screenshot
 * per page per viewport, many crops, no extra navigation.
 */

export interface EvidenceOptions {
  store: ArtifactStore;
  /** Report root; images are written under `<outDir>/assets/shots/`. */
  outDir: string;
  findings: readonly Finding[];
  mapping: PathMapping;
  logger: Logger;
  /**
   * Viewport id -> device scale factor.
   *
   * Playwright writes full-page screenshots in DEVICE pixels while element
   * geometry is recorded in CSS pixels, so at `deviceScaleFactor: 2` an
   * unscaled crop lands in the top-left quadrant and shows the wrong element
   * entirely - worse than showing nothing. Every box is multiplied by this
   * before extraction.
   */
  deviceScale: ReadonlyMap<string, number>;
  /**
   * Viewport whose full-page capture is cropped for a finding that is not tied
   * to one viewport.
   *
   * Content, image and price drift is viewport-independent by design, so those
   * findings carry no `viewport` - but they still happen somewhere on a rendered
   * page, and that is exactly the evidence a reviewer wants. Cropping them from
   * the primary render gives them a picture without ever claiming the drift is
   * specific to that device.
   */
  primaryViewport: string;
  /**
   * Lowest severity worth cutting a crop for.
   *
   * Cropping is the slowest part of writing a report, and most of what a
   * migration produces is low-severity styling noise nobody opens. Errors are
   * what people actually look at.
   */
  minSeverity?: Severity;
  /** Extra CSS pixels around the element, for context. */
  padding?: number;
  /**
   * Ceiling on generated images.
   *
   * A large migration can produce tens of thousands of style findings; writing
   * three PNGs for each would take longer than the crawl and produce an
   * artifact nobody can download. Errors are cropped first.
   */
  maxCrops?: number;
}

const DEFAULT_PADDING = 12;
const DEFAULT_MAX_CROPS = 400;

export async function generateEvidence(options: EvidenceOptions): Promise<Map<string, Evidence>> {
  const evidence = new Map<string, Evidence>();
  const padding = options.padding ?? DEFAULT_PADDING;
  const maxCrops = options.maxCrops ?? DEFAULT_MAX_CROPS;

  const floor = SEVERITY_ORDER[options.minSeverity ?? 'error'];

  const croppable = options.findings
    .filter(
      (finding) =>
        SEVERITY_ORDER[finding.severity] <= floor &&
        (boxOf(finding, 'sourceBox') !== null || boxOf(finding, 'targetBox') !== null),
    )
    // Most serious first, so the cap never discards an error in favour of an info.
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, maxCrops);

  // A page that is missing (or extra) has no element to crop, but the stored
  // full-page capture of the side that DOES have it is exactly the evidence a
  // reviewer wants: "here is the page that vanished".
  const wholePage = options.findings.filter(
    (finding) =>
      SEVERITY_ORDER[finding.severity] <= floor &&
      WHOLE_PAGE_SIDE[finding.category] !== undefined &&
      boxOf(finding, 'sourceBox') === null &&
      boxOf(finding, 'targetBox') === null,
  );

  for (const finding of wholePage) {
    try {
      const produced = await wholePageEvidence(finding, options);
      if (produced) evidence.set(finding.id, produced);
    } catch (error) {
      options.logger.debug(
        { finding: finding.id, error: String(error) },
        'could not generate whole-page evidence',
      );
    }
  }

  if (croppable.length === 0) {
    if (evidence.size > 0) {
      options.logger.info({ crops: evidence.size }, 'screenshot evidence generated');
    }
    return evidence;
  }

  // One page/viewport pair is loaded and decoded once, however many findings
  // reference it - decoding a full-page PNG per finding would dominate runtime.
  const byImage = new Map<string, Finding[]>();
  for (const finding of croppable) {
    const key = `${finding.path}\u0000${cropViewport(finding, options.primaryViewport)}`;
    const bucket = byImage.get(key);
    if (bucket) bucket.push(finding);
    else byImage.set(key, [finding]);
  }

  for (const [key, group] of byImage) {
    const [path = '', viewport = ''] = key.split('\u0000');
    const targetPath = options.mapping.toTarget(path);

    const [sourceImage, targetImage] = await Promise.all([
      loadImage(options.store.screenshotPath('source', path, viewport)),
      loadImage(options.store.screenshotPath('target', targetPath, viewport)),
    ]);

    // No screenshots for this page (a crawl run with captureScreenshots off, or
    // a page that failed to capture). Not an error - just no evidence to show.
    if (!sourceImage && !targetImage) continue;

    for (const finding of group) {
      try {
        const produced = await cropFinding({
          finding,
          viewport,
          sourceImage,
          targetImage,
          padding,
          scale: options.deviceScale.get(viewport) ?? 1,
          outDir: options.outDir,
        });
        if (produced) evidence.set(finding.id, produced);
      } catch (error) {
        // Evidence is a nice-to-have; a crop failure must never fail the report.
        options.logger.debug(
          { finding: finding.id, error: String(error) },
          'could not generate crop',
        );
      }
    }
  }

  options.logger.info({ crops: evidence.size }, 'screenshot evidence generated');
  return evidence;
}

/**
 * Coverage findings that warrant a whole-page shot, and which side holds it.
 *
 * The side is load-bearing and asymmetric: `page.missing-on-target` records the
 * SOURCE path in `finding.path` (the page that should have been migrated),
 * whereas `page.extra-on-target` records the TARGET path. Running an
 * already-target path through the source-to-target mapping - which the crop path
 * does for every finding - would look up the wrong page entirely.
 */
const WHOLE_PAGE_SIDE: Partial<Record<string, Side>> = {
  'page.missing-on-target': 'source',
  'page.extra-on-target': 'target',
};

/** Widest a whole-page shot is stored at; a full page is far too large as-is. */
const WHOLE_PAGE_WIDTH = 480;

/**
 * A downscaled copy of the whole page, for a finding with no element to crop.
 *
 * No pixel overlay: the two sides are different pages of different heights, so a
 * diff of them would be enormous and meaningless.
 */
async function wholePageEvidence(
  finding: Finding,
  options: EvidenceOptions,
): Promise<Evidence | null> {
  const side = WHOLE_PAGE_SIDE[finding.category];
  if (!side) return null;

  const viewport = finding.viewport ?? options.primaryViewport;
  const image = await loadImage(options.store.screenshotPath(side, finding.path, viewport));
  if (!image) return null;

  const relativeDir = join('assets', 'shots', pathSlug(finding.path), viewport);
  await mkdir(join(options.outDir, relativeDir), { recursive: true });

  const name = `${finding.id}-${side}.png`;
  const resized = await sharp(image.buffer)
    .resize({ width: WHOLE_PAGE_WIDTH, withoutEnlargement: true })
    .png()
    .toBuffer();
  await writeFile(join(options.outDir, relativeDir, name), resized);

  return { [side]: join(relativeDir, name), wholePage: true };
}

/**
 * Which viewport's capture to crop from.
 *
 * Deliberately read-only: `finding.viewport` drives the device matrix, and
 * writing the fallback back onto the finding would make a viewport-independent
 * content drift look like drift specific to one device.
 */
function cropViewport(finding: Finding, primaryViewport: string): string {
  return finding.viewport ?? primaryViewport;
}

interface LoadedImage {
  buffer: Buffer;
  width: number;
  height: number;
}

async function loadImage(file: string): Promise<LoadedImage | null> {
  try {
    const buffer = await readFile(file);
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height) return null;
    return { buffer, width: metadata.width, height: metadata.height };
  } catch {
    return null;
  }
}

interface CropInput {
  finding: Finding;
  viewport: string;
  sourceImage: LoadedImage | null;
  targetImage: LoadedImage | null;
  padding: number;
  /** Device pixels per CSS pixel for this viewport. */
  scale: number;
  outDir: string;
}

async function cropFinding(input: CropInput): Promise<Evidence | null> {
  const { finding, viewport, outDir } = input;

  // Either side alone is real evidence, and which one is missing carries the
  // meaning: a source-only crop shows what should be there, a target-only crop
  // shows what appeared. Requiring both would silently drop exactly the
  // missing- and extra-component findings people most want a picture of.
  const sourceBox = boxOf(finding, 'sourceBox');
  const targetBox = boxOf(finding, 'targetBox') ?? sourceBox;
  if (!sourceBox && !targetBox) return null;

  const relativeDir = join('assets', 'shots', pathSlug(finding.path), viewport);
  const absoluteDir = join(outDir, relativeDir);
  await mkdir(absoluteDir, { recursive: true });

  const evidence: Evidence = {};

  const source =
    input.sourceImage &&
    sourceBox &&
    (await crop(input.sourceImage, sourceBox, input.padding, input.scale));
  const target =
    input.targetImage &&
    targetBox &&
    (await crop(input.targetImage, targetBox, input.padding, input.scale));

  if (source) {
    const name = `${finding.id}-source.png`;
    await writeFile(join(absoluteDir, name), source.png);
    evidence.source = join(relativeDir, name);
  }
  if (target) {
    const name = `${finding.id}-target.png`;
    await writeFile(join(absoluteDir, name), target.png);
    evidence.target = join(relativeDir, name);
  }

  if (source && target) {
    const diff = await diffCrops(source, target);
    if (diff) {
      const name = `${finding.id}-diff.png`;
      await writeFile(join(absoluteDir, name), diff);
      evidence.diff = join(relativeDir, name);
    }
  }

  return Object.keys(evidence).length > 0 ? evidence : null;
}

interface Crop {
  png: Buffer;
  width: number;
  height: number;
}

/**
 * Extract an element's box from a full-page screenshot.
 *
 * The box is clamped to the image: an element can legitimately sit partly
 * outside a capture (a sticky header measured at a scroll offset, an element
 * hanging past the document edge), and sharp throws rather than clipping.
 */
async function crop(
  image: LoadedImage,
  box: BoxGeometry,
  padding: number,
  scale: number,
): Promise<Crop | null> {
  // CSS pixels -> device pixels, which is what the screenshot is measured in.
  const left = Math.max(0, Math.floor((box.x - padding) * scale));
  const top = Math.max(0, Math.floor((box.y - padding) * scale));
  const right = Math.min(image.width, Math.ceil((box.x + box.width + padding) * scale));
  const bottom = Math.min(image.height, Math.ceil((box.y + box.height + padding) * scale));

  const width = right - left;
  const height = bottom - top;
  // A zero-area intersection means the element is entirely off the capture.
  if (width < 1 || height < 1) return null;

  const png = await sharp(image.buffer).extract({ left, top, width, height }).png().toBuffer();
  return { png, width, height };
}

/**
 * Pixel overlay of two crops.
 *
 * The two crops are almost never the same size - the element moved or resized,
 * which is usually the very thing being reported - and pixelmatch requires
 * identical dimensions. Both are therefore padded (never scaled) onto a common
 * canvas: scaling would distort the difference being illustrated.
 */
async function diffCrops(source: Crop, target: Crop): Promise<Buffer | null> {
  const width = Math.max(source.width, target.width);
  const height = Math.max(source.height, target.height);
  if (width < 1 || height < 1) return null;

  const [sourceRaw, targetRaw] = await Promise.all([
    padToCanvas(source.png, width, height),
    padToCanvas(target.png, width, height),
  ]);

  // pixelmatch requires exactly width*height*4 bytes per side and reports only
  // "Image sizes do not match" when it does not get them, so verify here where
  // the cause is visible rather than letting it surface as a mystery.
  const expected = width * height * 4;
  if (sourceRaw.length !== expected || targetRaw.length !== expected) return null;

  const diff = new PNG({ width, height });
  pixelmatch(sourceRaw, targetRaw, diff.data, width, height, {
    threshold: 0.12,
    includeAA: false,
    alpha: 0.25,
  });

  return PNG.sync.write(diff);
}

/**
 * Place a crop on a fixed-size RGBA canvas.
 *
 * Composited onto a canvas of exactly the target size rather than extended and
 * re-extracted: the latter depends on the source's channel count and rounding,
 * and quietly produced buffers of the wrong length. Creating the canvas
 * explicitly guarantees `width * height * 4` bytes every time.
 *
 * The crop is never SCALED to fit - scaling would distort the very difference
 * being illustrated.
 */
async function padToCanvas(png: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      // Magenta: padding belongs to neither screenshot, and a neutral colour
      // would read as a real difference in the overlay.
      background: { r: 255, g: 0, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: png, top: 0, left: 0 }])
    .raw()
    .toBuffer();
}

/** Read a geometry box out of a finding's details, if it carries one. */
function boxOf(finding: Finding, key: 'sourceBox' | 'targetBox'): BoxGeometry | null {
  const raw = finding.details?.[key];
  if (!raw || typeof raw !== 'object') return null;

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

  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** Absolute path of the directory evidence is written into. */
export function evidenceDir(outDir: string): string {
  return dirname(join(outDir, 'assets', 'shots', 'x'));
}
