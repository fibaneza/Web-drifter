# Azure DevOps pipeline

A ready-to-use pipeline lives at [`ci/azure-pipelines.yml`](../ci/azure-pipelines.yml).
It publishes two things a reviewer can act on without leaving the build.

## What you get

| Where                          | What                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| **Artifacts → `drift-report`** | The full HTML report, downloadable and browsable offline     |
| **Tests tab**                  | Every finding as a test case, grouped by category            |
| **Build summary**              | `summary.md` — headline parity numbers and the device matrix |

## Setup

1. Copy `ci/azure-pipelines.yml` into your repository (or reference it as a
   template).
2. Set the `sourceBaseUrl` and `targetBaseUrl` parameters, or supply them as
   environment variables (see below).
3. Commit a `drifter.config.ts` — `npx drifter init` scaffolds one.

```yaml
resources:
  repositories:
    - repository: drifter
      type: github
      name: fibaneza/Web-drifter

extends:
  template: ci/azure-pipelines.yml@drifter
  parameters:
    sourceBaseUrl: 'https://legacy.example.com'
    targetBaseUrl: 'https://new.example.com'
    viewports: 'desktop,tablet,mobile-sm'
    maxPages: 300
```

## Pointing at different environments

A committed config should not need editing to run against a preview
deployment. These environment variables override it at load time, and a CLI
flag still wins over both:

| Variable                  | Overrides        |
| ------------------------- | ---------------- |
| `DRIFTER_SOURCE_BASE_URL` | `source.baseUrl` |
| `DRIFTER_TARGET_BASE_URL` | `target.baseUrl` |
| `DRIFTER_OUT_DIR`         | `output.dir`     |
| `DRIFTER_MAX_PAGES`       | `crawl.maxPages` |

A blank value is treated as unset, so an empty pipeline parameter does not blank
out a configured URL and fail validation with a confusing message.

## Why the run step uses `continueOnError`

`drifter run` exits non-zero when drift exceeds the budget. If that failed the
job immediately, the publish steps would be skipped — and the report would be
unavailable at exactly the moment somebody needs to read it.

So the run step defers its verdict, the report and test results are published
unconditionally, and a final step re-applies the gate by reading the error count
out of `report.json`.

## Exit codes

| Code | Meaning                              | Who fixes it   |
| ---- | ------------------------------------ | -------------- |
| `0`  | Clean, or within `thresholds.failOn` | —              |
| `1`  | Drift exceeded the budget            | A developer    |
| `2`  | The tool itself failed               | Infrastructure |

Distinguishing 1 from 2 is deliberate: a build that fails because the migration
has drifted needs a very different response from one that fails because Chromium
could not be installed.

## Caching

Two caches, both keyed on `package-lock.json`:

- **npm** — the usual.
- **Playwright browsers** — Playwright pins an exact browser revision per
  release, so a dependency bump _must_ invalidate this cache. Keying it on the
  lockfile does that. Without it, a Playwright upgrade produces a
  missing-browser error that reads like an infrastructure fault.

## Runtime

A full crawl at four viewports loads every page four times per side, so it is
not a two-minute job. Options, in order of preference:

1. **Fewer viewports** — `viewports: 'desktop,mobile-sm'` covers the widest and
   narrowest cases and halves the work.
2. **Cap pages** — `maxPages` with a sensible `crawl.includePatterns` covering
   the templates that matter.
3. **Schedule it** — the template runs on a weekday cron rather than on every
   commit, which is usually the right cadence for a migration.

## Before you trust the gate

Run `drifter doctor` once against your source site and commit the suppression
rules it suggests. It crawls the source twice and compares it against itself, so
everything it reports is inherent non-determinism — and every one of those would
otherwise fail your pipeline as a false positive. See
[Avoiding false positives](false-positives.md).

## Other CI systems

Nothing here is Azure-specific beyond the task syntax. The tool writes
`junit.xml` and a self-contained HTML directory, which GitHub Actions, GitLab CI
and Jenkins all consume natively:

```bash
npm ci
npx playwright install --with-deps chromium
npm run build
npx drifter run --out ./drift-report
# publish ./drift-report and ./drift-report/*/junit.xml
```
