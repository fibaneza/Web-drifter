import { resolveDevices, type DeviceProfile } from './config/devices.js';
import type { DrifterConfig } from './config/schema.js';
import { ConfigError } from './core/errors.js';
import type { Logger } from './core/logger.js';
import type { CrawlStats, Finding, PageStats, RunStats, Side } from './core/types.js';
import { compareRun } from './compare/engine.js';
import { crawlSide } from './crawl/crawler.js';
import { createCrawlPool } from './crawl/create-pool.js';
import { ArtifactStore, formatBytes, generateRunId } from './store/artifact-store.js';
import { writeReport, type WriteReportResult } from './report/write.js';

/**
 * Pipeline orchestration.
 *
 * The CLI commands are thin wrappers over these: `crawl`, `compare` and
 * `report` each run one stage against the artifact store, and `run` chains all
 * three. Keeping the stages independently callable is the whole reason capture
 * and comparison were decoupled - re-diffing a stored crawl takes seconds,
 * which is what makes tuning ignore rules bearable.
 */

export interface StageContext {
  config: DrifterConfig;
  logger: Logger;
  store: ArtifactStore;
  runId: string;
  startedAt: string;
}

export interface CrawlOptions {
  config: DrifterConfig;
  logger: Logger;
  /** Which sides to capture. */
  sides?: readonly Side[];
  captureScreenshots?: boolean;
  /** Reuse an existing run instead of creating one. */
  store?: ArtifactStore;
}

export interface CrawlResult {
  store: ArtifactStore;
  runId: string;
  startedAt: string;
  stats: Partial<Record<Side, CrawlStats>>;
}

function resolveProfiles(config: DrifterConfig): {
  devices: DeviceProfile[];
  primary: DeviceProfile;
} {
  const devices = resolveDevices(config.viewports, config.devices);
  const primary = devices.find((device) => device.id === config.primaryViewport);
  if (!primary) {
    throw new ConfigError(
      `primaryViewport "${config.primaryViewport}" is not among the enabled viewports`,
    );
  }
  return { devices, primary };
}

export async function runCrawl(options: CrawlOptions): Promise<CrawlResult> {
  const { config, logger } = options;
  const { devices, primary } = resolveProfiles(config);

  const runId = options.store?.runId ?? generateRunId();
  const startedAt = new Date().toISOString();

  const store =
    options.store ??
    (await ArtifactStore.create(config.output.dir, {
      runId,
      startedAt,
      sourceBaseUrl: config.source.baseUrl,
      targetBaseUrl: config.target.baseUrl,
      viewports: [...config.viewports],
      schemaVersion: 1,
    }));

  const stats: Partial<Record<Side, CrawlStats>> = {};

  // Sides run sequentially rather than in parallel: each already saturates the
  // machine with `crawl.concurrency` browser contexts, and running both at once
  // mostly succeeds in making each site's pages time out.
  for (const side of options.sides ?? (['source', 'target'] as const)) {
    logger.info({ side, baseUrl: config[side].baseUrl }, 'crawling');
    const pool = await createCrawlPool(config, side, logger);
    try {
      stats[side] = await crawlSide({
        side,
        config,
        devices,
        primaryDevice: primary,
        pool,
        store,
        logger,
        captureScreenshots: options.captureScreenshots ?? true,
      });
    } finally {
      await pool.close();
    }
  }

  return { store, runId, startedAt, stats };
}

export interface CompareResult {
  findings: Finding[];
  stats: RunStats;
  pageStats: PageStats[];
}

export async function runCompare(context: StageContext): Promise<CompareResult> {
  return compareRun({
    store: context.store,
    config: context.config,
    logger: context.logger,
    runId: context.runId,
    startedAt: context.startedAt,
  });
}

export async function runReportStage(
  context: StageContext,
  comparison: CompareResult,
  options: { skipEvidence?: boolean } = {},
): Promise<WriteReportResult> {
  return writeReport({
    // Reports live inside the run directory, so a run is one self-contained
    // folder: snapshots, screenshots and the rendered report together.
    outDir: context.store.dir,
    store: context.store,
    config: context.config,
    logger: context.logger,
    findings: comparison.findings,
    stats: comparison.stats,
    pageStats: comparison.pageStats,
    ...(options.skipEvidence === undefined ? {} : { skipEvidence: options.skipEvidence }),
  });
}

export interface FullRunResult extends CompareResult {
  store: ArtifactStore;
  runId: string;
  report: WriteReportResult;
  crawl: Partial<Record<Side, CrawlStats>>;
  /** Bytes this run occupies on disk, after any pruning. */
  diskUsage: number;
}

/** Crawl both sides, compare, and write reports. */
export async function runAll(options: {
  config: DrifterConfig;
  logger: Logger;
  captureScreenshots?: boolean;
}): Promise<FullRunResult> {
  const crawl = await runCrawl({
    config: options.config,
    logger: options.logger,
    ...(options.captureScreenshots === undefined
      ? {}
      : { captureScreenshots: options.captureScreenshots }),
  });

  const context: StageContext = {
    config: options.config,
    logger: options.logger,
    store: crawl.store,
    runId: crawl.runId,
    startedAt: crawl.startedAt,
  };

  const comparison = await runCompare(context);

  // Crawl statistics are gathered by the crawler, not the comparator, so they
  // are folded in here rather than being lost between the two stages.
  if (crawl.stats.source) comparison.stats.crawl.source = crawl.stats.source;
  if (crawl.stats.target) comparison.stats.crawl.target = crawl.stats.target;

  const report = await runReportStage(context, comparison);

  // Snapshots are what make `drifter compare` re-runnable without re-crawling,
  // so they are kept by default - but they are also by far the largest thing a
  // run writes, and a scheduled pipeline that never re-diffs is paying
  // gigabytes for an option it does not use.
  if (!options.config.output.keepSnapshots) {
    await crawl.store.pruneSnapshots();
    options.logger.info(
      'snapshots pruned (output.keepSnapshots is false); `drifter compare` will need a fresh crawl',
    );
  }

  // After the report, never before: the evidence crops are cut from these.
  if (!options.config.output.keepScreenshots) {
    await crawl.store.pruneScreenshots();
    options.logger.info(
      'full-page screenshots pruned (output.keepScreenshots is false); ' +
        'evidence crops are kept, but `drifter report` can no longer cut new ones',
    );
  }

  const diskUsage = await crawl.store.diskUsage();
  options.logger.info({ bytes: diskUsage, human: formatBytes(diskUsage) }, 'run complete');

  return {
    ...comparison,
    store: crawl.store,
    runId: crawl.runId,
    report,
    crawl: crawl.stats,
    diskUsage,
  };
}

/**
 * Configuration for a self-comparison.
 *
 * `doctor` crawls the SOURCE twice and compares it against itself, so anything
 * reported is inherent non-determinism - a carousel, an A/B bucket, a rendered
 * timestamp - rather than migration drift. That is the noise floor, and it
 * should be measured before anyone trusts a single finding.
 *
 * Built by rewriting an already-validated config rather than re-parsing one:
 * the schema deliberately rejects a config whose two sides share a baseUrl,
 * which is exactly what this needs.
 */
export function toSelfComparisonConfig(config: DrifterConfig): DrifterConfig {
  return {
    ...config,
    target: { ...config.source, name: `${config.source.name} (second crawl)` },
  };
}
