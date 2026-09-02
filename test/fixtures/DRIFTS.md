# Planted drifts in the fixture pair

`legacy/` and `modern/` render equivalent content with **completely different
markup** - tables and `sc-` classes vs semantic HTML5 and BEM. That is
deliberate: if the two fixtures shared structure, the tests would pass for the
wrong reason.

## Differences the tool MUST report

| #   | Page        | Category                          | Detail                                                                                                 |
| --- | ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `/`         | `css.property-drift`              | `h1` font-size 32px (legacy) vs 28px (modern)                                                          |
| 2   | `/`         | `css.responsive-visibility-drift` | "Spring sale" nav item hidden below 480px on legacy, below 900px on modern - so it differs at `tablet` |
| 3   | `/`         | `link.broken`                     | modern links to `/missing-page`, which 404s                                                            |
| 4   | `/about`    | `content.drift`                   | heading "Our history" vs "Our story"                                                                   |
| 5   | `/about`    | `content.missing`                 | apprenticeship paragraph present on legacy only                                                        |
| 6   | `/about`    | `content.added`                   | "Our values" section present on modern only                                                            |
| 7   | `/products` | `price.value-drift`               | $1,299.00 vs $1,399.00                                                                                 |
| 8   | `/contact`  | `page.missing-on-target`          | exists on legacy only                                                                                  |
| 9   | `/blog`     | `page.extra-on-target`            | exists on modern only                                                                                  |

## Things the tool MUST NOT report (false-positive guards)

| #   | Page        | Why it must stay quiet                                                                                                    |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| A   | `/products` | `$49.99` vs `USD 49,99` is the **same price** formatted differently - a `price.format-drift` at most, never a value drift |
| B   | all         | Images: `/-/media/images/hero.ashx?w=1200` vs `/_next/image?url=%2Fstatic%2Fhero.a1b2c3d4.webp` is the **same asset**     |
| C   | all         | Entirely different class names, tag choices and nesting depth are not content drift                                       |
| D   | `/`         | The external supplier link must be recorded but never crawled                                                             |

## SPA / client-side routing cases

`app.html` is a hash-routed single-page app whose view renders **asynchronously**
after navigation, and which lazy-loads more content on scroll. It exists to pin
down the React-shaped failure modes:

| Case | Must hold |
|---|---|
| `/app#/tools` vs `/app#/parts` | Two **separate pages** — the route lives in the fragment |
| `#pricing` | An in-page **anchor**, not a page — recorded, never crawled |
| View renders 350ms after load | Captured content is the rendered view, never the `Loading...` placeholder |
| Footnote appears only on scroll | Lazily-loaded content is captured, not missed |
| `#/parts` heading differs between sides | Reported as `content.drift` |
