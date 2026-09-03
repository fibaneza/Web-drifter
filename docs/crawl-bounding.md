# Crawl boundaries

Three rules bound every crawl, all enforced in the frontier _before_ a URL is
ever fetched. Every rejection is counted and reported, so a page that is missing
from a run can always be explained.

## 1. Same-origin only

The crawler never navigates to or renders another origin. "Same origin" is
evaluated per side against that side's own `baseUrl`, because source and target
live on different hosts by definition.

```
allowed  ⟺  scheme + host + port match the side's baseUrl
```

Nothing is inferred. `www.example.com` and `example.com` are **different**
origins, as is any subdomain — widen explicitly with `crawl.additionalOrigins`.
If `baseUrl` includes a path (`https://host/en-gb/`), the crawl is confined to
that sub-path too.

| Link kind                         | Crawled?                                        | Recorded? | Status-checked?                       |
| --------------------------------- | ----------------------------------------------- | --------- | ------------------------------------- |
| Same-origin `http(s)`             | yes, within depth                               | yes       | yes                                   |
| External `http(s)`                | **never**                                       | yes       | yes, HEAD only (`checkExternalLinks`) |
| `mailto:` / `tel:`                | no                                              | yes       | syntax only                           |
| `javascript:` / `data:` / `blob:` | no                                              | yes       | no                                    |
| Protocol-relative `//host/x`      | resolved against the page scheme, then as above |           |                                       |

External links are recorded and HEAD-checked so genuinely dead outbound links
still appear in the links report — but they are never rendered, so the crawl
cannot wander off into the public internet.

## 2. Depth limit

`crawl.maxDepth` (default `2`) counts **link hops from a seed**:

```
depth 0   seed URLs (crawl.startUrls, plus sitemap entries)
depth 1   pages linked from depth-0 pages
depth 2   pages linked from depth-1 pages   ← captured, links NOT followed
```

So the default captures **three tiers of pages**. Links found on depth-2 pages
are still recorded — they count for the links and coverage reports — but never
enqueued.

A URL reachable by several routes keeps its **minimum** depth. Breadth-first
ordering normally gives that for free, but under concurrency a page can be
discovered via a long route first, so the frontier also promotes an entry when a
shorter route to it appears later. Without that, a page legitimately two hops
from the home page could be discarded because a slower worker happened to find
it at three.

Sitemap entries are seeded at depth 0 deliberately: they are entry points the
site advertises, not pages found by wandering, and they reach content buried
deeper than `maxDepth` would.

The sitemap is located from robots.txt first — any `Sitemap:` line it declares,
in order — and only then from the conventional `/sitemap.xml`. Trying the
convention alone finds nothing on the many sites that publish elsewhere;
WordPress ships `/sitemap_index.xml` and says so only in robots.txt. Both
robots.txt and the sitemap are fetched with the side's configured
`headers`, so a staging site behind a preview-bypass token still contributes
seeds rather than silently contributing none.

## 3. Never revisit

A URL is reduced to a **canonical key** before any visited check:

1. lowercase scheme and host; drop default ports (`:80`, `:443`)
2. drop the fragment
3. drop tracking parameters and any in `dropParams`; sort the rest
4. normalise percent-encoding, collapse `//`, resolve `.` and `..`
5. drop `index.html` / `default.aspx`; apply the trailing-slash policy

Then three independent dedup layers:

| Layer             | Key                              | Catches                                   |
| ----------------- | -------------------------------- | ----------------------------------------- |
| Requested URL     | canonical key                    | plain repeat links                        |
| Post-redirect URL | canonical key of the final URL   | `/a` and `/a/` both landing on `/a`       |
| Content hash      | hash of the canonical page model | distinct URLs rendering an identical page |

Layers 2 and 3 record the extra URL as an **alias** — it appears in the coverage
report rather than being silently dropped.

### Query parameters are part of a page's identity

This is the rule most likely to bite, so it is worth being explicit.

**By default, different query values mean different pages.**

| URLs                                     | Treated as                             |
| ---------------------------------------- | -------------------------------------- |
| `/search?q=hammer` vs `/search?q=saw`    | **two pages** — both crawled           |
| `/products?page=1` vs `/products?page=2` | **two pages** — both crawled           |
| `/products?page=2` vs `/products`        | **two pages**                          |
| `/p?a=1&b=2` vs `/p?b=2&a=1`             | one page — order is not identity       |
| `/p?utm_source=news` vs `/p`             | one page — tracking params are dropped |

Collapsing query variants would silently drop most of a paginated catalogue or a
search-driven site, so the default keeps every parameter except known tracking
ones (`utm_*`, `gclid`, `gbraid`, `fbclid`, `msclkid`, `mc_cid`, `_ga`, …).
Ambiguous names like `ref` and `source` are deliberately **not** on that list,
because some sites route on them; drop those per-site with `dropParams`.

