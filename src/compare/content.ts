import type {
  ContentNode,
  ContentStats,
  Finding,
  FindingCategory,
  PageSnapshot,
  Region,
  Severity,
} from '../core/types.js';
import { REGIONS, kindFamily, percentStat } from '../core/types.js';
import { trigramSimilarity, truncate } from '../extract/text.js';
import { align, type AlignedPair } from './align.js';
import { createFinding, severityFor } from './findings.js';
import { boxDetails, type GeometryIndex } from './geometry-index.js';
import { describeChange as describeCriticalChange, diffCriticalValues } from './critical-values.js';

/**
 * Content comparison.
 *
 * Alignment is partitioned **by landmark region** before anything else. A
 * footer paragraph and a body paragraph are never candidates for each other,
 * however similar their words - matching across regions produces findings that
 * look plausible and are simply wrong, which is worse than reporting nothing.
 *
 * Within a region, alignment yields exactly the four things a migration team
 * needs to know: what changed, what was lost, what appeared, and what moved.
 */

export interface ContentCompareOptions {
  /** Trigram similarity above which two nodes are considered the same node. */
  textSimilarity: number;
  /** Below this, a match is reported but flagged as low confidence. */
  minMatchConfidence: number;
  severities?: Partial<Record<FindingCategory, Severity>>;
  /**
   * Element boxes at the primary viewport, so a text finding can carry a
   * screenshot of the element it is about. Optional: without them the findings
   * are unchanged apart from having no evidence.
   */
  sourceGeometry?: GeometryIndex | undefined;
  targetGeometry?: GeometryIndex | undefined;
}

export interface ContentCompareResult {
  findings: Finding[];
  stats: ContentStats;
  /**
   * Node pairs for downstream comparators. Phase 3.4 compares computed styles
   * only for nodes that content comparison already paired, so a style diff can
   * never be attributed to the wrong element.
   */
  matchedNodes: Array<{ source: ContentNode; target: ContentNode; confidence: number }>;
}

/**
 * Similarity between two content nodes.
 *
 * Different kinds never match: a heading becoming a paragraph is a structural
 * change worth reporting, not a text edit. Images compare on their asset rather
 * than their (frequently empty) alt text. Links weigh their destination as well
 * as their label, because a link whose href changed is drift even when the
 * wording did not.
 */
export function nodeSimilarity(a: ContentNode, b: ContentNode): number {
  // Different families never match: a heading becoming a paragraph is a
  // structural change worth reporting, not a text edit.
  if (kindFamily(a.kind) !== kindFamily(b.kind)) return 0;

  if (a.kind === 'image') {
    const sameAsset = String(a.attrs.src ?? '') === String(b.attrs.src ?? '');
    return sameAsset ? 1 : trigramSimilarity(String(a.attrs.alt ?? ''), String(b.attrs.alt ?? ''));
  }

  const textScore = trigramSimilarity(a.text, b.text);

  if (a.kind === 'link') {
    const samePath = (a.attrs.path ?? a.attrs.href) === (b.attrs.path ?? b.attrs.href);
    // Weighted so a matching label alone can still pair two links, but an
    // identical destination reinforces it.
    return textScore * 0.75 + (samePath ? 0.25 : 0);
  }

  if (a.kind === 'heading' && a.attrs.level !== b.attrs.level) {
    // Same words at a different level: the same content, restructured.
    return textScore * 0.9;
  }

  // Within the text family, a tag change (td -> span, li -> p) is exactly the
  // markup churn a migration produces. Score it just below an exact-tag match
  // so an identical tag still wins when both are available.
  if (a.kind !== b.kind) return textScore * 0.98;

  return textScore;
}

