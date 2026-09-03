import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Documentation that describes the tool that exists.
 *
 * The README documented a `drifter links` command for months. It was never
 * implemented - the idea was folded into `run` - and nothing caught it, because
 * prose is the one part of the project no test reads. Anyone following that page
 * hit "unknown command" on their first attempt.
 *
 * These are cheap checks against the two ways that drifts: a command named in
 * the docs but not registered, and a documentation file nothing links to.
 */

const root = new URL('../../', import.meta.url);
const read = (path: string): Promise<string> =>
  readFile(fileURLToPath(new URL(path, root)), 'utf8');

describe('documentation matches the CLI', () => {
  it('names only commands that are actually registered', async () => {
    const cli = await read('src/cli/index.ts');
    const registered = new Set(
      [...cli.matchAll(/\.command\('([a-z-]+)'/g)].map((match) => match[1]),
    );
    assert.ok(registered.size > 0, 'no commands found; the parser needs updating');

    const readme = await read('README.md');
    // Only the command table: prose mentions `npx drifter run` in passing, and
    // matching those would make this fire on every example.
    const documented = new Set(
      [...readme.matchAll(/^\| `drifter ([a-z-]+)/gm)].map((match) => match[1]),
    );

    const phantom = [...documented].filter((name) => !registered.has(name));
    assert.deepEqual(
      phantom,
      [],
      `the README documents commands that do not exist: ${phantom.join(', ')}`,
    );
  });

  it('documents every command that is registered', async () => {
    const cli = await read('src/cli/index.ts');
    const registered = [...cli.matchAll(/\.command\('([a-z-]+)'/g)].map((match) => match[1]);

    const readme = await read('README.md');
    const missing = registered.filter(
      // Allow the entry to carry flags, e.g. `drifter compare --run <id>`.
      (name) => name !== undefined && !new RegExp(`\`drifter ${name}[ \`]`).test(readme),
    );

    assert.deepEqual(
      missing,
      [],
      `these commands exist but are not in the README: ${missing.join(', ')}`,
    );
  });

  it('links every documentation page from the README', async () => {
    const readme = await read('README.md');
    const files = (await readdir(fileURLToPath(new URL('docs', root)))).filter((name) =>
      name.endsWith('.md'),
    );

    const unlinked = files.filter((name) => !readme.includes(`docs/${name}`));
    assert.deepEqual(
      unlinked,
      [],
      `these docs exist but nothing links to them: ${unlinked.join(', ')}`,
    );
  });
});