> ### ⚠️ `queryAllowlist` inverts this
>
> Setting `urlMapping.queryAllowlist` switches to strict allowlist mode, where
> every parameter **not** listed is discarded. `queryAllowlist: ['page']` makes
> `/search?q=hammer` and `/search?q=saw` canonicalise to the same `/search`, and
> one of them is never compared.
>
> Prefer `dropParams` to remove specific noisy parameters. Reach for
> `queryAllowlist` only to tame a genuine faceted-search URL explosion, and
> check the coverage report afterwards for pages you did not expect to lose.

### One more interaction worth knowing

Content-hash dedup (layer 3) can also collapse query variants: if
`/list?sort=asc` and `/list?sort=desc` render identically on the **source** but
differ on the **target**, only one source page is captured, so the difference is
never compared. It is rare, but if a site has URLs like that, turn it off:

```ts
crawl: {
  dedupeIdenticalContent: false;
}
```

## Crawler traps

The depth cap alone does not guarantee termination, because a single page can
mint thousands of distinct depth-1 URLs. These guards bound the URL space:

| Guard                | Default | Catches                                              |
| -------------------- | ------- | ---------------------------------------------------- |
| `maxRepeatedSegment` | 3       | self-nesting from a bad relative link (`/a/b/a/b/a`) |
| `maxPathSegments`    | 12      | runaway path construction                            |
| `maxQueryParams`     | 8       | faceted-search permutation explosions                |
| `maxUrlLength`       | 2048    | pathological URLs                                    |
| `crawl.maxPages`     | 1000    | absolute ceiling per side                            |

Note that `maxQueryParams` will reject a faceted-search URL carrying more than
eight filters. Raise it if the site legitimately uses that many.

## Explaining a missing page

Every rejection is counted by reason and reported in the crawl stats:

```
off-origin        the link pointed at another host
depth-exceeded    further than maxDepth hops from a seed
trap              matched a crawler-trap guard
excluded          matched crawl.excludePatterns
not-included      crawl.includePatterns was set and this did not match
ignored-path      matched ignore.paths
duplicate         already seen at the same or a shallower depth
already-captured  already fetched
```

If a page you expected is missing from the report, that table says why.

## Slow pages and retries

A page whose readiness gate times out is still captured — the capture is just
flagged as possibly incomplete, and counted in `slowPages`. That distinction
matters, because dropping the page instead would report every node it contains
as missing content: a timeout would masquerade as total drift.

`crawl.retries` (default `1`) re-attempts two failures that look nothing alike:

| Failure                  | What it usually means                |
| ------------------------ | ------------------------------------ |
| Navigation threw         | Transient network or browser fault   |
| Readiness gate timed out | Rendered, but perhaps not completely |

A retry can never make the result worse. Every attempt is kept and the best one
wins — fewer errors first, then more content — so a second attempt that fails
outright still leaves the first attempt's partial capture in place. A clean
capture returns immediately without spending the remaining budget.

Backoff is linear (500 ms, 1000 ms, …): a page that timed out is usually under
load, and retrying instantly mostly succeeds in reproducing the timeout.

```
attempt 1  ─ readiness timed out ─┐
                                  ├─ keep the better capture
attempt 2  ─ readiness timed out ─┘
                                  └─ captured, flagged slow, retriedPages += 1
```

`retriedPages` counts pages that needed more than one attempt. A run where it
climbs is telling you the source site is slower than `stabilization.readyTimeoutMs`
allows — raise that before raising `retries`, since the retry pays the full
timeout again.

## Pages nothing links to

A long-lived CMS accumulates pages that are still published but no longer
reachable: old campaign landing pages, print catalogues, URLs only ever sent by
email. The sitemap still lists them, so the crawler still finds them.

Counting those against the migration measures **the size of the legacy backlog,
not the quality of the rewrite** — and lets a 2019 landing page fail today's
build. So a source page that no other crawled source page links to is treated as
an orphan:

- still crawled, still compared, still reported;
- **excluded** from `pageCoverage`, from the run's finding counts, and therefore
  from `thresholds.failOn`;
- listed in its own section of the coverage report, which states that exclusion.

```
Page coverage   100%   (2 / 2 linked source pages)

Unreachable source pages (1)
  /campaigns/spring-2019    missing on target
  — excluded from every figure above and cannot fail a build
```

A page named in `crawl.startUrls` is never an orphan: it was chosen
deliberately, so `/` does not become one just because the home link is a logo
image. A hidden link still counts as making a page reachable — this is a
question about the site's shape, not about what a visitor can click.

Set `crawl.treatUnlinkedAsOrphans: false` to hold every published page to the
same standard.

> Reachability is derived from the stored snapshots, not from the crawler. The
> frontier does record where a URL was discovered, but it rejects a re-offer at
> equal-or-worse depth before updating that, and every sitemap URL is seeded at
> depth 0 — so a sitemap page that _is_ linked would still look orphaned.
> Deriving it from link records avoids that, works on runs captured earlier, and
> is recomputed by `drifter compare` without a re-crawl.

## Further reading

- [The artifact store](artifact-store.md) — what a bounded crawl costs on disk
