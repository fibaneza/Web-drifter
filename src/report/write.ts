import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDevices } from '../config/devices.js';
import type { DrifterConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import {
  SNAPSHOT_SCHEMA_VERSION,
  type Finding,
  type PageStats,
  type RunStats,
} from '../core/types.js';
import { createPathMapping } from '../map/path-map.js';
import { pathSlug, type ArtifactStore } from '../store/artifact-store.js';
import { aggregate, type ReportModel } from './aggregate.js';
import type { EvidenceIndex } from './html/components.js';
import {
  deviceHref,
  pageHref,
  renderCoverageReport,
  renderCssDeviceReport,
  renderCssReport,
  renderDeviceDetail,
  renderLinksReport,
  renderEvidenceReport,
  renderOverview,
  renderPageDetail,
  renderPageIndex,
} from './html/pages.js';
import { renderJUnit } from './junit.js';
import { renderMarkdown } from './markdown.js';
import { generateEvidence } from './screenshots.js';

/**
 * Report writing.
 *
 * Produces the whole tree described in `docs/reports.md`: two navigation axes
 * (by device and by page), the separate CSS report, links and coverage, plus
 * machine-readable JSON, a Markdown summary and JUnit XML.
 *
 * Every HTML file is self-contained - the only external references are the
 * screenshot PNGs written alongside them - so the output works as a downloaded
 * pipeline artifact with no network.
 */

export interface WriteReportOptions {
  outDir: string;
  store: ArtifactStore;
  config: DrifterConfig;
  logger: Logger;
  findings: readonly Finding[];
  stats: RunStats;
  pageStats: readonly PageStats[];
  /** Skip screenshot crops (tests, or a run captured without screenshots). */
  skipEvidence?: boolean;
}

export interface WriteReportResult {
  outDir: string;
  /** Absolute path of the report entry point. */
  indexPath: string;
  filesWritten: number;
  evidenceCount: number;
  model: ReportModel;
}

/** Schema version of `report.json`; bump when the finding shape changes. */
export const REPORT_SCHEMA_VERSION = 1;

export async function writeReport(options: WriteReportOptions): Promise<WriteReportResult> {
  const { outDir, config, logger } = options;
  const formats = new Set(config.output.formats);

  const model = aggregate({
    findings: options.findings,
    stats: options.stats,
    pageStats: options.pageStats,
    viewports: config.viewports,
  });

  let evidence: EvidenceIndex = new Map();
  if (!options.skipEvidence && formats.has('html')) {
    // Screenshots are written in device pixels; element geometry is in CSS
    // pixels. The crop needs the ratio, which only the device profiles know.
    const deviceScale = new Map(
      resolveDevices(config.viewports, config.devices).map((device) => [
        device.id,
        device.deviceScaleFactor,
      ]),
    );

    evidence = await generateEvidence({
      primaryViewport: config.primaryViewport,
      minSeverity: config.output.evidenceMinSeverity,
      store: options.store,
      outDir,
      findings: options.findings,
      mapping: createPathMapping(config.urlMapping),
      deviceScale,
      logger,
    });
  }

  const files: Array<[string, string]> = [];

  if (formats.has('json')) {
    files.push(
      [
        'report.json',
        json({
          schemaVersion: REPORT_SCHEMA_VERSION,
          snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
          stats: model.stats,
          findings: model.findings,
        }),
      ],
      ['stats.json', json(model.stats)],
      // The split files exist so a team can wire one concern into a pipeline
      // (say, broken links) without parsing and filtering the whole report.
      ['css-report.json', json({ stats: model.stats.css, findings: model.css })],
      ['links-report.json', json({ stats: model.stats.links, findings: model.links })],
      ['coverage-report.json', json({ stats: model.stats.coverage, findings: model.coverage })],
    );
  }

  if (formats.has('markdown')) {
    files.push(['summary.md', renderMarkdown(model)]);
  }

  if (formats.has('junit')) {
    files.push(['junit.xml', renderJUnit(model)]);
  }

  if (formats.has('html')) {
    // The two sites differ by host by definition, so every path shown in the
    // report is host-free; this is what lets a card say which target path a
    // source path is expected at.
    const pathMapping = createPathMapping(config.urlMapping);
    const context = {
      model,
      evidence,
      targetPathOf: (sourcePath: string): string => pathMapping.toTarget(sourcePath),
    };

    files.push(
      ['index.html', renderOverview(context)],
      ['evidence.html', renderEvidenceReport(context)],
      ['css-report.html', renderCssReport(context)],
      ['links-report.html', renderLinksReport(context)],
      ['coverage-report.html', renderCoverageReport(context)],
      [join('pages', 'index.html'), renderPageIndex(context)],
    );

    for (const page of model.pages) {
      files.push([join('pages', `${pathSlug(page.path)}.html`), renderPageDetail(page, context)]);
    }

    for (const device of model.devices) {
      files.push([deviceHref(device.viewport), renderDeviceDetail(device, context)]);
      files.push([
        join('css', `${device.viewport}.html`),
        renderCssDeviceReport(device.viewport, context),
      ]);
    }
  }

  for (const [name, contents] of files) {
    const file = join(outDir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents, 'utf8');
  }

  logger.info({ files: files.length, evidence: evidence.size, outDir }, 'report written');

  return {
    outDir,
    indexPath: join(outDir, 'index.html'),
    filesWritten: files.length,
    evidenceCount: evidence.size,
    model,
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Decide the process exit code.
 *
 * `1` means "drift exceeded the configured budget", which is what makes the
 * tool usable as a pipeline gate. A `null` warning budget means warnings never
 * fail the build - the common setting while a migration is still in progress.
 */
export function exitCodeFor(stats: RunStats, config: DrifterConfig): 0 | 1 {
  const { failOn } = config.thresholds;
  if (stats.findings.bySeverity.error > failOn.error) return 1;
  if (failOn.warning !== null && stats.findings.bySeverity.warning > failOn.warning) return 1;
  return 0;
}

/** Human summary line for the CLI, so a run ends with a verdict. */
export function summarise(stats: RunStats): string {
  const { error, warning, info } = stats.findings.bySeverity;
  return (
    `${error} error(s), ${warning} warning(s), ${info} info across ` +
    `${stats.pages.total} pages · content parity ${stats.content.contentParity.percent}% · ` +
    `style parity ${stats.css.styleParity.percent}%`
  );
}

export { pageHref };
