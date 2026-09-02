/**
 * Sequence alignment for the canonical page model.
 *
 * The problem: two ordered streams of nodes, extracted from DOMs that share no
 * structure, where a node may have been edited, moved, deleted or inserted. We
 * need to say which source node corresponds to which target node so that the
 * difference between them is reportable, and which have no counterpart at all.
 *
 * Approach - anchored alignment, the same idea as patience diff:
 *
 *   1. **Anchor** on items whose key occurs exactly once on each side. Those
 *      are unambiguous: a heading that appears once on both pages is the same
 *      heading, wherever it sits. Anchors are then reduced to a longest
 *      increasing subsequence so they cannot cross.
 *   2. **Align the gaps** between consecutive anchors with Needleman-Wunsch,
 *      scored by a caller-supplied similarity function, so a reworded node
 *      still pairs with its original.
 *
 * Why not Needleman-Wunsch over the whole page: it is O(n*m). A page with 800
 * nodes a side is 640,000 cells - tolerable once, ruinous across a thousand
 * pages and four viewports. Anchoring reduces it to a handful of small
 * quadratic problems and is near-linear on pages that mostly match, which is
 * the normal case for a migration.
 */

export interface AlignedPair<T> {
  source: T | null;
  target: T | null;
  /** 1 for an exact key match, in (0,1) for a fuzzy match, 0 when unmatched. */
  confidence: number;
}

export interface AlignOptions<T> {
  /** Stable identity used for anchoring. Equal keys mean "certainly the same". */
  keyOf: (item: T) => string;
  /** Similarity in [0,1]. Only pairs scoring >= `threshold` are matched. */
  similarity: (a: T, b: T) => number;
  threshold: number;
  /**
   * Cap on `sourceLen * targetLen` for one Needleman-Wunsch call. Beyond this a
   * gap falls back to greedy key matching, trading a little accuracy for a
   * bounded runtime on pathological pages.
   */
  maxProduct?: number;
}

const DEFAULT_MAX_PRODUCT = 250_000;

export function align<T>(
  source: readonly T[],
  target: readonly T[],
  options: AlignOptions<T>,
): AlignedPair<T>[] {
  if (source.length === 0 && target.length === 0) return [];
  if (source.length === 0) return target.map((t) => unmatchedTarget(t));
  if (target.length === 0) return source.map((s) => unmatchedSource(s));

  const anchors = findAnchors(source, target, options.keyOf);

  const result: AlignedPair<T>[] = [];
  let sourceCursor = 0;
  let targetCursor = 0;

  for (const anchor of anchors) {
    result.push(
      ...alignGap(
        source.slice(sourceCursor, anchor.sourceIndex),
        target.slice(targetCursor, anchor.targetIndex),
        options,
      ),
    );
    const anchorSource = source[anchor.sourceIndex];
    const anchorTarget = target[anchor.targetIndex];
    if (anchorSource !== undefined && anchorTarget !== undefined) {
      result.push({ source: anchorSource, target: anchorTarget, confidence: 1 });
    }
    sourceCursor = anchor.sourceIndex + 1;
    targetCursor = anchor.targetIndex + 1;
  }

  result.push(...alignGap(source.slice(sourceCursor), target.slice(targetCursor), options));
  return result;
}

interface Anchor {
  sourceIndex: number;
  targetIndex: number;
}

/**
 * Items whose key occurs exactly once on each side, reduced to a
 * non-crossing (increasing) subsequence.
 *
 * Requiring uniqueness is what makes an anchor trustworthy. A key appearing
 * three times ("Read more") says nothing about which instance is which, so
 * those are left to the similarity pass, where surrounding context decides.
 */
function findAnchors<T>(
  source: readonly T[],
  target: readonly T[],
  keyOf: (item: T) => string,
): Anchor[] {
  const sourceCounts = countKeys(source, keyOf);
  const targetPositions = new Map<string, number[]>();
  target.forEach((item, index) => {
    const key = keyOf(item);
    const positions = targetPositions.get(key);
    if (positions) positions.push(index);
    else targetPositions.set(key, [index]);
  });

  const candidates: Anchor[] = [];
  source.forEach((item, sourceIndex) => {
    const key = keyOf(item);
    if (sourceCounts.get(key) !== 1) return;
    const positions = targetPositions.get(key);
    if (!positions || positions.length !== 1) return;
    const targetIndex = positions[0];
    if (targetIndex !== undefined) candidates.push({ sourceIndex, targetIndex });
  });

  return longestIncreasingByTarget(candidates);
}

function countKeys<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Longest increasing subsequence by target index, O(n log n).
 *
 * Candidates are already sorted by source index, so keeping the longest
 * increasing run of target indices drops exactly the anchors that would cross -
 * i.e. genuinely moved content - and keeps the largest consistent skeleton.
 */
