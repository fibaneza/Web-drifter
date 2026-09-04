import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMatrix } from '../../src/report/html/components.js';
import type { MatrixRow } from '../../src/report/aggregate.js';

/**
 * The device matrix must line its cells up with its headers.
 *
 * The "All sizes" count was interpolated into a `<td>` by a helper that already
 * emitted one, producing `<td><td>...</td></td>`. A browser resolves that by
 * closing the outer cell, so every body row carried one cell more than the
 * header and every column from "All sizes" rightwards was rendered one place
 * out - each page's desktop count appearing under the tablet heading, and so on.
 * Counting cells is the cheap check that catches it.
 */

const row = (overrides: Partial<MatrixRow> = {}): MatrixRow => ({
  path: '/about',
  shared: 2,
  byViewport: { desktop: 1, tablet: 0 },
  total: 3,
  worst: 'error',
  ...overrides,
});

const countTags = (html: string, tag: 'th' | 'td'): number =>
  (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;

function cellCounts(rows: MatrixRow[], viewports: string[]): { head: number; body: number[] } {
  const html = renderMatrix(rows, viewports, '', (path) => `${path}.html`);
  const head = /<thead>[\s\S]*?<\/thead>/.exec(html)?.[0] ?? '';
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';
  const bodyRows = body.split('</tr>').filter((chunk) => chunk.includes('<tr'));

  return {
    head: countTags(head, 'th'),
    body: bodyRows.map((chunk) => countTags(chunk, 'td')),
  };
}

describe('renderMatrix', () => {
  it('gives every body row exactly as many cells as the header', () => {
    const { head, body } = cellCounts([row()], ['desktop', 'tablet']);
    // Page + All sizes + one per viewport + Total.
    assert.equal(head, 5);
    assert.deepEqual(body, [5]);
  });

  it('stays aligned however many viewports there are', () => {
    for (const viewports of [['desktop'], ['desktop', 'tablet', 'mobile-md', 'mobile-sm']]) {
      const { head, body } = cellCounts([row()], viewports);
      assert.deepEqual(body, [head], `misaligned with ${viewports.length} viewport(s)`);
    }
  });

  it('stays aligned across several rows, including zero counts', () => {
    const rows = [
      row(),
      row({ path: '/', shared: 0, byViewport: { desktop: 0, tablet: 0 }, total: 0, worst: null }),
    ];
    const { head, body } = cellCounts(rows, ['desktop', 'tablet']);
    assert.deepEqual(body, [head, head]);
  });

  it('never nests one cell inside another', () => {
    const html = renderMatrix([row()], ['desktop', 'tablet'], '', (path) => `${path}.html`);
    assert.doesNotMatch(html, /<td[^>]*>\s*<td/);
  });

  it('says so plainly when there is nothing to show', () => {
    assert.match(
      renderMatrix([], ['desktop'], '', (path) => path),
      /No page produced a finding/,
    );
  });
});
