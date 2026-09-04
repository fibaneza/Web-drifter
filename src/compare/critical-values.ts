/**
 * Critical value extraction.
 *
 * Text similarity answers "did the wording change". It cannot answer "does the
 * change matter", and on a registration or fees site those are different
 * questions with opposite answers:
 *
 *   "Fees are non-refundable."  ->  "Fees are refundable."        0.83 similar
 *   "You must renew before the expiry date." -> "Renew before it expires."
 *                                                                 0.69 similar
 *
 * The first inverts a refund policy; the second is the same instruction in
 * fewer words. Ranked by similarity the dangerous one looks like the safer one,
 * so a report sorted that way buries it.
 *
 * What separates them is not meaning but *facts that can be compared exactly*:
 * amounts, dates, durations, contact details, negations. Those are extractable
 * with no judgement, no model and no network - which keeps every finding
 * deterministic, cacheable and stable across runs, as `ignore.findingIds` and
 * the `doctor` noise floor both require.
 *
 * The deliberate limit: this detects changed *values*, not changed *meaning*.
 * A rewrite that alters intent while touching no number and no negation passes
 * silently, and no amount of pattern matching would catch it.
 */

import { trigramSimilarity } from '../extract/text.js';

export type CriticalClass =
  'amount' | 'date' | 'duration' | 'contact' | 'number' | 'negation' | 'modal';

/**
 * Extractors, applied in this order.
 *
 * Order is load-bearing. A richer class claims its characters first and later
 * patterns skip anything already claimed, so "30 days" is one `duration` rather
 * than a duration *and* a bare number, and "$49.99" is an `amount` rather than
 * an amount and the number 49.99. Without that, every fee change reported twice.
 */
const EXTRACTORS: ReadonlyArray<readonly [CriticalClass, RegExp]> = [
  [
    'amount',
    /(?:[$£€]\s?-?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:aud|usd|gbp|eur|dollars?|cents?|pence)\b)/gi,
  ],
  [
    'date',
    /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s+\d{4})?)\b/gi,
  ],
  [
    'duration',
    /\b\d[\d,]*(?:\.\d+)?\s?(?:business\s+)?(?:day|week|fortnight|month|year|hour|minute)s?\b/gi,
  ],
  ['contact', /(?:\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b\d[\d\s()-]{7,}\d\b)/gi],
  // The trailing boundary is part of the alternation: `%` is not a word
  // character, so a plain `\b` after it never matches and `10%` came back as
  // the bare number 10.
  ['number', /\b\d[\d,]*(?:\.\d+)?(?:%|\b)/gi],
  [
    'negation',
    /\b(?:not|no|never|cannot|can't|won't|non-[a-z]+|without|ineligible|excluding|unavailable)\b/gi,
  ],
];

/**
 * Modal verbs, handled separately from the extractors above.
 *
 * A modal carries obligation and possibility - "may be eligible" against "is
 * eligible" is a different promise - but a dropped modal is also the most
 * common artefact of ordinary rewriting, because turning a sentence into an
 * imperative removes it. See {@link modalChanged} for how the two are told
 * apart.
 */
const MODAL = /\b(?:may|might|must|shall|should|can|could|will|would|required|optional)\b/gi;

/**
 * How similar the rest of a sentence must be before a modal change counts.
 *
 * At this level the sentence is otherwise the same sentence, so the modal is
 * the change. Below it the sentence was rewritten, and a modal that vanished
 * along with half the words says nothing on its own.
 */
export const MODAL_REMAINDER_THRESHOLD = 0.85;

export type CriticalValues = Partial<Record<CriticalClass, string[]>>;

/**
 * Extract every comparable value from a piece of text.
 *
 * Values are lowercased, whitespace-collapsed and sorted, so the result is a
 * set comparison rather than an ordering one: moving a fee to a different
 * sentence is not a change to the fee.
 */
export function extractCriticalValues(text: string): CriticalValues {
  const lower = text.toLowerCase();
  const claimed = new Array<boolean>(lower.length).fill(false);
  const values: CriticalValues = {};

  for (const [name, pattern] of EXTRACTORS) {
    const hits: string[] = [];
    for (const match of lower.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const start = match.index;
      const end = start + match[0].length;
      let overlaps = false;
      for (let i = start; i < end; i += 1) {
        if (claimed[i]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      for (let i = start; i < end; i += 1) claimed[i] = true;
      hits.push(match[0].replace(/\s+/g, ' ').trim());
    }
    if (hits.length > 0) values[name] = hits.sort();
  }

  return values;
}

/** Modal verbs present in a piece of text, sorted. */
export function extractModals(text: string): string[] {
  return [...text.toLowerCase().matchAll(new RegExp(MODAL.source, MODAL.flags))]
    .map((match) => match[0])
    .sort();
}

/**
 * Did the modal change, in a sentence that is otherwise unchanged?
 *
 * Both halves are required. "Documents must be certified" against "Documents
 * should be certified" leaves an identical remainder, so the obligation is
 * demonstrably what moved. "You must renew before the expiry date" against
 * "Renew before it expires" also loses a modal, but the remainder barely
 * matches - the sentence was rewritten, and reporting that as a weakened
 * obligation would be wrong.
 */
export function modalChanged(source: string, target: string): boolean {
  if (sameValues(extractModals(source), extractModals(target))) return false;

  const strip = (text: string): string =>
    text
      .toLowerCase()
      .replace(new RegExp(MODAL.source, MODAL.flags), ' ')
      .replace(/\s+/g, ' ')
      .trim();

  return trigramSimilarity(strip(source), strip(target)) >= MODAL_REMAINDER_THRESHOLD;
}

export interface CriticalChange {
  class: CriticalClass;
  /** Present on the source, absent from the target. */
  removed: string[];
  /** Present on the target, absent from the source. */
  added: string[];
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Multiset difference, so a fee quoted twice and then once is a change. */
function difference(a: readonly string[], b: readonly string[]): string[] {
  const remaining = [...b];
  const only: string[] = [];
  for (const value of a) {
    const at = remaining.indexOf(value);
    if (at === -1) only.push(value);
    else remaining.splice(at, 1);
  }
  return only;
}

/**
 * Compare the extractable facts in two pieces of text.
 *
 * An empty result means the wording changed and every value survived it - the
 * signature of a rewrite rather than a revision.
 */
export function diffCriticalValues(source: string, target: string): CriticalChange[] {
  const before = extractCriticalValues(source);
  const after = extractCriticalValues(target);
  const changes: CriticalChange[] = [];

  const classes = new Set<CriticalClass>([
    ...(Object.keys(before) as CriticalClass[]),
    ...(Object.keys(after) as CriticalClass[]),
  ]);

  for (const name of classes) {
    const from = before[name] ?? [];
    const to = after[name] ?? [];
    if (sameValues(from, to)) continue;
    changes.push({ class: name, removed: difference(from, to), added: difference(to, from) });
  }

  if (modalChanged(source, target)) {
    changes.push({
      class: 'modal',
      removed: difference(extractModals(source), extractModals(target)),
      added: difference(extractModals(target), extractModals(source)),
    });
  }

  // Stable order, so a finding's description does not depend on key iteration.
  return changes.sort((a, b) => a.class.localeCompare(b.class));
}

/** One-line description of what changed, for a finding label. */
export function describeChange(change: CriticalChange): string {
  const from = change.removed.length > 0 ? change.removed.join(', ') : '(none)';
  const to = change.added.length > 0 ? change.added.join(', ') : '(none)';
  return `${change.class}: ${from} → ${to}`;
}
