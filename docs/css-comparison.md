# CSS and layout comparison

Produces the **separate CSS report**. Two decisions define it.

## 1. Computed styles, never stylesheets

Across a rewrite the two sites share no selectors, no class names and no cascade
structure. Diffing CSS source is therefore meaningless — there is nothing to
line up.

Computed style is the only common ground, and it is what the browser actually
resolved, which is what the user actually sees.

```
legacy  .sc-header h1  { font-size: 32px }      ─┐
                                                 ├─→  compare 32px vs 28px
modern  .masthead__title { font-size: 28px }    ─┘
```

## 2. Only elements content comparison already paired

Styles are never matched independently. If the content pass could not
confidently say two elements are the same element, comparing their styles would
attribute a difference to the wrong thing.

Findings below `thresholds.minMatchConfidence` are not reported at all.

## Comparison is always like-for-like

Source at `mobile-sm` against target at `mobile-sm`, never against source at
`desktop`. A mobile layout differing from a desktop one is not drift.

## The property allowlist

`getComputedStyle` exposes ~350 properties. Most are defaults that never differ,
or are derived from others and would double-report the same difference.
Comparing everything produces a report nobody reads.

| Group      | Properties                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typography | `font-family`, `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `word-spacing`, `text-transform`, `text-decoration-line`, `text-align`, `white-space`, `text-overflow` |
| Colour     | `color`, `background-color`, `border-*-color`, `outline-color`, `opacity`, `fill`, `stroke`                                                                                                      |
| Box        | `margin-*`, `padding-*`, `border-*-width`, `border-*-style`, `border-*-radius`, `box-sizing`                                                                                                     |
| Layout     | `display`, `position`, `flex-*`, `justify-content`, `align-*`, `gap`, `grid-template-*`, `float`, `clear`, `z-index`, `overflow-*`, `vertical-align`                                             |
| Effects    | `box-shadow`, `text-shadow`, `transform`, `filter`, `background-*`, `visibility`, `cursor`                                                                                                       |

**Longhands only.** Shorthands (`margin`, `border`, `font`) are excluded because
engines resolve them inconsistently, and a longhand difference would then be
reported twice.

## Normalisation — where the false positives die

Without this the report is unusable. Two stylesheets expressing the same intent
routinely produce values that are textually different and visually identical.

| Problem                                              | Handling                                             |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `#fff` vs `rgb(255,255,255)` vs `white`              | Canonicalised to `rgba(r, g, b, a)`                  |
| `rgba(0,0,0,0.8)` vs `rgba(0,0,0,0.800000012)`       | Alpha rounded                                        |
| `16px` vs `16.0000px` vs `15.9998px`                 | Parsed to px, compared with `thresholds.cssLengthPx` |
| `"Helvetica Neue", Arial` vs `Helvetica Neue, Arial` | Stack unquoted, lowercased                           |
| `0 1px 2px rgba(0,0,0,.5)` whitespace                | Collapsed                                            |
| `0 1px 2px #000` vs `0 1px 2px rgb(0,0,0)`           | Colours inside compound values canonicalised too     |

### SVG paint

`fill` and `stroke` are in the colour group because nothing else can see them.
An inline icon set or logo recoloured in the rewrite leaves the element's
`color` unchanged, its geometry unchanged, and its asset key unchanged — the
markup _is_ the asset. Both properties inherit, so a wrapper carries the colour
of the icons inside it. On a non-SVG element they compute to a default that is
identical on both sides, so they cost a comparison and produce no finding.

### Colours inside shadows and gradients

`box-shadow` and `background-image` are where a rewrite most often changes a
brand colour, and they are compound values rather than colours. Comparing them
as strings meant a gradient whose colour moved by one channel reported
identically to one that went from navy to orange, and neither carried a
perceptual distance.

A compound value is now split into its **structure** and its **colours**. When
only the colours differ, it is judged exactly as `color` is — below
`cssColorDeltaWarn` it is not drift at all, above it, it is a colour finding
carrying its distance.

When the structure differs too — a gradient that gained a stop, a shadow that
moved — it stays a plain value difference. Calling that a colour change would
hide the structural change behind a delta.

### Sub-pixel lengths

A percentage width resolving against a container that differs by a fraction of a
pixel makes **every descendant** differ too. One tolerated difference at the top
prevents hundreds of derived rows below.

### Font fallbacks

When the _first_ family agrees and only the fallbacks differ, both render
identically anywhere the primary font exists. That is classified separately and
emitted at `info` — reporting it as drift would flag every text node on the site
over a difference nobody can see.

## Layout geometry

Document-relative bounding boxes, compared per viewport with a tolerance that
**scales with viewport width**:

```
tolerance = max(thresholds.geometryPx, viewportWidth × thresholds.geometryPercent)
```

2px is generous at 1440px and punitive at 360px, where it is over half a percent
of the screen.

> **Vertical position is deliberately not compared on its own.** One extra line
> of text near the top of a page shifts everything below it, which would turn a
> single real difference into hundreds of derived ones. Width, height and
> horizontal position are compared; vertical drift surfaces through the elements
> that actually changed.

