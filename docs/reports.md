# Report structure

Reports are navigable along **two axes**, because there are two questions people
actually ask:

- _"What is broken on mobile?"_ → browse **by device**
- _"What is broken on the pricing page?"_ → browse **by page**

Both views are generated from the same `report.json`, so they can never disagree.

## Viewport-independent vs viewport-specific findings

This distinction drives the whole layout, so it is worth stating plainly.

| Class                    | Categories                                                                                                                     | Captured                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| **Viewport-independent** | `content.*`, `image.*`, `price.*`, `link.*`, `page.*`, `meta.*`                                                                | Once, at the primary viewport |
| **Viewport-specific**    | `css.property-drift`, `css.layout-drift`, `css.visibility-drift`, `css.responsive-visibility-drift`, `css.horizontal-overflow` | At every enabled viewport     |

A paragraph either changed or it did not — that is not a per-device fact, and
reporting it four times (once per viewport) would inflate every count fourfold
and bury the findings that genuinely _are_ per-device.

CSS and layout are the opposite: the same element can be pixel-perfect at
1440px and broken at 360px, so those findings always carry a `viewport`.

> Comparison is always **like-for-like**: source at `mobile-sm` is compared with
> target at `mobile-sm`, never with source at `desktop`. A mobile layout
> legitimately differs from a desktop one; that is not drift.

## Output layout

```
drifter-out/<runId>/
├── index.html                    Overview: headline stats, device matrix, worst pages
├── stats.json                    Machine-readable statistics
├── report.json                   All findings (versioned schema, source of truth)
├── summary.md                    For a PR comment or pipeline summary
├── junit.xml                     Azure DevOps "Tests" tab
│
├── devices/                      ── BY DEVICE ──
│   ├── desktop/
│   │   ├── index.html            All CSS/layout findings at 1440x900, page list
│   │   └── pages/<slug>.html     One page at this device, with screenshots
│   ├── tablet/
│   ├── mobile-md/
│   └── mobile-sm/
│
├── pages/                        ── BY PAGE ──
│   ├── index.html                Every compared page, sorted by finding count
│   └── <slug>.html               One page across ALL devices, tabbed by viewport
│
├── css-report.html               ── SEPARATE CSS REPORT ──
├── css/
│   ├── index.html                CSS drift summary, grouped by property
│   └── <device>.html             CSS drift at one device
│
├── links-report.html             Broken links, redirect chains, path mismatches
├── coverage-report.html          Pages missing on target / extra on target
│
└── assets/
    └── screenshots/
        ├── <slug>/<device>/source.png     Full page
        ├── <slug>/<device>/target.png
        └── <slug>/<device>/<findingId>-{source,target,diff}.png
```

## Screenshots as evidence

Screenshots are **evidence, not detection**.

Detection is done by comparing computed styles and the canonical page model,
because those are deterministic and produce very few false positives. Pixel
comparison is the opposite: anti-aliasing, font hinting and one-pixel scroll
offsets make it noisy enough to be useless as a gate.

So nothing is ever reported _because_ pixels differ. But once a finding exists,
a side-by-side crop of the offending element is by far the fastest way to
understand and fix it — so every finding with an element attached carries:

- the source crop,
- the target crop,
- and a pixel-diff overlay of the two.

The overlay is safe here precisely because it is not driving the verdict.

One full-page screenshot is captured per page per device, and element crops are
cut from it offline using the geometry already recorded — one screenshot, many
crops, no extra navigation.

## The device matrix

The overview page leads with a matrix so a regression that only affects one
screen size is visible immediately:

| Page        | desktop | tablet | mobile-md | mobile-sm |
| ----------- | ------- | ------ | --------- | --------- |
| `/`         | 0       | 0      | 2         | 5         |
| `/products` | 1       | 1      | 1         | 1         |
| `/basket`   | 0       | 0      | 0         | 12        |

A row that is clean until the last column is a responsive bug. A row that is
uniform across all columns is a general styling difference. Being able to tell
those apart at a glance is the point of grouping by device.

## Statistics

Every percentage is a **parity** measure — how much of the source was faithfully
reproduced — so 100% always means "no drift" and the number improves as the
migration is fixed. Each one names its own denominator, because "coverage"
means nothing without one.

| Statistic       | Denominator                                                          |
| --------------- | -------------------------------------------------------------------- |
| Page coverage   | Source pages with a reachable target counterpart / all source pages  |
| Content parity  | Source nodes matched with identical text / all source nodes          |
| Image parity    | Source images matched / all source images                            |
| Price parity    | Source prices whose value matched / all source prices                |
| Style parity    | Property comparisons that agreed / all property comparisons          |
| Link parity     | Source link paths that resolve on target / all internal source links |
| Clean page rate | Pages with zero findings / compared pages                            |

Plus per-viewport CSS breakdowns, the most frequently drifting properties
(where to start fixing), and the worst-offending pages.
