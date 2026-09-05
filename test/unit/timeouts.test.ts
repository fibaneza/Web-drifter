import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveTimeouts } from '../../src/crawl/timeouts.js';

describe('resolveTimeouts', () => {
  it('uses a matching route selector ahead of the side default', () => {
    const resolved = resolveTimeouts(
      '/application/renew',
      {
        navigationTimeoutMs: 10_000,
        readyTimeoutMs: 30_000,
        quietMs: 500,
        awaitFirstRenderMs: 1000,
        readySelector: '[data-app-ready]',
      },
      [{ pattern: /^\/application\//, readySelector: '[data-application-ready]' }],
    );

    assert.equal(resolved.readySelector, '[data-application-ready]');
  });
});
