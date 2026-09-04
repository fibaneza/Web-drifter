/**
 * The in-page extractor.
 *
 * `extractInPage` is serialised and evaluated inside the browser, so it must be
 * entirely self-contained: no imports, no closure over module scope, no
 * TypeScript features that would emit a runtime helper. Everything it needs
 * arrives through its single options argument.
 *
 * It deliberately does only DOM work. Hashing, text normalisation, price
 * parsing and node keying all happen in Node, where they are deterministic and
 * unit testable rather than dependent on browser behaviour.
 */

export interface ExtractOptions {
  /** Elements removed from consideration entirely (chat widgets, ad slots). */
  ignoreSelectors: string[];
  /** Extra selectors known to contain a displayed price. */
  priceSelectors: string[];
  /** Computed CSS properties to record for each node. */
  cssProperties: string[];
  /** Cap on elements scanned for background images, to bound cost. */
  maxElementScan: number;
  /**
   * Landmark inference for pages that declare none, as `[region, pattern]`
   * pairs applied in order. Passed as data because this function is serialised
   * into the page and cannot import anything.
   */
  regionHints: Array<[string, string]>;
}

export interface RawBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawNode {
  kind: string;
  region: string;
  /** Raw text, normalised later in Node. */
  text: string;
  attrs: Record<string, string | number | boolean | undefined>;
  selectorHint: string;
  box: RawBox;
  visible: boolean;
  styles: Record<string, string>;
}

export interface RawLink {
  href: string;
  text: string;
  region: string;
  visible: boolean;
  rel: string;
  target: string;
}

export interface RawImage {
  src: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
  region: string;
  visible: boolean;
  isBackground: boolean;
  box: RawBox;
}

export interface RawPriceCandidate {
  /** The matched text exactly as displayed. */
  raw: string;
  /** Where it came from, in decreasing order of reliability. */
  source: 'jsonld' | 'microdata' | 'selector' | 'text';
  region: string;
  /** Surrounding text used to pair prices across the two sites. */
  context: string;
  /** Currency code when the source states it explicitly (JSON-LD, microdata). */
  currency?: string;
  /**
   * Where the price is rendered, when it came from an element at all.
   * Absent for JSON-LD, which is metadata with nothing on screen to point at.
   */
  box?: RawBox;
}

export interface RawPageModel {
  title: string;
  meta: {
    description: string | null;
    canonical: string | null;
    robots: string | null;
    lang: string | null;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImage: string | null;
  };
  nodes: RawNode[];
  links: RawLink[];
  images: RawImage[];
  prices: RawPriceCandidate[];
  documentHeight: number;
  documentWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Content wider than the viewport - a classic responsive regression. */
  hasHorizontalOverflow: boolean;
}

/**
 * Build the raw page model. Evaluated inside the browser.
 *
 * Exported (rather than inlined at the call site) so it can be type-checked and
 * reviewed like normal code.
 */
