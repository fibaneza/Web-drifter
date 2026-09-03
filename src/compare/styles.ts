import type {
  ContentNode,
  CssStats,
  CssViewportStats,
  Finding,
  FindingCategory,
  NodeStyle,
  PageSnapshot,
  Severity,
  ViewportCapture,
} from '../core/types.js';
import { percentStat } from '../core/types.js';
import { groupOf } from '../extract/css-properties.js';
import { truncate } from '../extract/text.js';
import {
  compareCssValue,
  geometryTolerance,
  parsePx,
  type CssComparison,
} from './css-normalize.js';
import { createFinding, severityFor } from './findings.js';

/**
 * CSS and layout comparison - Phase 3.4, and the source of the separate CSS
 * report.
 *
 * Two decisions define this module.
 *
 * **Computed styles, not stylesheets.** Across a rewrite the two sites share no
 * selectors, no class names and no cascade. The only thing they have in common
 * is what the browser finally resolved, which is also the only thing the user
 * can see.
 *
 * **Only nodes that content comparison already paired.** Styles are never
 * matched independently. If the content pass could not confidently say two
 * elements are the same element, comparing their styles would attribute a
 * difference to the wrong thing - a confident, precise, wrong finding, which is
 * the most damaging kind.
 *
 * Everything is compared like-for-like per viewport: source at `mobile-sm`
 * against target at `mobile-sm`, never across sizes.
 */

export interface StyleCompareOptions {
  /** Properties to compare, already filtered by `ignore.cssProperties`. */
  cssProperties: readonly string[];
  /** Perceptual colour distance below which a colour difference is not reported. */
  colorTolerance: number;
  /** Distances at or above which a CSS drift is a warning rather than information. */
  colorDeltaWarn: number;
  lengthWarnPx: number;
  lengthWarnPercent: number;
  geometryWarnFactor: number;
  lengthTolerancePx: number;
  /** Absolute geometry tolerance in CSS pixels. */
  geometryPx: number;
  /** Geometry tolerance as a fraction of viewport width. */
  geometryPercent: number;
  /** Match confidence below which style differences are not reported at all. */
  minMatchConfidence: number;
  severities?: Partial<Record<FindingCategory, Severity>>;
}

export interface MatchedNode {
  source: ContentNode;
  target: ContentNode;
  confidence: number;
}

export interface StyleCompareResult {
  findings: Finding[];
  stats: CssStats;
}

const styleKey = (node: ContentNode): string => `${node.key}#${node.ordinal}`;

function indexStyles(capture: ViewportCapture): Map<string, NodeStyle> {
  const index = new Map<string, NodeStyle>();
  for (const style of capture.styles) index.set(`${style.nodeKey}#${style.ordinal}`, style);
  return index;
}

/**
 * How big a CSS difference is, relative to the threshold that makes it a warning.
 *
 * One unitless number across colour, length and geometry so the report can rank
 * unlike drifts against each other: `>= 1` is a warning, below that is
 * information. Recording it on the finding is what lets a reviewer sort by "show
 * me the blatant ones" instead of reading four thousand equal-looking rows.
 */
function propertyMagnitude(comparison: CssComparison, options: StyleCompareOptions): number | null {
  if (comparison.deltaE !== undefined && options.colorDeltaWarn > 0) {
    return comparison.deltaE / options.colorDeltaWarn;
  }

  if (comparison.deltaPx !== undefined) {
    const absolute = Math.abs(comparison.deltaPx);
    const byPixels = options.lengthWarnPx > 0 ? absolute / options.lengthWarnPx : 0;

    // The relative term is what stops 4px reading the same on a 12px body font
    // as on a 48px heading. Whichever measure is more alarmed wins.
    const sourcePx = parsePx(comparison.normalizedSource);
    const byFraction =
      sourcePx !== null && sourcePx !== 0 && options.lengthWarnPercent > 0
        ? Math.abs(comparison.deltaPx / sourcePx) / options.lengthWarnPercent
        : 0;

    return Math.max(byPixels, byFraction);
  }

  return null;
}

/**
 * Severity for a graded CSS finding.
 *
 * CSS never reaches `error`. Some restyling is intentional in a rewrite, and a
 * gate that fails the build over a shifted margin gets switched off on day one -
 * at which point it catches nothing at all. An explicit severity override in
 * config still wins outright, so the escape hatch stays honest.
 */
function gradedSeverity(
  category: 'css.property-drift' | 'css.layout-drift',
  magnitude: number | null,
  severities: Partial<Record<FindingCategory, Severity>>,
): Severity {
  const override = severities[category];
  if (override) return override;
  if (magnitude === null) return 'warning';
  return magnitude >= 1 ? 'warning' : 'info';
}

