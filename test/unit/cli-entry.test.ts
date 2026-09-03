import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../src/cli/index.js';

/**
 * The binary must actually run when invoked through its bin symlink.
 *
 * `npm install -g` and `npm link` both put a symlink in the bin directory, so
 * `process.argv[1]` is that symlink while `import.meta.url` is the real module
 * path. Comparing them without resolving first silently matched nothing: the
 * installed `drifter` printed no output and exited 0, for every command.
 */

const cliPath = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drifter-bin-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('isDirectRun', () => {
  it('recognises the module invoked by its own path', () => {
    assert.equal(isDirectRun(cliPath), true);
  });

  it('recognises the module invoked through a bin symlink', async () => {
    const link = join(dir, 'drifter');
    await symlink(cliPath, link);
    assert.equal(isDirectRun(link), true);
  });

  it('does not fire for another entry point, so tests can import this module', () => {
    assert.equal(isDirectRun(fileURLToPath(import.meta.url)), false);
  });

  it('does not fire when argv[1] is absent or unstattable', () => {
    assert.equal(isDirectRun(undefined), false);
    assert.equal(isDirectRun(join(dir, 'no-such-file')), false);
  });
});
