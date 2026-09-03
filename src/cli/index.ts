#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { loadConfig } from '../config/load.js';
import type { DrifterConfig } from '../config/schema.js';
import { ConfigError, DrifterError, StoreError, toMessage } from '../core/errors.js';
import { createLogger, type LogLevel, type Logger } from '../core/logger.js';
import type { Finding, Severity, Side } from '../core/types.js';
import { compareRun } from '../compare/engine.js';
import { runAll, runCrawl, runReportStage, toSelfComparisonConfig } from '../pipeline.js';
import {
  atOrAbove,
  countBySeverity,
  diffRuns,
  type ReportFile,
  type RunDiff,
} from '../report/diff.js';
import { renderDiffMarkdown } from '../report/diff-markdown.js';
import { archiveRun } from '../publish/archive.js';
import { s3Destination, uploadToS3 } from '../publish/s3.js';
import { exitCodeFor, summarise } from '../report/write.js';
import { ArtifactStore, formatBytes, listRuns } from '../store/artifact-store.js';
import { writeInitConfig } from './init.js';

/**
 * Command line interface.
 *
 * Exit codes are part of the contract, because the primary consumer after a
 * human is a CI pipeline:
 *
 *   0  clean, or within the configured budget
 *   1  drift exceeded `thresholds.failOn`
 *   2  the tool itself failed - config error, no browser, unreadable store
 *
 * Distinguishing 1 from 2 matters: a build that fails because the migration has
 * drifted needs a developer, whereas one that fails because Chromium is missing
 * needs an infrastructure fix, and a single non-zero code conflates them.
 */

const EXIT_OK = 0;
// `run` and `compare` reach this through `exitCodeFor`, which weighs the whole
// run against its budget; `diff` returns it directly, because a regression
// against the previous run is a budget of its own.
const EXIT_DRIFT = 1;
const EXIT_ERROR = 2;

interface GlobalOptions {
  config?: string;
  logLevel: LogLevel;
  out?: string;
  maxPages?: number;
  viewports?: string[];
  sourceUrl?: string;
  targetUrl?: string;
}

async function resolveConfig(options: GlobalOptions): Promise<DrifterConfig> {
  const overrides: Record<string, unknown> = {};
  const { config } = await loadConfig({
    ...(options.config === undefined ? {} : { configPath: options.config }),
    overrides,
  });

  // CLI flags win over the file, so a one-off run can be narrowed without
  // editing (and accidentally committing) a change to the project config.
  if (options.sourceUrl !== undefined) config.source.baseUrl = options.sourceUrl;
  if (options.targetUrl !== undefined) config.target.baseUrl = options.targetUrl;
  // The schema rejects two sides sharing a base URL, but it validated before
  // these flags were applied - so without this a flag pointing one side at the
  // other would quietly crawl a site against itself and report perfect parity.
  if (config.source.baseUrl === config.target.baseUrl) {
    throw new ConfigError(
      `source and target resolve to the same base URL (${config.source.baseUrl}). ` +
        'Point --source-url and --target-url at the two different deployments.',
    );
  }

  if (options.out !== undefined) config.output.dir = options.out;
  if (options.maxPages !== undefined) config.crawl.maxPages = options.maxPages;
  if (options.viewports !== undefined && options.viewports.length > 0) {
    config.viewports = options.viewports;
    if (!config.viewports.includes(config.primaryViewport)) {
      // Keep the primary viewport valid: extraction of viewport-independent
      // data happens there, so it has to be one of the enabled sizes.
      const [first] = config.viewports;
      if (first) config.primaryViewport = first;
    }
  }

  return config;
}

function positiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

