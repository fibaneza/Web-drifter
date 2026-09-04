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

### What a real noise floor looks like

Measured against `nodejs.org` — a hydrated Next.js site, seven pages at depth 1,
two viewports, captured twice:

| Category                     | Count | Severity | Verdict                                                       |
| ---------------------------- | ----- | -------- | ------------------------------------------------------------- |
| `link.redirect-chain`        | 2     | info     | Real: an i18n prefix strip, and a `current` → `v26.8.1` alias |
| `page.alias`                 | 1     | info     | Real: `/learn` deduped against `/en/learn`                    |
| Content, CSS, images, prices | 0     | —        | Clean                                                         |

Zero findings from the content and computed-style comparators across two
independent captures of a JavaScript-rendered site is the result to aim for; it
means the readiness gate settled at the same point both times.

The `current` → `v26.8.1` redirect is worth dwelling on. It is genuine
non-determinism — it changes the day Node ships a release — and it is exactly
the kind of finding that would otherwise appear in a real run as drift the
migration did not cause.

## Crawl boundaries are not drift

Worth understanding, because it is the trap this check fell into once already.

A crawl is bounded by `maxDepth`, `maxPages`, `robots.txt` and the
include/exclude patterns, so **most link destinations are never captured on
either side**. A page beyond the boundary is not missing; it is unexamined, and
those are very different claims.

So `link.path-mismatch` accepts two independent kinds of evidence that a route
survived:

1. The target crawl **captured** the page, or
2. Some target page still **links to** it.

Either is enough. Requiring the first alone reported every out-of-bounds link as
a dropped route — 29 errors on a site compared against _itself_, all of them
paths at depth 2 in a `maxDepth: 1` crawl.

```
source /a ──link──▶ /deep          /deep is beyond maxDepth.
target /a ──link──▶ /deep          Neither side captured it.

                                   No evidence of drift. Report nothing.
```

The general principle: **absence of evidence is not evidence of absence.** A
comparator that cannot distinguish "the target lacks this" from "we did not
look" must stay quiet.

Hidden links are treated asymmetrically for the same reason. A hidden link on
the source is not a promise to the user, so it is never held to parity; a hidden
link on the _target_ still proves the route exists, so it counts as evidence.

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

### 6. Give the slower side room, not both

The two sides rarely need the same budget. A server-rendered CMS is ready almost
immediately; a React rewrite fetches, then renders, and is perfectly quiet in
between — so quiescence declares it settled while it still shows a placeholder,
and the capture records "Loading…" as total content loss.

The fix is `awaitFirstRenderMs`, and it belongs on the side that needs it:

```ts
source: { name: 'legacy', baseUrl: 'https://legacy.example.com' },
target: {
  name: 'react',
  baseUrl: 'https://new.example.com',
  stabilization: {
    awaitFirstRenderMs: 3000,   // wait for the router's first paint
    minWaitMs: 1000,            // floor for late-starting hydration
    quietMs: 800,
  },
},
```

Every field falls back to the global `stabilization` value, so overriding one
setting keeps the rest. Setting these globally instead would make the legacy
side pay the same wait on every page — at `awaitFirstRenderMs: 3000` across a
thousand pages, roughly fifty minutes for nothing.

Only timing may be overridden per side: `quietMs`, `readyTimeoutMs`,
`minWaitMs`, `awaitFirstRenderMs`, `scrollThroughPage` and `slowPages`.
`locale`, `timezoneId` and the clock and random freezes stay global, because a
per-side difference there would make the comparison unfair rather than merely
slower. Naming one of them in a per-side block is a config error, not a silently
ignored key.

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
