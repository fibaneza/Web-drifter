import type { Finding, PercentStat } from '../../core/types.js';
import type { MatrixRow, SubjectGroup } from '../aggregate.js';
import { escapeAttr, escapeHtml, renderValue, severityBadge, toText } from './layout.js';

/**
 * Shared rendering pieces.
 *
 * Findings are rendered collapsed by default. A migration report routinely runs
 * to hundreds of rows, and expanding every one of them makes the page
 * unscannable - the value of the report is being able to see the shape of the
 * problem before reading any single finding.
 */

/** Screenshot evidence for a finding, as paths relative to the report root. */
export interface Evidence {
  source?: string;
  target?: string;
  diff?: string;
  /**
   * True when these are whole-page captures rather than element crops, which
   * are far taller and need to be constrained rather than shown at full height.
   */
  wholePage?: boolean;
}

export type EvidenceIndex = ReadonlyMap<string, Evidence>;

export interface FindingRenderOptions {
  /** Relative prefix back to the report root. */
  root: string;
  evidence?: EvidenceIndex;
  /** Show which page a finding belongs to (off on a single-page view). */
  showPath?: boolean;
  /** Show which viewport (off on a single-device view). */
  showViewport?: boolean;
  /** Source path -> target path, so a card can show both sides host-free. */
  targetPathOf?: (sourcePath: string) => string;
  /** Render the card already open. Used by the evidence gallery. */
  open?: boolean;
}

/** Marks a card that has screenshots, so it is visible without opening it. */
const EVIDENCE_BADGE =
  '<span class="badge shot" title="Has screenshot evidence" aria-label="Has screenshot evidence">&#9673; shot</span>';

export function renderFinding(finding: Finding, options: FindingRenderOptions): string {
  const searchable = [
    finding.path,
    finding.label,
    finding.category,
    finding.subject ?? '',
    finding.facet ?? '',
    toText(finding.expected),
    toText(finding.actual),
  ].join(' ');

  const hasEvidence = options.evidence?.has(finding.id) === true;

  const tags: string[] = [severityBadge(finding.severity)];
  if (options.showViewport !== false && finding.viewport) {
    tags.push(`<span class="badge info">${escapeHtml(finding.viewport)}</span>`);
  }
  if (hasEvidence) tags.push(EVIDENCE_BADGE);

  const meta: string[] = [`<code>${escapeHtml(finding.category)}</code>`];
  if (options.showPath !== false) meta.push(renderPathPair(finding, options));
  if (finding.region) meta.push(escapeHtml(finding.region));

  // Magnitude is only set on graded CSS findings; everything else sorts as 1 so
  // an ungraded error still outranks a marginal styling drift.
  const magnitude = finding.details?.['magnitude'];

  return `<details class="finding" data-filterable data-severity="${escapeAttr(
    finding.severity,
  )}" data-evidence="${hasEvidence ? '1' : '0'}" data-magnitude="${
    typeof magnitude === 'number' ? magnitude : 1
  }" data-path="${escapeAttr(finding.path)}" data-search="${escapeAttr(searchable)}"${
    options.open ? ' open' : ''
  }>
  <summary>
    ${tags.join(' ')}
    <span class="title">${escapeHtml(finding.label)}</span>
    <span class="muted mono">${meta.join(' \u00b7 ')}</span>
  </summary>
  <div class="body">
    ${renderExpectedActual(finding)}
    ${renderDetails(finding, options)}
    ${renderEvidence(finding, options)}
  </div>
</details>`;
}

/**
 * Source path against target path, without the host.
 *
 * The host always differs - that is the premise of the whole exercise - so
 * showing it buries the part that matters. Query parameters are kept: they are
 * part of a page's identity here, so `/search?q=hat` and `/search?q=boot` are
 * different pages and the report has to say which one it means.
 */
function renderPathPair(finding: Finding, options: FindingRenderOptions): string {
  const targetPath = options.targetPathOf?.(finding.path);
  if (targetPath === undefined || targetPath === finding.path) {
    return `<code>${escapeHtml(finding.path)}</code>`;
  }
  // A remapped path is worth pointing at: it is a deliberate migration decision
  // and the commonest reason a page looks "missing" when it is only moved.
  return `<code>${escapeHtml(finding.path)}</code> <span class="arrow">\u2192</span> <code class="remapped">${escapeHtml(
    targetPath,
  )}</code>`;
}

function renderExpectedActual(finding: Finding): string {
  if (finding.expected === undefined && finding.actual === undefined) return '';
  return `<div class="diffpair">
  <div class="side"><div class="head">Source (legacy)</div><div class="val">${renderValue(
    finding.expected,
  )}</div></div>
  <div class="side"><div class="head">Target (modern)</div><div class="val">${renderValue(
    finding.actual,
  )}</div></div>
</div>`;
}

