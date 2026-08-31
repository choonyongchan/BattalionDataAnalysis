/**
 * Tests for the eval scorer itself — no API calls, so this runs under `bun test`.
 *
 * A scorer is a measuring instrument, and an instrument that always reads 100% is worse
 * than none: it would bless the cheapest model on the list and the decision would look
 * evidence-based. So these tests check both directions — a perfect extraction scores
 * perfectly, and each kind of error is actually caught and charged to the right tier.
 */

import { describe, expect, test } from 'bun:test';
import { loadExamples, normalise, personnelKey, scoreExample, TIERS } from './parser.eval.js';

/** @type {!Array<!Object>} All five labelled examples. */
const EXAMPLES = loadExamples(null);

/**
 * Deep-copies a labelled extraction so a test can corrupt it safely.
 * @param {!Object} gold The extraction to copy.
 * @returns {!Object} The copy.
 */
function copy(gold) {
  return JSON.parse(JSON.stringify(gold));
}

/**
 * Scores an extraction against a labelled one.
 * @param {!Object} got The extraction under test.
 * @param {!Object} gold The labelled extraction.
 * @returns {!Object} The score.
 */
function score(got, gold) {
  return scoreExample('test', got, gold);
}

describe('a perfect extraction scores perfectly', () => {
  test.each(EXAMPLES.map((example) => [example.name, example]))('%s scored against itself', (_name, example) => {
    const result = score(copy(example.gold), example.gold);
    TIERS.forEach(({ tier }) => {
      // null means nothing was scored at that tier, which is fine for an example with
      // no personnel; a rate below 1 is not.
      const rate = result.rate(tier);
      expect(rate === null || rate === 1).toBe(true);
    });
  });

  test('scores something at every tier across the full set, so no tier is dead', () => {
    // If a tier never accumulates a single comparison, its bar is decorative.
    const totals = {};
    TIERS.forEach(({ tier }) => (totals[tier] = 0));
    EXAMPLES.forEach((example) => {
      const result = score(copy(example.gold), example.gold);
      TIERS.forEach(({ tier }) => (totals[tier] += result.tiers[tier].total));
    });
    TIERS.forEach(({ tier }) => expect(totals[tier]).toBeGreaterThan(0));
  });
});

describe('identity errors are caught at tier 1', () => {
  /** @type {!Object} A labelled example with everything populated. */
  const gold = EXAMPLES.find((example) => example.name === 'hercules').gold;

  test.each([['company', 'Braves'], ['date', '2026-06-23'], ['session', 'LPS']])(
    'a wrong %s',
    (field, wrong) => {
      const got = copy(gold);
      got[field] = wrong;
      const result = score(got, gold);
      expect(result.rate(1)).toBeLessThan(1);
      expect(result.tiers[1].misses.join(' ')).toContain(field);
    }
  );

  test('a null identity field', () => {
    const got = copy(gold);
    got.company = null;
    expect(score(got, gold).rate(1)).toBeLessThan(1);
  });
});

describe('strength errors are caught at tier 2', () => {
  const gold = EXAMPLES.find((example) => example.name === 'cougar').gold;

  test('a misread headcount', () => {
    const got = copy(gold);
    got.platoons[0].total_present = 121;
    const result = score(got, gold);
    expect(result.rate(2)).toBeLessThan(1);
    expect(result.tiers[2].misses.join(' ')).toContain('total_present');
  });

  test('a dropped platoon row', () => {
    const got = copy(gold);
    got.platoons.pop();
    const result = score(got, gold);
    expect(result.rate(2)).toBeLessThan(1);
    expect(result.tiers[2].misses.join(' ')).toContain('missing entirely');
  });

  test('an invented platoon row', () => {
    const got = copy(gold);
    got.platoons.push({ ...got.platoons[1], platoon: '9' });
    const result = score(got, gold);
    expect(result.rate(2)).toBeLessThan(1);
    expect(result.tiers[2].misses.join(' ')).toContain('invented');
  });

  test('a wrong unit_type is tier 4, not tier 2 — wrong but correctable', () => {
    const got = copy(gold);
    got.platoons[1].unit_type = 'HQ';
    const result = score(got, gold);
    expect(result.rate(2)).toBe(1);
    expect(result.rate(4)).toBeLessThan(1);
  });
});

