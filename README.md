# web-drifter

Detect **content, image, price, link and CSS drift** between a legacy website and its modern
rewrite — across desktop, tablet and mobile screen sizes.

Built for migrations where the new site (e.g. a React SPA) must be _visually, content-wise and
URL-path-wise identical_ to the legacy one (e.g. Sitecore). Only the host and the backend API
calls are expected to differ.

> **Status:** under active development. See [Roadmap](#roadmap) for what is implemented today.

---

## Why not just diff the HTML?

Because it does not work. A legacy CMS and a React rewrite share no class names, no wrapper
structure and no tag choices, so a raw HTML diff — or any diff keyed on CSS selectors — reports
100% drift on a perfect migration.

web-drifter reduces **both** sites to the same _canonical page model_: an ordered stream of
semantic nodes (headings, paragraphs, links, images, prices…) scoped to landmark regions. All
comparison happens on that model, so it survives a complete re-implementation of the markup.

The same reasoning drives the CSS comparison: stylesheets are not compared, **computed styles of
matched elements** are. Computed style is the only thing the two sites genuinely have in common,
because it is what the user actually sees.

---

## What it reports

| Report               | Contents                                                                       |
| -------------------- | ------------------------------------------------------------------------------ |
| **Overview**         | Run summary, per-page index with finding counts                                |
| **Per page**         | Every finding for one path, grouped by category, with side-by-side screenshots |
| **CSS** _(separate)_ | Computed-style and layout drift, per viewport                                  |
| **Links**            | Broken links, redirect chains, path mismatches, mixed content                  |
| **Coverage**         | Pages missing on target, extra on target, aliases, redirects                   |
| `report.json`        | Full machine-readable findings (versioned schema)                              |
| `junit.xml`          | For the Azure DevOps "Tests" tab                                               |

Findings carry a stable `id`, so an accepted difference can be suppressed permanently without
silencing a whole category.

---

## Crawl boundaries

Three hard limits, enforced in the frontier before a URL is ever fetched:

- **Same-origin only.** The crawler never navigates to another origin. Subdomains and `www` vs
  apex must be opted in explicitly via `crawl.additionalOrigins` — nothing is inferred.
  External links are still _recorded_ and HEAD-checked so dead outbound links show up in the
  links report, but they are never rendered.
- **Depth limit** (`crawl.maxDepth`, default `2`). Depth 0 is the seeds, depth 1 is pages linked
  from seeds, depth 2 is pages linked from those. Pages at `maxDepth` are captured but their
  links are not followed — so the default captures **three tiers of pages**.
- **Never revisit.** Three independent dedup layers: the canonical URL, the post-redirect final
  URL, and a hash of the page content. Plus crawler-trap guards for self-nesting paths, faceted
  search explosions and over-long URLs.

**Query parameters are part of a page's identity.** `/search?q=hammer` and `/search?q=saw` are two
different pages and both are crawled; only known tracking parameters (`utm_*`, `gclid`, `fbclid`, …)
are stripped, and parameter _order_ is normalised so `?a=1&b=2` and `?b=2&a=1` are one page. See
[Crawl boundaries](docs/crawl-bounding.md) for the full rules and the one setting that changes this.

---

## Requirements

- **Node.js >= 22**
- **Chromium** via Playwright

## Install

```bash
git clone https://github.com/fibaneza/Web-drifter.git
cd Web-drifter
npm install
npx playwright install chromium   # skip if your image already ships a browser
npm run build
```

### Using a pre-installed Chromium

On CI images that ship a browser whose revision does not match the installed Playwright version,
point web-drifter at it directly instead of downloading another copy:

```bash
export DRIFTER_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
```

or set `browser.executablePath` in the config file.

## Usage

```bash
npx drifter init          # scaffold drifter.config.ts
npx drifter run           # crawl both sites, compare, write reports
open drifter-out/latest/index.html
```

| Command                                     | Purpose                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `drifter init`                              | Scaffold a config file                                             |
| `drifter run`                               | Full pipeline: crawl both sides → compare → report                 |
| `drifter crawl --side source\|target\|both` | Capture snapshots only                                             |
| `drifter compare --run <id>`                | Re-diff stored snapshots without re-crawling                       |
| `drifter links`                             | Link and URL check only                                            |
| `drifter doctor`                            | Crawl the source twice and diff it against itself to measure noise |
| `drifter report --run <id>`                 | Re-render reports from stored findings                             |

Exit codes: `0` clean or within budget · `1` findings exceed `thresholds.failOn` · `2` tool failure.

### `drifter doctor` — do this first

Real sites are non-deterministic: carousels, ads, timestamps, A/B tests. `doctor` crawls the
**source against itself** and reports what differs. Anything it finds is inherent noise, not
migration drift — and it emits ready-made ignore rules. Calibrate the noise floor before trusting
a single finding.

## Configuration

```ts
// drifter.config.ts
import { defineConfig } from 'web-drifter';

export default defineConfig({
  source: { name: 'legacy', baseUrl: 'https://legacy.example.com' },
  target: { name: 'react', baseUrl: 'https://new.example.com' },

  crawl: {
    startUrls: ['/'],
    maxDepth: 2, // seeds + 2 hops
    maxPages: 1000,
    concurrency: 4,
    sameOriginOnly: true, // never render another host
    checkExternalLinks: true, // HEAD-check them, never render them
  },

  viewports: ['desktop', 'tablet', 'mobile-md', 'mobile-sm'],

  urlMapping: {
    trailingSlash: 'strip',
    // Drop noisy parameters individually. Prefer this over `queryAllowlist`,
    // which discards every parameter NOT listed and would collapse
    // /search?q=hammer and /search?q=saw into one page.
    dropParams: ['sessionid'],
    overrides: { '/products.aspx': '/products' },
  },

  ignore: {
    selectors: ['#chat-widget', '.ad-slot'],
    textPatterns: [/\d{2}\/\d{2}\/\d{4}/],
  },

  thresholds: {
    failOn: { error: 0 },
  },
});
```

Every option and its default is defined in [`src/config/schema.ts`](src/config/schema.ts).

### Viewports

Device profiles are pinned in [`src/config/devices.ts`](src/config/devices.ts) rather than taken
from Playwright's `devices` registry, which lags hardware releases and changes keys between
versions. Adding a screen size is a config line, not a dependency bump.

| id                 | Viewport    | Class              |
| ------------------ | ----------- | ------------------ |
| `mobile-sm`        | 360 × 740   | Small phone        |
| `mobile-md`        | 393 × 852   | iPhone 15/16 class |
| `mobile-lg`        | 402 × 874   | iPhone 17 class    |
| `mobile-xl`        | 440 × 956   | Pro Max class      |
| `tablet`           | 768 × 1024  | Tablet portrait    |
| `tablet-landscape` | 1024 × 768  | Tablet landscape   |
| `desktop`          | 1440 × 900  | **primary**        |
| `desktop-xl`       | 1920 × 1080 | Large desktop      |

Source-mobile is always compared against target-mobile — never against source-desktop. A mobile
layout legitimately differs from a desktop one; that is not drift.

> ⚠️ Verify the exact logical size of any specific handset against the vendor's published
> specification before relying on it. Override with a custom entry in `devices` if it differs.

## Documentation

| Guide                                               | Covers                                                   |
| --------------------------------------------------- | -------------------------------------------------------- |
| [Architecture](docs/architecture.md)                | Pipeline, comparator ordering, the Node/browser split    |
| [The canonical page model](docs/page-model.md)      | Why the DOM is not compared, and the alignment algorithm |
| [CSS comparison](docs/css-comparison.md)            | Computed styles, the allowlist, responsive visibility    |
| [Crawl boundaries](docs/crawl-bounding.md)          | Origin, depth, revisits, query parameters, traps         |
| [The artifact store](docs/artifact-store.md)        | Run layout, disk cost, and the `keepSnapshots` trade-off |
| [Report structure](docs/reports.md)                 | The two navigation axes, screenshots, statistics         |
| [Avoiding false positives](docs/false-positives.md) | What the tool handles, and what you should tune          |

## Development

```bash
npm run dev        # run the CLI from source via tsx
npm test           # unit + integration tests
npm run verify     # format + lint + typecheck + test
```

## Roadmap

| Phase | Scope                                                     | Status |
| ----- | --------------------------------------------------------- | ------ |
| 0     | Project scaffold, tooling                                 | ✅     |
| 1     | Crawler: origin guard, depth limit, dedup, traps, capture | 🚧     |
| 2     | Canonical page model extraction                           | ⬜     |
| 3.1   | URL mapping and page coverage                             | ⬜     |
| 3.2   | Content alignment and drift                               | ⬜     |
| 3.3   | Image and price comparators                               | ⬜     |
| 3.4   | CSS and layout drift (separate report)                    | ⬜     |
| 3.5   | Broken links and redirects                                | ⬜     |
| 4     | Reporting incl. screenshots, per-page organisation        | ⬜     |
| 5     | CLI polish, `doctor`, docs                                | ⬜     |
| 6     | Azure DevOps pipeline                                     | ⬜     |

## License

MIT