export function compareStyles(
  source: PageSnapshot,
  target: PageSnapshot,
  matchedNodes: readonly MatchedNode[],
  options: StyleCompareOptions,
): StyleCompareResult {
  const findings: Finding[] = [];
  const { severities = {} } = options;

  const targetViewports = new Map(target.viewports.map((v) => [v.viewport, v]));
  const propertyCounts = new Map<string, number>();
  const perViewport: CssViewportStats[] = [];

  /**
   * Visibility per node per viewport, accumulated across all viewports before
   * being classified. A node hidden at every size is a plain visibility bug; a
   * node hidden at only some sizes is a responsive bug. Those need different
   * severities and different places in the report, and they cannot be told
   * apart until every viewport has been seen.
   */
  const visibility = new Map<
    string,
    { node: ContentNode; byViewport: Map<string, { source: boolean; target: boolean }> }
  >();

  let comparedNodesTotal = 0;
  let comparedPropertiesTotal = 0;
  let propertyDriftsTotal = 0;
  let layoutDriftsTotal = 0;

  for (const sourceCapture of source.viewports) {
    const targetCapture = targetViewports.get(sourceCapture.viewport);
    // A viewport captured on one side only cannot be compared like-for-like.
    if (!targetCapture) continue;

    const viewport = sourceCapture.viewport;
    const sourceStyles = indexStyles(sourceCapture);
    const targetStyles = indexStyles(targetCapture);

    const tolerance = geometryTolerance(
      sourceCapture.width,
      options.geometryPx,
      options.geometryPercent,
    );

    let comparedNodes = 0;
    let comparedProperties = 0;
    let propertyDrifts = 0;
    let layoutDrifts = 0;

    for (const match of matchedNodes) {
      // A weak content pairing cannot support a precise style claim.
      if (match.confidence < options.minMatchConfidence) continue;

      const sourceStyle = sourceStyles.get(styleKey(match.source));
      const targetStyle = targetStyles.get(styleKey(match.target));
      if (!sourceStyle || !targetStyle) continue;

      const identity = styleKey(match.source);
      let record = visibility.get(identity);
      if (!record) {
        record = { node: match.source, byViewport: new Map() };
        visibility.set(identity, record);
      }
      record.byViewport.set(viewport, {
        source: sourceStyle.visible,
        target: targetStyle.visible,
      });

      // An element hidden on either side has no meaningful computed geometry,
      // and its other properties are not what the user sees. Visibility is
      // reported separately, below.
      if (!sourceStyle.visible || !targetStyle.visible) continue;

      comparedNodes += 1;

      for (const property of options.cssProperties) {
        const sourceValue = sourceStyle.props[property];
        const targetValue = targetStyle.props[property];
        if (sourceValue === undefined || targetValue === undefined) continue;

        comparedProperties += 1;
        const comparison = compareCssValue(property, sourceValue, targetValue, {
          lengthTolerancePx: options.lengthTolerancePx,
          colorTolerance: options.colorTolerance,
        });
        if (comparison.equal) continue;

        propertyDrifts += 1;
        propertyCounts.set(property, (propertyCounts.get(property) ?? 0) + 1);

        const magnitude = propertyMagnitude(comparison, options);

        findings.push(
          createFinding({
            category: 'css.property-drift',
            // Only the fallbacks differ: both render in the same primary font
            // wherever it exists, so this is information, not a defect.
            severity:
              comparison.kind === 'font-fallback'
                ? 'info'
                : gradedSeverity('css.property-drift', magnitude, severities),
            path: source.path,
            sourceUrl: source.finalUrl,
            targetUrl: target.finalUrl,
            viewport,
            region: match.source.region,
            nodeKind: match.source.kind,
            subject: identity,
            facet: property,
            confidence: match.confidence,
            label: `${property} differs on ${describeNode(match.source)}`,
            expected: comparison.normalizedSource,
            actual: comparison.normalizedTarget,
            details: {
              group: groupOf(property),
              kind: comparison.kind,
              selectorHint: match.source.selectorHint,
              // Carried so the report can crop this element out of the stored
              // full-page screenshot as evidence, without re-navigating.
              sourceBox: sourceStyle.box,
              targetBox: targetStyle.box,
              ...(comparison.deltaPx === undefined ? {} : { deltaPx: comparison.deltaPx }),
              ...(comparison.deltaE === undefined
                ? {}
                : { deltaE: Math.round(comparison.deltaE * 1000) / 1000 }),
              ...(magnitude === null ? {} : { magnitude: Math.round(magnitude * 100) / 100 }),
            },
          }),
        );
      }

      const layout = compareGeometry(sourceStyle, targetStyle, tolerance);
      if (layout) {
        layoutDrifts += 1;
        // The largest shift in any gated dimension. A box that moved 40px is a
        // different problem from one that moved 3px, and the report should not
        // present them as the same problem.
        const shift = Math.max(
          Math.abs(layout.deltas.x),
          Math.abs(layout.deltas.width),
          Math.abs(layout.deltas.height),
        );
        // Measured against the tolerance in force at this viewport, so the
        // bands mean the same thing at 360px and at 1440px.
        const warnAt = tolerance * options.geometryWarnFactor;
        const layoutMagnitude = warnAt > 0 ? shift / warnAt : null;

        findings.push(
          createFinding({
            category: 'css.layout-drift',
            severity: gradedSeverity('css.layout-drift', layoutMagnitude, severities),
            path: source.path,
            sourceUrl: source.finalUrl,
            targetUrl: target.finalUrl,
            viewport,
            region: match.source.region,
            nodeKind: match.source.kind,
            subject: identity,
            facet: layout.facet,
            confidence: match.confidence,
            label: `${describeNode(match.source)} is ${layout.summary}`,
            expected: layout.expected,
            actual: layout.actual,
            details: {
              tolerancePx: Math.round(tolerance * 100) / 100,
              deltas: layout.deltas,
              selectorHint: match.source.selectorHint,
              sourceBox: sourceStyle.box,
              targetBox: targetStyle.box,
              ...(layoutMagnitude === null
                ? {}
                : { magnitude: Math.round(layoutMagnitude * 100) / 100 }),
            },
          }),
        );
      }
    }

    // Content wider than the viewport forces horizontal scrolling - one of the
    // most common and most visible responsive regressions.
    let horizontalOverflowPages = 0;
    if (targetCapture.hasHorizontalOverflow && !sourceCapture.hasHorizontalOverflow) {
      horizontalOverflowPages = 1;
      findings.push(
        createFinding({
          category: 'css.horizontal-overflow',
          severity: severityFor('css.horizontal-overflow', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          viewport,
          subject: 'document',
          label: `Page scrolls horizontally at ${viewport} but the source does not`,
          expected: `<= ${sourceCapture.width}px`,
          actual: `> ${targetCapture.width}px`,
        }),
      );
    }

    perViewport.push({
      viewport,
      comparedNodes,
      comparedProperties,
      propertyDrifts,
      layoutDrifts,
      visibilityDrifts: 0, // filled in below, once all viewports are known
      horizontalOverflowPages,
    });

    comparedNodesTotal += comparedNodes;
    comparedPropertiesTotal += comparedProperties;
    propertyDriftsTotal += propertyDrifts;
    layoutDriftsTotal += layoutDrifts;
  }

  const visibilityResult = classifyVisibility(visibility, source, target, severities);
  findings.push(...visibilityResult.findings);

  for (const stats of perViewport) {
    stats.visibilityDrifts = visibilityResult.byViewport.get(stats.viewport) ?? 0;
  }

  const topProperties = [...propertyCounts.entries()]
    .map(([property, count]) => ({ property, count }))
    .sort((a, b) => b.count - a.count || a.property.localeCompare(b.property))
    .slice(0, 20);

  return {
    findings,
    stats: {
      comparedNodes: comparedNodesTotal,
      comparedProperties: comparedPropertiesTotal,
      propertyDrifts: propertyDriftsTotal,
      layoutDrifts: layoutDriftsTotal,
      visibilityDrifts: visibilityResult.total,
      responsiveVisibilityDrifts: visibilityResult.responsive,
      styleParity: percentStat(
        comparedPropertiesTotal - propertyDriftsTotal,
        comparedPropertiesTotal,
      ),
      byViewport: perViewport,
      topProperties,
    },
  };
}

interface LayoutDrift {
  facet: string;
  summary: string;
  expected: Record<string, number>;
  actual: Record<string, number>;
  /** Signed target-minus-source change per dimension, in CSS pixels. */
  deltas: { x: number; y: number; width: number; height: number };
}

/**
 * Compare document-relative geometry.
 *
 * Position and size are reported as separate facets because they mean different
 * things: a box that moved is usually caused by something above it, while a box
 * that changed size is usually its own styling. Reporting them together makes
 * the cause harder to find.
 */
function compareGeometry(
  source: NodeStyle,
  target: NodeStyle,
  tolerance: number,
): LayoutDrift | null {
  const deltas = {
    x: round(target.box.x - source.box.x),
    y: round(target.box.y - source.box.y),
    width: round(target.box.width - source.box.width),
    height: round(target.box.height - source.box.height),
  };

  const movedX = Math.abs(deltas.x) > tolerance;
  const resizedWidth = Math.abs(deltas.width) > tolerance;
  const resizedHeight = Math.abs(deltas.height) > tolerance;

  // Vertical position is deliberately NOT compared on its own. One extra line
  // of text near the top of a page shifts everything below it, which would turn
  // a single real difference into hundreds of derived ones.
  if (!movedX && !resizedWidth && !resizedHeight) return null;

  const parts: string[] = [];
  if (resizedWidth)
    parts.push(`${deltas.width > 0 ? 'wider' : 'narrower'} by ${Math.abs(deltas.width)}px`);
  if (resizedHeight)
    parts.push(`${deltas.height > 0 ? 'taller' : 'shorter'} by ${Math.abs(deltas.height)}px`);
  if (movedX) parts.push(`shifted horizontally by ${deltas.x}px`);

  return {
    facet: resizedWidth || resizedHeight ? 'size' : 'position',
    summary: parts.join(', '),
    expected: { ...source.box },
    actual: { ...target.box },
    deltas,
  };
}

interface VisibilityResult {
  findings: Finding[];
  total: number;
  responsive: number;
  byViewport: Map<string, number>;
}

/**
 * Turn accumulated per-viewport visibility into findings.
 *
 * An element hidden on the target at *every* viewport is simply missing from
 * view. One hidden at only *some* viewports is a responsive bug - a nav item
 * that vanishes on mobile, a panel that never appears on tablet - and that is
 * the single most common real defect in a responsive rewrite, so it gets its
 * own category and appears per device in the report.
 */
function classifyVisibility(
  visibility: Map<
    string,
    { node: ContentNode; byViewport: Map<string, { source: boolean; target: boolean }> }
  >,
  source: PageSnapshot,
  target: PageSnapshot,
  severities: Partial<Record<FindingCategory, Severity>>,
): VisibilityResult {
  const findings: Finding[] = [];
  const byViewport = new Map<string, number>();
  let total = 0;
  let responsive = 0;

  for (const [identity, record] of visibility) {
    const entries = [...record.byViewport.entries()];
    const mismatched = entries.filter(([, v]) => v.source !== v.target);
    if (mismatched.length === 0) continue;

    total += mismatched.length;
    const everywhere = mismatched.length === entries.length;

    if (everywhere) {
      const first = mismatched[0]?.[1];
      findings.push(
        createFinding({
          category: 'css.visibility-drift',
          severity: severityFor('css.visibility-drift', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          region: record.node.region,
          nodeKind: record.node.kind,
          subject: identity,
          facet: 'visibility',
          label:
            `${describeNode(record.node)} is ` +
            `${first?.target ? 'visible only on the target' : 'hidden on the target'} ` +
            'at every viewport',
          expected: first?.source ? 'visible' : 'hidden',
          actual: first?.target ? 'visible' : 'hidden',
          details: { selectorHint: record.node.selectorHint },
        }),
      );
      for (const [viewport] of mismatched) {
        byViewport.set(viewport, (byViewport.get(viewport) ?? 0) + 1);
      }
      continue;
    }

    for (const [viewport, state] of mismatched) {
      responsive += 1;
      byViewport.set(viewport, (byViewport.get(viewport) ?? 0) + 1);
      findings.push(
        createFinding({
          category: 'css.responsive-visibility-drift',
          severity: severityFor('css.responsive-visibility-drift', severities),
          path: source.path,
          sourceUrl: source.finalUrl,
          targetUrl: target.finalUrl,
          viewport,
          region: record.node.region,
          nodeKind: record.node.kind,
          subject: identity,
          facet: 'visibility',
          label:
            `${describeNode(record.node)} is ${state.source ? 'visible' : 'hidden'} on source ` +
            `but ${state.target ? 'visible' : 'hidden'} on target at ${viewport}`,
          expected: state.source ? 'visible' : 'hidden',
          actual: state.target ? 'visible' : 'hidden',
          details: {
            selectorHint: record.node.selectorHint,
            // Naming the viewports where it agrees makes the breakpoint obvious.
            agreesAt: entries.filter(([, v]) => v.source === v.target).map(([v]) => v),
          },
        }),
      );
    }
  }

  return { findings, total, responsive, byViewport };
}

function describeNode(node: ContentNode): string {
  if (node.kind === 'image') return `image "${truncate(String(node.attrs.alt ?? ''), 40)}"`;
  const text = truncate(node.text, 40);
  return text === '' ? node.kind : `${node.kind} "${text}"`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
