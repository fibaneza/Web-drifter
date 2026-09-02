# Avoiding false positives

> A report with 4,000 bogus rows gets abandoned in week two.
> A false positive costs more than a missed finding.

That principle drives more of this codebase than any other. This page collects
what the tool does about it, and what you should do.

## Start here: measure the noise floor

```bash
drifter doctor
```

`doctor` crawls the **source twice** and compares it against itself. Both sides
are the same site, so **anything it reports is noise by construction** — a
carousel, an A/B bucket, a rendered timestamp, a lazily-loaded advert.

It prints ready-made suppression rules:

```
ignore: {
  findingIds: [
    'a3f81c02b9d4',
    …
  ],
},
```

Run it before you trust a single finding from a real comparison. A clean
`doctor` means every finding in a real run is a genuine difference.

## What the tool already handles

### Stabilisation, at capture time

| Technique                                   | Removes                                |
| ------------------------------------------- | -------------------------------------- |
| Fixed viewport, locale, timezone            | Environment variance                   |
| `prefers-reduced-motion` + animation freeze | Mid-animation captures                 |
| Web Animations API settling                 | Transitions already running on arrival |
| Seeded `Math.random`                        | A/B bucketing, shuffles                |
| Pinned clock epoch                          | Rendered dates and times               |
| Blocked analytics/ad hosts                  | Third-party injected DOM               |
| Scroll-through + re-settle                  | Lazily-loaded content                  |

> The clock is **pinned, not frozen**. A hard freeze hangs anything polling for
> time to pass, which would stop the page ever going quiet.

### The readiness gate

Waits for DOM quiescence rather than `networkidle`, which never fires on a React
app with polling, websockets or analytics beacons. It also waits for the first
DOM mutation _after_ load — a router that fetches then renders is perfectly
quiet in the meantime, and capturing then records a "Loading…" placeholder as
total content loss.

### Normalisation, at comparison time

- Text: whitespace, smart quotes, dashes, invisible characters, Unicode forms
- Colours: `#fff` = `rgb(255,255,255)` = `white`
- Lengths: sub-pixel tolerance
- Fonts: fallback-only differences downgraded to `info`
- Prices: `$1,299.00` = `USD 1 299,00`
- Images: CDN host, query, transform segments and content hash all stripped
- Markup: table cells, list items and paragraphs share one identity family

### Structural guards

- Alignment is partitioned by landmark region, so a footer paragraph can never
  pair with a body paragraph
- Pairs below the similarity threshold are reported as separate missing/added
  findings, never as a bogus "drift"
- Styles are only compared for elements content alignment already paired
- Vertical position alone is not compared — one extra line at the top would
  otherwise shift, and report, everything below it

## What you should tune

### 1. Remove third-party furniture

```ts
ignore: {
  selectors: ['#chat-widget', '.ad-slot', '[data-testid="cart-count"]'],
}
```

Elements removed here never enter the page model at all.

### 2. Blank volatile text

```ts
ignore: {
  textPatterns: [
    /\d{2}\/\d{2}\/\d{4}/,     // dates
    /©\s*\d{4}/,               // copyright year
    /\b\d+ items? in basket\b/,
  ],
}
```

### 3. Accept specific known differences

Every finding carries a **stable id**, hashed from its identity — category,
path, viewport, element, property — and never from the values compared. Fixing a
colour from red to orange does not mint a new id, so an acceptance keeps
applying.

```ts
ignore: {
  findingIds: ['a3f81c02b9d4'];
}
```

The id is shown on every finding in the HTML report.

### 4. Downgrade a whole category

```ts
ignore: {
  categories: ['css.layout-drift'];
}
```

This demotes to `info` rather than deleting. That is deliberate: a category that
is noisy today may hide a real regression tomorrow, and silently dropping it
removes the only evidence it was ever considered.

To change severity without demoting all the way:

```ts
severities: { 'css.property-drift': 'info' }
```

### 5. Give slow pages room

A premature timeout is the most misleading false positive there is — it looks
like catastrophic content loss rather than a slow upstream.

```ts
stabilization: {
  slowPages: [
    { pattern: /^\/reports\//, readyTimeoutMs: 60_000, quietMs: 1500 },
  ],
}
```

Pages whose readiness gate timed out are flagged **slow capture** in the report,
so their findings can be read with appropriate suspicion.

## Deliberate non-features

**Pixel comparison never gates anything.** Anti-aliasing, font hinting and
one-pixel scroll offsets make it far too noisy to drive a verdict. Screenshots
exist purely as _evidence_ for a finding another method already proved — that is
why the overlay is safe.

**Raw HTML is never diffed.** Ever. If a change makes this tool compare markup
structure, it is the wrong change.

## When a page is missing from the report

Every rejection is counted by reason in the crawl stats — `off-origin`,
`depth-exceeded`, `trap`, `excluded`, `not-included`, `ignored-path`,
`duplicate`, `already-captured`. See [Crawl boundaries](crawl-bounding.md).
