import type { PercentStat } from '../core/types.js';
import type { ReportModel } from './aggregate.js';

/**
 * Markdown summary.
 *
 * Written for a place with no room to scroll - a pull request comment or a
 * pipeline summary panel - so it answers "is this migration close?" and "where
 * do I start?" and stops. Anything longer belongs in the HTML report, which is
 * linked from the top.
 */

export function renderMarkdown(model: ReportModel, reportUrl?: string): string {
  const { stats } = model;
  const lines: string[] = [];

  const verdict =
    stats.findings.bySeverity.error === 0
      ? '✅ No errors'
      : `❌ ${stats.findings.bySeverity.error} error${stats.findings.bySeverity.error === 1 ? '' : 's'}`;

  lines.push(
    '# web-drifter report',
    '',
    `${verdict} · ${stats.findings.bySeverity.warning} warnings · ${stats.findings.bySeverity.info} info`,
    '',
    `\`${stats.sourceBaseUrl}\` → \`${stats.targetBaseUrl}\``,
    '',
    `${stats.pages.total} pages compared at ${stats.viewports.join(', ')} in ${formatDuration(
      stats.durationMs,
    )}.`,
    '',
  );

  if (reportUrl) lines.push(`[Full report](${reportUrl})`, '');

  lines.push(
    '## Parity',
    '',
    '| Measure | Result | Of |',
    '| --- | ---: | --- |',
    parityRow('Page coverage', stats.coverage.pageCoverage, 'source pages reachable on target'),
    parityRow('Content parity', stats.content.contentParity, 'source nodes unchanged'),
    parityRow('Image parity', stats.images.imageParity, 'source images unchanged'),
    parityRow('Price parity', stats.prices.priceParity, 'source prices unchanged'),
    parityRow('Style parity', stats.css.styleParity, 'property comparisons agreeing'),
    parityRow('Link parity', stats.links.linkParity, 'source link paths resolving'),
    parityRow('Clean pages', stats.pages.cleanRate, 'pages with no findings'),
    '',
  );

  if (
    stats.coverage.missingOnTarget > 0 ||
    stats.coverage.extraOnTarget > 0 ||
    stats.links.brokenLinks > 0
  ) {
    lines.push(
      '## Coverage',
      '',
      `- **${stats.coverage.missingOnTarget}** pages missing on target`,
      `- **${stats.coverage.extraOnTarget}** pages only on target`,
      `- **${stats.links.brokenLinks}** broken links`,
      '',
    );
  }

  const matrix = model.matrix.slice(0, 15);
  if (matrix.length > 0) {
    lines.push(
      '## Findings by page and device',
      '',
      `| Page | All sizes | ${model.viewports.join(' | ')} | Total |`,
      `| --- | ---: | ${model.viewports.map(() => '---:').join(' | ')} | ---: |`,
      ...matrix.map(
        (row) =>
          `| \`${row.path}\` | ${row.shared} | ${model.viewports
            .map((viewport) => row.byViewport[viewport] ?? 0)
            .join(' | ')} | **${row.total}** |`,
      ),
      '',
    );
    if (model.matrix.length > matrix.length) {
      lines.push(`_${model.matrix.length - matrix.length} further pages in the full report._`, '');
    }
  }

  if (stats.css.topProperties.length > 0) {
    lines.push(
      '## Most frequently drifting CSS properties',
      '',
      ...stats.css.topProperties
        .slice(0, 8)
        .map((entry) => `- \`${entry.property}\` — ${entry.count}`),
      '',
    );
  }

  return lines.join('\n');
}

function parityRow(label: string, stat: PercentStat, denominator: string): string {
  return `| ${label} | ${stat.percent}% | ${stat.matched.toLocaleString()} / ${stat.total.toLocaleString()} ${denominator} |`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
