import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveRun } from '../../src/publish/archive.js';
import { s3Destination, uploadToS3 } from '../../src/publish/s3.js';

/**
 * Archiving and uploading a run.
 *
 * The upload shells out to the AWS CLI, so these cover everything up to that
 * boundary: the destination the command is pointed at, and the archive it is
 * handed. Whether S3 accepts it is the CLI's business and cannot be asserted
 * without credentials.
 */

describe('s3Destination', () => {
  it('builds a key from a bucket and prefix', () => {
    assert.equal(
      s3Destination({ bucket: 'drift-reports', prefix: 'vplates', fileName: 'drift-r1.zip' }),
      's3://drift-reports/vplates/drift-r1.zip',
    );
  });

  it('works with no prefix at all', () => {
    assert.equal(
      s3Destination({ bucket: 'drift-reports', fileName: 'drift-r1.zip' }),
      's3://drift-reports/drift-r1.zip',
    );
  });

  it('tolerates whatever slashes a pipeline variable happens to carry', () => {
    assert.equal(
      s3Destination({ bucket: 'drift-reports/', prefix: '/nightly/', fileName: 'r.zip' }),
      's3://drift-reports/nightly/r.zip',
    );
  });

  it('accepts a whole s3:// URI, since a pipeline usually already has one', () => {
    assert.equal(
      s3Destination({ uri: 's3://drift-reports/nightly', fileName: 'r.zip' }),
      's3://drift-reports/nightly/r.zip',
    );
  });

  it('refuses a destination that is not S3 rather than guessing', () => {
    assert.throws(
      () => s3Destination({ uri: 'https://example.com/bucket', fileName: 'r.zip' }),
      /must start with s3:\/\//,
    );
  });

  it('says what to set when there is no destination', () => {
    assert.throws(() => s3Destination({ fileName: 'r.zip' }), /--bucket|output\.publish\.bucket/);
  });
});

describe('uploadToS3', () => {
  it('passes arguments as an array, so a bucket name cannot become a command', async () => {
    // A bucket or prefix out of a config file is not a trusted value. Through a
    // shell, `; rm -rf /` in one would run; through execFile it is just an
    // argument. The dry run reports the command without executing anything.
    const result = await uploadToS3({
      file: '/tmp/drift.zip',
      destination: 's3://bucket/; rm -rf /',
      dryRun: true,
    });

    assert.equal(result.uploaded, false);
    assert.equal(result.command, 'aws s3 cp /tmp/drift.zip s3://bucket/; rm -rf /');
  });

  it('carries extra arguments through, for encryption and storage class', async () => {
    const result = await uploadToS3({
      file: '/tmp/drift.zip',
      destination: 's3://bucket/r.zip',
      extraArgs: ['--sse', 'aws:kms'],
      dryRun: true,
    });

    assert.match(result.command, /--sse aws:kms$/);
  });
});

describe('archiveRun', () => {
  let workDir: string;

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'drifter-archive-'));
  });

  after(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('archives a run, keeping its directory structure', async () => {
    const runDir = join(workDir, 'run-1');
    await mkdir(join(runDir, 'pages'), { recursive: true });
    await writeFile(join(runDir, 'index.html'), '<h1>report</h1>', 'utf8');
    await writeFile(join(runDir, 'report.json'), '{"findings":[]}', 'utf8');
    await writeFile(join(runDir, 'pages', 'home.html'), '<p>page</p>', 'utf8');

    const archive = await archiveRun(runDir, join(workDir, 'run-1.zip'));

    assert.equal(archive.entries, 3);
    assert.ok(archive.bytes > 0, 'the archive is empty');

    // Entry names are relative and forward-slashed, so it expands to one clean
    // folder rather than to a fragment of whoever's absolute path built it.
    const raw = await readArchive(archive.file);
    assert.ok(raw.includes('pages/home.html'), `no forward-slashed entry: ${raw.slice(0, 200)}`);
    assert.ok(!raw.includes(runDir), 'the archive leaks an absolute path');
  });

  it('does not follow the `latest` symlink back into another run', async () => {
    // `<outDir>/latest` points at a run directory. Following it would archive
    // that run a second time, inside this one.
    const runDir = join(workDir, 'run-2');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'index.html'), 'x', 'utf8');
    const { symlink } = await import('node:fs/promises');
    await symlink(runDir, join(runDir, 'latest'), 'dir').catch(() => undefined);

    const archive = await archiveRun(runDir, join(workDir, 'run-2.zip'));
    assert.equal(archive.entries, 1);
  });
});

/** Entry names live as plain text in a zip's local headers. */
async function readArchive(file: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return (await readFile(file)).toString('latin1');
}
