import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
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

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/**
 * Snapshots are gzipped on disk.
 *
 * A snapshot carries every allowlisted computed property for every matched node
 * at every viewport, which measures around 1.8 KB per node-viewport - so a
 * 500-node page at four viewports is roughly 3.6 MB, and a 1000-page site runs
 * to several gigabytes per side. The content is highly repetitive JSON, which
 * gzip reduces by roughly an order of magnitude for the cost of a few
 * milliseconds per page against a capture that already took seconds.
 *
 * Reads accept either extension, so a run captured by an older version is still
 * comparable without re-crawling.
 */
const SNAPSHOT_EXT = '.json.gz';
const LEGACY_SNAPSHOT_EXT = '.json';

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
    return join(this.dir, 'snapshots', side, `${pathSlug(pathKey)}${SNAPSHOT_EXT}`);
  }

  screenshotPath(side: Side, pathKey: string, device: string): string {
    return join(this.dir, 'screenshots', side, pathSlug(pathKey), `${device}.png`);
  }

  async writeSnapshot(snapshot: PageSnapshot): Promise<void> {
    const file = this.snapshotPath(snapshot.side, snapshot.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await gzip(JSON.stringify(snapshot)));
  }

  async readSnapshot(side: Side, pathKey: string): Promise<PageSnapshot | null> {
    const compressed = await this.readSnapshotFile(this.snapshotPath(side, pathKey));
    if (compressed) return compressed;

    // Fall back to the uncompressed layout so a run captured by an earlier
    // version can still be compared without being re-crawled.
    const legacy = join(this.dir, 'snapshots', side, `${pathSlug(pathKey)}${LEGACY_SNAPSHOT_EXT}`);
    return this.readSnapshotFile(legacy);
  }

  /** Read a snapshot, transparently handling both the gzipped and plain layouts. */
  private async readSnapshotFile(file: string): Promise<PageSnapshot | null> {
    let raw: Buffer;
    try {
      raw = await readFile(file);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StoreError(`Could not read ${file}`, { cause });
    }

    try {
      const json = file.endsWith(SNAPSHOT_EXT)
        ? (await gunzip(raw)).toString('utf8')
        : raw.toString('utf8');
      return JSON.parse(json) as PageSnapshot;
    } catch (cause) {
      throw new StoreError(`Snapshot ${file} is corrupt`, { cause });
    }
  }

  /**
   * Delete captured snapshots.
   *
   * What `output.keepSnapshots: false` does. The trade-off is explicit: the run
   * becomes far smaller on disk, and `drifter compare --run <id>` can no longer
   * re-diff it without re-crawling.
   */
  async pruneSnapshots(): Promise<void> {
    await rm(join(this.dir, 'snapshots'), { recursive: true, force: true });
  }

  /**
   * Delete the full-page captures.
   *
   * What `output.keepScreenshots: false` does, and it must run only after the
   * report has been written: the evidence crops are cut from these, so pruning
   * first would silently produce a report with no pictures.
   */
  async pruneScreenshots(): Promise<void> {
    await rm(join(this.dir, 'screenshots'), { recursive: true, force: true });
  }

  /** Total bytes on disk for this run, so a growing store is visible not silent. */
  async diskUsage(): Promise<number> {
    return directorySize(this.dir);
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
      if (!entry.endsWith(SNAPSHOT_EXT) && !entry.endsWith(LEGACY_SNAPSHOT_EXT)) continue;
      const snapshot = await this.readSnapshotFile(join(dir, entry));
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

/** Recursive size of a directory in bytes. Missing directories count as zero. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else {
      try {
        total += (await stat(full)).size;
      } catch {
        // A file removed between listing and stat is simply not counted.
      }
    }
  }
  return total;
}

/** Bytes as a short human string, for logs and CLI output. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}

/**
 * Every stored run, oldest first.
 *
 * Run ids are timestamps, so lexicographic order is chronological order and no
 * metadata has to be read to sort them. A directory without `run.json` is not a
 * run - it is a partial write or something else entirely - and `latest` is a
 * symlink to a run rather than a run itself.
 */
export async function listRuns(baseDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry !== 'latest' && existsSync(join(baseDir, entry, 'run.json')))
    .sort();
}

/** Most recent run directory by name, which sorts chronologically by design. */
async function findLatestRun(baseDir: string): Promise<string | null> {
  return (await listRuns(baseDir)).at(-1) ?? null;
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
