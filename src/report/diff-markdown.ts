import type { Finding } from '../core/types.js';
import { countBySeverity, type ChangedFinding, type RunDiff } from './diff.js';

/**
 * Markdown summary of a run-over-run comparison.
 *
 * Written for the same place as `summary.md` - a pull request comment or a
 * pipeline summary panel - so it leads with the verdict and stops. The question
 * it answers is "did that change help, and did it break anything else?", so
 * regressions come first and everything else is context.
 */

/** Rows per bucket. Beyond this the full report is the right place to look. */
const MAX_ROWS = 20;

export function renderDiffMarkdown(diff: RunDiff): string {
  const lines: string[] = [];

  const added = countBySeverity(diff.added);
  const verdict =
    diff.added.length === 0
      ? '✅ Nothing new'
      : `❌ ${diff.added.length} new finding${diff.added.length === 1 ? '' : 's'}`;

  lines.push(
    '# web-drifter run comparison',
    '',
    `${verdict} · ${diff.fixed.length} fixed · ${diff.changed.length} changed · ${diff.unchanged} unchanged`,
    '',
    `\`${diff.baseline.runId}\` → \`${diff.current.runId}\``,
    '',
  );

  if (diff.warnings.length > 0) {
    lines.push(
      '## ⚠️ This comparison may not mean what it looks like',
      '',
      ...diff.warnings.map((warning) => `- ${warning}`),
      '',
    );
  }

  lines.push(
    '## Totals',
    '',
    '| | Errors | Warnings | Info | Total |',
    '| --- | ---: | ---: | ---: | ---: |',
    countRow('Baseline', diff.baseline.counts),
    countRow('Current', diff.current.counts),
    '',
  );

  if (diff.added.length > 0) {
    lines.push(
      '## New findings',
      '',
      `${added.error} error${added.error === 1 ? '' : 's'}, ${added.warning} warning${
        added.warning === 1 ? '' : 's'
      }, ${added.info} info. These were not in the baseline.`,
      '',
      ...findingTable(diff.added),
    );
  }

  const escalated = diff.changed.filter((entry) => entry.escalated);
  if (escalated.length > 0) {
    lines.push(
      '## Findings that got worse',
      '',
      'Not counted as new - the same difference was already reported - but the',
      'severity moved up.',
      '',
      '| Severity | Page | Finding |',
      '| --- | --- | --- |',
      ...escalated
        .slice(0, MAX_ROWS)
        .map(
          (entry) =>
            `| ${entry.previous.severity} → **${entry.current.severity}** | \`${entry.current.path}\` | ${escapeCell(entry.current.label)} |`,
        ),
      '',
      ...overflow(escalated.length, escalated.slice(0, MAX_ROWS).length, 'escalations'),
    );
  }

  if (diff.fixed.length > 0) {
    lines.push('## Fixed since the baseline', '', ...findingTable(diff.fixed));
  }

  const valueChanges = diff.changed.filter((entry) => !entry.escalated);
  if (valueChanges.length > 0) {
    lines.push(
      '## Changed',
      '',
      'Still reported, but the observed values moved.',
      '',
      '| Page | Finding | Was | Now |',
      '| --- | --- | --- | --- |',
      ...valueChanges
        .slice(0, MAX_ROWS)
        .map(
          (entry) =>
            `| \`${entry.current.path}\` | ${escapeCell(entry.current.label)} | ${cell(entry.previous.actual)} | ${cell(entry.current.actual)} |`,
        ),
      '',
      ...overflow(valueChanges.length, valueChanges.slice(0, MAX_ROWS).length, 'changes'),
    );
  }

  return lines.join('\n');
}

function countRow(label: string, counts: Record<string, number>): string {
  const error = counts['error'] ?? 0;
  const warning = counts['warning'] ?? 0;
  const info = counts['info'] ?? 0;
  return `| ${label} | ${error} | ${warning} | ${info} | **${error + warning + info}** |`;
}

function findingTable(findings: readonly Finding[]): string[] {
  const shown = findings.slice(0, MAX_ROWS);
  return [
    '| Severity | Category | Page | Finding |',
    '| --- | --- | --- | --- |',
    ...shown.map(
      (finding) =>
        `| ${finding.severity} | \`${finding.category}\` | \`${finding.path}\` | ${escapeCell(finding.label)} |`,
    ),
    '',
    ...overflow(findings.length, shown.length, 'findings'),
  ];
}

function overflow(total: number, shown: number, noun: string): string[] {
  if (total <= shown) return [];
  return [`_${total - shown} further ${noun} in \`diff.json\`._`, ''];
}

/** A value as a short table cell. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `\`${escapeCell(truncate(text, 60))}\``;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Pipes and newlines would break out of the table cell they sit in. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/** Type re-export so callers building a table need not import from two places. */
export type { ChangedFinding };
