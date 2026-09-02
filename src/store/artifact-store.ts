import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StoreError } from '../core/errors.js';
import { SNAPSHOT_SCHEMA_VERSION, type PageSnapshot, type Side } from '../core/types.js';

/**
 * On-disk artifact store.
 *
 * Capture and comparison are deliberately decoupled by this store rather than
 * being one pipeline in memory. Crawling is by far the slowest part of a run,
 * and tuning ignore rules is inherently iterative - being able to re-diff a
 * stored crawl in seconds, instead of re-crawling for twenty minutes, is the
 * difference between a tool people tune and a tool people abandon. It also lets
 * CI crawl once and compare many times, and makes a run reproducible after the
 * fact.
 *
 * Layout:
 *
 *   <outDir>/<runId>/
 *     run.json                          run metadata
 *     snapshots/<side>/<slug>.json      one captured page
 *     screenshots/<side>/<slug>/<device>.png
 *     findings.json  stats.json         comparison output
 *   <outDir>/latest -> <runId>
 */

export interface RunMetadata {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  sourceBaseUrl: string;
  targetBaseUrl: string;
  viewports: string[];
  schemaVersion: number;
}

/**
 * Filesystem-safe, human-recognisable name for a canonical path.
 *
 * The readable prefix matters: someone debugging a run should be able to find
 * the artifacts for `/products/hats` without grepping. The hash suffix keeps it
 * collision-free, since slugification is lossy and `/a/b` and `/a-b` would
 * otherwise collide.
 */
export function pathSlug(pathKey: string): string {
  const hash = createHash('sha1').update(pathKey).digest('hex').slice(0, 8);
  const readable = pathKey
    .replace(/^\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return readable === '' ? `root-${hash}` : `${readable}-${hash}`;
}

/** Timestamped, sortable, filesystem-safe run id. */
export function generateRunId(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

export class ArtifactStore {
  readonly dir: string;
  readonly runId: string;

  private constructor(dir: string, runId: string) {
    this.dir = dir;
    this.runId = runId;
  }

  /** Create a fresh run directory and point `latest` at it. */
  static async create(baseDir: string, metadata: RunMetadata): Promise<ArtifactStore> {
    const dir = resolve(baseDir, metadata.runId);
    await mkdir(join(dir, 'snapshots', 'source'), { recursive: true });
    await mkdir(join(dir, 'snapshots', 'target'), { recursive: true });
    await mkdir(join(dir, 'screenshots'), { recursive: true });

    const store = new ArtifactStore(dir, metadata.runId);
    await store.writeJson('run.json', { ...metadata, schemaVersion: SNAPSHOT_SCHEMA_VERSION });
    await updateLatestLink(baseDir, metadata.runId);
    return store;
  }

  /** Open an existing run, or the most recent one when `runId` is omitted. */
  static async open(baseDir: string, runId?: string): Promise<ArtifactStore> {
    const resolved = runId ?? (await findLatestRun(baseDir));
    if (!resolved) {
      throw new StoreError(`No runs found in ${baseDir}. Run \`drifter crawl\` first.`);
    }

    const dir = resolve(baseDir, resolved);
    if (!existsSync(join(dir, 'run.json'))) {
      throw new StoreError(`Run ${resolved} is missing run.json - it may be incomplete.`);
    }

    const store = new ArtifactStore(dir, resolved);
    const metadata = await store.readJson<RunMetadata>('run.json');
    if (metadata && metadata.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      throw new StoreError(
        `Run ${resolved} uses snapshot schema v${metadata.schemaVersion}, ` +
          `but this version of drifter reads v${SNAPSHOT_SCHEMA_VERSION}. Re-crawl to compare.`,
      );
    }
    return store;
  }

  snapshotPath(side: Side, pathKey: string): string {
    return join(this.dir, 'snapshots', side, `${pathSlug(pathKey)}.json`);
  }

  screenshotPath(side: Side, pathKey: string, device: string): string {
    return join(this.dir, 'screenshots', side, pathSlug(pathKey), `${device}.png`);
  }

  async writeSnapshot(snapshot: PageSnapshot): Promise<void> {
    const file = this.snapshotPath(snapshot.side, snapshot.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(snapshot), 'utf8');
  }

  async readSnapshot(side: Side, pathKey: string): Promise<PageSnapshot | null> {
    return this.readJsonFile<PageSnapshot>(this.snapshotPath(side, pathKey));
  }

  /** Canonical path keys captured for a side, in stable order. */
  async listPaths(side: Side): Promise<string[]> {
    const paths: string[] = [];
    for await (const snapshot of this.iterateSnapshots(side)) paths.push(snapshot.path);
    return paths.sort();
  }

  /**
   * Stream snapshots one at a time.
   *
   * A crawl of a thousand pages with styles at four viewports is far too large
   * to hold in memory at once, so comparison consumes them as a stream.
   */
  async *iterateSnapshots(side: Side): AsyncGenerator<PageSnapshot> {
    const dir = join(this.dir, 'snapshots', side);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const snapshot = await this.readJsonFile<PageSnapshot>(join(dir, entry));
      if (snapshot) yield snapshot;
    }
  }

  async writeScreenshot(
    side: Side,
    pathKey: string,
    device: string,
    data: Buffer,
  ): Promise<string> {
    const file = this.screenshotPath(side, pathKey, device);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
    return file;
  }

  async writeJson(name: string, data: unknown): Promise<void> {
    const file = join(this.dir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  }

  async readJson<T>(name: string): Promise<T | null> {
    return this.readJsonFile<T>(join(this.dir, name));
  }

  async writeText(name: string, contents: string): Promise<void> {
    const file = join(this.dir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents, 'utf8');
  }

  private async readJsonFile<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (cause) {
      // A missing file is a normal "not captured" answer; malformed JSON is not.
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StoreError(`Could not read ${file}`, { cause });
    }
  }
}

/** Most recent run directory by name, which sorts chronologically by design. */
async function findLatestRun(baseDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return null;
  }
  const runs = entries.filter((e) => e !== 'latest' && existsSync(join(baseDir, e, 'run.json')));
  return runs.sort().at(-1) ?? null;
}

/**
 * Point `<outDir>/latest` at this run so scripts and CI can reference a stable
 * path. Symlinks are unavailable on some Windows setups and in some containers,
 * so failure is non-fatal - a convenience, not a correctness requirement.
 */
async function updateLatestLink(baseDir: string, runId: string): Promise<void> {
  const link = join(baseDir, 'latest');
  try {
    await rm(link, { force: true, recursive: true });
    await symlink(runId, link, 'dir');
  } catch {
    // Best effort only.
  }
}
