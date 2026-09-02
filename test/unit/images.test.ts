import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { imageAssetKey } from '../../src/extract/images.js';

const PAGE = 'https://legacy.example.com/products';

describe('imageAssetKey', () => {
  it('reduces a plain URL to its filename stem', () => {
    assert.equal(imageAssetKey('https://a.test/img/hero.jpg'), 'hero');
    assert.equal(imageAssetKey('/img/hero.png', PAGE), 'hero');
  });

  it('ignores the host, which always differs between environments', () => {
    assert.equal(
      imageAssetKey('https://legacy.example.com/img/hero.jpg'),
      imageAssetKey('https://cdn.new-example.com/assets/hero.jpg'),
    );
  });

  it('ignores the extension, so a png -> webp conversion still matches', () => {
    assert.equal(imageAssetKey('/img/hero.png', PAGE), imageAssetKey('/img/hero.webp', PAGE));
  });

  it('strips build content hashes, which change on every deploy', () => {
    assert.equal(imageAssetKey('/static/hero.a1b2c3d4.png', PAGE), 'hero');
    assert.equal(imageAssetKey('/static/hero-9f8e7d6c5b4a.webp', PAGE), 'hero');
    assert.equal(imageAssetKey('/static/hero.png', PAGE), 'hero');
  });

  it('unwraps a Next.js image proxy', () => {
    const proxied = '/_next/image?url=%2Fimg%2Fhero.a1b2c3d4.webp&w=828&q=75';
    assert.equal(imageAssetKey(proxied, PAGE), 'hero');
  });

  it('drops CDN transform segments', () => {
    assert.equal(
      imageAssetKey('https://res.cloudinary.com/demo/image/upload/w_300,c_fill/hero.jpg'),
      imageAssetKey('https://res.cloudinary.com/demo/image/upload/hero.jpg'),
    );
  });

  it('ignores resizing query parameters', () => {
    assert.equal(
      imageAssetKey('/-/media/root/hero.ashx?h=400&w=800', PAGE),
      imageAssetKey('/img/hero.jpg', PAGE),
    );
  });

  it('matches a Sitecore media path against a modern static path', () => {
    // The exact scenario this exists for.
    assert.equal(
      imageAssetKey('https://legacy.example.com/-/media/images/hero.ashx?w=1200', PAGE),
      imageAssetKey('https://new.example.com/_next/image?url=%2Fhero.1a2b3c4d.webp&w=1200', PAGE),
    );
  });

  it('keeps genuinely different images apart', () => {
    assert.notEqual(imageAssetKey('/img/hero.jpg', PAGE), imageAssetKey('/img/banner.jpg', PAGE));
  });

  it('handles data URIs without throwing', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    assert.equal(imageAssetKey(uri), imageAssetKey(uri));
    assert.ok(imageAssetKey(uri).startsWith('data:'));
  });

  it('handles empty and malformed input', () => {
    assert.equal(imageAssetKey(''), '');
    assert.equal(imageAssetKey('   '), '');
    assert.doesNotThrow(() => imageAssetKey('not a url at all'));
  });

  it('does not loop on a self-referential proxy URL', () => {
    const selfRef =
      'https://a.test/_next/image?url=https%3A%2F%2Fa.test%2F_next%2Fimage%3Furl%3Dx.png';
    assert.doesNotThrow(() => imageAssetKey(selfRef));
  });
});
