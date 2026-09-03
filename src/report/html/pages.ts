import type { Finding } from '../../core/types.js';
import { pathSlug } from '../../store/artifact-store.js';
import type { DeviceReport, PageReport, ReportModel } from '../aggregate.js';
import {
  percentTile,
  renderFinding,
  renderFindingList,
  renderMatrix,
  renderSubjectGroups,
  statTile,
  type EvidenceIndex,
} from './components.js';
import {
  emptyState,
  escapeAttr,
  escapeHtml,
  filterControls,
  renderLayout,
  standardNav,
  severityBadge,
} from './layout.js';

/**
 * The six report views.
 *
 * Two navigation axes, because there are two questions people actually ask:
 * "what is broken on mobile?" (by device) and "what is broken on the pricing
 * page?" (by page). Both render from the same aggregated model, so they can
 * never disagree.
 */

export interface RenderContext {
  model: ReportModel;
  evidence: EvidenceIndex;
  /** Source path -> target path, so every card can show both sides host-free. */
  targetPathOf: (sourcePath: string) => string;
}

/**
 * Findings per gallery page.
 *
 * Each card shows up to three images and the gallery opens its cards, which
 * defeats lazy loading by design - so the whole page's images decode at once.
 * Twenty cards is about sixty images: enough to browse, few enough that a real
 * migration's several hundred findings no longer lock the browser up.
 */
const EVIDENCE_PAGE_SIZE = 20;

export const pageHref = (path: string): string => `pages/${pathSlug(path)}.html`;
export const deviceHref = (viewport: string): string => `devices/${viewport}/index.html`;

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

