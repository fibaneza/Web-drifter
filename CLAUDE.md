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
| `src/compare/` | Comparators producing `Finding[]`                                                            |
| `src/report/`  | JSON / HTML / Markdown / JUnit output                                                        |

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
- Keep `docs/` current when behaviour changes — `docs/crawl-bounding.md` and
  `docs/reports.md` are specifications, not afterthoughts.
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
