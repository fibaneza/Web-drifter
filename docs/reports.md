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
├── visual.html                   ── VISUAL MAP ──
│                                 Every visible difference drawn on the page it
│                                 appears on, numbered, both sides side by side
│
├── links-report.html             Broken links, redirect chains, path mismatches
├── coverage-report.html          Pages missing on target / extra on target
│
└── assets/
    ├── visual/
    │   └── <slug>@<device>-{source,target}.png   Full page, markers drawn on
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

## Findings by section

"Which page drifted" and "which section drifted" are different questions, and
the second is not answerable from a per-page breakdown.

| Section      | Findings | Share |
| ------------ | -------- | ----- |
| `main`       | 41       | 87.2% |
| `header`     | 4        | 8.5%  |
| `page-level` | 2        | 4.3%  |
| `nav`        | 0        | ·     |
| `footer`     | 0        | ·     |

Read it for where the work is. Drift concentrated in `header`, `nav` or
`footer` is **shared chrome** — one fix usually clears every page at once, and a
non-zero `nav` figure is the loudest of all because navigation appears on every
page. The same count spread across `main` is a page-by-page content job.

Regions with no findings are still listed: `nav: 0` is a result, and a table
that omits it leaves you unsure whether the navigation was compared at all.
`page-level` holds findings that carry no region — page coverage, links,
whole-page CSS — so the rows always sum to the headline total.

Region assignment, including what happens when a page declares no landmarks, is
described in [the page model](page-model.md#1-partition-by-region).

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

## Screenshot evidence

Findings that have a known position on the page carry crops of the element, cut
from the stored full-page captures. Three ways to reach them:

| Where                              | What you get                                                            |
| ---------------------------------- | ----------------------------------------------------------------------- |
| **Evidence** in the nav            | Every finding that has screenshots, grouped by page, cards already open |
| A **&#9673; shot** badge on a card | That finding has images; open it to see them                            |
| **With screenshot** filter         | Narrows any list to findings that have evidence                         |

Crops are cut for findings at or above `output.evidenceMinSeverity`, which
defaults to `error`. That covers text drift, missing text, missing images, wrong
prices and missing pages. Set it to `warning` to also crop extra components and
CSS drift:

```ts
output: {
  evidenceMinSeverity: 'warning',   // 'error' (default) | 'warning' | 'info'
}
```

Because CSS is graded no higher than a warning (see
[CSS comparison](css-comparison.md)), **CSS findings get no crops under the
default**. That is deliberate: cropping is the slowest part of writing a report,
and styling drift is rarely what someone opens the report to look at. One line
brings it back.

Evidence lands in `assets/shots/<page>/<viewport>/<finding-id>-{source,target,diff}.png`.
A one-sided crop is normal and meaningful: source-only shows what should be
there, target-only shows what appeared.

A page that is **missing entirely** has no element to crop, so it gets a
downscaled capture of the whole page from the side that does have it — the
source for `page.missing-on-target`, the target for `page.extra-on-target`. No
pixel overlay: two different pages of different heights produce a diff that is
enormous and says nothing.

> The pixel overlay illustrates a finding that content comparison already
> proved. Nothing is ever reported _because_ pixels differ.

## The visual map

`visual.html` answers a different question from the rest of the report. A
findings list answers "what is wrong"; the visual map answers **"where do I
look"** - the two full-page captures side by side, every visible difference
boxed and numbered, with a legend saying what each number is.

It marks, it does not detect. The comparison has already decided what changed,
which is why a marker carries a sentence — _"Price changed from $1,299.00 to
$1,399.00"_ — rather than a red smear. Boxes are coloured by severity, and a
number appearing on one side but not the other means the element exists on only
one site.

Three things are deliberately **not** marked:

| Excluded                | Why                                                                   |
| ----------------------- | --------------------------------------------------------------------- |
| Typography              | Real drift, but boxing every text node buries the few you can act on  |
| Markup annotation       | `alt` text, link targets, meta fields — invisible in a screenshot     |
| Sub-perceptual movement | An element that shifted a pixel or two is noise on any real migration |

`css.property-drift` is marked only for the `color` and `effects` property
groups; box spacing is left out because the same difference already arrives as
`css.layout-drift` with a box to point at. Movement must reach 8 CSS pixels on
some edge, and a box under roughly 80px² is skipped — below that the marker is
bigger than the thing it points at.

Everything excluded here is still in the CSS report. Nothing is hidden; it is
sorted.

## Getting from a finding to the page

Each finding shows, host-free, the source path and the target path it maps to,
with query parameters intact — those are part of a page's identity here, so
`/search?q=hat` and `/search?q=boot` are different pages.

Where a finding is about text, the Source and Target URLs are
[text-fragment](https://developer.mozilla.org/en-US/docs/Web/URI/Fragment/Text_fragments)
links: opening one scrolls the live page to the drifted text and highlights it.
Browsers that do not support text fragments open the page normally, so nothing
is lost.

Findings that carry geometry also state where the element sits, in CSS pixels
from the top-left of the page.

## The evidence gallery is paginated

The gallery opens its cards — seeing the screenshots without clicking is the
point — which defeats `loading="lazy"`. One page holding every finding therefore
decodes every image at once, so it is split into pages of 20 findings:
`evidence.html`, `evidence-2.html`, and so on, with links at both ends. Page one
keeps the name the navigation points at.

## Sorting

Findings arrive in the order the tool considers most useful: most serious first,
then by what is worth fixing first — prices and text, then missing or extra
components, then links, with styling last.

The **Sort** control offers two alternatives:

| Sort                   | Use it when                                               |
| ---------------------- | --------------------------------------------------------- |
| Most serious (default) | Working the report top-down                               |
| Size of drift          | "Show me the blatant ones" — ranks by `details.magnitude` |
| Page                   | Fixing one page at a time                                 |

Sorting reorders findings **within** their section, so subject groups keep their
headings and nothing is hoisted out of the group it belongs to.
