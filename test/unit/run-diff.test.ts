import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Finding, RunStats, Severity } from '../../src/core/types.js';
import { createFinding } from '../../src/compare/findings.js';
import { atOrAbove, diffRuns, type ReportFile } from '../../src/report/diff.js';

/**
 * Run-over-run classification.
 *
 * The whole feature rests on finding ids being identity-only, so these build
 * findings through `createFinding` rather than as object literals - a literal
 * with a hand-written id would pass while proving nothing about whether real
 * ids survive a value change.
 */

function finding(overrides: {
  path: string;
  subject?: string;
  severity?: Severity;
  expected?: unknown;
  actual?: unknown;
  viewport?: string;
}): Finding {
  return createFinding({
    category: 'content.drift',
    severity: overrides.severity ?? 'error',
    path: overrides.path,
    label: `Text drifted on ${overrides.path}`,
    subject: overrides.subject ?? 'node#0',
    ...(overrides.viewport === undefined ? {} : { viewport: overrides.viewport }),
    ...(overrides.expected === undefined ? {} : { expected: overrides.expected }),
    ...(overrides.actual === undefined ? {} : { actual: overrides.actual }),
  });
}

function stats(overrides: Partial<RunStats> = {}): RunStats {
  return {
    runId: '2026-09-03T10-00-00-000',
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:05:00.000Z',
    durationMs: 300_000,
    sourceBaseUrl: 'https://legacy.example.com',
    targetBaseUrl: 'https://new.example.com',
    viewports: ['desktop', 'mobile-sm'],
    ...overrides,
  } as RunStats;
}

const report = (findings: Finding[], overrides?: Partial<RunStats>): ReportFile => ({
  stats: stats(overrides),
  findings,
});

describe('diffRuns', () => {
  it('reports a finding only in the current run as added', () => {
    const kept = finding({ path: '/' });
    const appeared = finding({ path: '/pricing' });

    const diff = diffRuns(report([kept]), report([kept, appeared]));

    assert.deepEqual(
      diff.added.map((f) => f.path),
      ['/pricing'],
    );
    assert.deepEqual(diff.fixed, []);
    assert.equal(diff.unchanged, 1);
  });

  it('reports a finding only in the baseline as fixed', () => {
    const kept = finding({ path: '/' });
    const gone = finding({ path: '/contact' });

    const diff = diffRuns(report([kept, gone]), report([kept]));

    assert.deepEqual(
      diff.fixed.map((f) => f.path),
      ['/contact'],
    );
    assert.deepEqual(diff.added, []);
  });

  it('treats a changed value as changed, not as one fixed plus one new', () => {
    // This is the property the whole command depends on: the id excludes
    // `expected`/`actual`, so partially fixing a difference must not look like
    // the old one vanishing and an unrelated one appearing.
    const before = finding({ path: '/', expected: 'Hello', actual: 'Hola' });
    const after = finding({ path: '/', expected: 'Hello', actual: 'Hello there' });

    assert.equal(before.id, after.id, 'ids must survive a value change');

    const diff = diffRuns(report([before]), report([after]));

    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.fixed, []);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0]?.previous.actual, 'Hola');
    assert.equal(diff.changed[0]?.current.actual, 'Hello there');
    assert.equal(diff.unchanged, 0);
  });

  it('flags a severity that got worse as an escalation', () => {
    const before = finding({ path: '/', severity: 'warning' });
    const after = finding({ path: '/', severity: 'error' });

    const diff = diffRuns(report([before]), report([after]));

    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0]?.escalated, true);
  });

  it('does not call an improving severity an escalation', () => {
    const diff = diffRuns(
      report([finding({ path: '/', severity: 'error' })]),
      report([finding({ path: '/', severity: 'warning' })]),
    );

    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0]?.escalated, false);
  });

  it('reports nothing at all when a run is compared with itself', () => {
    // Cheap, and it catches any accidental nondeterminism in the classifier.
    const findings = [
      finding({ path: '/', expected: { a: 1, b: [2, 3] } }),
      finding({ path: '/pricing', severity: 'warning' }),
      finding({ path: '/about', viewport: 'mobile-sm' }),
    ];

    const diff = diffRuns(report(findings), report(findings));

    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.fixed, []);
    assert.deepEqual(diff.changed, []);
    assert.equal(diff.unchanged, 3);
    assert.deepEqual(diff.warnings, []);
  });

  it('ignores key order inside a value, which is not a change', () => {
    const diff = diffRuns(
      report([finding({ path: '/', expected: { colour: 'red', size: 12 } })]),
      report([finding({ path: '/', expected: { size: 12, colour: 'red' } })]),
    );

    assert.deepEqual(diff.changed, []);
    assert.equal(diff.unchanged, 1);
  });

  it('warns when the two runs crawled different source sites', () => {
    const diff = diffRuns(
      report([], { sourceBaseUrl: 'https://old-legacy.example.com' }),
      report([]),
    );

    assert.equal(diff.warnings.length, 1);
    assert.match(diff.warnings[0] ?? '', /different source sites/);
  });

  it('warns when the viewport sets differ, since viewport is part of the id', () => {
    const diff = diffRuns(report([], { viewports: ['desktop'] }), report([]));

    assert.equal(diff.warnings.length, 1);
    assert.match(diff.warnings[0] ?? '', /different viewports/);
  });

  it('carries both runs identities into the summary', () => {
    const diff = diffRuns(
      report([finding({ path: '/' })], { runId: 'run-a' }),
      report([finding({ path: '/' }), finding({ path: '/b', severity: 'warning' })], {
        runId: 'run-b',
      }),
    );

    assert.equal(diff.baseline.runId, 'run-a');
    assert.equal(diff.current.runId, 'run-b');
    assert.deepEqual(diff.baseline.counts, { error: 1, warning: 0, info: 0 });
    assert.deepEqual(diff.current.counts, { error: 1, warning: 1, info: 0 });
  });
});

describe('atOrAbove', () => {
  it('selects the findings a gate should fail on', () => {
    const findings = [
      finding({ path: '/a', severity: 'error' }),
      finding({ path: '/b', severity: 'warning' }),
      finding({ path: '/c', severity: 'info' }),
    ];

    assert.deepEqual(
      atOrAbove(findings, 'error').map((f) => f.path),
      ['/a'],
    );
    assert.deepEqual(
      atOrAbove(findings, 'warning').map((f) => f.path),
      ['/a', '/b'],
    );
    assert.equal(atOrAbove(findings, 'info').length, 3);
  });
});