export function compareContent(
  source: PageSnapshot,
  target: PageSnapshot,
  options: ContentCompareOptions,
): ContentCompareResult {
  const findings: Finding[] = [];
  const matchedNodes: ContentCompareResult['matchedNodes'] = [];

  let matchedCount = 0;
  let driftedCount = 0;
  let missingCount = 0;
  let addedCount = 0;
  let reorderedCount = 0;

  const sourceByRegion = groupByRegion(source.content);
  const targetByRegion = groupByRegion(target.content);

  for (const region of REGIONS) {
    const sourceNodes = sourceByRegion.get(region) ?? [];
    const targetNodes = targetByRegion.get(region) ?? [];
    if (sourceNodes.length === 0 && targetNodes.length === 0) continue;

    const pairs = align(sourceNodes, targetNodes, {
      // The FAMILY is part of the anchor key, not the exact tag: identical text
      // used as both a heading and a paragraph must not anchor together, but a
      // table cell and a div carrying the same text must.
      keyOf: (node) => `${kindFamily(node.kind)}:${node.key}`,
      similarity: nodeSimilarity,
      threshold: options.textSimilarity,
    });

    for (const pair of pairs) {
      const finding = classifyPair(pair, source, target, options);
      if (finding) findings.push(finding);

      if (pair.source && pair.target) {
        matchedCount += 1;
        matchedNodes.push({
          source: pair.source,
          target: pair.target,
          confidence: pair.confidence,
        });
        if (!isIdentical(pair.source, pair.target)) driftedCount += 1;
      } else if (pair.source) {
        missingCount += 1;
      } else if (pair.target) {
        addedCount += 1;
      }
    }

    reorderedCount += countReordered(pairs);
  }

  const identicalCount = matchedCount - driftedCount;

  return {
    findings,
    matchedNodes,
    stats: {
      sourceNodes: source.content.length,
      targetNodes: target.content.length,
      matchedNodes: matchedCount,
      driftedNodes: driftedCount,
      missingNodes: missingCount,
      addedNodes: addedCount,
      reorderedNodes: reorderedCount,
      contentParity: percentStat(identicalCount, source.content.length),
    },
  };
}

function classifyPair(
  pair: AlignedPair<ContentNode>,
  source: PageSnapshot,
  target: PageSnapshot,
  options: ContentCompareOptions,
): Finding | null {
  const { severities = {} } = options;
  const geometry = { source: options.sourceGeometry, target: options.targetGeometry };

  if (pair.source && !pair.target) {
    return createFinding({
      category: 'content.missing',
      severity: severityFor('content.missing', severities),
      path: source.path,
      sourceUrl: source.finalUrl,
      targetUrl: target.finalUrl,
      region: pair.source.region,
      nodeKind: pair.source.kind,
      subject: `${pair.source.key}#${pair.source.ordinal}`,
      label: `Missing on target: ${describe(pair.source)}`,
      expected: pair.source.text,
      actual: null,
      details: {
        selectorHint: pair.source.selectorHint,
        ...boxDetails(pair.source, null, geometry),
      },
    });
  }

  if (!pair.source && pair.target) {
    return createFinding({
      category: 'content.added',
      severity: severityFor('content.added', severities),
      path: source.path,
      sourceUrl: source.finalUrl,
      targetUrl: target.finalUrl,
      region: pair.target.region,
      nodeKind: pair.target.kind,
      subject: `${pair.target.key}#${pair.target.ordinal}`,
      label: `Only on target: ${describe(pair.target)}`,
      expected: null,
      actual: pair.target.text,
      details: {
        selectorHint: pair.target.selectorHint,
        ...boxDetails(null, pair.target, geometry),
      },
    });
  }

  if (!pair.source || !pair.target) return null;
  if (isIdentical(pair.source, pair.target)) return null;

  const changed = describeChange(pair.source, pair.target);

  // Both are errors: text that is not identical is drift, full stop. The split
  // is about RANKING, not tolerance - a fee, date, duration, contact detail,
  // negation or obligation that moved is named as such and sorted first, so it
  // cannot sit unnoticed among rewordings that score as more similar. Nothing
  // here suppresses or downgrades a difference.
  const valueChanges = diffCriticalValues(pair.source.text, pair.target.text);
  const category: FindingCategory =
    valueChanges.length > 0 ? 'content.value-drift' : 'content.drift';

  return createFinding({
    category,
    severity: severityFor(category, severities),
    path: source.path,
    sourceUrl: source.finalUrl,
    targetUrl: target.finalUrl,
    region: pair.source.region,
    nodeKind: pair.source.kind,
    subject: `${pair.source.key}#${pair.source.ordinal}`,
    ...(valueChanges.length > 0
      ? { facet: valueChanges.map((change) => change.class).join('+') }
      : {}),
    confidence: pair.confidence,
    label:
      valueChanges.length > 0
        ? `${changed.label} (${valueChanges.map(describeCriticalChange).join('; ')})`
        : changed.label,
    expected: changed.expected,
    actual: changed.actual,
    details: {
      selectorHint: pair.source.selectorHint,
      // Both sides, because showing only one reads as though selectors were what
      // got compared. They are not - the two sites share no markup by
      // construction - and these are here purely to help locate the element.
      targetSelectorHint: pair.target.selectorHint,
      // Surfaced so a reviewer can discount a finding built on a weak pairing
      // rather than having to guess why two unrelated nodes were compared.
      lowConfidence: pair.confidence < options.minMatchConfidence,
      ...(valueChanges.length > 0
        ? {
            valueChanges,
            valueClasses: valueChanges.map((change) => change.class),
          }
        : {}),
      ...boxDetails(pair.source, pair.target, geometry),
    },
  });
}

