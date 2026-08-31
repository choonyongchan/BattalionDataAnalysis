/**
 * Tests for the parade-state signature matcher.
 *
 * The positive cases in the "first parade gate" block are well-formed parade states
 * built around one header under test. The negative cases are the chatter that must
 * never reach the spreadsheet.
 */

import { describe, expect, test } from 'bun:test';
import { isFirstParade, isParadeState } from '../src/signature.js';

describe('isParadeState - chatter', () => {
  /** @type {Array<[string, string]>} Label and text of each rejected message. */
  const negatives = [
    ['the stated near-miss', 'Why is your parade state late?'],
    ['a greeting', 'Hi!'],
    ['an empty string', ''],
    ['whitespace only', '   \n\n  '],
    ['a chase-up with the phrase', 'Braves, please send your parade state by 0730 tomorrow. Thanks!'],
    [
      'a long chat message without the anchor',
      Array.from({ length: 20 }, (_, i) => `Line ${i}: reminder about tomorrow's admin timings and transport.`).join('\n'),
    ],
    [
      'a long message with the anchor but no structure',
      Array.from({ length: 20 }, () => 'Reminder to submit the parade state on time please.').join('\n'),
    ],
  ];

  for (const [label, text] of negatives) {
    test(`rejects ${label}`, () => {
      const result = isParadeState(text);
      expect(result.accepted).toBe(false);
      expect(result.rejectReason).toBeString();
    });
  }

  test('rejects non-string input', () => {
    expect(isParadeState(null).accepted).toBe(false);
    expect(isParadeState(undefined).accepted).toBe(false);
    expect(isParadeState(42).accepted).toBe(false);
  });
});

describe('isParadeState - verdict shape', () => {
  test('explains why a near-miss was rejected', () => {
    const result = isParadeState('Why is your parade state late?');
    expect(result.rejectReason).toContain('too few lines');
  });
});

describe('isParadeState - first parade gate', () => {
  /**
   * Builds a well-formed parade state around a given header.
   *
   * The body carries enough signals and bulk to clear every other gate, so the
   * verdict turns purely on the header.
   *
   * @param {string} header The header lines under test.
   * @returns {string} A complete parade-state message.
   */
  function withHeader(header) {
    return [
      header,
      '',
      'TOTAL STRENGTH: 136',
      'CURRENT STRENGTH: 120',
      'PLATOON 1: 51/55',
      'PLATOON 2: 49/56',
      'COMMANDERS: 20/25',
      '[OFFICER]: 05/07',
      'CDO: 2LT TERENCE LEE',
      'CDS: 3SG KWOH KAI JIE',
      'Padding line to clear the character gate comfortably for this test case.',
    ].join('\n');
  }

  test('accepts an explicit FIRST PARADE STATE header', () => {
    expect(isParadeState(withHeader('COUGAR COMPANY FIRST PARADE STATE\nDATE: 220626 @ 1400 Hrs')).accepted).toBe(true);
  });

  test('accepts a bare "FIRST PARADE" marker', () => {
    expect(isParadeState(withHeader('PARADE STATE FOR 220626\nSTALLION COY FIRST PARADE')).accepted).toBe(true);
  });

  test('accepts an unlabelled session with a morning timing', () => {
    expect(isParadeState(withHeader('40 SAR BRAVES COMPANY PARADE STATE\n220626 FP 0738')).accepted).toBe(true);
  });

  test('rejects a last parade state', () => {
    const result = isParadeState(withHeader('40 SAR BRAVES COMPANY LAST PARADE STATE\n220626 LP 1830'));
    expect(result.accepted).toBe(false);
    expect(result.rejectReason).toContain('first parade state');
  });

  test('rejects an unlabelled session with an afternoon timing', () => {
    expect(isParadeState(withHeader('COUGAR COMPANY PARADE STATE\nDATE: 220626 @ 1730 Hrs')).accepted).toBe(false);
  });

  test('rejects an unlabelled session with no timing at all', () => {
    expect(isParadeState(withHeader('COUGAR COMPANY PARADE STATE\nDATE: 220626')).accepted).toBe(false);
  });
});

describe('first parade timing extraction', () => {
  test('does not read a timing out of a DDMMYY date', () => {
    expect(isFirstParade('PARADE STATE\n220626\nCDO: 2LT LEE')).toBe(false);
  });

  test('reads a timing glued to its suffix', () => {
    expect(isFirstParade('PARADE STATE\nCAA 220626, 0930HRS')).toBe(true);
  });

  test('reads a timing separated from its suffix', () => {
    expect(isFirstParade('PARADE STATE\nCAA 220626, 0930 HRS')).toBe(true);
  });

  test('treats noon itself as not a first parade', () => {
    expect(isFirstParade('PARADE STATE\nCAA 220626, 1200 HRS')).toBe(false);
    expect(isFirstParade('PARADE STATE\nCAA 220626, 1159 HRS')).toBe(true);
  });

  test('ignores timings below the header block', () => {
    const text = ['PARADE STATE', 'line 2', 'line 3', 'line 4', 'line 5', '0730'].join('\n');
    expect(isFirstParade(text)).toBe(false);
  });
});