Size and position are reported as separate facets, because they mean different
things: a box that moved is usually caused by something above it, while a box
that changed size is usually its own styling.

## Visibility — the responsive signal

Visibility is accumulated across **all** viewports before being classified,
because the distinction can only be made once every viewport is known:

| Pattern                              | Category                          | Severity |
| ------------------------------------ | --------------------------------- | -------- |
| Hidden on target at _every_ viewport | `css.visibility-drift`            | error    |
| Hidden on target at _some_ viewports | `css.responsive-visibility-drift` | error    |

The second is the most common real defect in a responsive rewrite — a nav item
that vanishes on mobile, a panel that never appears on tablet — and it is
reported **per device**, with the viewports where the two sides agree listed in
its details so the breakpoint is obvious.

An element hidden on either side is skipped for property and geometry
comparison: its computed values are not what the user sees.

## Horizontal overflow

Content wider than the viewport forces horizontal scrolling. Reported when the
target overflows and the source does not — one of the most visible responsive
regressions there is.

## Severities and tuning

`css.property-drift` and `css.layout-drift` default to **warning**, not error.
Some styling change is intentional in a redesign, and treating every one as a
build failure makes the gate unusable on day one. Elements _disappearing_ is
different, and defaults to error.

Tune per project:

```ts
severities: {
  'css.layout-drift': 'info',        // redesign changed spacing on purpose
  'css.property-drift': 'error',     // pixel-parity is the acceptance criterion
},
ignore: {
  cssProperties: ['font-family'],    // the font stack changed deliberately
},
```

## Reading the report

`css-report.html` gives the whole picture and links to `css/<device>.html` for
one screen size at a time. The **most frequently drifting properties** table is
the place to start: one root cause usually explains a whole column.

## Severity is graded by distance

A report where a 1px nudge and a redesign read identically gets ignored
wholesale, so CSS findings are banded by how big the difference actually is.

Each graded finding carries `details.magnitude`: one unitless number, across
colour, length and geometry, measured against the threshold that makes a drift a
warning. **At or above 1 is a warning; below it is information.**

| Family                              | Distance                                   | Warning at                                             |
| ----------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Colour                              | Perceptual delta (CIE Lab, via `colord`)   | `thresholds.cssColorDeltaWarn` (0.03)                  |
| Length — font-size, margin, padding | Larger of the absolute and relative change | `cssLengthWarnPx` (4) or `cssLengthWarnPercent` (0.15) |
| Geometry                            | Largest shift in a gated dimension         | `cssGeometryWarnFactor` (2) × the tolerance in force   |

The length family takes the _larger_ of the two measures, which is what stops
3px reading the same on a 12px caption as on a 48px heading.

Geometry is expressed as a multiple of the tolerance rather than a pixel count
because the tolerance itself scales with viewport width. A fixed threshold would
sit below the reporting gate at 1440px and above it on a phone, making the
information band unreachable at one end or the other.

### Colour has a tolerance now

Colours used to be compared as strings, so `rgb(0,0,0)` against `rgb(1,1,1)` —
which nobody can see and every rewrite produces — reported identically to black
against white. Anything below `thresholds.cssColorTolerance` (0.01, roughly the
threshold of human vision) is no longer reported at all.

Calibration, measured:

| Pair                                                    | Distance |
| ------------------------------------------------------- | -------- |
| `rgb(0,0,0)` vs `rgb(1,1,1)` — imperceptible            | 0.002    |
| `rgb(26,29,33)` vs `rgb(40,44,50)` — subtle but visible | 0.048    |
| Blue vs red                                             | 0.469    |
| Black vs white                                          | 1.000    |

### CSS never becomes an error

Whatever the magnitude, a styling drift is capped at `warning`, so CSS alone can
never fail a build through `thresholds.failOn.error`. Some restyling is
intentional in a rewrite, and a gate that fails on a shifted margin gets switched
off on day one — at which point it catches nothing at all.

Two exceptions, and they are not really styling: `css.visibility-drift` and
`css.responsive-visibility-drift` stay errors. An element that vanished is a
missing component.

An explicit override in config still wins outright, so the escape hatch is
honest:

```ts
severities: { 'css.property-drift': 'error' },   // gates on styling once the migration is close
```

## Node identity is region-qualified

A node's `ordinal` counts within `region|key`, so a "Home" link in the nav and
one in the footer are **both ordinal 0 and share a key**. Style lookup therefore
keys on `region|key#ordinal`.

This is not pedantry. Keying without the region made both nodes resolve to
whichever was indexed last, which meant:

- CSS drift was attributed to the wrong element — reporting drift that did not
  exist, and missing drift that did; and
- the screenshot crop showed the wrong part of the page, which is worse than
  showing nothing, because a reviewer trusts what the picture shows.

`NodeStyle.region` is optional, and the snapshot schema version did not change:
an added optional field is a compatible read, so a stored run is not rejected. A
snapshot captured before it existed falls back to the old ambiguous key, and
yields no element evidence rather than wrong evidence. Re-crawl to get both.
