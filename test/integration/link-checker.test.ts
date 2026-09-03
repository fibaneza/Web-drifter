import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { LinkChecker } from '../../src/compare/link-checker.js';
import { startFixtureServer } from '../fixtures/server.js';

/**
 * Link checking, over real HTTP.
 *
 * Redirect following is only observable through the network path, and it is
 * exactly what regressed silently: `request({ maxRedirections })` is no longer
 * supported by undici, the checker caught the resulting `InvalidArgumentError`
 * as a network failure, and every external link on every page was reported
 * broken. A unit test over a mocked fetch would not have noticed.
 */

const server = await startFixtureServer({
  site: 'legacy',
  redirects: { '/old': '/about', '/older': '/old' },
});

after(async () => {
  await server.close();
});

async function check(path: string): Promise<ReturnType<LinkChecker['check']>> {
  const checker = new LinkChecker({ timeoutMs: 5000 });
  try {
    return await checker.check(`${server.origin}${path}`);
  } finally {
    await checker.close();
  }
}

describe('LinkChecker', () => {
  it('reports a plain 200 as ok with no redirects', async () => {
    const status = await check('/about');
    assert.equal(status.kind, 'ok');
    assert.equal(status.status, 200);
    assert.equal(status.redirectCount, 0);
  });

  it('follows a redirect and reports where it landed', async () => {
    const status = await check('/old');
    assert.equal(status.kind, 'redirected');
    assert.equal(status.status, 200);
    assert.equal(status.redirectCount, 1);
    assert.match(status.finalUrl ?? '', /\/about$/);
  });

  it('follows a multi-hop redirect chain and counts every hop', async () => {
    const status = await check('/older');
    assert.equal(status.kind, 'redirected');
    assert.equal(status.redirectCount, 2);
    assert.match(status.finalUrl ?? '', /\/about$/);
  });

  it('reports a 404 as broken, not as a network error', async () => {
    const status = await check('/does-not-exist');
    assert.equal(status.kind, 'broken');
    assert.equal(status.status, 404);
  });

  it('reports an unreachable host as an error with a reason', async () => {
    const checker = new LinkChecker({ timeoutMs: 2000 });
    try {
      const status = await checker.check('http://127.0.0.1:1/nothing');
      assert.equal(status.kind, 'error');
      assert.equal(status.status, 0);
      assert.ok((status.reason ?? '').length > 0);
    } finally {
      await checker.close();
    }
  });

  it('caches by URL so a site-wide footer link is requested once', async () => {
    const checker = new LinkChecker({ timeoutMs: 5000 });
    try {
      const url = `${server.origin}/about`;
      const [a, b] = await Promise.all([checker.check(url), checker.check(url)]);
      assert.equal(checker.checkedCount, 1);
      assert.deepEqual(a, b);
    } finally {
      await checker.close();
    }
  });
});