/** Reject a malformed URL at parse time, where the message can name the flag. */
function httpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidArgumentError(`expected an absolute URL, got "${value}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidArgumentError(`expected an http(s) URL, got "${parsed.protocol}"`);
  }
  return value;
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

const program = new Command();

program
  .name('drifter')
  .description(
    'Compare a legacy website against its modern rewrite and report every drift\n' +
      'in content, images, prices, links and CSS across desktop, tablet and mobile.',
  )
  .option('-c, --config <path>', 'path to a drifter config file')
  .option('-o, --out <dir>', 'output directory (overrides output.dir)')
  .option('--source-url <url>', 'legacy site base URL (overrides source.baseUrl)', httpUrl)
  .option('--target-url <url>', 'modern site base URL (overrides target.baseUrl)', httpUrl)
  .option('--max-pages <n>', 'cap pages crawled per side', positiveInt)
  .option('--viewports <list>', 'comma-separated viewport ids', commaList)
  .option('--log-level <level>', 'trace|debug|info|warn|error|silent', 'info');

function loggerFor(): Logger {
  const options = program.opts<GlobalOptions>();
  return createLogger(options.logLevel);
}

/* ------------------------------------------------------------------ init -- */

program
  .command('init')
  .description('scaffold a drifter.config.ts')
  .option('--force', 'overwrite an existing config', false)
  .action(async (options: { force: boolean }) => {
    await run(async (logger) => {
      const file = await writeInitConfig(process.cwd(), options.force);
      logger.info({ file }, 'configuration written');
      process.stdout.write(
        `\nCreated ${file}\n\nNext:\n` +
          `  1. Set source.baseUrl and target.baseUrl\n` +
          `  2. Run \`drifter doctor\` to measure the noise floor\n` +
          `  3. Run \`drifter run\`\n\n`,
      );
      return EXIT_OK;
    });
  });

/* ------------------------------------------------------------------- run -- */

program
  .command('run', { isDefault: true })
  .description('crawl both sites, compare them and write reports')
  .option('--no-screenshots', 'skip screenshot capture and evidence crops')
  .action(async (options: { screenshots: boolean }) => {
    await run(async (logger) => {
      const config = await resolveConfig(program.opts<GlobalOptions>());
      const result = await runAll({ config, logger, captureScreenshots: options.screenshots });

      report(result.stats, result.report.indexPath);
      process.stdout.write(`Run size: ${formatBytes(result.diskUsage)}\n\n`);
      return exitCodeFor(result.stats, config);
    });
  });

/* ----------------------------------------------------------------- crawl -- */

program
  .command('crawl')
  .description('capture snapshots only, so a comparison can be re-run later')
  .option('--side <side>', 'source | target | both', 'both')
  .option('--no-screenshots', 'skip screenshot capture')
  .action(async (options: { side: string; screenshots: boolean }) => {
    await run(async (logger) => {
      const config = await resolveConfig(program.opts<GlobalOptions>());

      const sides: Side[] = options.side === 'both' ? ['source', 'target'] : [asSide(options.side)];

      const result = await runCrawl({
        config,
        logger,
        sides,
        captureScreenshots: options.screenshots,
      });

      process.stdout.write(`\nRun ${result.runId} captured in ${result.store.dir}\n`);
      process.stdout.write(`Compare it with: drifter compare --run ${result.runId}\n\n`);
      return EXIT_OK;
    });
  });

/* --------------------------------------------------------------- compare -- */

program
  .command('compare')
  .description('re-diff stored snapshots without re-crawling')
  .option('--run <id>', 'run id (defaults to the most recent)')
  .option('--no-screenshots', 'skip evidence crops')
  .action(async (options: { run?: string; screenshots: boolean }) => {
    await run(async (logger) => {
      const config = await resolveConfig(program.opts<GlobalOptions>());
      const store = await ArtifactStore.open(config.output.dir, options.run);

      const startedAt = new Date().toISOString();
      const comparison = await compareRun({
        store,
        config,
        logger,
        runId: store.runId,
        startedAt,
      });

      const written = await runReportStage(
        { config, logger, store, runId: store.runId, startedAt },
        comparison,
        { skipEvidence: !options.screenshots },
      );

      report(comparison.stats, written.indexPath);
      return exitCodeFor(comparison.stats, config);
    });
  });

/* ---------------------------------------------------------------- report -- */

program
  .command('report')
  .description('re-render reports from a stored run')
  .option('--run <id>', 'run id (defaults to the most recent)')
  .action(async (options: { run?: string }) => {
    await run(async (logger) => {
      const config = await resolveConfig(program.opts<GlobalOptions>());
      const store = await ArtifactStore.open(config.output.dir, options.run);

      const startedAt = new Date().toISOString();
      const comparison = await compareRun({
        store,
        config,
        logger,
        runId: store.runId,
        startedAt,
      });
      const written = await runReportStage(
        { config, logger, store, runId: store.runId, startedAt },
        comparison,
      );

      process.stdout.write(`\nReport: ${written.indexPath}\n\n`);
      return EXIT_OK;
    });
  });

