# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

`web-drifter` compares a **legacy website** against its **modern rewrite** and
reports every drift in content, images, prices, links and CSS, across desktop,
tablet and mobile viewports.

The premise that shapes every design decision: the two sites share **no markup**.
A legacy CMS emits tables and `sc-` classes; a React rewrite emits semantic HTML
and BEM. So any diff keyed on CSS selectors, DOM structure or raw HTML reports
100% drift on a _perfect_ migration and is worthless.

## Non-negotiable invariants

Break any of these and the tool becomes a noise generator nobody trusts.

1. **Never diff raw HTML or selector-keyed structure.** Both sides reduce to the
   canonical page model (`src/extract/page-model.ts`) and comparison happens
   there. If you find yourself matching on a class name, stop.
2. **Never compare stylesheets — compare computed styles of matched elements.**
   Computed style is the only common ground; it is what the user actually sees.
3. **Compare like-for-like viewports.** Source at `mobile-sm` is compared with
   target at `mobile-sm`, never with source at `desktop`. A mobile layout
   differing from a desktop one is not drift.
4. **Never crawl off-origin.** The origin guard is a hard boundary. External
   links are recorded and HEAD-checked, never rendered.
5. **Screenshots are evidence, not detection.** Nothing is ever reported
   _because_ pixels differ — pixel comparison is far too noisy to gate on.
   Crops exist to help someone fix a finding another method already proved.
6. **A false positive costs more than a missed finding.** A report with 4,000
   bogus rows gets abandoned in week two. When in doubt, lower the severity or
   add a normalisation step rather than emitting noise.
7. **Node identity is region-qualified.** `ContentNode.ordinal` counts within
   `region|key`, so `key#ordinal` alone collides — a "Home" link in the nav and
   one in the footer are both ordinal 0. Dropping the region misattributes CSS
   drift _and_ crops the wrong element as evidence, and a picture of the wrong
   element is worse than no picture.
8. **The report may show element paths; it must never imply they were
   compared.** Corollary of 1, and the place it actually went wrong: a card
   showing one selector reads as though selectors were the basis of the diff.
   Show both sides, say what the pairing was really based on, or show neither.
9. **CSS never reaches `error`.** Some restyling is intentional in a rewrite,
   and a gate that fails a build over a shifted margin is switched off on day
   one — at which point it catches nothing at all. Severity is graded by
   distance across `info → warning`. Elements _disappearing_ is different and
   stays an error: that is a missing component, not styling.
10. **Text is compared for exact equality; similarity only decides pairing.**
    `thresholds.textSimilarity` (0.6) chooses which source node pairs with which
    target node. It never decides whether a difference is acceptable. Text that
    is not identical is an error, with no tolerance band. Similarity is also
    actively misleading as a severity signal — "Fees are non-refundable" against
    "Fees are refundable" scores 0.83, while a harmless imperative rewrite scores
    0.69 — so it must never be used to rank findings by importance.
11. **No LLM, and no semantic comparison, anywhere in the pipeline.** Considered
    and rejected: it breaks determinism, and every downstream mechanism depends
    on determinism — stable finding ids for `ignore.findingIds`, the `doctor`
    noise floor, and CI gating that must not flap. Discrimination between a
    rewrite and a revision is done by extracting facts that compare exactly
    (`src/compare/critical-values.ts`), not by judging meaning.
12. **Every percentage names its denominator, and unreachable pages are outside
    it.** A source page nothing links to is usually a forgotten campaign or
    legacy URL. Counting it measures the size of the legacy backlog rather than
    the quality of the migration, so it is compared and reported but excluded
    from the figures and from the gate.

## Architecture

```
discover → capture → [artifact store] → map → compare → report
```

Capture and compare are decoupled **through the on-disk store on purpose**:
crawling is the slow part, tuning ignore rules is iterative, and re-diffing a
stored crawl in seconds instead of re-crawling for twenty minutes is what makes
the tool tunable. Do not collapse them into one in-memory pipeline.

| Directory      | Responsibility                                                                               |
| -------------- | -------------------------------------------------------------------------------------------- |
| `src/config/`  | Zod schema (single source of truth for options, types and defaults), loader, device profiles |
| `src/crawl/`   | Frontier, origin guard, traps, browser pool, stabilisation, readiness gate, robots, sitemap  |
| `src/extract/` | In-page extractor, canonical page model, text normalisation, prices, images, CSS allowlist   |
| `src/map/`     | URL canonicalisation, source→target path mapping                                             |
| `src/store/`   | On-disk artifact store                                                                       |
| `src/compare/` | Comparators producing `Finding[]`, node geometry, reachability                               |
| `src/report/`  | JSON / HTML / Markdown / JUnit output, screenshot evidence, run-over-run diff                |

### The Node/browser split

Code in `src/extract/browser-extract.ts` is **serialised and evaluated inside
the browser**. It must be self-contained: no imports, no closure over module
scope. Everything deterministic — hashing, text normalisation, price parsing,
URL canonicalisation — happens in Node, where it is unit testable.

A bundler shim (`bundlerShimInitScript`) defines an identity `__name` in the
page, because esbuild (via tsx) rewrites named functions to call a helper that
does not exist in the browser. Removing it breaks every `page.evaluate`.

## Conventions

- TypeScript strict + ESM, Node 22. Imports carry `.js` extensions.
- `exactOptionalPropertyTypes` is on: optional fields that may legitimately hold
  `undefined` are declared `?: T | undefined`.