export function renderOverview(context: RenderContext): string {
  const { model } = context;
  const { stats } = model;

  const headline = `<section>
  <h2>Headline</h2>
  <div class="grid">
    ${statTile(String(stats.findings.bySeverity.error), 'Errors')}
    ${statTile(String(stats.findings.bySeverity.warning), 'Warnings')}
    ${statTile(String(stats.findings.bySeverity.info), 'Info')}
    ${percentTile(stats.pages.cleanRate, 'Clean pages', 'pages compared')}
  </div>
</section>`;

  // Every percentage is a parity measure, so 100% always means "no drift" and
  // each one names its own denominator - "coverage" is meaningless without one.
  const parity = `<section>
  <h2>Parity</h2>
  <div class="grid">
    ${percentTile(stats.coverage.pageCoverage, 'Page coverage', 'source pages reachable')}
    ${percentTile(stats.content.contentParity, 'Content parity', 'source nodes unchanged')}
    ${percentTile(stats.images.imageParity, 'Image parity', 'source images unchanged')}
    ${percentTile(stats.prices.priceParity, 'Price parity', 'source prices unchanged')}
    ${percentTile(stats.css.styleParity, 'Style parity', 'property comparisons agreeing')}
    ${percentTile(stats.links.linkParity, 'Link parity', 'source link paths resolving')}
  </div>
</section>`;

  const coverage = `<section>
  <h2>Coverage</h2>
  <div class="grid">
    ${statTile(String(stats.coverage.sourcePages), 'Source pages crawled')}
    ${statTile(String(stats.coverage.targetPages), 'Target pages crawled')}
    ${statTile(String(stats.coverage.missingOnTarget), 'Missing on target')}
    ${statTile(String(stats.coverage.extraOnTarget), 'Extra on target')}
    ${statTile(String(stats.links.brokenLinks), 'Broken links')}
  </div>
</section>`;

  const matrix = `<section>
  <h2>Findings by page and device</h2>
  <p class="muted">A row that is clean until the narrow columns is a responsive bug.
  A row that is uniform across every column is a general styling difference.</p>
  ${filterControls()}
  ${renderMatrix(model.matrix, model.viewports, '', pageHref)}
</section>`;

  const devices = `<section>
  <h2>By device</h2>
  <div class="scroll"><table>
    <thead><tr><th>Device</th><th class="num">Errors</th><th class="num">Warnings</th>
      <th class="num">Info</th><th class="num">Total</th></tr></thead>
    <tbody>${model.devices
      .map(
        (device) => `<tr>
      <td><a href="${escapeAttr(deviceHref(device.viewport))}">${escapeHtml(device.viewport)}</a></td>
      <td class="num">${device.counts.error}</td>
      <td class="num">${device.counts.warning}</td>
      <td class="num">${device.counts.info}</td>
      <td class="num"><strong>${device.total}</strong></td>
    </tr>`,
      )
      .join('')}</tbody>
  </table></div>
</section>`;

  const topProperties =
    model.stats.css.topProperties.length === 0
      ? ''
      : `<section>
  <h2>Most frequently drifting CSS properties</h2>
  <p class="muted">Where to start: one root cause usually explains a whole column.</p>
  <div class="scroll"><table>
    <thead><tr><th>Property</th><th class="num">Occurrences</th></tr></thead>
    <tbody>${model.stats.css.topProperties
      .map(
        (entry) =>
          `<tr><td><code>${escapeHtml(entry.property)}</code></td><td class="num">${entry.count}</td></tr>`,
      )
      .join('')}</tbody>
  </table></div>
</section>`;

  const categories = `<section>
  <h2>Findings by category</h2>
  <div class="scroll"><table>
    <thead><tr><th>Category</th><th class="num">Count</th></tr></thead>
    <tbody>${model.countsByCategory
      .map(
        (entry) =>
          `<tr><td><code>${escapeHtml(entry.category)}</code></td><td class="num">${entry.count}</td></tr>`,
      )
      .join('')}</tbody>
  </table></div>
</section>`;

  // The overview used to render statistics and nothing else, so the first page
  // anyone opened showed no findings at all - and, since evidence lives on a
  // finding, no screenshots either. These are the rows worth reading first.
  const worst = model.findings.slice(0, 15);
  const evidenceCount = model.findings.filter((f) => context.evidence.has(f.id)).length;

  // The premise is counter-intuitive enough that a reader who does not know it
  // will misread every card, so it is stated on the first page they open.
  const howItWorks = `<section class="panel explainer">
  <h2>How the comparison works</h2>
  <p>
    The two sites share <strong>no markup</strong>. A legacy CMS emits tables and generated
    class names; a modern rewrite emits semantic HTML and its own conventions. Comparing
    selectors or DOM structure would therefore report total drift on a <em>perfect</em>
    migration, so this tool never does.
  </p>
  <p>
    Instead each page is reduced to an ordered stream of semantic nodes \u2014 headings,
    paragraphs, links, images, prices \u2014 and a source node is paired with a target node by
    <strong>text similarity within the same region and element family</strong>. Every finding
    shows the basis of its own pairing under <em>Matched by</em>.
  </p>
  <p>
    Element paths appear on a finding only so you can locate the element on each side. They
    are never compared. Styling is compared as <strong>computed values</strong> on nodes that
    content matching already paired, which is the only common ground two unrelated
    implementations have.
  </p>
</section>`;

  const top = `<section>
  <h2>Worst findings</h2>
  <p class="muted">
    Most serious first, then by what is worth fixing first: prices and text before styling.
    ${
      evidenceCount > 0
        ? `${evidenceCount} findings in this run have screenshots \u2014 see <a href="evidence.html">Evidence</a>.`
        : ''
    }
  </p>
  ${
    worst.length === 0
      ? emptyState('No findings. The target matches the source everywhere it was compared.')
      : renderFindingList(worst, {
          root: '',
          evidence: context.evidence,
          targetPathOf: context.targetPathOf,
        })
  }
  ${
    model.findings.length > worst.length
      ? `<p class="muted">Showing ${worst.length} of ${model.findings.length}. <a href="pages/index.html">Browse by page</a>.</p>`
      : ''
  }
</section>`;

  return renderLayout({
    title: 'web-drifter report',
    subtitle: `${stats.sourceBaseUrl} → ${stats.targetBaseUrl} · ${stats.viewports.join(', ')}`,
    root: '',
    nav: standardNav('', 'Overview'),
    body:
      headline +
      parity +
      top +
      howItWorks +
      coverage +
      matrix +
      devices +
      topProperties +
      categories,
  });
}