/* ------------------------------------------------------------------ diff -- */

program
  .command('diff')
  .description('compare two stored runs and report what is new, fixed or changed')
  .option('--since <id>', 'baseline run id (defaults to the run before --run)')
  .option('--run <id>', 'current run id (defaults to the most recent)')
  .option('--fail-on <severity>', 'new findings at or above this fail the command', 'error')
  .option('--no-fail', 'report only; never exit non-zero')
  .action(async (options: { since?: string; run?: string; failOn: string; fail: boolean }) => {
    await run(async (logger) => {
      const config = await resolveConfig(program.opts<GlobalOptions>());
      const floor = asSeverity(options.failOn);

      const { baselineId, currentId } = await resolveRunPair(
        config.output.dir,
        options.since,
        options.run,
      );

      const [baseline, current] = await Promise.all([
        ArtifactStore.open(config.output.dir, baselineId),
        ArtifactStore.open(config.output.dir, currentId),
      ]);

      const [baselineReport, currentReport] = await Promise.all([
        readReport(baseline, baselineId),
        readReport(current, currentId),
      ]);

      logger.info({ baseline: baselineId, current: currentId }, 'comparing runs');
      const diff = diffRuns(baselineReport, currentReport);

      // Written into the CURRENT run, so a run directory stays the one place
      // holding everything known about that run.
      await current.writeJson('diff.json', diff);
      await current.writeText('diff.md', `${renderDiffMarkdown(diff)}\n`);

      const gating = atOrAbove(diff.added, floor);
      printDiff(diff, gating, floor, join(current.dir, 'diff.md'));

      // `--no-fail` makes this a diagnostic like `doctor`, rather than a gate.
      if (!options.fail || gating.length === 0) return EXIT_OK;
      return EXIT_DRIFT;
    });
  });

/**
 * Which two runs to compare.
 *
 * With no flags this is "the two most recent", which is the question people
 * actually ask - did the last change help? A baseline is only defaulted when one
 * exists; comparing a first run against nothing is a mistake worth naming rather
 * than silently reporting every finding as new.
 */
async function resolveRunPair(
  baseDir: string,
  since: string | undefined,
  runId: string | undefined,
): Promise<{ baselineId: string; currentId: string }> {
  const runs = await listRuns(baseDir);
  if (runs.length === 0) {
    throw new StoreError(`No runs found in ${baseDir}. Run \`drifter run\` first.`);
  }

  const currentId = runId ?? runs.at(-1);
  if (currentId === undefined || !runs.includes(currentId)) {
    throw new StoreError(`Run ${String(runId)} not found in ${baseDir}.`);
  }

  if (since !== undefined) {
    if (!runs.includes(since)) throw new StoreError(`Run ${since} not found in ${baseDir}.`);
    if (since === currentId) {
      throw new StoreError('--since and --run name the same run; there is nothing to compare.');
    }
    return { baselineId: since, currentId };
  }

  const previous = runs[runs.indexOf(currentId) - 1];
  if (previous === undefined) {
    throw new StoreError(
      `Run ${currentId} is the earliest stored run, so there is no baseline to compare it ` +
        'against. Run `drifter run` again, or name a baseline with --since.',
    );
  }
  return { baselineId: previous, currentId };
}

/** A run with no `report.json` cannot be compared, and it is worth saying why. */
async function readReport(store: ArtifactStore, runId: string): Promise<ReportFile> {
  const report = await store.readJson<ReportFile>('report.json');
  if (!report) {
    throw new StoreError(
      `Run ${runId} has no report.json, so its findings cannot be compared. ` +
        'Re-render it with `drifter report --run ' +
        `${runId}\`, or check that 'json' is in output.formats.`,
    );
  }
  return report;
}

function asSeverity(value: string): Severity {
  if (value === 'error' || value === 'warning' || value === 'info') return value;
  throw new ConfigError(`--fail-on must be error, warning or info (got "${value}")`);
}

