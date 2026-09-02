import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every configuration option must actually be read somewhere.
 *
 * This exists because two options - `crawl.retries` and `output.keepSnapshots` -
 * shipped declared and documented but never implemented. Config that describes
 * behaviour the code does not have is worse than no config: it stops the user
 * looking for the real fix, and no type check or normal test catches it, because
 * an unread option is perfectly valid TypeScript.
 */

const SCHEMA = 'src/config/schema.ts';

/**
 * Options that are legitimately never referenced by name.
 *
 * Deliberately empty. Anything added here needs a reason in a comment, because
 * the whole point of this test is that the list stays short.
 */
const ALLOWED_UNREAD: readonly string[] = [];

function readSourceExcept(skip: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && full !== skip) files.push(full);
    }
  };
  walk('src');
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
}

describe('configuration is wired up', () => {
  it('reads every option it declares', () => {
    const schema = readFileSync(SCHEMA, 'utf8');

    // Leaf option names: an indented `name: z.` declaration in the schema.
    const declared = [
      ...new Set([...schema.matchAll(/^\s{4,}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map((m) => m[1])),
    ].filter((name): name is string => name !== undefined);

    assert.ok(declared.length > 20, `expected to find the options; found ${declared.length}`);

    const source = readSourceExcept(SCHEMA);
    const unread = declared.filter(
      (name) => !ALLOWED_UNREAD.includes(name) && !new RegExp(`\\b${name}\\b`).test(source),
    );

    assert.deepEqual(
      unread,
      [],
      `these options are declared in the schema but never read:\n  ${unread.join('\n  ')}\n` +
        'Either implement them or remove them - a documented option that does nothing ' +
        'is worse than an absent one.',
    );
  });
});