/* -------------------------------------------------------------------------- */
/* Page index and page detail                                                 */
/* -------------------------------------------------------------------------- */

export function renderPageIndex(context: RenderContext): string {
  const { model } = context;

  const rows = model.pages
    .map(
      (page) => `<tr data-filterable data-severity="${escapeAttr(
        page.stats.counts.error > 0 ? 'error' : page.stats.counts.warning > 0 ? 'warning' : 'info',
      )}" data-search="${escapeAttr(page.path)}">
  <td><a href="${escapeAttr(pathSlug(page.path))}.html"><code>${escapeHtml(page.path)}</code></a></td>
  <td class="num">${page.stats.counts.error}</td>
  <td class="num">${page.stats.counts.warning}</td>
  <td class="num">${page.stats.counts.info}</td>
  <td class="num"><strong>${page.total}</strong></td>
  <td>${page.stats.slowCapture ? '<span class="badge warning">slow capture</span>' : ''}</td>
</tr>`,
    )
    .join('\n');

  const body = `<section>
  <h2>Every compared page</h2>
  <p class="muted">Sorted worst first. A page marked <em>slow capture</em> hit the
  readiness timeout, so its findings are less certain.</p>
  ${filterControls()}
  <div class="scroll"><table>
    <thead><tr><th>Page</th><th class="num">Errors</th><th class="num">Warnings</th>
      <th class="num">Info</th><th class="num">Total</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>`;

  return renderLayout({
    title: 'Findings by page',
    subtitle: `${model.pages.length} pages compared`,
    root: '../',
    nav: standardNav('../', 'By page'),
    body,
  });
}

export function renderPageDetail(page: PageReport, context: RenderContext): string {
  const options = {
    root: '../',
    evidence: context.evidence,
    targetPathOf: context.targetPathOf,
    showPath: false as const,
  };

  const shared = `<section>
  <h2>Content, images, prices and links</h2>
  <p class="muted">These apply to the page regardless of screen size.</p>
  ${renderSubjectGroups(page.groups, { ...options, showViewport: false })}
</section>`;

  // One section per viewport, so a device-specific problem is obvious.
  const viewportSections = context.model.viewports
    .map((viewport) => {
      const findings = page.byViewport.get(viewport) ?? [];
      return `<section>
  <h2>${escapeHtml(viewport)} <span class="muted">(${findings.length})</span></h2>
  ${
    findings.length === 0
      ? emptyState(`No CSS or layout drift at ${viewport}.`)
      : renderFindingList(findings, { ...options, showViewport: false })
  }
</section>`;
    })
    .join('\n');

  const urls = `<section class="panel">
  <dl class="kv">
    <dt>Source</dt><dd>${
      page.sourceUrl
        ? `<a href="${escapeAttr(page.sourceUrl)}" rel="noreferrer noopener">${escapeHtml(page.sourceUrl)}</a>`
        : '<em class="muted">not crawled</em>'
    }</dd>
    <dt>Target</dt><dd>${
      page.targetUrl
        ? `<a href="${escapeAttr(page.targetUrl)}" rel="noreferrer noopener">${escapeHtml(page.targetUrl)}</a>`
        : '<em class="muted">not crawled</em>'
    }</dd>
  </dl>
</section>`;

  return renderLayout({
    title: page.path,
    subtitle: `${page.total} findings · ${page.stats.counts.error} errors`,
    root: '../',
    nav: standardNav('../', 'By page'),
    body: urls + filterControls() + shared + viewportSections,
  });
}

/* -------------------------------------------------------------------------- */
/* Evidence gallery                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every finding that has a screenshot, in one place, already open.
 *
 * The per-page and per-device views answer "what is wrong here?"; this answers
 * "show me the pictures". Findings elsewhere are collapsed so a report of
 * hundreds of rows stays scannable, which also means the evidence is invisible
 * until something is clicked - so the gallery opens its cards.
 */