function printDiff(
  diff: RunDiff,
  gating: readonly Finding[],
  floor: Severity,
  markdownPath: string,
): void {
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`Comparing ${diff.baseline.runId} -> ${diff.current.runId}\n\n`);

  for (const warning of diff.warnings) process.stdout.write(`WARNING: ${warning}\n\n`);

  const added = countBySeverity(diff.added);
  process.stdout.write(
    `  new       ${String(diff.added.length).padStart(4)}` +
      `   (${added.error} error, ${added.warning} warning, ${added.info} info)\n` +
      `  fixed     ${String(diff.fixed.length).padStart(4)}\n` +
      `  changed   ${String(diff.changed.length).padStart(4)}\n` +
      `  unchanged ${String(diff.unchanged).padStart(4)}\n\n`,
  );

  const escalated = diff.changed.filter((entry) => entry.escalated);
  if (escalated.length > 0) {
    // Not gated on, but a warning that became an error is a regression in all
    // but name, so it must not be buried.
    process.stdout.write(
      `${escalated.length} finding(s) got more serious without being new:\n` +
        `${escalated
          .slice(0, 5)
          .map(
            (entry) =>
              `  ${entry.previous.severity} -> ${entry.current.severity}  ${entry.current.path}  ${entry.current.label}\n`,
          )
          .join('')}\n`,
    );
  }

  if (diff.added.length === 0) {
    process.stdout.write('No new findings since the baseline.\n\n');
  } else {
    process.stdout.write(
      `${gating.length} new finding(s) at or above ${floor}:\n` +
        `${gating
          .slice(0, 10)
          .map((finding) => `  ${finding.severity}  ${finding.path}  ${finding.label}\n`)
          .join('')}\n`,
    );
  }

  process.stdout.write(`Full detail: ${markdownPath}\n\n`);
}

/* --------------------------------------------------------------- publish -- */

program
  .command('publish')
  .description('zip a stored run and upload it to S3 with the AWS CLI')
  .option('--run <id>', 'run id (defaults to the most recent)')
  .option('--bucket <name>', 'S3 bucket (overrides output.publish.bucket)')
  .option('--prefix <path>', 'key prefix within the bucket')
  .option('--s3-uri <uri>', 'full s3://bucket/prefix destination')
  .option('--keep-archive', 'keep the local zip after uploading', false)
  .option('--dry-run', 'build the archive and print the command without uploading', false)
  .action(
    async (options: {
      run?: string;
      bucket?: string;
      prefix?: string;
      s3Uri?: string;
      keepArchive: boolean;
      dryRun: boolean;
    }) => {
      await run(async (logger) => {
        const config = await resolveConfig(program.opts<GlobalOptions>());
        const store = await ArtifactStore.open(config.output.dir, options.run);

        const fileName = `drift-${store.runId}.zip`;
        // Resolved before archiving: a missing bucket should fail in a second,
        // not after zipping a gigabyte of screenshots.
        const destination = s3Destination({
          bucket: options.bucket ?? config.output.publish.bucket,
          prefix: options.prefix ?? config.output.publish.prefix,
          uri: options.s3Uri,
          fileName,
        });

        // Written beside the run rather than inside it, or the archive would be
        // racing to include itself.
        const archivePath = join(config.output.dir, fileName);
        logger.info({ runId: store.runId }, 'archiving run');
        const archive = await archiveRun(store.dir, archivePath);
        logger.info(
          { file: archive.file, entries: archive.entries, human: formatBytes(archive.bytes) },
          'archive written',
        );

        const upload = await uploadToS3({
          file: archive.file,
          destination,
          extraArgs: config.output.publish.args,
          dryRun: options.dryRun,
        });

        if (!options.keepArchive && upload.uploaded) await rm(archive.file, { force: true });

        process.stdout.write(`\n${'='.repeat(64)}\n`);
        process.stdout.write(
          `Run ${store.runId} \u00b7 ${archive.entries} files \u00b7 ${formatBytes(archive.bytes)}\n\n`,
        );
        if (upload.uploaded) {
          process.stdout.write(`Uploaded to ${upload.destination}\n`);
          if (options.keepArchive) process.stdout.write(`Archive kept at ${archive.file}\n`);
        } else {
          process.stdout.write(
            `Dry run - nothing was uploaded.\n\n  ${upload.command}\n\n` +
              `Archive left at ${archive.file}\n`,
          );
        }
        process.stdout.write('\n');

        return EXIT_OK;
      });
    },
  );

