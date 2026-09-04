import type { Finding } from '../../core/types.js';
import type { CriticalChange } from '../../compare/critical-values.js';
import { escapeAttr, escapeHtml, renderLayout, severityBadge, standardNav } from './layout.js';
import { filterControls } from './layout.js';
import type { RenderContext } from './pages.js';
import { pageHref } from './pages.js';

/**
 * The changed-values report.
 *
 * Every other view answers "what differs". This one answers the question a
 * migration is actually signed off against: **which facts changed**. A fee, a
 * deadline, a phone number, a dropped "non-" - each on one row, old value
 * beside new, across the whole site.
 *
 * It is a projection of `content.value-drift` findings, not a separate
 * comparison. Nothing here is detected differently, ranked differently or
 * suppressed; the rows exist because the text was not identical, and this page
 * only puts the extractable part of that difference in a table you can read
 * top to bottom.
 */

/** Rows are grouped by class so a reader can scan all the fees at once. */
const CLASS_ORDER: readonly string[] = [
  'amount',
  'date',
  'duration',
  'contact',
  'negation',
  'modal',
  'number',
];

const CLASS_LABEL: Record<string, string> = {
  amount: 'Amounts and fees',
  date: 'Dates',
  duration: 'Durations and deadlines',
  contact: 'Contact details',
  negation: 'Negations',
  modal: 'Obligation and possibility',
  number: 'Other numbers',
};

interface ValueRow {
  finding: Finding;
  change: CriticalChange;
}

export function renderValuesReport(context: RenderContext): string {
  const rows = collectRows(context.model.findings);

  if (rows.length === 0) {
    return renderLayout({
      title: 'Changed values',
      subtitle: 'No extractable value changed',
      root: '',
      nav: standardNav('', 'Values'),
      body: `<div class="panel empty">Every amount, date, duration, contact detail and
      negation survived the migration unchanged.
      <p class="muted">Text that differs only in wording is still reported as drift &mdash;
      see the findings list. This page shows only differences where a value moved.</p></div>`,
    });
  }

  const byClass = new Map<string, ValueRow[]>();
  for (const row of rows) {
    const bucket = byClass.get(row.change.class);
    if (bucket) bucket.push(row);
    else byClass.set(row.change.class, [row]);
  }

  const sections = CLASS_ORDER.filter((name) => byClass.has(name))
    .map((name) => renderClassSection(name, byClass.get(name) ?? []))
    .join('\n');

  return renderLayout({
    title: 'Changed values',
    subtitle: subtitleFor(rows),
    root: '',
    nav: standardNav('', 'Values'),
    body: `<section>
  <p class="muted">Facts that changed between the two sites: fees, dates, deadlines, contact
  details, negations and obligations. Each row is one extracted value, not one sentence, so a
  paragraph whose fee and deadline both moved appears twice &mdash; once under each.</p>
</section>
${filterControls()}
${sections}`,
  });
}

function subtitleFor(rows: readonly ValueRow[]): string {
  const pages = new Set(rows.map((row) => row.finding.path)).size;
  return `${rows.length} changed value${rows.length === 1 ? '' : 's'} across ${pages} page${
    pages === 1 ? '' : 's'
  }`;
}

/** Expand each finding into one row per class of value it carries. */
function collectRows(findings: readonly Finding[]): ValueRow[] {
  const rows: ValueRow[] = [];

  for (const finding of findings) {
    if (finding.category !== 'content.value-drift') continue;
    const changes = finding.details?.['valueChanges'];
    if (!Array.isArray(changes)) continue;

    for (const change of changes as CriticalChange[]) {
      if (typeof change?.class !== 'string') continue;
      rows.push({ finding, change });
    }
  }

  return rows;
}

function renderClassSection(name: string, rows: readonly ValueRow[]): string {
  return `<section>
  <h2>${escapeHtml(CLASS_LABEL[name] ?? name)} <span class="muted">${rows.length}</span></h2>
  <div class="scroll"><table>
    <thead><tr>
      <th>Page</th><th>Section</th><th>Legacy</th><th>Rewrite</th><th></th>
    </tr></thead>
    <tbody>${rows.map(renderRow).join('')}</tbody>
  </table></div>
</section>`;
}

function renderRow({ finding, change }: ValueRow): string {
  // `(none)` rather than an empty cell: a value that vanished entirely is the
  // most serious version of this finding, and a blank cell reads as a rendering
  // fault rather than as the answer.
  const was = change.removed.length > 0 ? change.removed.join(', ') : '(none)';
  const now = change.added.length > 0 ? change.added.join(', ') : '(none)';

  return `<tr data-filterable data-severity="${escapeAttr(finding.severity)}"
    data-search="${escapeAttr(`${finding.path} ${was} ${now}`)}">
  <td><a href="${escapeAttr(pageHref(finding.path))}"><code>${escapeHtml(finding.path)}</code></a></td>
  <td><code>${escapeHtml(finding.region ?? 'page')}</code></td>
  <td><del>${escapeHtml(was)}</del></td>
  <td><ins>${escapeHtml(now)}</ins></td>
  <td>${severityBadge(finding.severity)}</td>
</tr>`;
}
