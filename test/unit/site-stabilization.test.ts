import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../src/config/load.js';
import { stabilizationFor } from '../../src/config/schema.js';

/**
 * Per-side timing.
 *
 * A legacy server-rendered CMS and a React rewrite need different budgets: the
 * rewrite hydrates late and must be waited for, and making the legacy side pay
 * that wait on every page costs hours on a large crawl. Only the timing fields
 * are overridable - locale, timezone and the clock freeze stay global, because
 * a per-side difference there would quietly make the comparison unfair.
 */

const base = {
  source: { name: 'legacy', baseUrl: 'https://legacy.test' },
  target: { name: 'react', baseUrl: 'https://new.test' },
};

describe('stabilizationFor', () => {
  it('returns the global settings when a side overrides nothing', () => {
    const config = parseConfig(base);
    assert.equal(stabilizationFor(config, 'source'), config.stabilization);
    assert.equal(stabilizationFor(config, 'target'), config.stabilization);
  });

  it('applies an override to that side only', () => {
    const config = parseConfig({
      ...base,
      target: { ...base.target, stabilization: { awaitFirstRenderMs: 3000 } },
    });

    assert.equal(stabilizationFor(config, 'target').awaitFirstRenderMs, 3000);
    assert.equal(stabilizationFor(config, 'source').awaitFirstRenderMs, 1000);
  });

  it('merges field by field, keeping every global value left unset', () => {
    const config = parseConfig({
      ...base,
      stabilization: { quietMs: 700, readyTimeoutMs: 20_000 },
      target: { ...base.target, stabilization: { awaitFirstRenderMs: 3000 } },
    });

    const target = stabilizationFor(config, 'target');
    assert.equal(target.awaitFirstRenderMs, 3000);
    assert.equal(target.quietMs, 700);
    assert.equal(target.readyTimeoutMs, 20_000);
  });

  it('keeps a React readiness selector on the target only', () => {
    const config = parseConfig({
      ...base,
      target: { ...base.target, stabilization: { readySelector: '[data-route-ready]' } },
    });

    assert.equal(stabilizationFor(config, 'target').readySelector, '[data-route-ready]');
    assert.equal(stabilizationFor(config, 'source').readySelector, undefined);
  });

  it('carries per-side slowPages rules', () => {
    const config = parseConfig({
      ...base,
      target: {
        ...base.target,
        stabilization: { slowPages: [{ pattern: '^/search', readyTimeoutMs: 60_000 }] },
      },
    });

    assert.equal(stabilizationFor(config, 'target').slowPages.length, 1);
    assert.equal(stabilizationFor(config, 'source').slowPages.length, 0);
  });

  it('does not let a side override the settings that must match', () => {
    // locale, timezoneId and the freezes are deliberately absent from the
    // per-side schema; `.strict()` turns an attempt into a config error rather
    // than a silently unfair comparison.
    assert.throws(() =>
      parseConfig({
        ...base,
        target: { ...base.target, stabilization: { locale: 'fr-FR' } },
      }),
    );
  });

  it('rejects a nonsensical override value', () => {
    assert.throws(() =>
      parseConfig({
        ...base,
        target: { ...base.target, stabilization: { quietMs: -1 } },
      }),
    );
  });
});