function renderDetails(finding: Finding, options: FindingRenderOptions): string {
  const rows: Array<[string, string]> = [];

  const targetPath = options.targetPathOf?.(finding.path);
  rows.push([
    'Path',
    targetPath === undefined || targetPath === finding.path
      ? `<code>${escapeHtml(finding.path)}</code>`
      : `<code>${escapeHtml(finding.path)}</code> \u2192 <code>${escapeHtml(targetPath)}</code>`,
  ]);

  const element = describeElement(finding);
  if (element) rows.push(['Element', element]);
  if (finding.facet) rows.push(['Property', `<code>${escapeHtml(finding.facet)}</code>`]);

  const basis = matchingBasis(finding);
  if (basis) rows.push(['Matched by', basis]);

  const where = renderLocation(finding);
  if (where) rows.push(['On the page', where]);

  const magnitude = finding.details?.['magnitude'];
  if (typeof magnitude === 'number') {
    // Stated as a multiple of the warning threshold, because the raw number is
    // meaningless without knowing what it is being measured against.
    rows.push([
      'Size of drift',
      `${magnitude}\u00d7 the warning threshold ${
        magnitude >= 1 ? '<span class="muted">(over)</span>' : '<span class="muted">(under)</span>'
      }`,
    ]);
  }

  const selectors = renderSelectors(finding);
  if (selectors) rows.push(['Where', selectors]);

  if (finding.sourceUrl) rows.push(['Source URL', link(deepLink(finding, 'source'))]);
  if (finding.targetUrl) rows.push(['Target URL', link(deepLink(finding, 'target'))]);
  rows.push([
    'Finding id',
    `<code>${escapeHtml(finding.id)}</code> <span class="muted">(use in <code>ignore.findingIds</code> to accept)</span>`,
  ]);

  return `<dl class="kv">${rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`)
    .join('')}</dl>`;
}

function link(url: string): string {
  return `<a href="${escapeAttr(url)}" rel="noreferrer noopener">${escapeHtml(url)}</a>`;
}

/**
 * The element in words rather than as a hash.
 *
 * `subject` is `nodeKey#ordinal`, where the key is a hash of the node's text -
 * unambiguous to the tool and meaningless to a reader. The kind and a snippet of
 * the text say the same thing in a form someone can act on. The raw subject is
 * still available beside the finding id, where an opaque handle belongs.
 */
function describeElement(finding: Finding): string | null {
  const text = typeof finding.expected === 'string' ? finding.expected : finding.actual;
  const snippet = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';

  const kind = finding.nodeKind ? `<code>${escapeHtml(finding.nodeKind)}</code>` : null;
  const quoted =
    snippet === ''
      ? null
      : `&ldquo;${escapeHtml(snippet.length > 80 ? `${snippet.slice(0, 79)}\u2026` : snippet)}&rdquo;`;

  if (kind && quoted) return `${kind} \u00b7 ${quoted}`;
  if (kind ?? quoted) return kind ?? quoted;
  return finding.subject ? `<code>${escapeHtml(finding.subject)}</code>` : null;
}

/**
 * Why these two elements were treated as the same element.
 *
 * This is the row that answers the question the report kept provoking. Nothing
 * here is new data - confidence, region and kind are already on every finding -
 * but stating the basis explicitly is what stops a reader assuming the selectors
 * below were what got compared.
 */
function matchingBasis(finding: Finding): string | null {
  if (finding.region === undefined && finding.nodeKind === undefined) return null;

  const parts: string[] = [`${Math.round(finding.confidence * 100)}% text similarity`];
  if (finding.region) parts.push(`region <code>${escapeHtml(finding.region)}</code>`);
  if (finding.nodeKind) parts.push(`<code>${escapeHtml(finding.nodeKind)}</code> family`);

  const low = finding.details?.['lowConfidence'] === true;
  const caveat = low ? ' <span class="badge warning">weak pairing</span>' : '';

  return `${parts.join(' \u00b7 ')}${caveat}`;
}

/**
 * Both sides' element paths, labelled as location rather than comparison.
 *
 * Showing only the source's read as though selectors were the basis of the diff.
 * They cannot be: a Sitecore table and a React component share no markup, so any
 * selector-keyed comparison would report total drift on a perfect migration.
 */
function renderSelectors(finding: Finding): string | null {
  const source = finding.details?.['selectorHint'];
  const target = finding.details?.['targetSelectorHint'];

  const rows: string[] = [];
  if (typeof source === 'string' && source !== '') {
    rows.push(`<div><span class="muted">source</span> <code>${escapeHtml(source)}</code></div>`);
  }
  if (typeof target === 'string' && target !== '') {
    rows.push(`<div><span class="muted">target</span> <code>${escapeHtml(target)}</code></div>`);
  }
  if (rows.length === 0) return null;

  return `${rows.join('')}<div class="muted note">Shown to help you find the element. The two sites share no markup, so these are never compared.</div>`;
}

/** Where on the rendered page this finding is, in CSS pixels. */
function renderLocation(finding: Finding): string | null {
  const box = finding.details?.['sourceBox'] ?? finding.details?.['targetBox'];
  if (!box || typeof box !== 'object') return null;

  const { x, y, width, height } = box as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (typeof width !== 'number' || typeof height !== 'number') return null;

  return `<code>${Math.round(x)}, ${Math.round(y)}</code> <span class="muted">(${Math.round(
    width,
  )}\u00d7${Math.round(height)} px from the top-left of the page)</span>`;
}

