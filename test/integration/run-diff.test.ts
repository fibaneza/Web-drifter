import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createFinding } from '../../src/compare/findings.js';
import type { Finding, RunStats } from '../../src/core/types.js';
import { ArtifactStore } from '../../src/store/artifact-store.js';

/**
 * `drifter diff` through the real CLI.
 *
 * Exercised by spawning the command rather than calling the action directly,
 * because the exit code IS the feature here - a gate that reports correctly but
 * always exits 0 is not a gate. Runs are written as report payloads rather than
 * crawled: the pipeline that produces them is covered elsewhere, and two real
 * crawls would add half a minute to the suite for no extra confidence.
 */

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));

interface DiffFile {
  added: Finding[];
  fixed: Finding[];
  changed: Array<{ escalated: boolean }>;
  unchanged: number;
  warnings: string[];
}

function stats(runId: string): RunStats {
  return {
    runId,
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:05:00.000Z',
    durationMs: 300_000,
    sourceBaseUrl: 'https://legacy.example.com',
    targetBaseUrl: 'https://new.example.com',
    viewports: ['desktop'],
  } as RunStats;
}

function finding(path: string, actual = 'drifted'): Finding {
  return createFinding({
    category: 'content.drift',
    severity: 'error',
    path,
    label: `Text drifted on ${path}`,
    subject: 'node#0',
    expected: 'original',
    actual,
  });
}

describe('drifter diff (end to end)', () => {
  let outDir: string;
  let configPath: string;

  /** Write a run directory holding just enough for a diff: run.json + report.json. */
  async function writeRun(runId: string, findings: Finding[]): Promise<void> {
    const store = await ArtifactStore.create(outDir, {
      runId,
      startedAt: '2026-09-03T10:00:00.000Z',
      sourceBaseUrl: 'https://legacy.example.com',
      targetBaseUrl: 'https://new.example.com',
      viewports: ['desktop'],
      schemaVersion: 1,
    });
    await store.writeJson('report.json', { stats: stats(runId), findings });
  }

  async function runDiff(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await exec('npx', ['tsx', CLI, '-c', configPath, 'diff', ...args]);
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: failure.code ?? -1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  }

  before(async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'drifter-diff-'));
    outDir = join(workDir, 'runs');
    configPath = join(workDir, 'drifter.config.mjs');

    await rm(configPath, { force: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      configPath,
      `export default {
  source: { name: 'legacy', baseUrl: 'https://legacy.example.com' },
  target: { name: 'modern', baseUrl: 'https://new.example.com' },
  output: { dir: ${JSON.stringify(outDir)} },
};\n`,
      'utf8',
    );

    // Ordered by run id, which is how the command picks a default baseline.
    await writeRun('2026-09-01T09-00-00-000', [finding('/'), finding('/contact')]);
    await writeRun('2026-09-02T09-00-00-000', [
      finding('/'), // unchanged
      finding('/pricing'), // new
      // '/contact' is gone: fixed
    ]);
  });

  after(async () => {
    if (outDir) await rm(join(outDir, '..'), { recursive: true, force: true });
  });

  it('classifies the two most recent runs with no flags at all', async () => {
    const { stdout } = await runDiff(['--no-fail']);

    assert.match(stdout, /Comparing 2026-09-01T09-00-00-000 -> 2026-09-02T09-00-00-000/);
    assert.match(stdout, /new\s+1/);
    assert.match(stdout, /fixed\s+1/);
    assert.match(stdout, /unchanged\s+1/);
  });

  it('writes diff.json and diff.md into the current run', async () => {
    await runDiff(['--no-fail']);

    const runDir = join(outDir, '2026-09-02T09-00-00-000');
    assert.ok(existsSync(join(runDir, 'diff.json')), 'no diff.json');
    assert.ok(existsSync(join(runDir, 'diff.md')), 'no diff.md');

    const diff = JSON.parse(await readFile(join(runDir, 'diff.json'), 'utf8')) as DiffFile;
    assert.deepEqual(
      diff.added.map((f) => f.path),
      ['/pricing'],
    );
    assert.deepEqual(
      diff.fixed.map((f) => f.path),
      ['/contact'],
    );
    assert.equal(diff.unchanged, 1);
    assert.deepEqual(diff.warnings, [], 'these runs are directly comparable');

    const markdown = await readFile(join(runDir, 'diff.md'), 'utf8');
    assert.match(markdown, /# web-drifter run comparison/);
    assert.match(markdown, /## New findings/);
    assert.match(markdown, /`\/pricing`/);
  });

  it('exits non-zero when a new finding appears, so it can gate a pipeline', async () => {
    const { code } = await runDiff([]);
    assert.equal(code, 1, 'a new error must fail the command');
  });

  it('exits zero for the same comparison under --no-fail', async () => {
    const { code } = await runDiff(['--no-fail']);
    assert.equal(code, 0);
  });

  it('passes when the only new finding sits below the fail-on threshold', async () => {
    // The third run adds nothing but a warning. Under the default error floor
    // that must pass, and under a warning floor the same comparison must fail -
    // asserting both is what proves the threshold is actually consulted rather
    // than the command always gating on "any new finding".
    await writeRun('2026-09-03T09-00-00-000', [
      finding('/'),
      finding('/pricing'),
      createFinding({
        category: 'content.added',
        severity: 'warning',
        path: '/blog',
        label: 'Extra paragraph on /blog',
        subject: 'node#0',
      }),
    ]);

    const lenient = await runDiff(['--fail-on', 'error']);
    assert.equal(lenient.code, 0, 'a new warning must not trip the error gate');

    const strict = await runDiff(['--fail-on', 'warning']);
    assert.equal(strict.code, 1, 'the same warning must trip a warning gate');
  });

  it('refuses to compare a run against itself instead of reporting a clean result', async () => {
    // Silently reporting "nothing changed" would be the worst answer here: it
    // reads exactly like a clean deploy.
    const { code, stderr } = await runDiff([
      '--since',
      '2026-09-01T09-00-00-000',
      '--run',
      '2026-09-01T09-00-00-000',
    ]);

    assert.equal(code, 2);
    assert.match(stderr, /nothing to compare/);
  });

  it('refuses to guess a baseline for the earliest run', async () => {
    const { code, stderr } = await runDiff(['--run', '2026-09-01T09-00-00-000']);

    assert.equal(code, 2, 'no baseline exists before the first run');
    assert.match(stderr, /earliest stored run/);
  });

  it('rejects an unknown severity for --fail-on', async () => {
    const { code, stderr } = await runDiff(['--fail-on', 'critical']);

    assert.equal(code, 2);
    assert.match(stderr, /must be error, warning or info/);
  });
});
