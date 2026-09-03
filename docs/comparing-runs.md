# Comparing two runs

A single report answers _"how far apart are these two sites?"_. After the first
fix, the question changes to _"did that help, and did it break anything else?"_

```bash
drifter diff
```

With no arguments this compares the two most recent runs.

## What it reports

| Bucket        | Meaning                                                |
| ------------- | ------------------------------------------------------ |
| **new**       | In the current run, not in the baseline — a regression |
| **fixed**     | In the baseline, gone from the current run             |
| **changed**   | The same finding, but its severity or values moved     |
| **unchanged** | Identical in both runs                                 |

```
================================================================
Comparing 2026-09-01T09-00-00-000 -> 2026-09-02T09-00-00-000

  new          2   (1 error, 1 warning, 0 info)
  fixed        1
  changed      2
  unchanged    0

1 finding(s) got more serious without being new:
  warning -> error  /about  Call to action text drifted on /about
```

It writes `diff.json` and `diff.md` into the **current** run's directory, so a
run folder stays the one place holding everything known about that run. The
Markdown is sized for a pull request comment or a pipeline summary panel.

## Why this works at all

Finding ids are **identity-only** by design. `findingId` hashes the category,
path, viewport, region, node kind, subject and facet — and deliberately _not_
`expected` or `actual`:

```ts
// src/compare/findings.ts
const identity = [category, path, viewport, region, nodeKind, subject, facet].join('|');
```

So fixing a price from `€49` to `£49` keeps the same id, and the comparison can
tell "the same difference, partly addressed" apart from "a different difference".
Without that, every partial fix would read as one finding vanishing and an
unrelated one appearing.

## When the comparison is **not** meaningful

This is the part you cannot infer from the output, so `diff` says it out loud.

Because ids come from source-side identity, the arithmetic only means something
when both runs looked at **the same source site** through **the same viewports**.
Change either and findings churn wholesale between `new` and `fixed` while
nothing has actually regressed — which reads exactly like a catastrophe and is
not one.

`diff` emits a warning, in the terminal and at the top of `diff.md`, when:

- the two runs crawled different `source.baseUrl`s;
- they compared against different `target.baseUrl`s (legitimate when promoting a
  build between environments, but then you are measuring two deployments rather
  than one change); or
- the viewport sets differ — `viewport` is part of the id, so every CSS finding
  at a dropped or added size will read as fixed or new.

A diff that is quietly nonsense is worse than one that refuses to run.

## Exit codes

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| `0`  | No new findings at or above `--fail-on`              |
| `1`  | New findings appeared                                |
| `2`  | The tool failed — unknown run, missing `report.json` |

```bash
drifter diff --fail-on warning    # stricter: any new warning fails too
drifter diff --no-fail            # diagnostic only, always exits 0
```

**Escalations are reported but not gated.** A finding that went from warning to
error is a regression in all but name, yet it is not _new_, so it does not fail
the command by default. It is printed prominently and gets its own section in
`diff.md`. To gate on it too, treat a non-empty "got worse" section as a failure
in your pipeline, or raise `--fail-on`.

## Selecting runs

```bash
drifter diff                                   # two most recent
drifter diff --since 2026-09-01T09-00-00-000   # explicit baseline, latest current
drifter diff --since <base> --run <head>       # both explicit
```

Run ids are timestamps, so they sort chronologically. `drifter diff --run <id>`
on the earliest stored run fails rather than guessing a baseline — comparing a
first run against nothing would report every finding as new.

## In a pipeline

The natural place for this is straight after `drifter run`, as a second gate:

```yaml
- script: npx drifter run --out ./drift-report
  continueOnError: true

- script: npx drifter diff --out ./drift-report
  displayName: 'Fail on regressions since the previous run'
```

`drifter run` answers "is the migration within budget?"; `drifter diff` answers
"did this change make it worse?" Those are different questions, and a migration
that is still far from done needs the second one long before it can pass the
first.

Both `diff.json` and `diff.md` are written into the run directory, so publishing
that directory as a build artifact already captures them.

## Further reading

- [Report structure](reports.md) — what a single run produces
- [The artifact store](artifact-store.md) — run directories and retention
- [Azure DevOps pipeline](ado-pipeline.md) — publishing and gating
