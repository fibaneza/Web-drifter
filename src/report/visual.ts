import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import type { BoxGeometry, Finding, FindingCategory, Severity } from '../core/types.js';
import { SEVERITY_ORDER } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { PathMapping } from '../map/path-map.js';
import { pathSlug, type ArtifactStore } from '../store/artifact-store.js';
import { boxOf, selectVisualMarks, type VisualFilterOptions } from './visual-select.js';

/**
 * The page-level visual map.
 *
 * A reviewer's first question about a page is not "which of these 41 findings
 * is most severe" but "where do I look". Element crops answer the second
 * question well and the first not at all, because a crop carries no context: it
 * shows a heading, not *which* heading, on a page it does not show.
 *
 * So this draws every visually-perceptible difference onto the two full-page
 * captures the crawler already stored, numbered, with a legend. It detects
 * nothing - the comparison already decided what is wrong - which is exactly
 * what lets each box carry a sentence instead of just a colour.
 */

export interface VisualMark {
  /** 1-based label drawn on the image. */
  n: number;
  findingId: string;
  category: FindingCategory;
  severity: Severity;
  label: string;
  /** True when the element exists on only one side. */
  oneSided: boolean;
}

export interface VisualPageMap {
  path: string;
  targetPath: string;
  viewport: string;
  /** Report-relative hrefs, or null when that side had no capture. */
  sourceImage: string | null;
  targetImage: string | null;
  marks: VisualMark[];
}

export interface VisualMapOptions extends VisualFilterOptions {
  store: ArtifactStore;
  outDir: string;
  findings: readonly Finding[];
  mapping: PathMapping;
  /** Viewport id -> device scale factor. Screenshots are in device pixels. */
  deviceScale: ReadonlyMap<string, number>;
  /** Viewport used for findings that are not tied to one. */
  primaryViewport: string;
  logger: Logger;
  /** Ceiling on annotated pages, most-affected first. */
  maxPages?: number | undefined;
  /** Ceiling on boxes per image, most severe first. */
  maxMarksPerPage?: number | undefined;
}

const DEFAULT_MAX_PAGES = 60;
const DEFAULT_MAX_MARKS = 40;

/** Stroke colour per severity. Fill is the same colour at low opacity. */
const SEVERITY_COLOR: Record<Severity, string> = {
  error: '#d92d20',
  warning: '#dc6803',
  info: '#2970ff',
};

export const VISUAL_DIR = join('assets', 'visual');

