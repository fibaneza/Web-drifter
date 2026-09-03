# Publishing a run

```bash
drifter publish --bucket drift-reports --prefix vplates/nightly
```

Zips the most recent run and uploads it to S3. The zip is what someone actually
wants: it opens with a double-click on Windows and macOS, and expands to one
folder containing `index.html` and everything it references.

```
drift-2026-09-03T21-00-00-000.zip
  index.html   evidence.html   evidence-2.html
  pages/   devices/   css/   assets/shots/
  report.json   summary.md   junit.xml   diff.md
```

## Credentials

There are none to configure, and that is deliberate. Upload shells out to
`aws s3 cp`, so it uses whatever the machine is already authenticated with — an
IAM role on the build agent, a shared profile, `AWS_PROFILE`, SSO. **No
credential ever reaches this tool or its config file.**

The cost of that choice is an undeclared binary dependency, so a missing CLI
fails with a message that says exactly that rather than a stack trace:

```
PublishError: The AWS CLI is not on PATH, and `drifter publish` uses it to
upload. Install it (https://aws.amazon.com/cli/) or use --dry-run to produce
the archive and the command without uploading.
```

## Options

| Flag              | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `--run <id>`      | Which run to publish (defaults to the most recent)            |
| `--bucket <name>` | S3 bucket, without the `s3://` scheme                         |
| `--prefix <path>` | Key prefix within the bucket                                  |
| `--s3-uri <uri>`  | A whole `s3://bucket/prefix` instead of the two above         |
| `--keep-archive`  | Keep the local zip after uploading (it is deleted by default) |
| `--dry-run`       | Build the archive, print the command, upload nothing          |

Or set it once in the config:

```ts
output: {
  dir: './drifter-out',
  publish: {
    bucket: 'drift-reports',
    prefix: 'vplates/nightly',
    // Extra `aws s3 cp` arguments, passed as an array and never through a shell.
    args: ['--sse', 'aws:kms'],
  },
}
```

A CLI flag wins over the config, as everywhere else.

## Why arguments are never a shell string

A bucket name or prefix out of a config file is not a trusted value. `publish`
invokes the CLI with an argument array, so a prefix containing `; rm -rf /` is
passed to `aws` as a (nonsensical) argument rather than interpreted. There is a
test asserting exactly that.

## In a pipeline

```yaml
- script: npx drifter run --out ./drift-report
  continueOnError: true

- script: npx drifter publish --bucket $(DriftBucket) --prefix $(Build.BuildNumber)
  displayName: 'Publish the drift report'
```

Run it **after** `drifter run`, and after `drifter diff` if you use one — the
archive is a snapshot of the run directory at the moment it is taken, so
anything written afterwards is not in it.

Worth pairing with `output.keepScreenshots: false` if you only need the report:
full-page captures are by far the largest thing in a run, and the evidence crops
the report displays survive without them. See
[The artifact store](artifact-store.md).

## Further reading

- [The artifact store](artifact-store.md) — what a run contains and what it costs
- [Report structure](reports.md) — what is inside the archive
- [Azure DevOps pipeline](ado-pipeline.md) — the rest of the pipeline
