import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parsePrice, buildPriceRecords } from '../../src/extract/prices.js';
import type { RawPriceCandidate } from '../../src/extract/browser-extract.js';

describe('parseAmount', () => {
  it('parses plain numbers', () => {
    assert.equal(parseAmount('1299'), 1299);
    assert.equal(parseAmount('12.99'), 12.99);
  });

  it('parses UK/US grouping', () => {
    assert.equal(parseAmount('1,299.00'), 1299);
    assert.equal(parseAmount('1,234,567.89'), 1234567.89);
  });

  it('parses EU grouping, where the separators are swapped', () => {
    assert.equal(parseAmount('1.299,00'), 1299);
    assert.equal(parseAmount('1.234.567,89'), 1234567.89);
  });

  it('treats spaces as thousands separators', () => {
    assert.equal(parseAmount('1 299,00'), 1299);
    assert.equal(parseAmount('1 234 567.89'), 1234567.89);
  });

  it('resolves the ambiguous single-separator case by digit count', () => {
    // Three trailing digits is a thousands group...
    assert.equal(parseAmount('1,299'), 1299);
    assert.equal(parseAmount('1.299'), 1299);
    // ...one or two is a decimal fraction.
    assert.equal(parseAmount('12,99'), 12.99);
    assert.equal(parseAmount('12.9'), 12.9);
  });

  it('handles negatives', () => {
    assert.equal(parseAmount('-12.50'), -12.5);
  });

  it('returns null when there is no number', () => {
    assert.equal(parseAmount('Price on application'), null);
    assert.equal(parseAmount(''), null);
  });

  it('is not confused by a currency code sitting next to the number', () => {
    assert.equal(parseAmount('USD 1 299,00'), 1299);
    assert.equal(parseAmount('1299.00 EUR'), 1299);
  });
});

describe('parsePrice', () => {
  it('reads the currency from a symbol', () => {
    assert.deepEqual(parsePrice('$1,299.00'), {
      amount: 1299,
      currency: 'USD',
      raw: '$1,299.00',
    });
    assert.equal(parsePrice('£49.99')?.currency, 'GBP');
    assert.equal(parsePrice('€19,90')?.currency, 'EUR');
  });

  it('reads the currency from an ISO code, which beats a symbol', () => {
    assert.equal(parsePrice('USD 1 299,00')?.currency, 'USD');
    assert.equal(parsePrice('1299 GBP')?.currency, 'GBP');
  });

  it('prefers an explicit hint from JSON-LD or microdata', () => {
    assert.equal(parsePrice('1299.00', 'EUR')?.currency, 'EUR');
    assert.equal(parsePrice('$1299.00', 'CAD')?.currency, 'CAD');
  });

  it('treats differently-formatted identical prices as equal', () => {
    // The whole point: a legacy CMS and an Intl.NumberFormat rewrite render the
    // same price differently, and that must not be reported as a value change.
    const legacy = parsePrice('$1,299.00');
    const modern = parsePrice('USD 1 299,00');
    assert.equal(legacy?.amount, modern?.amount);
    assert.equal(legacy?.currency, modern?.currency);
  });

  it('returns null when no amount is recoverable', () => {
    assert.equal(parsePrice('From'), null);
  });

  it('leaves currency null when nothing indicates one', () => {
    assert.equal(parsePrice('1299')?.currency, null);
  });
});

describe('buildPriceRecords', () => {
  const candidate = (over: Partial<RawPriceCandidate>): RawPriceCandidate => ({
    raw: '$10.00',
    source: 'text',
    region: 'main',
    context: 'Widget',
    ...over,
  });

  it('drops candidates with no parseable amount', () => {
    const records = buildPriceRecords([
      candidate({ raw: 'Price on application' }),
      candidate({ raw: '$10.00' }),
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.amount, 10);
  });

  it('collapses the same price found by several sources, keeping the best', () => {
    // JSON-LD and the rendered text describe one fact, not two.
    const records = buildPriceRecords([
      candidate({ raw: '10.00', source: 'jsonld', currency: 'USD' }),
      candidate({ raw: '$10.00', source: 'text' }),
    ]);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.source, 'jsonld', 'the most reliable source should win');
    assert.equal(records[0]?.currency, 'USD');
  });

  it('keeps genuinely different prices apart', () => {
    const records = buildPriceRecords([
      candidate({ raw: '$10.00', context: 'Widget' }),
      candidate({ raw: '$20.00', context: 'Gadget' }),
    ]);
    assert.equal(records.length, 2);
  });
});