export function renderEvidenceReport(context: RenderContext, page = 1): string {
  const { model, evidence } = context;

  const withEvidence = model.findings.filter((finding) => evidence.has(finding.id));
  const pages = Math.max(1, Math.ceil(withEvidence.length / EVIDENCE_PAGE_SIZE));
  const current = Math.min(Math.max(page, 1), pages);
  const slice = withEvidence.slice(
    (current - 1) * EVIDENCE_PAGE_SIZE,
    current * EVIDENCE_PAGE_SIZE,
  );

  // Grouped within the page rather than across the whole run: a page break in
  // the middle of one path's findings is far less confusing than a heading that
  // claims a count the page does not contain.
  const byPath = new Map<string, typeof withEvidence>();
  for (const finding of slice) {
    const bucket = byPath.get(finding.path);
    if (bucket) bucket.push(finding);
    else byPath.set(finding.path, [finding]);
  }

  const sections = [...byPath]
    .map(
      ([path, findings]) => `<section>
  <h2><a href="${escapeAttr(pageHref(path))}">${escapeHtml(path)}</a> <span class="muted">(${
    findings.length
  })</span></h2>
  ${findings
    .map((finding) =>
      renderFinding(finding, {
        root: '',
        evidence,
        targetPathOf: context.targetPathOf,
        open: true,
      }),
    )
    .join('\n')}
</section>`,
    )
    .join('\n');

  const body =
    withEvidence.length === 0
      ? emptyState(
          'No screenshot evidence in this run. Evidence is cut for findings at or above ' +
            '`output.evidenceMinSeverity` (default `error`) that have a known position on the ' +
            'page; lower that setting, or check the crawl captured screenshots.',
        )
      : `<section class="panel">
  <p class="muted">
    Source and target crops of the element each finding is about, cut from the stored
    full-page captures. Where both sides exist there is also a pixel overlay - it illustrates
    a finding that was already proven by comparing content, never the reason for one.
  </p>
</section>
${evidencePager(current, pages, withEvidence.length)}
${filterControls()}
${sections}
${evidencePager(current, pages, withEvidence.length)}`;

  return renderLayout({
    title: pages > 1 ? `Evidence (page ${current} of ${pages})` : 'Evidence',
    subtitle: `${withEvidence.length} findings with screenshots`,
    root: '',
    nav: standardNav('', 'Evidence'),
    body,
  });
}

/** How many pages the gallery needs for a given run. */
export function evidencePageCount(findingsWithEvidence: number): number {
  return Math.max(1, Math.ceil(findingsWithEvidence / EVIDENCE_PAGE_SIZE));
}

/** File name for one gallery page. Page 1 keeps the name the nav links to. */
export function evidenceHref(page: number): string {
  return page <= 1 ? 'evidence.html' : `evidence-${page}.html`;
}

function evidencePager(current: number, pages: number, total: number): string {
  if (pages <= 1) return '';

  const link = (page: number, label: string, disabled: boolean): string =>
    disabled
      ? `<span class="muted">${escapeHtml(label)}</span>`
      : `<a href="${escapeAttr(evidenceHref(page))}">${escapeHtml(label)}</a>`;

  const numbered = Array.from({ length: pages }, (_, index) => index + 1)
    .map((page) =>
      page === current
        ? `<strong>${page}</strong>`
        : `<a href="${escapeAttr(evidenceHref(page))}">${page}</a>`,
    )
    .join(' ');

  return `<nav class="pager" aria-label="Evidence pages">
  ${link(current - 1, '\u2190 Previous', current === 1)}
  <span class="pages">${numbered}</span>
  ${link(current + 1, 'Next \u2192', current === pages)}
  <span class="muted">page ${current} of ${pages} \u00b7 ${total} findings</span>
</nav>`;
}

/* -------------------------------------------------------------------------- */
/* Device detail                                                              */
/* -------------------------------------------------------------------------- */

