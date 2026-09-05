import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIN_SHIFT_PX,
  boxShift,
  isVisualMark,
  selectVisualMarks,
} from '../../src/report/visual-select.js';
import type { BoxGeometry, Finding, FindingCategory } from '../../src/core/types.js';

/**
 * What earns a box on the visual map.
 *
 * The rule is "would a person looking at the rendered page see it", which is
 * narrower than "did something change". Three things are excluded on purpose -
 * typography, invisible markup, and movement too small to perceive - and each
 * exclusion is worth pinning, because widening any of them quietly turns the
 * map from a handful of things to look at into a page of boxes.
 */

const box = (overrides: Partial<BoxGeometry> = {}): BoxGeometry => ({
  x: 10,
  y: 20,
  width: 200,
  height: 40,
  ...overrides,
});

function finding(
  category: FindingCategory,
  overrides: Partial<Finding> & { details?: Record<string, unknown> } = {},
): Finding {
  return {
    id: 'f1',
    category,
    severity: 'error',
    path: '/about',
    label: 'something changed',
    confidence: 1,
    details: { sourceBox: box(), targetBox: box() },
    ...overrides,
  };
}

describe('isVisualMark - categories', () => {
  it('marks content, image and price differences', () => {
    for (const category of [
      'content.drift',
      'content.value-drift',
      'content.missing',
      'content.added',
      'content.order-changed',
      'image.missing',
      'image.size-drift',
      'price.value-drift',
      'price.format-drift',
    ] as FindingCategory[]) {
      assert.ok(isVisualMark(finding(category)), `${category} should be marked`);
    }
  });

  it('does not mark differences nobody can see on the page', () => {
    // alt text and link targets are real findings and belong in the report -
    // just not as a box drawn over a screenshot.
    for (const category of [
      'image.alt-drift',
      'link.broken',
      'link.path-mismatch',
      'page.status-mismatch',
      'page.redirected',
    ] as FindingCategory[]) {
      assert.equal(isVisualMark(finding(category)), false, `${category} should not be marked`);
    }
  });
});

describe('isVisualMark - CSS properties', () => {
  it('marks colour drift', () => {
    for (const property of ['color', 'background-color', 'border-top-color', 'opacity']) {
      assert.ok(
        isVisualMark(finding('css.property-drift', { facet: property })),
        `${property} should be marked`,
      );
    }
  });

  it('marks appearance effects', () => {
    for (const property of ['box-shadow', 'background-image', 'transform', 'filter']) {
      assert.ok(
        isVisualMark(finding('css.property-drift', { facet: property })),
        `${property} should be marked`,
      );
    }
  });

  it('does not mark typography, however real the drift', () => {
    for (const property of ['font-family', 'font-size', 'letter-spacing', 'line-height']) {
      assert.equal(
        isVisualMark(finding('css.property-drift', { facet: property })),
        false,
        `${property} should not be marked`,
      );
    }
  });

  it('does not mark spacing, which arrives again as layout drift with a box', () => {
    for (const property of ['margin-top', 'padding-left', 'border-top-width']) {
      assert.equal(isVisualMark(finding('css.property-drift', { facet: property })), false);
    }
  });

  it('does not mark a property that cannot appear in a screenshot', () => {
    assert.equal(isVisualMark(finding('css.property-drift', { facet: 'cursor' })), false);
  });
});

describe('isVisualMark - thresholds', () => {
  it('ignores movement below the shift threshold', () => {
    const moved = finding('css.layout-drift', {
      details: { sourceBox: box(), targetBox: box({ y: 21 }) },
    });
    assert.equal(isVisualMark(moved), false);
  });

  it('marks movement at or above the threshold', () => {
    const moved = finding('css.layout-drift', {
      details: { sourceBox: box(), targetBox: box({ y: 20 + DEFAULT_MIN_SHIFT_PX }) },
    });
    assert.ok(isVisualMark(moved));
  });

  it('does not apply the shift threshold to a stationary colour change', () => {
    // A recoloured element has moved zero pixels and must still be marked.
    const recoloured = finding('css.property-drift', {
      facet: 'background-color',
      details: { sourceBox: box(), targetBox: box() },
    });
    assert.ok(isVisualMark(recoloured));
  });

  it('ignores a box too small to point at', () => {
    const speck = finding('content.drift', {
      details: { sourceBox: box({ width: 4, height: 4 }), targetBox: box({ width: 4, height: 4 }) },
    });
    assert.equal(isVisualMark(speck), false);
  });

  it('honours caller-supplied thresholds', () => {
    const moved = finding('css.layout-drift', {
      details: { sourceBox: box(), targetBox: box({ y: 24 }) },
    });
    assert.equal(isVisualMark(moved, { minShiftPx: 100 }), false);
    assert.ok(isVisualMark(moved, { minShiftPx: 2 }));
  });
});

describe('isVisualMark - geometry', () => {
  it('needs somewhere to draw the box', () => {
    assert.equal(isVisualMark(finding('content.drift', { details: {} })), false);
  });

  it('accepts a one-sided box, which is what a missing element looks like', () => {
    const missing = finding('content.missing', { details: { sourceBox: box() } });
    assert.ok(isVisualMark(missing));
  });

  it('rejects a zero-area box', () => {
    const collapsed = finding('content.drift', { details: { sourceBox: box({ height: 0 }) } });
    assert.equal(isVisualMark(collapsed), false);
  });
});

describe('boxShift', () => {
  it('reports the largest edge movement', () => {
    assert.equal(boxShift(box(), box({ x: 12, y: 26 })), 6);
    assert.equal(boxShift(box(), box({ width: 260 })), 60);
  });

  it('treats a one-sided pair as maximally different', () => {
    assert.equal(boxShift(box(), null), Number.POSITIVE_INFINITY);
  });
});

describe('selectVisualMarks', () => {
  it('orders by severity so a cap never discards an error', () => {
    const findings: Finding[] = [
      finding('content.drift', { id: 'info', severity: 'info' }),
      finding('content.drift', { id: 'error', severity: 'error' }),
      finding('content.drift', { id: 'warning', severity: 'warning' }),
    ];

    assert.deepEqual(
      selectVisualMarks(findings).map((f) => f.id),
      ['error', 'warning', 'info'],
    );
    assert.deepEqual(
      selectVisualMarks(findings, { max: 1 }).map((f) => f.id),
      ['error'],
    );
  });

  it('drops everything unmarkable', () => {
    const findings = [finding('link.broken'), finding('image.alt-drift')];
    assert.deepEqual(selectVisualMarks(findings), []);
  });
});
