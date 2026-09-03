import { createHash } from 'node:crypto';
import type { Finding, FindingCategory, NodeKind, Region, Severity } from '../core/types.js';

/**
 * Finding construction.
 *
 * The important property here is that a finding's `id` is **deterministic**:
 * the same difference gets the same id on every run, on every machine. That is
 * what makes suppression usable - a team can accept one specific known
 * difference without silencing an entire category, and the acceptance keeps
 * working across re-crawls.
 *
 * So the id is hashed from identity only (what and where), never from the
 * values being compared. If it included the values, fixing a colour from red to
 * orange would mint a brand-new id and the old suppression would silently stop
 * applying - or worse, a re-run would report an "unseen" finding for a
 * difference the team had already reviewed.
 */

export interface FindingInput {
  category: FindingCategory;
  severity: Severity;
  path: string;
  label: string;
  confidence?: number;
  sourceUrl?: string | undefined;
  targetUrl?: string | undefined;
  viewport?: string | undefined;
  region?: Region | undefined;
  nodeKind?: NodeKind | undefined;
  /** Stable handle for the element or item, e.g. a node key or asset key. */
  subject?: string | undefined;
  /** Distinguishes several findings about one subject, e.g. a CSS property. */
  facet?: string | undefined;
  expected?: unknown;
  actual?: unknown;
  details?: Record<string, unknown> | undefined;
}

/**
 * Deterministic finding id.
 *
 * Deliberately excludes `expected` and `actual`: see the note above.
 */
export function findingId(input: FindingInput): string {
  const identity = [
    input.category,
    input.path,
    input.viewport ?? '',
    input.region ?? '',
    input.nodeKind ?? '',
    input.subject ?? '',
    input.facet ?? '',
  ].join('|');
  return createHash('sha1').update(identity).digest('hex').slice(0, 12);
}

export function createFinding(input: FindingInput): Finding {
  return {
    id: findingId(input),
    category: input.category,
    severity: input.severity,
    path: input.path,
    label: input.label,
    confidence: input.confidence ?? 1,
    ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
    ...(input.targetUrl === undefined ? {} : { targetUrl: input.targetUrl }),
    ...(input.viewport === undefined ? {} : { viewport: input.viewport }),
    ...(input.region === undefined ? {} : { region: input.region }),
    ...(input.nodeKind === undefined ? {} : { nodeKind: input.nodeKind }),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.facet === undefined ? {} : { facet: input.facet }),
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.actual === undefined ? {} : { actual: input.actual }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

/** Default severity per category. Overridable per project via config. */
export const DEFAULT_SEVERITIES: Record<FindingCategory, Severity> = {
  // Coverage: a missing page is the most serious thing this tool can find.
  'page.missing-on-target': 'error',
  'page.extra-on-target': 'warning',
  'page.status-mismatch': 'error',
  'page.redirected': 'warning',
  'page.alias': 'info',

  // Content.
  'content.drift': 'error',
  'content.missing': 'error',
  'content.added': 'warning',
  // Reordering is usually a template decision, not lost content.
  'content.order-changed': 'info',
  'meta.drift': 'warning',

  // Images and prices. A wrong price is unambiguously serious; a differently
  // formatted identical price is not a defect at all.
  'image.missing': 'error',
  'image.added': 'warning',
  'image.alt-drift': 'warning',
  'image.size-drift': 'info',
  'price.value-drift': 'error',
  'price.currency-drift': 'error',
  'price.format-drift': 'info',
  'price.missing': 'error',
  'price.added': 'warning',

  // CSS. Property drift is a warning rather than an error: some of it is
  // intentional in a redesign, and treating every one as a failure would make
  // the gate unusable on day one. Elements disappearing is different.
  'css.property-drift': 'warning',
  'css.layout-drift': 'warning',
  'css.visibility-drift': 'error',
  'css.responsive-visibility-drift': 'error',
  'css.horizontal-overflow': 'warning',

  // Links.
  'link.broken': 'error',
  'link.path-mismatch': 'error',
  'link.redirect-chain': 'info',
  'link.mixed-content': 'warning',
};

export function severityFor(
  category: FindingCategory,
  overrides: Partial<Record<FindingCategory, Severity>> = {},
): Severity {
  return overrides[category] ?? DEFAULT_SEVERITIES[category];
}

/**
 * Apply suppression rules.
 *
 * Two mechanisms, deliberately different in strength:
 * - `ignoreFindingIds` removes a specific accepted difference entirely.
 * - `downgradeCategories` keeps a whole category visible but demotes it to
 *   `info`, so it stops failing the build without disappearing from the report.
 *
 * Downgrading rather than deleting matters: a category that is noisy today may
 * hide a real regression tomorrow, and silently dropping it removes the only
 * evidence that it was ever considered.
 */
export function applySuppression(
  findings: readonly Finding[],
  options: {
    ignoreFindingIds?: readonly string[];
    downgradeCategories?: readonly string[];
  },
): Finding[] {
  const ignored = new Set(options.ignoreFindingIds ?? []);
  const downgraded = new Set(options.downgradeCategories ?? []);

  const out: Finding[] = [];
  for (const finding of findings) {
    if (ignored.has(finding.id)) continue;
    out.push(downgraded.has(finding.category) ? { ...finding, severity: 'info' } : finding);
  }
  return out;
}

/**
 * What a migration team fixes first, within a severity.
 *
 * Wrong text and wrong prices are what a visitor notices and what costs money;
 * a missing page or component is next. Styling comes last - some of it is
 * intentional in a redesign, and none of it is worth reading before the content
 * is right. Ranking by this rather than alphabetically by category is the
 * difference between a report that opens on the pricing bug and one that opens
 * on a 3px margin.
 */
const CATEGORY_PRIORITY: Partial<Record<FindingCategory, number>> = {
  'price.value-drift': 0,
  'price.currency-drift': 0,
  'price.missing': 1,
  'price.added': 1,
  'content.drift': 1,
  'content.missing': 2,
  'content.added': 2,
  'image.missing': 2,
  'image.added': 3,
  'page.missing-on-target': 2,
  'page.status-mismatch': 2,
  'page.extra-on-target': 3,
  'link.broken': 3,
  'link.path-mismatch': 3,
};
const DEFAULT_PRIORITY = 5;
/** Styling ranks below everything else, whatever its severity band. */
const CSS_PRIORITY = 8;

function priorityOf(category: FindingCategory): number {
  return (
    CATEGORY_PRIORITY[category] ?? (category.startsWith('css.') ? CSS_PRIORITY : DEFAULT_PRIORITY)
  );
}

/** How big a graded drift is, for ranking. Ungraded findings sort as average. */
function magnitudeOf(finding: Finding): number {
  const magnitude = finding.details?.['magnitude'];
  return typeof magnitude === 'number' ? magnitude : 1;
}

/** Sort most serious first, then by what is worth fixing first, so a report reads top-down. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return [...findings].sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      priorityOf(a.category) - priorityOf(b.category) ||
      // Bigger drifts first: "show me the blatant ones" is the common request.
      magnitudeOf(b) - magnitudeOf(a) ||
      a.path.localeCompare(b.path) ||
      a.category.localeCompare(b.category) ||
      a.id.localeCompare(b.id),
  );
}