export async function generateVisualMaps(options: VisualMapOptions): Promise<VisualPageMap[]> {
  const { logger } = options;
  const maxMarks = options.maxMarksPerPage ?? DEFAULT_MAX_MARKS;

  const byKey = new Map<string, Finding[]>();
  for (const finding of selectVisualMarks(options.findings, options)) {
    const viewport = finding.viewport ?? options.primaryViewport;
    const key = `${finding.path} ${viewport}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(finding);
    else byKey.set(key, [finding]);
  }

  // Most-affected pages first, so a cap never discards the worst page.
  const ordered = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length);
  const capped = ordered.slice(0, options.maxPages ?? DEFAULT_MAX_PAGES);

  const maps: VisualPageMap[] = [];

  for (const [key, group] of capped) {
    const [path = '', viewport = options.primaryViewport] = key.split(' ');
    const findings = group.slice(0, maxMarks);

    try {
      const map = await renderPageMap(path, viewport, findings, options);
      if (map) maps.push(map);
    } catch (error) {
      logger.debug({ path, viewport, error: String(error) }, 'could not build visual map');
    }
  }

  if (maps.length > 0) {
    logger.info({ pages: maps.length }, 'visual maps generated');
  }
  return maps;
}

async function renderPageMap(
  path: string,
  viewport: string,
  findings: readonly Finding[],
  options: VisualMapOptions,
): Promise<VisualPageMap | null> {
  const targetPath = options.mapping.toTarget(path);
  const scale = options.deviceScale.get(viewport) ?? 1;

  const marks: VisualMark[] = [];
  const sourceBoxes: NumberedBox[] = [];
  const targetBoxes: NumberedBox[] = [];

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  sorted.forEach((finding, index) => {
    const n = index + 1;
    const source = boxOf(finding, 'sourceBox');
    const target = boxOf(finding, 'targetBox');

    if (source) sourceBoxes.push({ n, box: source, severity: finding.severity });
    if (target) targetBoxes.push({ n, box: target, severity: finding.severity });

    marks.push({
      n,
      findingId: finding.id,
      category: finding.category,
      severity: finding.severity,
      label: finding.label,
      oneSided: !source || !target,
    });
  });

  const slug = `${pathSlug(path)}@${viewport}`;
  const [sourceImage, targetImage] = await Promise.all([
    annotateSide(options, 'source', path, viewport, sourceBoxes, scale, `${slug}-source.png`),
    annotateSide(options, 'target', targetPath, viewport, targetBoxes, scale, `${slug}-target.png`),
  ]);

  if (sourceImage === null && targetImage === null) return null;

  return { path, targetPath, viewport, sourceImage, targetImage, marks };
}

export interface NumberedBox {
  n: number;
  box: BoxGeometry;
  severity: Severity;
}

async function annotateSide(
  options: VisualMapOptions,
  side: 'source' | 'target',
  path: string,
  viewport: string,
  boxes: readonly NumberedBox[],
  scale: number,
  fileName: string,
): Promise<string | null> {
  let image: Buffer;
  try {
    image = await readFile(options.store.screenshotPath(side, path, viewport));
  } catch {
    // No capture for this side: a page missing on the target, or a run made
    // with screenshots disabled. The other side is still worth showing.
    return null;
  }

  const annotated = await drawBoxes(image, boxes, scale);
  const href = join(VISUAL_DIR, fileName);
  const file = join(options.outDir, href);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, annotated);
  return href;
}

/**
 * Composite numbered boxes onto a screenshot.
 *
 * Drawn as one SVG layer rather than as per-box composites: sharp would
 * otherwise re-encode the full-page PNG once per marker, which on a tall page
 * carrying forty markers costs more than the crawl that produced it.
 */
export async function drawBoxes(
  image: Buffer,
  boxes: readonly NumberedBox[],
  scale: number,
): Promise<Buffer> {
  const metadata = await sharp(image).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width === 0 || height === 0 || boxes.length === 0) return image;

  const svg = overlaySvg(boxes, scale, width, height);
  return sharp(image)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/**
 * The overlay layer.
 *
 * Exported so its geometry can be asserted directly: rendering a PNG and
 * reading pixels back would test sharp rather than the placement.
 */
export function overlaySvg(
  boxes: readonly NumberedBox[],
  scale: number,
  width: number,
  height: number,
): string {
  const parts: string[] = [];

  for (const { n, box, severity } of boxes) {
    const color = SEVERITY_COLOR[severity];
    const x = Math.max(0, Math.round(box.x * scale));
    const y = Math.max(0, Math.round(box.y * scale));
    // Clamped to the canvas: an element can sit partly outside a full-page
    // capture, and sharp rejects a composite that overflows.
    const w = Math.min(Math.round(box.width * scale), width - x);
    const h = Math.min(Math.round(box.height * scale), height - y);
    if (w <= 0 || h <= 0) continue;

    const stroke = Math.max(2, Math.round(2 * scale));
    const badge = Math.max(18, Math.round(18 * scale));
    // The badge sits inside the box for an element at the very top of the page,
    // where an outside badge would be clipped away entirely.
    const badgeY = y >= badge ? y - badge : y;

    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" fill-opacity="0.10" ` +
        `stroke="${color}" stroke-width="${stroke}" />`,
      `<rect x="${x}" y="${badgeY}" width="${Math.round(badge * 1.6)}" height="${badge}" fill="${color}" />`,
      `<text x="${x + Math.round(badge * 0.8)}" y="${badgeY + Math.round(badge * 0.74)}" ` +
        `font-family="system-ui, sans-serif" font-size="${Math.round(badge * 0.7)}" ` +
        `font-weight="700" fill="#ffffff" text-anchor="middle">${n}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
}
