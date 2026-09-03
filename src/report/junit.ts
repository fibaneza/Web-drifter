import type { Finding, FindingCategory } from '../core/types.js';
import type { ReportModel } from './aggregate.js';

/**
 * JUnit XML.
 *
 * Lets Azure DevOps (and Jenkins, GitLab, and anything else that reads JUnit)
 * render drift in its native Tests view, so a migration shows up in the same
 * place as the rest of the build's failures rather than as an artifact somebody
 * has to remember to download.
 *
 * Mapping: one **test suite per category**, one **test case per finding**.
 * Grouping by category rather than by page keeps the suite list short and
 * stable across runs - a CI dashboard that gains and loses a suite every time a
 * page is added or removed is unreadable.
 *
 * Errors and warnings become failures; info findings are recorded as passing
 * cases carrying their detail, so they are visible without failing the build.
 *
 * Findings on unreachable source pages become **skipped** cases. They are
 * excluded from the run's statistics and from the exit code by design (see
 * `docs/crawl-bounding.md`), so rendering them as failures would make the Tests
 * tab contradict the exit code - a build that passes while its test view is red
 * is worse than either signal alone. `skipped` is JUnit's own word for a case
 * that exists but was not counted.
 */

/** True for a finding on a source page nothing links to. */
const isOrphan = (finding: Finding): boolean => finding.details?.['orphanPage'] === true;

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return (
    (text ?? '')
      .replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c)
      // XML 1.0 forbids these control characters outright, so a stray one in
      // scraped page content would make the whole file unparseable for the CI
      // server. Written as escapes rather than literals: an invisible control
      // character pasted into source is impossible to review.
      // eslint-disable-next-line no-control-regex -- removing them is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

export function renderJUnit(model: ReportModel): string {
  const byCategory = new Map<FindingCategory, Finding[]>();
  for (const finding of model.findings) {
    const bucket = byCategory.get(finding.category);
    if (bucket) bucket.push(finding);
    else byCategory.set(finding.category, [finding]);
  }

  const suites = [...byCategory.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, findings]) => renderSuite(category, findings));

  // `failures` comes from the statistics, which exclude orphan pages, so the
  // Tests tab and the exit code always agree. `tests` counts the cases actually
  // emitted, which includes the skipped ones - otherwise the totals would not
  // add up against the suites below.
  const totals = model.stats.findings;
  const failures = totals.bySeverity.error + totals.bySeverity.warning;
  const skipped = model.findings.filter(isOrphan).length;

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="web-drifter" tests="${model.findings.length}" failures="${failures}" skipped="${skipped}" time="${(
    model.stats.durationMs / 1000
  ).toFixed(3)}">
${suites.join('\n')}
</testsuites>
`;
}

function renderSuite(category: FindingCategory, findings: readonly Finding[]): string {
  const failures = findings.filter((f) => f.severity !== 'info' && !isOrphan(f)).length;
  const skipped = findings.filter(isOrphan).length;

  const cases = findings
    .map((finding) => {
      // The page and viewport belong in the case name: a CI failure list that
      // says only "content.drift" twelve times is useless.
      const name = [finding.path, finding.viewport, finding.label]
        .filter((part) => part !== undefined && part !== '')
        .join(' — ');

      const body = [
        `Category: ${finding.category}`,
        `Severity: ${finding.severity}`,
        finding.subject ? `Element: ${finding.subject}` : '',
        finding.facet ? `Property: ${finding.facet}` : '',
        `Expected (source): ${describe(finding.expected)}`,
        `Actual (target):   ${describe(finding.actual)}`,
        finding.sourceUrl ? `Source: ${finding.sourceUrl}` : '',
        finding.targetUrl ? `Target: ${finding.targetUrl}` : '',
        `Finding id: ${finding.id}`,
      ]
        .filter((line) => line !== '')
        .join('\n');

      if (isOrphan(finding)) {
        return `    <testcase classname="${escapeXml(category)}" name="${escapeXml(name)}">
      <skipped message="On a source page nothing links to; excluded from the run's figures and from the gate."/>
      <system-out>${escapeXml(body)}</system-out>
    </testcase>`;
      }

      if (finding.severity === 'info') {
        return `    <testcase classname="${escapeXml(category)}" name="${escapeXml(name)}">
      <system-out>${escapeXml(body)}</system-out>
    </testcase>`;
      }

      return `    <testcase classname="${escapeXml(category)}" name="${escapeXml(name)}">
      <failure message="${escapeXml(finding.label)}" type="${escapeXml(
        finding.severity,
      )}">${escapeXml(body)}</failure>
    </testcase>`;
    })
    .join('\n');

  return `  <testsuite name="${escapeXml(category)}" tests="${findings.length}" failures="${failures}" skipped="${skipped}">
${cases}
  </testsuite>`;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '(unserialisable)';
}
