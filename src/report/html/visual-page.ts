import type { Severity } from '../../core/types.js';
import type { VisualPageMap } from '../visual.js';
import { escapeAttr, escapeHtml, renderLayout, severityBadge, standardNav } from './layout.js';

/**
 * The visual map page.
 *
 * Deliberately not a findings list with pictures attached - the report already
 * has one of those. This is the inverse: the page first, the findings second,
 * so the question it answers is "where on this page do I look" rather than
 * "what is finding 37 about".
 *
 * The two captures are shown side by side at the same scale, each carrying the
 * same numbers, so a marker present on one side and absent on the other says
 * "this exists only on the legacy site" without needing a word of explanation.
 */

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function renderVisualReport(maps: readonly VisualPageMap[]): string {
  const body =
    maps.length === 0
      ? `<div class="panel empty">No visible differences to map.
  <p class="muted">Typography, markup annotation such as <code>alt</code> text, and movement
  under the shift threshold are excluded from this view by design - see the CSS report for
  those.</p></div>`
      : `<section>
  <p class="muted">Every difference a viewer could see, drawn on the page it appears on.
  Font-only drift, invisible markup and sub-threshold movement are excluded on purpose:
  this view answers <em>where do I look</em>, and the CSS report answers the rest.</p>
</section>
${maps.map(renderPageSection).join('\n')}`;

  return renderLayout({
    title: 'Visual differences',
    subtitle: subtitleFor(maps),
    root: '',
    nav: standardNav('', 'Visual'),
    body,
  });
}

function subtitleFor(maps: readonly VisualPageMap[]): string {
  if (maps.length === 0) return 'Nothing visible to mark';
  const marks = maps.reduce((sum, map) => sum + map.marks.length, 0);
  return `${marks} marked difference${marks === 1 ? '' : 's'} across ${maps.length} page${
    maps.length === 1 ? '' : 's'
  }`;
}

function renderPageSection(map: VisualPageMap): string {
  const worst = [...map.marks].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  )[0];

  const pathLine =
    map.targetPath === map.path
      ? `<code>${escapeHtml(map.path)}</code>`
      : `<code>${escapeHtml(map.path)}</code> &rarr; <code>${escapeHtml(map.targetPath)}</code>`;

  return `<section class="panel">
  <h2>${pathLine} <span class="muted">${escapeHtml(map.viewport)}</span>
    ${worst ? severityBadge(worst.severity) : ''}</h2>
  <div class="visual-pair">
    ${renderSide('Legacy', map.sourceImage)}
    ${renderSide('Rewrite', map.targetImage)}
  </div>
  <ol class="visual-legend">
    ${map.marks.map(renderLegendItem).join('\n    ')}
  </ol>
</section>`;
}

function renderSide(label: string, href: string | null): string {
  if (href === null) {
    // One-sided by circumstance, not by error: a page missing on the target has
    // no capture to annotate, and saying so beats a broken image.
    return `<figure><figcaption>${escapeHtml(label)}</figcaption>
      <div class="panel empty">No capture for this side.</div></figure>`;
  }
  return `<figure><figcaption>${escapeHtml(label)}</figcaption>
    <a href="${escapeAttr(href)}"><img src="${escapeAttr(href)}" alt="${escapeAttr(
      `${label} page with differences marked`,
    )}" loading="lazy"></a></figure>`;
}

function renderLegendItem(mark: VisualPageMap['marks'][number]): string {
  const oneSided = mark.oneSided ? ' <span class="muted">(one side only)</span>' : '';
  return `<li value="${mark.n}">${severityBadge(mark.severity)}
      <code>${escapeHtml(mark.category)}</code> ${escapeHtml(mark.label)}${oneSided}</li>`;
}
