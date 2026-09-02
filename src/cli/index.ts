#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { loadConfig } from '../config/load.js';
import type { DrifterConfig } from '../config/schema.js';
import { DrifterError, toMessage } from '../core/errors.js';
import { createLogger, type LogLevel, type Logger } from '../core/logger.js';
import type { Side } from '../core/types.js';
import { compareRun } from '../compare/engine.js';
import { runAll, runCrawl, runReportStage, toSelfComparisonConfig } from '../pipeline.js';
import { exitCodeFor, summarise } from '../report/write.js';
import { ArtifactStore, formatBytes } from '../store/artifact-store.js';
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
// Exit code 1 (drift over budget) is produced by `exitCodeFor`, not here.
const EXIT_ERROR = 2;

interface GlobalOptions {
  config?: string;
  logLevel: LogLevel;
  out?: string;
  maxPages?: number;
  viewports?: string[];
}

async function resolveConfig(options: GlobalOptions): Promise<DrifterConfig> {
  const overrides: Record<string, unknown> = {};
  const { config } = await loadConfig({
    ...(options.config === undefined ? {} : { configPath: options.config }),
    overrides,
  });

  // CLI flags win over the file, so a one-off run can be narrowed without
  // editing (and accidentally committing) a change to the project config.
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

// Self-execute only when invoked as the binary, so tests can import this module
// without it parsing their argv. Compared as file URLs rather than by string
// suffix, which misfires on relative paths and symlinked bin entries.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