describe('personnel errors are caught at the right tier', () => {
  const gold = EXAMPLES.find((example) => example.name === 'cougar').gold;

  test('a dropped person costs tier 3', () => {
    const got = copy(gold);
    got.personnel.splice(0, 1);
    const result = score(got, gold);
    expect(result.rate(3)).toBeLessThan(1);
    expect(result.tiers[3].misses.join(' ')).toContain('dropped');
  });

  test('an invented person costs tier 3', () => {
    const got = copy(gold);
    got.personnel.push({ ...got.personnel[0], name: 'NOBODY AT ALL' });
    const result = score(got, gold);
    expect(result.rate(3)).toBeLessThan(1);
    expect(result.tiers[3].misses.join(' ')).toContain('invented');
  });

  test('a failure to split a multi-status person costs tier 3', () => {
    // The discriminating case: one person, two concurrent statuses, two rows expected.
    const twoStatuses = {
      ...gold,
      personnel: [
        { ...gold.personnel[0], name: 'KEVIN NG', reason: 'Excuse Heavy Loads' },
        { ...gold.personnel[0], name: 'KEVIN NG', reason: 'Excuse Kneeling' },
      ],
    };
    const merged = { ...twoStatuses, personnel: [twoStatuses.personnel[0]] };

    expect(score(merged, twoStatuses).rate(3)).toBeLessThan(1);
    expect(score(copy(twoStatuses), twoStatuses).rate(3)).toBe(1);
  });

  test.each(['reason_category', 'start_date', 'end_date', 'num_days', 'four_d', 'rank'])(
    'a wrong %s costs tier 4, not tier 3',
    (field) => {
      const got = copy(gold);
      got.personnel[0][field] = field === 'num_days' ? 99 : 'WRONG';
      const result = score(got, gold);
      expect(result.rate(3)).toBe(1);
      expect(result.rate(4)).toBeLessThan(1);
    }
  );

  test('a paraphrased reason costs tier 5 but keeps the person found', () => {
    // Prose has no single right phrasing, so it must not read as a dropped person.
    const got = copy(gold);
    got.personnel[0].reason = 'MC for nausea and diarrhoea';
    const result = score(got, gold);
    expect(result.rate(3)).toBe(1);
    expect(result.rate(5)).toBeLessThan(1);
  });

  test('an inferred in_camp costs only tier 5', () => {
    // The exact error the gold audit removed 35 of; it must be visible but not fatal.
    const got = copy(gold);
    got.personnel.forEach((person) => {
      person.in_camp = true;
    });
    const result = score(got, gold);
    expect(result.rate(3)).toBe(1);
    expect(result.rate(4)).toBe(1);
    expect(result.rate(5)).toBeLessThan(1);
  });
});

describe('normalisation does not hide real errors', () => {
  test.each([
    ['null and empty string are both absent', null, ''],
    ['null and undefined are both absent', null, undefined],
    ['a numeric string matches its integer', 28, '28'],
    ['surrounding whitespace is ignored', 'MC', '  MC  '],
  ])('%s', (_label, a, b) => {
    expect(normalise(a)).toBe(normalise(b));
  });

  test.each([
    ['0 is not absent', 0, null],
    ['false is not absent', false, null],
    ['a different number', 28, 29],
    ['different text', 'MC', 'LD'],
    ['case differs', 'MC', 'mc'],
  ])('%s', (_label, a, b) => {
    expect(normalise(a)).not.toBe(normalise(b));
  });
});

describe('the personnel match key', () => {
  test('ignores case and surrounding whitespace in both parts', () => {
    expect(personnelKey({ name: ' tan ah kow ', reason: ' mc ' })).toBe(
      personnelKey({ name: 'TAN AH KOW', reason: 'MC' })
    );
  });

  test('separates two statuses held by the same person', () => {
    expect(personnelKey({ name: 'ZHAN', reason: 'Excuse Kneeling' })).not.toBe(
      personnelKey({ name: 'ZHAN', reason: 'Excuse Heavy Loads' })
    );
  });

  test('survives a missing name or reason without throwing', () => {
    expect(() => personnelKey({})).not.toThrow();
  });
});