function longestIncreasingByTarget(candidates: readonly Anchor[]): Anchor[] {
  if (candidates.length === 0) return [];

  const tailIndices: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);

  for (let i = 0; i < candidates.length; i += 1) {
    const value = candidates[i]?.targetIndex ?? 0;

    let low = 0;
    let high = tailIndices.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const midIndex = tailIndices[mid];
      const midValue = midIndex === undefined ? 0 : (candidates[midIndex]?.targetIndex ?? 0);
      if (midValue < value) low = mid + 1;
      else high = mid;
    }

    if (low > 0) previous[i] = tailIndices[low - 1] ?? -1;
    tailIndices[low] = i;
  }

  const result: Anchor[] = [];
  let cursor = tailIndices[tailIndices.length - 1] ?? -1;
  while (cursor !== -1) {
    const anchor = candidates[cursor];
    if (anchor) result.push(anchor);
    cursor = previous[cursor] ?? -1;
  }
  return result.reverse();
}

/** Needleman-Wunsch over one gap, with a greedy fallback when it is too large. */
function alignGap<T>(
  source: readonly T[],
  target: readonly T[],
  options: AlignOptions<T>,
): AlignedPair<T>[] {
  if (source.length === 0 && target.length === 0) return [];
  if (source.length === 0) return target.map((t) => unmatchedTarget(t));
  if (target.length === 0) return source.map((s) => unmatchedSource(s));

  const maxProduct = options.maxProduct ?? DEFAULT_MAX_PRODUCT;
  if (source.length * target.length > maxProduct) {
    return greedyAlign(source, target, options);
  }

  const rows = source.length + 1;
  const columns = target.length + 1;
  // Flat arrays: a page can produce hundreds of thousands of cells and nested
  // arrays cost noticeably more in both allocation and cache behaviour.
  const scores = new Float64Array(rows * columns);
  const moves = new Uint8Array(rows * columns); // 0 diagonal, 1 up, 2 left

  // A gap costs nothing. Deleting and inserting are exactly what we want to
  // report, so penalising them would push the alignment into pairing unrelated
  // nodes just to avoid a gap - producing confident nonsense.
  for (let i = 1; i < rows; i += 1) moves[i * columns] = 1;
  for (let j = 1; j < columns; j += 1) moves[j] = 2;

  for (let i = 1; i < rows; i += 1) {
    const sourceItem = source[i - 1];
    for (let j = 1; j < columns; j += 1) {
      const targetItem = target[j - 1];
      const score =
        sourceItem === undefined || targetItem === undefined
          ? 0
          : options.similarity(sourceItem, targetItem);

      const diagonal = (scores[(i - 1) * columns + (j - 1)] ?? 0) + score;
      const up = scores[(i - 1) * columns + j] ?? 0;
      const left = scores[i * columns + (j - 1)] ?? 0;

      if (diagonal >= up && diagonal >= left) {
        scores[i * columns + j] = diagonal;
        moves[i * columns + j] = 0;
      } else if (up >= left) {
        scores[i * columns + j] = up;
        moves[i * columns + j] = 1;
      } else {
        scores[i * columns + j] = left;
        moves[i * columns + j] = 2;
      }
    }
  }

  const pairs: AlignedPair<T>[] = [];
  let i = source.length;
  let j = target.length;

  while (i > 0 || j > 0) {
    const move = i === 0 ? 2 : j === 0 ? 1 : (moves[i * columns + j] ?? 0);
    if (move === 0) {
      const sourceItem = source[i - 1];
      const targetItem = target[j - 1];
      if (sourceItem !== undefined && targetItem !== undefined) {
        const confidence = options.similarity(sourceItem, targetItem);
        // Below threshold the two are not the same node; report both as
        // unmatched rather than inventing a pairing nobody would accept.
        if (confidence >= options.threshold) {
          pairs.push({ source: sourceItem, target: targetItem, confidence });
        } else {
          pairs.push(unmatchedTarget(targetItem));
          pairs.push(unmatchedSource(sourceItem));
        }
      }
      i -= 1;
      j -= 1;
    } else if (move === 1) {
      const sourceItem = source[i - 1];
      if (sourceItem !== undefined) pairs.push(unmatchedSource(sourceItem));
      i -= 1;
    } else {
      const targetItem = target[j - 1];
      if (targetItem !== undefined) pairs.push(unmatchedTarget(targetItem));
      j -= 1;
    }
  }

  return pairs.reverse();
}

/** Fallback for pathologically large gaps: exact keys only, in order. */
function greedyAlign<T>(
  source: readonly T[],
  target: readonly T[],
  options: AlignOptions<T>,
): AlignedPair<T>[] {
  const remaining = new Map<string, T[]>();
  for (const item of target) {
    const key = options.keyOf(item);
    const bucket = remaining.get(key);
    if (bucket) bucket.push(item);
    else remaining.set(key, [item]);
  }

  const pairs: AlignedPair<T>[] = [];
  const matched = new Set<T>();

  for (const item of source) {
    const bucket = remaining.get(options.keyOf(item));
    const partner = bucket?.shift();
    if (partner) {
      matched.add(partner);
      pairs.push({ source: item, target: partner, confidence: 1 });
    } else {
      pairs.push(unmatchedSource(item));
    }
  }

  for (const item of target) {
    if (!matched.has(item)) pairs.push(unmatchedTarget(item));
  }
  return pairs;
}

function unmatchedSource<T>(item: T): AlignedPair<T> {
  return { source: item, target: null, confidence: 0 };
}

function unmatchedTarget<T>(item: T): AlignedPair<T> {
  return { source: null, target: item, confidence: 0 };
}