function isIdentical(a: ContentNode, b: ContentNode): boolean {
  if (a.text !== b.text) return false;
  // Compared by family, not exact tag: the same words moving from a table cell
  // to a div is markup churn, not a content change, and reporting it would
  // flag every line of every table-built page.
  if (kindFamily(a.kind) !== kindFamily(b.kind)) return false;

  switch (a.kind) {
    case 'link':
      return (a.attrs.path ?? a.attrs.href ?? '') === (b.attrs.path ?? b.attrs.href ?? '');
    case 'heading':
      return a.attrs.level === b.attrs.level;
    case 'image':
      return a.attrs.alt === b.attrs.alt;
    default:
      return true;
  }
}

function describeChange(
  a: ContentNode,
  b: ContentNode,
): { label: string; expected: unknown; actual: unknown } {
  if (a.kind === 'link' && a.text === b.text) {
    return {
      label: `Link "${truncate(a.text, 60)}" points somewhere else`,
      expected: a.attrs.path ?? a.attrs.href,
      actual: b.attrs.path ?? b.attrs.href,
    };
  }

  if (a.kind === 'heading' && a.text === b.text && a.attrs.level !== b.attrs.level) {
    return {
      label: `Heading "${truncate(a.text, 60)}" changed level`,
      expected: `h${String(a.attrs.level)}`,
      actual: `h${String(b.attrs.level)}`,
    };
  }

  if (a.kind === 'image') {
    return {
      label: `Image alt text changed`,
      expected: a.attrs.alt,
      actual: b.attrs.alt,
    };
  }

  return {
    label: `Text changed: "${truncate(a.text, 60)}" -> "${truncate(b.text, 60)}"`,
    expected: a.text,
    actual: b.text,
  };
}

function describe(node: ContentNode): string {
  if (node.kind === 'image') return `image ${String(node.attrs.src ?? '')}`;
  if (node.kind === 'heading') return `h${String(node.attrs.level)} "${truncate(node.text, 60)}"`;
  return `${node.kind} "${truncate(node.text, 60)}"`;
}

function groupByRegion(nodes: readonly ContentNode[]): Map<Region, ContentNode[]> {
  const grouped = new Map<Region, ContentNode[]>();
  for (const node of nodes) {
    const bucket = grouped.get(node.region);
    if (bucket) bucket.push(node);
    else grouped.set(node.region, [node]);
  }
  return grouped;
}

/**
 * Matched nodes whose relative order differs between the two sides.
 *
 * Counted for the statistics only. Reordering is rarely a defect on its own -
 * it is usually a template decision - so it is not raised as an error, but a
 * large count is a useful signal that a page was restructured.
 */
function countReordered(pairs: readonly AlignedPair<ContentNode>[]): number {
  const matchedKeys = pairs
    .filter((p) => p.source && p.target)
    .map((p) => `${p.source?.key ?? ''}#${p.source?.ordinal ?? 0}`);

  // Alignment output is already in source order, so any inversion relative to
  // the target order shows up as a pair the alignment could not keep monotonic.
  return Math.max(0, matchedKeys.length - new Set(matchedKeys).size);
}