/* ---------------------------------------------------------------- doctor -- */

program
  .command('doctor')
  .description('crawl the source twice and diff it against itself to measure noise')
  .action(async () => {
    await run(async (logger) => {
      const config = await resolveConfig(program.opts<GlobalOptions>());
      const selfConfig = toSelfComparisonConfig(config);

      logger.info('crawling the source twice to measure inherent non-determinism');
      const result = await runAll({ config: selfConfig, logger, captureScreenshots: false });

      const total = result.stats.findings.total;
      process.stdout.write(`\n${'='.repeat(64)}\n`);

      if (total === 0) {
        process.stdout.write(
          'Noise floor: clean.\n\n' +
            'The source compared against itself produced no findings, so every\n' +
            'finding in a real run is a genuine difference.\n\n',
        );
        return EXIT_OK;
      }

      // Anything here is noise BY CONSTRUCTION - both sides are the same site.
      process.stdout.write(
        `Noise floor: ${total} finding(s) comparing the source against itself.\n\n` +
          'These are NOT migration drift. Every one is inherent non-determinism -\n' +
          'a carousel, an A/B bucket, a rendered timestamp - and each will appear\n' +
          'as a false positive in a real run until it is suppressed.\n\n' +
          'Suggested configuration:\n\n',
      );
      process.stdout.write(suggestIgnores(result.findings.map((f) => f.id)));
      process.stdout.write(`\nFull detail: ${result.report.indexPath}\n\n`);

      // Deliberately exit 0: doctor is a diagnostic, not a gate.
      return EXIT_OK;
    });
  });

/* ------------------------------------------------------------------------- */

function suggestIgnores(ids: readonly string[]): string {
  const listed = ids.slice(0, 40);
  const lines = [
    '  ignore: {',
    '    findingIds: [',
    ...listed.map((id) => `      '${id}',`),
    '    ],',
    '  },',
  ];
  if (ids.length > listed.length) {
    lines.push(`  // ...and ${ids.length - listed.length} more; see report.json`);
  }
  return `${lines.join('\n')}\n`;
}

function report(stats: Parameters<typeof summarise>[0], indexPath: string): void {
  process.stdout.write(`\n${'='.repeat(64)}\n${summarise(stats)}\n`);
  process.stdout.write(`Report: ${indexPath}\n\n`);
}

function asSide(value: string): Side {
  if (value === 'source' || value === 'target') return value;
  throw new InvalidArgumentError('--side must be source, target or both');
}

/**
 * Run a command, mapping failures onto the documented exit codes.
 *
 * A `DrifterError` is a problem the user can act on (bad config, no browser),
 * so it is reported as a single clear line. Anything else is a bug in this
 * tool, and its stack is printed because someone will need it.
 */
async function run(action: (logger: Logger) => Promise<number>): Promise<void> {
  const logger = loggerFor();
  try {
    process.exitCode = await action(logger);
  } catch (error) {
    if (error instanceof DrifterError) {
      process.stderr.write(`\n${error.name}: ${error.message}\n\n`);
    } else {
      process.stderr.write(`\nUnexpected failure: ${toMessage(error)}\n`);
      if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n\n`);
    }
    process.exitCode = EXIT_ERROR;
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  await program.parseAsync([...argv]);
}

/**
 * Was this module run as the binary, rather than imported by a test?
 *
 * `argv[1]` is the path as invoked, but `import.meta.url` is always the real
 * path - Node resolves symlinks when loading a module. An installed or linked
 * `drifter` is a symlink in the bin directory, so comparing the two directly
 * never matched and the binary parsed nothing, printed nothing and exited 0.
 * Resolving `argv[1]` first is what makes the installed command work at all.
 */
export function isDirectRun(entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // argv[1] can name something unstattable (an eval, a deleted file).
    return false;
  }
}

if (isDirectRun(process.argv[1])) {
  await main();
}