export function renderDeviceDetail(device: DeviceReport, context: RenderContext): string {
  const options = {
    root: '../../',
    evidence: context.evidence,
    targetPathOf: context.targetPathOf,
    showViewport: false as const,
  };

  const sections = [...device.byPath.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(
      ([path, findings]) => `<section>
  <h2><a href="../../${escapeAttr(pageHref(path))}"><code>${escapeHtml(path)}</code></a>
    <span class="muted">(${findings.length})</span></h2>
  ${renderFindingList(findings, options)}
</section>`,
    )
    .join('\n');

  const summary = `<section>
  <div class="grid">
    ${statTile(String(device.counts.error), 'Errors')}
    ${statTile(String(device.counts.warning), 'Warnings')}
    ${statTile(String(device.counts.info), 'Info')}
    ${statTile(String(device.byPath.size), 'Pages affected')}
  </div>
</section>`;

  return renderLayout({
    title: `${device.viewport} findings`,
    subtitle: 'CSS, layout and visibility drift seen only at this screen size',
    root: '../../',
    nav: standardNav('../../', 'Overview'),
    body:
      summary +
      filterControls() +
      (device.total === 0 ? emptyState(`No drift at ${device.viewport}.`) : sections),
  });
}

/* -------------------------------------------------------------------------- */
/* Separate CSS report                                                        */
/* -------------------------------------------------------------------------- */

export function renderCssReport(context: RenderContext): string {
  const { model } = context;
  const { css } = model.stats;

  const perViewport = `<section>
  <h2>By viewport</h2>
  <div class="scroll"><table>
    <thead><tr><th>Viewport</th><th class="num">Nodes compared</th>
      <th class="num">Properties compared</th><th class="num">Property drift</th>
      <th class="num">Layout drift</th><th class="num">Visibility drift</th>
      <th class="num">Overflow</th></tr></thead>
    <tbody>${css.byViewport
      .map(
        (viewport) => `<tr>
      <td><a href="${escapeAttr(`css/${viewport.viewport}.html`)}">${escapeHtml(viewport.viewport)}</a></td>
      <td class="num">${viewport.comparedNodes.toLocaleString()}</td>
      <td class="num">${viewport.comparedProperties.toLocaleString()}</td>
      <td class="num">${viewport.propertyDrifts}</td>
      <td class="num">${viewport.layoutDrifts}</td>
      <td class="num">${viewport.visibilityDrifts}</td>
      <td class="num">${viewport.horizontalOverflowPages}</td>
    </tr>`,
      )
      .join('')}</tbody>
  </table></div>
</section>`;

  const body = `<section>
  <h2>CSS and layout</h2>
  <p class="muted">Stylesheets are never compared - across a rewrite the two sides
  share no selectors. What is compared is the <strong>computed style of matched
  elements</strong>, which is the only common ground and what the user actually sees.</p>
  <div class="grid">
    ${percentTile(css.styleParity, 'Style parity', 'property comparisons agreeing')}
    ${statTile(String(css.propertyDrifts), 'Property drift')}
    ${statTile(String(css.layoutDrifts), 'Layout drift')}
    ${statTile(String(css.visibilityDrifts), 'Visibility drift')}
    ${statTile(String(css.responsiveVisibilityDrifts), 'Responsive visibility drift')}
  </div>
</section>
${perViewport}
<section>
  <h2>All CSS findings</h2>
  ${filterControls()}
  ${renderFindingList(model.css, {
    root: '',
    evidence: context.evidence,
    targetPathOf: context.targetPathOf,
  })}
</section>`;

  return renderLayout({
    title: 'CSS and layout report',
    subtitle: `${model.css.length} findings across ${model.viewports.join(', ')}`,
    root: '',
    nav: standardNav('', 'CSS'),
    body,
  });
}

export function renderCssDeviceReport(viewport: string, context: RenderContext): string {
  const findings = context.model.css.filter((f) => f.viewport === viewport);
  return renderLayout({
    title: `CSS drift at ${viewport}`,
    subtitle: `${findings.length} findings`,
    root: '../',
    nav: standardNav('../', 'CSS'),
    body: `<section>${filterControls()}${renderFindingList(findings, {
      root: '../',
      evidence: context.evidence,
      targetPathOf: context.targetPathOf,
      showViewport: false,
    })}</section>`,
  });
}

/* -------------------------------------------------------------------------- */
/* Links and coverage                                                         */
/* -------------------------------------------------------------------------- */

export function renderLinksReport(context: RenderContext): string {
  const { links } = context.model.stats;

  const body = `<section>
  <h2>Links and URLs</h2>
  <div class="grid">
    ${percentTile(links.linkParity, 'Link parity', 'source link paths resolving')}
    ${statTile(String(links.brokenLinks), 'Broken')}
    ${statTile(String(links.pathMismatches), 'No counterpart on target')}
    ${statTile(String(links.redirectedLinks), 'Redirected')}
    ${statTile(String(links.mixedContentLinks), 'Mixed content')}
    ${statTile(String(links.externalLinks), 'External links found', 'checked, never rendered')}
  </div>
</section>
<section>
  <h2>Findings</h2>
  ${filterControls()}
  ${renderFindingList(context.model.links, { root: '', evidence: context.evidence, targetPathOf: context.targetPathOf })}
</section>`;

  return renderLayout({
    title: 'Links report',
    subtitle: `${context.model.links.length} findings`,
    root: '',
    nav: standardNav('', 'Links'),
    body,
  });
}

/**
 * Source pages nothing else links to.
 *
 * Kept out of every percentage above them and out of the gate, so the section
 * has to say so - a number whose denominator is unstated is exactly the kind of
 * statistic this report exists not to produce.
 */
function renderOrphanSection(context: RenderContext): string {
  const paths = context.model.stats.coverage.orphanPages;
  if (paths.length === 0) return '';

  const byPath = new Map<string, Finding[]>();
  for (const finding of context.model.orphans) {
    const bucket = byPath.get(finding.path);
    if (bucket) bucket.push(finding);
    else byPath.set(finding.path, [finding]);
  }

  const rows = paths
    .map((path) => {
      const findings = byPath.get(path) ?? [];
      const errors = findings.filter((f) => f.severity === 'error').length;
      return `<tr>
    <td><code>${escapeHtml(path)}</code></td>
    <td class="num">${findings.length}</td>
    <td class="num">${errors}</td>
  </tr>`;
    })
    .join('');

  return `<section>
  <h2>Unreachable source pages <span class="muted">(${paths.length})</span></h2>
  <p class="muted">
    No other crawled source page links to these. They are usually published but
    forgotten \u2014 old campaign landing pages, print catalogues, URLs only ever sent by
    email \u2014 and the sitemap is the only thing that still remembers them.
  </p>
  <p class="muted">
    <strong>They are excluded from every figure above and cannot fail a build.</strong>
    Counting them would measure the size of the legacy backlog rather than the quality of
    the migration. Set <code>crawl.treatUnlinkedAsOrphans: false</code> to hold them to the
    same standard as the rest of the site.
  </p>
  <div class="scroll"><table>
    <thead><tr><th>Page</th><th class="num">Findings</th><th class="num">Errors</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  ${
    context.model.orphans.length === 0
      ? ''
      : renderFindingList(context.model.orphans, {
          root: '',
          evidence: context.evidence,
          targetPathOf: context.targetPathOf,
        })
  }
</section>`;
}

export function renderCoverageReport(context: RenderContext): string {
  const { coverage } = context.model.stats;

  const body = `<section>
  <h2>Page coverage</h2>
  <div class="grid">
    ${percentTile(coverage.pageCoverage, 'Page coverage', 'linked source pages reachable')}
    ${statTile(String(coverage.missingOnTarget), 'Missing on target')}
    ${statTile(String(coverage.extraOnTarget), 'Extra on target')}
    ${statTile(String(coverage.statusMismatches), 'Status mismatches')}
    ${statTile(String(coverage.aliasPages), 'Duplicate URLs')}
  </div>
</section>
<section>
  <h2>Findings</h2>
  ${filterControls()}
  ${renderFindingList(context.model.coverage, { root: '', evidence: context.evidence, targetPathOf: context.targetPathOf })}
</section>
${renderOrphanSection(context)}`;

  return renderLayout({
    title: 'Coverage report',
    subtitle: `${coverage.sourcePages} source pages · ${coverage.targetPages} target pages`,
    root: '',
    nav: standardNav('', 'Coverage'),
    body,
  });
}

/** Re-exported so the writer can render a single finding in isolation. */
export { renderFinding, severityBadge };