export function extractInPage(options: ExtractOptions): RawPageModel {
  const ignored = new Set<Element>();
  for (const selector of options.ignoreSelectors) {
    try {
      for (const element of document.querySelectorAll(selector)) {
        ignored.add(element);
        for (const descendant of element.querySelectorAll('*')) ignored.add(descendant);
      }
    } catch {
      // An invalid selector in config must not abort the whole extraction.
    }
  }

  const isIgnored = (element: Element): boolean => {
    if (ignored.has(element)) return true;
    // Machine-only content: never rendered, so never comparable.
    return element.closest('script, style, noscript, template, svg defs') !== null;
  };

  /* ---------------------------------------------------------------- regions */

  /**
   * `<header>` and `<footer>` only map to the banner/contentinfo landmarks when
   * they are NOT scoped to a sectioning element - a `<header>` inside an
   * `<article>` is that article's header, not the site header. Getting this
   * wrong would let an article heading match the site masthead.
   */
  const isPageLevelScope = (node: Element): boolean => {
    let parent = node.parentElement;
    while (parent && parent !== document.body) {
      const tag = parent.tagName.toLowerCase();
      if (
        tag === 'article' ||
        tag === 'aside' ||
        tag === 'main' ||
        tag === 'nav' ||
        tag === 'section'
      ) {
        return false;
      }
      parent = parent.parentElement;
    }
    return true;
  };

  /**
   * Does this document declare any landmark at all?
   *
   * Decided once, for the whole page. When it does, its landmarks are trusted
   * completely and class names are never consulted - second-guessing a page
   * that marked itself up properly could only make things worse. The `id` and
   * `class` heuristic exists solely for markup that offers nothing else.
   */
  const hasLandmarks =
    document.querySelector(
      'header, nav, main, footer, aside, [role="banner"], [role="navigation"], ' +
        '[role="main"], [role="contentinfo"], [role="complementary"]',
    ) !== null;

  const hints = options.regionHints.map(
    ([region, pattern]) => [region, new RegExp(pattern)] as const,
  );

  const inferRegion = (node: Element): string | null => {
    const className = typeof node.className === 'string' ? node.className : '';
    const identity = `${className} ${node.id ?? ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (identity === '') return null;

    for (const [region, pattern] of hints) {
      if (pattern.test(identity)) return region;
    }
    return null;
  };

  const regionOf = (element: Element): string => {
    let node: Element | null = element;
    while (node && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      const role = (node.getAttribute('role') ?? '').toLowerCase();

      if (role === 'banner') return 'header';
      if (role === 'navigation') return 'nav';
      if (role === 'contentinfo') return 'footer';
      if (role === 'complementary') return 'aside';
      if (role === 'main') return 'main';

      if (tag === 'nav') return 'nav';
      if (tag === 'aside') return 'aside';
      if (tag === 'main') return 'main';
      if (tag === 'header' && isPageLevelScope(node)) return 'header';
      if (tag === 'footer' && isPageLevelScope(node)) return 'footer';

      if (!hasLandmarks) {
        const inferred = inferRegion(node);
        if (inferred !== null) return inferred;
      }

      node = node.parentElement;
    }
    return 'other';
  };

  /* ------------------------------------------------------------- visibility */

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  const boxOf = (element: Element): RawBox => {
    const rect = element.getBoundingClientRect();
    // Document-relative, so a different scroll position cannot look like drift.
    return {
      x: Math.round((rect.left + scrollX) * 100) / 100,
      y: Math.round((rect.top + scrollY) * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  };

  const isVisible = (element: Element): boolean => {
    const el = element as Element & {
      checkVisibility?: (opts: Record<string, boolean>) => boolean;
    };
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      });
    }
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };

  /* ---------------------------------------------------------- selector hint */

  const selectorHintOf = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    for (let depth = 0; node && depth < 3 && node !== document.body; depth += 1) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${node.id}`;
        parts.unshift(part);
        break;
      }
      const className = typeof node.className === 'string' ? node.className.trim() : '';
      if (className) part += `.${className.split(/\s+/).slice(0, 2).join('.')}`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  /* --------------------------------------------------------------- styles */

  const stylesOf = (element: Element): Record<string, string> => {
    const computed = getComputedStyle(element);
    const out: Record<string, string> = {};
    for (const property of options.cssProperties) {
      out[property] = computed.getPropertyValue(property).trim();
    }
    return out;
  };

  /** An element's OWN text, excluding anything contributed by descendants. */
  const directText = (element: Element): string => {
    let text = '';
    for (const child of element.childNodes) {
      if (child.nodeType === 3) text += child.nodeValue ?? '';
    }
    return text;
  };

  /* ---------------------------------------------------------------- nodes */

  const nodes: RawNode[] = [];
  const pushNode = (
    element: Element,
    kind: string,
    text: string,
    attrs: Record<string, string | number | boolean | undefined> = {},
  ): void => {
    if (text.trim() === '' && kind !== 'image') return;
    nodes.push({
      kind,
      region: regionOf(element),
      text,
      attrs,
      selectorHint: selectorHintOf(element),
      box: boxOf(element),
      visible: isVisible(element),
      styles: stylesOf(element),
    });
  };

  // Text-bearing blocks. Nested candidates (a <p> inside an <li>) are skipped so
  // the same words are not recorded twice at two different granularities.
  const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, td, th, dt, dd, blockquote, figcaption';
  const blockKind = (tag: string): string => {
    if (tag.length === 2 && tag[0] === 'h') return 'heading';
    if (tag === 'li' || tag === 'dt' || tag === 'dd') return 'listItem';
    if (tag === 'td' || tag === 'th') return 'tableCell';
    return 'paragraph';
  };

  /** Elements already captured by the block pass, so later passes skip them. */
  const capturedElements = new Set<Element>();

  /**
   * Elements captured elsewhere in their own right. A container that merely
   * wraps one of these adds no content of its own.
   */
  const CARRIER_SELECTOR = 'a[href], img, button, [role="button"], select, textarea';

  for (const element of document.querySelectorAll(BLOCK_SELECTOR)) {
    if (isIgnored(element)) continue;
    if (element.parentElement?.closest(BLOCK_SELECTOR)) continue;

    // A cell or item that only wraps a link or an image contributes nothing of
    // its own: `<td><a>Home</a></td>` would otherwise record "Home" twice, once
    // as a table cell and once as a link. That doubling is severe in navigation,
    // where it makes every item appear both missing AND added once the other
    // side implements the same nav with different tags.
    if (directText(element).trim() === '' && element.querySelector(CARRIER_SELECTOR)) {
      continue;
    }

    capturedElements.add(element);

    const tag = element.tagName.toLowerCase();
    const kind = blockKind(tag);
    const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
    const attrs: Record<string, string | number | boolean | undefined> = {};

    if (kind === 'heading') attrs['level'] = Number(tag.slice(1));
    if (kind === 'tableCell') {
      const cell = element as HTMLTableCellElement;
      attrs['col'] = cell.cellIndex;
      attrs['row'] = (cell.parentElement as HTMLTableRowElement | null)?.rowIndex ?? -1;
    }
    if (kind === 'listItem') {
      let depth = 0;
      let parent = element.parentElement;
      while (parent) {
        const parentTag = parent.tagName.toLowerCase();
        if (parentTag === 'ul' || parentTag === 'ol' || parentTag === 'dl') depth += 1;
        parent = parent.parentElement;
      }
      attrs['depth'] = depth;
    }

    pushNode(element, kind, text, attrs);
  }

  /*
   * Generic text-bearing elements.
   *
   * The block pass above only sees semantic tags. A component-based rewrite
   * puts most of its copy in `<div>` and `<span>`, and a client-side router
   * commonly renders straight into a container - so text like
   * `<main id="view">Hand tools catalogue</main>` would otherwise be invisible
   * to the model entirely. That is not a cosmetic gap: it silently drops real
   * content from the comparison, and can make two different routes look
   * identical.
   *
   * Only DIRECT text is taken (an element's own text nodes, not its
   * descendants'), so a wrapper does not re-report everything nested inside it.
   */
  const SKIP_GENERIC = new Set([
    'a', // captured as links
    'script',
    'style',
    'noscript',
    'template',
    'option',
    'title',
    'br',
  ]);

  const CONTROL_SELECTOR = 'button, [role="button"], summary, label, select, textarea';

  /**
   * True when an ancestor was already captured, so this element's text is
   * already accounted for.
   *
   * Tested against what was ACTUALLY captured, not against the block selector:
   * a `<li>` that merely wraps an image and some spans is skipped by the block
   * pass, and its spans must then be captured here. Checking `closest(BLOCK)`
   * instead would skip them too, silently dropping the text - which is exactly
   * how a product name inside `<li><img><span>Name</span></li>` disappeared.
   */
  const hasCapturedAncestor = (element: Element): boolean => {
    let parent = element.parentElement;
    while (parent) {
      if (capturedElements.has(parent)) return true;
      parent = parent.parentElement;
    }
    return false;
  };

  for (const element of document.querySelectorAll('body *')) {
    if (isIgnored(element) || capturedElements.has(element)) continue;

    const tag = element.tagName.toLowerCase();
    if (SKIP_GENERIC.has(tag)) continue;
    if (hasCapturedAncestor(element)) continue;
    // An anchor's label belongs to the link node, not to a generic text node.
    if (element.closest('a[href]')) continue;

    const text = directText(element);
    if (text.trim() === '') continue;

    capturedElements.add(element);
    pushNode(element, element.matches(CONTROL_SELECTOR) ? 'control' : 'paragraph', text);
  }

  /* ---------------------------------------------------------------- links */

  const links: RawLink[] = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (isIgnored(anchor)) continue;
    const el = anchor as HTMLAnchorElement;
    const text = (el.innerText ?? el.textContent ?? '').trim();
    const visible = isVisible(el);
    const region = regionOf(el);

    links.push({
      href: el.getAttribute('href') ?? '',
      text,
      region,
      visible,
      rel: el.getAttribute('rel') ?? '',
      target: el.getAttribute('target') ?? '',
    });

    // Links are also content: their label is comparable text, and a link whose
    // destination changed is drift even when the label did not.
    pushNode(el, 'link', text || (el.getAttribute('aria-label') ?? ''), {
      href: el.getAttribute('href') ?? '',
    });
  }

  /* --------------------------------------------------------------- images */

  const images: RawImage[] = [];
  for (const image of document.querySelectorAll('img')) {
    if (isIgnored(image)) continue;
    const el = image;
    images.push({
      src: el.currentSrc || el.src || el.getAttribute('src') || '',
      alt: el.getAttribute('alt') ?? '',
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
      region: regionOf(el),
      visible: isVisible(el),
      isBackground: false,
      box: boxOf(el),
    });
    pushNode(el, 'image', el.getAttribute('alt') ?? '', {
      src: el.currentSrc || el.src || '',
      alt: el.getAttribute('alt') ?? '',
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
    });
  }

  // CSS background images: hero banners and decorative panels are routinely
  // backgrounds rather than <img>, and losing one in a migration is very
  // visible. Bounded by maxElementScan so a huge DOM cannot stall the capture.
  const allElements = document.querySelectorAll('*');
  const scanLimit = Math.min(allElements.length, options.maxElementScan);
  for (let i = 0; i < scanLimit; i += 1) {
    const element = allElements[i];
    if (!element || isIgnored(element)) continue;
    const backgroundImage = getComputedStyle(element).backgroundImage;
    if (!backgroundImage || backgroundImage === 'none') continue;
    const match = /url\((['"]?)(.*?)\1\)/.exec(backgroundImage);
    if (!match?.[2]) continue;

    images.push({
      src: match[2],
      alt: '',
      naturalWidth: 0,
      naturalHeight: 0,
      region: regionOf(element),
      visible: isVisible(element),
      isBackground: true,
      box: boxOf(element),
    });
  }

  /* --------------------------------------------------------------- prices */

  const prices: RawPriceCandidate[] = [];
  const seenPrice = new Set<string>();
  const addPrice = (candidate: RawPriceCandidate): void => {
    const dedupeKey = `${candidate.source}|${candidate.raw}|${candidate.context}`;
    if (seenPrice.has(dedupeKey)) return;
    seenPrice.add(dedupeKey);
    prices.push(candidate);
  };

  // 1. JSON-LD is the most reliable source: explicit value and currency.
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      continue;
    }
    const stack: unknown[] = [parsed];
    let guard = 0;
    while (stack.length > 0 && guard < 2000) {
      guard += 1;
      const current = stack.pop();
      if (Array.isArray(current)) {
        for (const item of current as unknown[]) stack.push(item);
        continue;
      }
      if (!current || typeof current !== 'object') continue;
      const record = current as Record<string, unknown>;
      const price = record['price'] ?? record['lowPrice'] ?? record['highPrice'];
      if (typeof price === 'string' || typeof price === 'number') {
        const currency = record['priceCurrency'];
        addPrice({
          raw: String(price),
          source: 'jsonld',
          region: 'other',
          context: asText(record['name']) || asText(record['@type']),
          ...(typeof currency === 'string' ? { currency } : {}),
        });
      }
      for (const value of Object.values(record)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  }

  // 2. Microdata.
  for (const element of document.querySelectorAll('[itemprop="price"]')) {
    if (isIgnored(element)) continue;
    const content = element.getAttribute('content') ?? (element as HTMLElement).innerText ?? '';
    if (!content.trim()) continue;
    const currencyEl = element.closest('[itemscope]')?.querySelector('[itemprop="priceCurrency"]');
    const currency =
      currencyEl?.getAttribute('content') ?? (currencyEl as HTMLElement | null)?.innerText;
    addPrice({
      raw: content.trim(),
      source: 'microdata',
      region: regionOf(element),
      context: contextTextFor(element),
      box: boxOf(element),
      ...(currency ? { currency: currency.trim() } : {}),
    });
  }

  // 3. Explicitly configured selectors.
  for (const selector of options.priceSelectors) {
    try {
      for (const element of document.querySelectorAll(selector)) {
        if (isIgnored(element)) continue;
        const text = ((element as HTMLElement).innerText ?? '').trim();
        if (!text) continue;
        addPrice({
          raw: text,
          source: 'selector',
          region: regionOf(element),
          context: contextTextFor(element),
          box: boxOf(element),
        });
      }
    } catch {
      // Ignore an invalid configured selector rather than failing the page.
    }
  }

  // 4. Text scan, as a fallback. Raw matches only - parsing happens in Node,
  //    where locale handling ("$1,299.00" vs "1.299,00 EUR") is testable.
  const CURRENCY_TEXT =
    /(?:[$£€¥₹₩]\s?\d[\d.,\s]*|\d[\d.,\s]*\s?[$£€¥₹₩]|\b(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|INR)\s?\d[\d.,\s]*|\d[\d.,\s]*\s?\b(?:USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|INR)\b)/g;

  const walker = document.createTreeWalker(document.body ?? document.documentElement, 4);
  let textNode = walker.nextNode();
  let textGuard = 0;
  while (textNode && textGuard < 20000) {
    textGuard += 1;
    const parent = textNode.parentElement;
    const value = textNode.nodeValue ?? '';
    if (parent && !isIgnored(parent) && value.trim() !== '') {
      CURRENCY_TEXT.lastIndex = 0;
      let match = CURRENCY_TEXT.exec(value);
      while (match) {
        addPrice({
          raw: match[0].trim(),
          source: 'text',
          region: regionOf(parent),
          context: contextTextFor(parent),
          // The containing element, not the text run: a Range box would be
          // tighter but crops need surrounding context to be recognisable.
          box: boxOf(parent),
        });
        match = CURRENCY_TEXT.exec(value);
      }
    }
    textNode = walker.nextNode();
  }

  /** Only strings and numbers stringify usefully; objects would give "[object Object]". */
  function asText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
  }

  function contextTextFor(element: Element): string {
    // The nearest enclosing card/section gives a price its identity, so the
    // same product's price can be paired across two different DOMs.
    const container =
      element.closest('[itemscope], article, li, tr, .product, .card') ?? element.parentElement;
    const text = ((container as HTMLElement | null)?.innerText ?? '').trim();
    return text.slice(0, 160).replace(/\s+/g, ' ');
  }

  /* ----------------------------------------------------------------- meta */

  const metaContent = (selector: string): string | null => {
    const element = document.querySelector(selector);
    return element?.getAttribute('content')?.trim() ?? null;
  };

  const documentWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body?.scrollWidth ?? 0,
  );
  const documentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0,
  );

  return {
    title: document.title,
    meta: {
      description: metaContent('meta[name="description"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      robots: metaContent('meta[name="robots"]'),
      lang: document.documentElement.getAttribute('lang'),
      ogTitle: metaContent('meta[property="og:title"]'),
      ogDescription: metaContent('meta[property="og:description"]'),
      ogImage: metaContent('meta[property="og:image"]'),
    },
    nodes,
    links,
    images,
    prices,
    documentHeight,
    documentWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    // 1px of slack: sub-pixel layout rounding is not an overflow bug.
    hasHorizontalOverflow: documentWidth > window.innerWidth + 1,
  };
}
