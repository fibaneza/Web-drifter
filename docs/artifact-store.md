# The artifact store

Every run writes one self-contained folder. This document covers what it costs,
how to bound it, and the decision — `output.keepSnapshots` — that trades disk
against the ability to re-diff without re-crawling.

## Layout

```
<output.dir>/
  2026-09-02T10-14-33-441/          one run, named by its start time
    run.json                        metadata: run id, base URLs, viewports, schema version
    snapshots/
      source/products-3f9a1c02.json.gz
      target/products-3f9a1c02.json.gz
    screenshots/
      source/products-3f9a1c02/desktop.png
    report.json  stats.json  junit.xml  summary.md
    index.html   pages/  devices/  css/
  latest -> 2026-09-02T10-14-33-441
```

Run directories are named from an ISO timestamp, so they sort chronologically
by name alone — no metadata read needed to find the newest. `latest` is a
symlink for scripts and CI; it is created best-effort, because some Windows
setups and containers refuse symlinks, and a convenience must not fail a run.

File names come from `pathSlug()`: a readable prefix plus an eight-character
SHA-1 suffix. The prefix means someone debugging a run can find the artifacts
for `/products/hats` without grepping; the hash keeps it collision-free, since
slugification is lossy and `/a/b` and `/a-b` would otherwise land on the same
name.

## What a run costs

The snapshot is the expensive artifact, and its size is driven by computed
styles rather than content. Every matched node carries the full allowlisted
property set **at every viewport**:

| Quantity                      | Measured |
| ----------------------------- | -------- |
| One node, one viewport        | ~1.8 KB  |
| 500-node page, four viewports | ~3.6 MB  |
| 1,000 pages × 2 sides         | ~7 GB    |

Seven gigabytes per nightly run is not a viable default, so snapshots are
gzipped on disk.

### Why gzip pays here

Snapshot JSON is close to the ideal case for a dictionary compressor: the same
property names, the same `rgb(26, 29, 33)` colour and the same
`Arial, sans-serif` stack repeat once per node, per viewport. Measured on
representative content it compresses by roughly an order of magnitude, and on
the highly uniform fixture used in the tests by ~29×.

The cost is a few milliseconds per page, against a capture that already spent
seconds rendering — it does not register.

```
1,000 pages × 2 sides, 4 viewports

  uncompressed  ████████████████████████████████████████  ~7 GB
  gzipped       ████                                      ~700 MB
```

Reads accept either extension. A run captured before compression existed is
still readable, so upgrading the tool never silently invalidates a stored run:

```ts
// src/store/artifact-store.ts
async readSnapshot(side: Side, pathKey: string): Promise<PageSnapshot | null> {
  const compressed = await this.readSnapshotFile(this.snapshotPath(side, pathKey));
  if (compressed) return compressed;

  // Fall back to the uncompressed layout so a run captured by an earlier
  // version can still be compared without being re-crawled.
  const legacy = join(this.dir, 'snapshots', side, `${pathSlug(pathKey)}.json`);
  return this.readSnapshotFile(legacy);
}
```

## `output.keepSnapshots` — the decision

```ts
output: {
  dir: './drifter-out',
  keepSnapshots: true,   // default
}
```

| Value            | Disk         | `drifter compare --run <id>` |
| ---------------- | ------------ | ---------------------------- |
| `true` (default) | Full run     | Re-diffs in seconds          |
| `false`          | Reports only | Needs a fresh crawl          |

The default keeps them, because re-diffing a stored crawl is the entire reason
capture and comparison are decoupled — see
[Architecture](architecture.md#why-capture-and-compare-are-decoupled).

Set it to `false` when a run is genuinely fire-and-forget: a scheduled pipeline
that publishes an HTML artifact and never re-compares is paying gigabytes for a
capability it does not use. Pruning happens **after** reports are written, so
the reports and screenshot evidence survive intact — only the raw page models go.

Every run logs its size when it finishes, so a growing store is visible rather
than discovered when a build agent runs out of disk:

```
run complete  bytes=734003200 human=700 MB
```

## Bounding the store further

Ordered by how much they save per unit of lost coverage:

1. **Fewer viewports.** Snapshot size is linear in viewport count, and
   `desktop,mobile-sm` covers the widest and narrowest cases for half the disk
   and half the crawl time.
2. **`crawl.maxPages` with `includePatterns`.** A migration usually has a dozen
   templates; crawling 40 pages that cover all of them beats crawling 1,000 that
   cover the same dozen.
3. **`output.keepSnapshots: false`.** Removes the snapshots, at the cost of
   re-crawling to re-diff. Note the caveat below: since snapshots were gzipped,
   this is no longer the largest thing in a run.
4. **Retention.** Runs are independent folders, so pruning is a `find`:

   ```bash
   find ./drifter-out -maxdepth 1 -name '20*' -mtime +14 -exec rm -rf {} +
   ```

## What actually dominates a run now

Gzipping the snapshots was roughly a 10× win, and it moved the bottleneck.
Measured on a two-viewport fixture run:

| Directory                       | Size   |
| ------------------------------- | ------ |
| `snapshots/` (gzipped)          | 72 KB  |
| `assets/` (evidence crops)      | 152 KB |
| `screenshots/` (full-page PNGs) | 1.5 MB |

**Full-page screenshots are now around twenty times the snapshot cost**, and
`output.keepSnapshots: false` does not touch them — `pruneSnapshots()` removes
only `snapshots/`. So on a large crawl the option no longer controls the dominant
consumer, and the ordering above should be read with that in mind: fewer
viewports is the biggest single lever, because it reduces snapshots _and_
screenshots together.

`output.keepScreenshots: false` discards them once the report is written:

```ts
output: {
  keepSnapshots: true,     // re-diff without re-crawling
  keepScreenshots: false,  // drop the full-page captures; keep the crops
}
```

| Value            | What survives                                           |
| ---------------- | ------------------------------------------------------- |
| `true` (default) | Everything; `drifter report` can cut new evidence crops |
| `false`          | The report and its crops, without the originals         |

Pruning runs **after** reporting, never before — the crops are cut from these
files, so the other order would silently produce a report with no pictures. What
you give up is re-cutting evidence later: change `evidenceMinSeverity` and you
will need a fresh crawl.

## Schema versioning

`run.json` records `schemaVersion`. Opening a run written by an incompatible
version fails loudly rather than comparing mismatched models:

```
Run 2026-08-01T09-00-00-000 uses snapshot schema v1, but this version of
drifter reads v2. Re-crawl to compare.
```

Silently reading a stale model would produce findings that look real and are
not — and a false positive costs more than a missed finding.

## Further reading

- [Architecture](architecture.md) — why capture and compare are decoupled
- [Crawl boundaries](crawl-bounding.md) — how the page count is bounded
- [Report structure](reports.md) — what survives when snapshots are pruned
