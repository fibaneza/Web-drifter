import { createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ZipFile } from 'yazl';

/**
 * Zip a run directory.
 *
 * Zip rather than tar.gz because a drift report exists to be read by people: it
 * gets downloaded from a pipeline and opened, and a zip opens with a double
 * click on Windows and macOS without installing anything.
 *
 * Entry paths are always forward-slashed and relative to the run directory, so
 * the archive expands to one clean folder on any platform rather than to a
 * fragment of whoever's absolute path built it.
 */

export interface ArchiveResult {
  file: string;
  bytes: number;
  entries: number;
}

export async function archiveRun(runDir: string, outFile: string): Promise<ArchiveResult> {
  const files = await collectFiles(runDir);

  const zip = new ZipFile();
  for (const file of files) {
    // Forward slashes even on Windows: the zip spec says so, and a backslash
    // here produces one file with a slash in its name rather than a directory.
    zip.addFile(file, relative(runDir, file).split(sep).join('/'));
  }
  zip.end();

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outFile);
    out.on('close', resolve);
    out.on('error', reject);
    zip.outputStream.on('error', reject).pipe(out);
  });

  return { file: outFile, bytes: (await stat(outFile)).size, entries: files.length };
}

/** Every file under a directory, depth first, in a stable order. */
async function collectFiles(dir: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      // Not `isDirectory()`: `latest` is a symlink to a run directory, and
      // following it would archive that run a second time inside this one.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };

  await walk(dir);
  return found;
}