- Comments explain **why**, not what. Prefer a sentence about the trade-off or
  the bug being prevented over restating the code.
- No non-null assertions (`!`). Narrow, or throw with a useful message.
- Escape sequences, never literal characters, for invisible or near-identical
  glyphs (zero-width, NBSP, smart quotes) — a literal copy is unreviewable.

## Testing

```bash
npm test              # unit + integration
npm run verify        # format + lint + typecheck + test
```

- **Unit tests** cover the pure logic: URL canonicalisation, origin guard, depth
  accounting, traps, text normalisation, similarity, price parsing, asset keys.
- **Integration tests** run a real Chromium against the fixture sites in
  `test/fixtures/`.

`test/fixtures/legacy/` and `test/fixtures/modern/` render equivalent content
with **deliberately unrelated markup**. If you make them structurally similar,
the tests will pass for the wrong reason. `test/fixtures/DRIFTS.md` lists both
the drifts that must be reported and the ones that must **not** be — the
false-positive guards are as important as the positive cases.

Chromium resolution falls back through config → `DRIFTER_CHROMIUM_EXECUTABLE` →
Playwright's own path → a scan of `PLAYWRIGHT_BROWSERS_PATH`, so a CI image with
a mismatched browser revision still works. Never run `playwright install` in a
sandbox that already ships a browser.

## Working practice

- **Commit and push to `main` after each phase or meaningful step.** This repo
  uses a single branch; do not create feature branches or pull requests.
- Run `npm run verify` before committing.
- Keep `docs/` current when behaviour changes. `docs/crawl-bounding.md`,
  `docs/reports.md`, `docs/css-comparison.md` and `docs/comparing-runs.md` are
  specifications, not afterthoughts — several of them state a contract the tests
  assert.
- Explain trade-offs in commit messages. The _why_ is the valuable part.

## Delivery phases

| Phase | Scope                                                        | Status |
| ----- | ------------------------------------------------------------ | ------ |
| 0     | Scaffold and tooling                                         | done   |
| 1     | Crawler: origin guard, depth limit, dedup, traps, capture    | done   |
| 2     | Canonical page model extraction                              | done   |
| 3.1   | URL mapping and page coverage                                | done   |
| 3.2   | Content alignment and drift                                  | done   |
| 3.3   | Image and price comparators                                  | done   |
| 3.4   | CSS and layout drift, per viewport (separate report)         | done   |
| 3.5   | Broken links and redirects                                   | done   |
| 4     | Reporting: by device and by page, with screenshots and stats | done   |
| 5     | CLI polish, `doctor`, docs                                   | done   |
| 6     | Azure DevOps pipeline (optional, last)                       | done   |
| 7     | Evidence for text/price findings; distance-graded CSS        | done   |
| 8     | Region-qualified identity; CLI URL flags; report sorting     | done   |
| 9     | `drifter diff`: run-over-run comparison                      | done   |
| 10    | Orphan pages; paginated evidence; self-explanatory cards     | done   |
| 11    | `drifter publish`; audit fixes; sitemap parsing coverage     | done   |
| 12    | Redirects, bin entry point, robots-declared sitemaps         | done   |
| 13    | Device matrix column alignment                               | done   |
| 14    | Per-side stabilization timing                                | done   |
| 15    | Visual map: differences drawn on the page                    | done   |
| 16    | Landmark inference for markup with no landmarks              | done   |
| 17    | SVG paint; colours inside shadows and gradients              | done   |
| 18    | Findings by section                                          | done   |
| 19    | `content.value-drift` and the changed-values report          | done   |

### What each recent phase actually changed

Read this before re-deriving any of it from the source tree.

- **12** — `request({ maxRedirections })` is no longer supported by undici and
  throws; both call sites caught broadly, so sitemap seeding silently returned
  zero seeds and every external link was reported unreachable. Replaced with
  `interceptors.redirect` on an explicit Agent in `src/core/http.ts`. The `bin`
  entry did nothing when installed: the self-execute guard compared
  `import.meta.url` against an unresolved `argv[1]`, which never matches through
  a bin symlink. robots.txt `Sitemap:` directives are now read and tried before
  `/sitemap.xml`, and both robots and sitemap fetches carry `site.headers`.
- **14** — `stabilization` timing may be overridden per side
  (`source.stabilization` / `target.stabilization`), merged field by field. Only
  timing is overridable; `locale`, `timezoneId` and the clock/random freezes stay
  global because they must match for the comparison to be like-for-like, and the
  per-side schema is `.strict()` so naming one is a config error.
- **15** — `visual.html` draws every visually-perceptible finding on the two
  full-page captures, numbered, with a legend. Driven by findings, never by
  pixels (invariant 5). Excludes typography, invisible markup, and movement under
  8 CSS px.
- **16** — when a document declares no landmark at all, region is inferred from
  `id`/`class` (`src/extract/regions.ts`). Without it a Sitecore-style source
  puts every node in `other` while a React target uses real landmarks, alignment
  never crosses a region, and a perfect migration reads as total content loss on
  both sides at once. Inference never overrides a real landmark.
- **19** — text drift splits into `content.drift` (wording changed, every
  extractable value survived) and `content.value-drift` (a fee, date, duration,
  contact detail, negation or obligation moved). **Both are `error`** — the split
  ranks and names, it never excuses. `values.html` projects the second into a
  table of old value beside new. Modal changes count only when the sentence is
  otherwise identical, because turning a sentence into an imperative drops a
  modal without changing the instruction.