/**
 * Link that opens the live page scrolled to the finding.
 *
 * Uses a text fragment, which Chromium and Edge scroll to and highlight. Nothing
 * is lost elsewhere: a browser that does not understand the fragment ignores it
 * and opens the page normally. Only text worth searching for is used - a couple
 * of words match too much of the page to be useful.
 */
function deepLink(finding: Finding, side: 'source' | 'target'): string {
  const url = side === 'source' ? finding.sourceUrl : finding.targetUrl;
  if (!url) return '';

  const value = side === 'source' ? finding.expected : finding.actual;
  if (typeof value !== 'string') return url;

  const snippet = value.trim().slice(0, 120);
  if (snippet.length < 8 || url.includes('#')) return url;

  return `${url}#:~:text=${encodeURIComponent(snippet)}`;
}

function renderEvidence(finding: Finding, options: FindingRenderOptions): string {
  const evidence = options.evidence?.get(finding.id);
  if (!evidence) return '';

  const figures: string[] = [];
  const add = (caption: string, path: string | undefined): void => {
    if (!path) return;
    figures.push(
      `<figure><figcaption>${escapeHtml(caption)}</figcaption><img loading="lazy" decoding="async" src="${escapeAttr(
        options.root + path,
      )}" alt="${escapeAttr(caption)}"></figure>`,
    );
  };

  add(evidence.wholePage ? 'Source page' : 'Source', evidence.source);
  add(evidence.wholePage ? 'Target page' : 'Target', evidence.target);
  add('Pixel overlay', evidence.diff);

  if (figures.length === 0) return '';
  return `<div class="shots${evidence.wholePage ? ' wholepage' : ''}">${figures.join('')}</div>`;
}

export function renderFindingList(
  findings: readonly Finding[],
  options: FindingRenderOptions,
): string {
  if (findings.length === 0) {
    return '<div class="panel empty">Nothing to report here.</div>';
  }
  return findings.map((finding) => renderFinding(finding, options)).join('\n');
}

/** A group of findings about one element, rendered as a single block. */
export function renderSubjectGroups(
  groups: readonly SubjectGroup[],
  options: FindingRenderOptions,
): string {
  if (groups.length === 0) return '<div class="panel empty">Nothing to report here.</div>';

  return groups
    .map((group) => {
      if (group.findings.length === 1) {
        const only = group.findings[0];
        return only ? renderFinding(only, options) : '';
      }
      return `<section>
  <h3>${escapeHtml(group.label)} <span class="muted">(${group.findings.length} findings)</span></h3>
  ${group.findings.map((finding) => renderFinding(finding, options)).join('\n')}
</section>`;
    })
    .join('\n');
}

export function statTile(value: string, label: string, denominator?: string): string {
  return `<div class="stat">
  <div class="value">${escapeHtml(value)}</div>
  <div class="label">${escapeHtml(label)}</div>
  ${denominator ? `<div class="denom">${escapeHtml(denominator)}</div>` : ''}
</div>`;
}

export function percentTile(stat: PercentStat, label: string, denominatorLabel: string): string {
  return statTile(
    `${stat.percent}%`,
    label,
    `${stat.matched.toLocaleString()} of ${stat.total.toLocaleString()} ${denominatorLabel}`,
  );
}

/**
 * The device matrix.
 *
 * Reading a row left to right tells you what kind of problem you have: a row
 * that is clean until the narrow columns is a responsive bug, while a row that
 * is uniform across every column is a general styling difference. Being able to
 * tell those apart at a glance is the entire point of grouping by device.
 */
export function renderMatrix(
  rows: readonly MatrixRow[],
  viewports: readonly string[],
  root: string,
  pageHref: (path: string) => string,
): string {
  if (rows.length === 0) {
    return '<div class="panel empty">No page produced a finding.</div>';
  }

  const head = viewports.map((viewport) => `<th class="num">${escapeHtml(viewport)}</th>`).join('');

  const body = rows
    .map((row) => {
      const cells = viewports.map((viewport) => cell(row.byViewport[viewport] ?? 0)).join('');
      return `<tr data-filterable data-severity="${escapeAttr(row.worst ?? '')}" data-search="${escapeAttr(
        row.path,
      )}">
  <td><a href="${escapeAttr(root + pageHref(row.path))}"><code>${escapeHtml(row.path)}</code></a></td>
  <td class="num">${cell(row.shared)}</td>
  ${cells}
  <td class="num"><strong>${row.total}</strong></td>
</tr>`;
    })
    .join('\n');

  return `<div class="scroll"><table>
<thead><tr>
  <th>Page</th>
  <th class="num" title="Findings that apply regardless of screen size">All sizes</th>
  ${head}
  <th class="num">Total</th>
</tr></thead>
<tbody>${body}</tbody>
</table></div>`;
}

function cell(count: number): string {
  if (count === 0) return '<td class="num cell-0">·</td>';
  return `<td class="num cell-hit">${count}</td>`;
}
