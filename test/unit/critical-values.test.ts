import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffCriticalValues,
  extractCriticalValues,
  extractModals,
  modalChanged,
} from '../../src/compare/critical-values.js';

/**
 * Telling a rewrite from a revision.
 *
 * Text similarity ranks these the wrong way round: "Fees are non-refundable"
 * against "Fees are refundable" scores 0.83, while "You must renew before the
 * expiry date" against "Renew before it expires" scores 0.69. The dangerous one
 * looks safer. These tests pin the separation that fixes that.
 */

const classesChanged = (a: string, b: string): string[] =>
  diffCriticalValues(a, b).map((change) => change.class);

describe('extractCriticalValues - ordering', () => {
  it('claims a fee as an amount, not also as a bare number', () => {
    // Without ordered claiming every fee change would be reported twice.
    assert.deepEqual(extractCriticalValues('The fee is $49.99'), { amount: ['$49.99'] });
  });

  it('claims a period as a duration, not also as a bare number', () => {
    assert.deepEqual(extractCriticalValues('You have 30 days'), { duration: ['30 days'] });
  });

  it('claims a date as a date', () => {
    assert.deepEqual(extractCriticalValues('Closes 31/03/2026'), { date: ['31/03/2026'] });
  });

  it('still finds a bare number when nothing richer claims it', () => {
    assert.deepEqual(extractCriticalValues('A 10% discount'), { number: ['10%'] });
  });

  it('does not read a month name as a date without a day or year', () => {
    // "may" is a modal far more often than it is a month.
    assert.equal(extractCriticalValues('You may be eligible').date, undefined);
  });
});

describe('extractCriticalValues - classes', () => {
  it('finds contact details', () => {
    assert.deepEqual(extractCriticalValues('Email plates@example.gov.au').contact, [
      'plates@example.gov.au',
    ]);
    assert.deepEqual(extractCriticalValues('Call 1300 555 123 today').contact, ['1300 555 123']);
  });

  it('finds negations, including hyphenated ones', () => {
    assert.deepEqual(extractCriticalValues('Fees are non-refundable').negation, ['non-refundable']);
    assert.deepEqual(extractCriticalValues('You cannot apply').negation, ['cannot']);
  });

  it('sorts values, so moving a fee between sentences is not a change', () => {
    assert.deepEqual(classesChanged('Pay $10 then $20.', 'Pay $20. Later, pay $10.'), []);
  });
});

describe('diffCriticalValues - revisions', () => {
  it('catches a changed fee', () => {
    assert.deepEqual(classesChanged('The fee is $49.99.', 'The fee is $59.99.'), ['amount']);
  });

  it('catches a shortened deadline', () => {
    assert.deepEqual(classesChanged('You have 30 days to pay.', 'You have 14 days to pay.'), [
      'duration',
    ]);
  });

  it('catches a changed date', () => {
    assert.deepEqual(classesChanged('Closes 31/03/2026.', 'Closes 30/04/2026.'), ['date']);
  });

  it('catches a changed phone number', () => {
    assert.deepEqual(classesChanged('Call 1300 555 123.', 'Call 1300 555 999.'), ['contact']);
  });

  it('catches a dropped negation, which inverts the policy', () => {
    assert.deepEqual(classesChanged('Fees are non-refundable.', 'Fees are refundable.'), [
      'negation',
    ]);
  });

  it('reports what moved in each direction', () => {
    const [change] = diffCriticalValues('The fee is $49.99.', 'The fee is $59.99.');
    assert.deepEqual(change?.removed, ['$49.99']);
    assert.deepEqual(change?.added, ['$59.99']);
  });

  it('notices a value that was dropped entirely', () => {
    const [change] = diffCriticalValues('Renew within 12 months.', 'Renew promptly.');
    assert.equal(change?.class, 'duration');
    assert.deepEqual(change?.added, []);
  });
});

describe('diffCriticalValues - rewrites', () => {
  it('stays quiet when only the wording changed', () => {
    assert.deepEqual(
      classesChanged(
        'You must renew your registration before the expiry date.',
        'Renew your registration before it expires.',
      ),
      [],
    );
  });

  it('stays quiet for a full restructure that keeps every value', () => {
    assert.deepEqual(
      classesChanged(
        'You must provide proof of identity when you attend.',
        'Bring proof of identity with you to the appointment.',
      ),
      [],
    );
  });

  it('stays quiet when information is added but nothing changed', () => {
    assert.deepEqual(
      classesChanged('You can renew online.', 'You can renew online using the mobile app.'),
      [],
    );
  });
});

describe('modalChanged', () => {
  it('flags possibility becoming certainty', () => {
    assert.equal(
      modalChanged('You may be eligible for a refund.', 'You are eligible for a refund.'),
      true,
    );
  });

  it('flags an obligation being weakened', () => {
    assert.equal(
      modalChanged('Documents must be certified.', 'Documents should be certified.'),
      true,
    );
  });

  it('flags a requirement becoming optional', () => {
    assert.equal(
      modalChanged(
        'Payment is required before collection.',
        'Payment is optional before collection.',
      ),
      true,
    );
  });

  it('ignores a modal lost to an imperative rewrite', () => {
    // The half that stops this being a false-positive machine: the sentence was
    // restructured, so the missing modal says nothing on its own.
    assert.equal(
      modalChanged(
        'You must renew your registration before the expiry date.',
        'Renew your registration before it expires.',
      ),
      false,
    );
  });

  it('ignores an unchanged modal', () => {
    assert.equal(modalChanged('You can renew online.', 'You can renew online today.'), false);
  });

  it('reads modals out of text', () => {
    assert.deepEqual(extractModals('You must pay and may appeal.'), ['may', 'must']);
  });
});
