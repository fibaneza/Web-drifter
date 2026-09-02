import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEnvOverrides } from '../../src/config/load.js';

const base = (): Record<string, unknown> => ({
  source: { name: 'legacy', baseUrl: 'https://legacy.example.com' },
  target: { name: 'modern', baseUrl: 'https://new.example.com' },
  output: { dir: 'drifter-out' },
  crawl: { maxPages: 1000, concurrency: 4 },
});

describe('applyEnvOverrides', () => {
  it('leaves the config alone when nothing is set', () => {
    assert.deepEqual(applyEnvOverrides(base(), {}), base());
  });

  it('points the same committed config at a different pair of environments', () => {
    const result = applyEnvOverrides(base(), {
      DRIFTER_SOURCE_BASE_URL: 'https://legacy-staging.example.com',
      DRIFTER_TARGET_BASE_URL: 'https://preview-123.example.com',
    });
    assert.deepEqual(result['source'], {
      name: 'legacy',
      baseUrl: 'https://legacy-staging.example.com',
    });
    assert.deepEqual(result['target'], {
      name: 'modern',
      baseUrl: 'https://preview-123.example.com',
    });
  });

  it('preserves the other fields of the object it overrides', () => {
    const result = applyEnvOverrides(base(), { DRIFTER_MAX_PAGES: '25' });
    assert.deepEqual(result['crawl'], { maxPages: 25, concurrency: 4 });
  });

  it('treats a blank value as unset', () => {
    // A pipeline parameter left empty must not blank out the configured URL
    // and fail schema validation with a confusing message.
    const result = applyEnvOverrides(base(), {
      DRIFTER_SOURCE_BASE_URL: '',
      DRIFTER_TARGET_BASE_URL: '   ',
    });
    assert.deepEqual(result, base());
  });

  it('ignores a non-numeric page cap rather than corrupting the config', () => {
    const result = applyEnvOverrides(base(), { DRIFTER_MAX_PAGES: 'lots' });
    assert.deepEqual(result['crawl'], { maxPages: 1000, concurrency: 4 });
  });

  it('does not mutate the input', () => {
    const input = base();
    applyEnvOverrides(input, { DRIFTER_OUT_DIR: '/tmp/elsewhere' });
    assert.deepEqual(input, base());
  });
});
