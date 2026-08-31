/**
 * Tests for turning raw Sheets API values into typed records.
 *
 * The cases worth having are the ones that would otherwise fail silently: a renamed
 * column read as the wrong field, a short row read as missing data, and a date read a
 * day out because the viewer is west of Singapore.
 */

import { describe, expect, test } from 'bun:test';
import {
  addDays,
  inclusiveDaySpan,
  indexHeaders,
  normaliseName,
  toIsoDate,
  toNumber,
  toRecords,
  toText,
  weekdayOf,
} from '../../dashboard/js/model/normalize.js';

describe('header resolution', () => {
  test('resolves columns by name, not position', () => {
    const index = indexHeaders(['session', 'date', 'company'], ['date', 'company'], 'Tab');
    expect(index.date).toBe(1);
    expect(index.company).toBe(2);
  });

  test('a missing column throws, naming the tab and the column', () => {
    expect(() => indexHeaders(['date'], ['date', 'reason'], 'Personnel Data')).toThrow(
      /Personnel Data.*"reason"/
    );
  });

  test('the error names every missing column at once', () => {
    expect(() => indexHeaders([], ['date', 'reason'], 'Personnel Data')).toThrow(
      /columns "date", "reason"/
    );
  });

  test('surrounding whitespace in a header does not hide it', () => {
    expect(indexHeaders(['  date  '], ['date'], 'Tab').date).toBe(0);
  });
});

describe('record mapping', () => {
  test('maps rows to objects keyed by header', () => {
    const values = [
      ['date', 'company'],
      ['2026-06-22', 'Cougar'],
    ];
    expect(toRecords(values, ['date', 'company'], 'Tab')).toEqual([
      { date: '2026-06-22', company: 'Cougar' },
    ]);
  });

  test('a row the API truncated reads as blank, not as an error', () => {
    const values = [
      ['date', 'company', 'reason'],
      ['2026-06-22'],
    ];
    expect(toRecords(values, ['date', 'reason'], 'Tab')).toEqual([
      { date: '2026-06-22', reason: '' },
    ]);
  });

  test('an empty tab yields no records', () => {
    expect(toRecords([], ['date'], 'Tab')).toEqual([]);
  });
});

describe('dates', () => {
  test('an ISO string is read as written', () => {
    expect(toIsoDate('2026-06-22')).toBe('2026-06-22');
  });

  test('a Sheets serial number is read as the same calendar date', () => {
    expect(toIsoDate(46195)).toBe('2026-06-22');
  });

  test('a serial with a time fraction keeps its date', () => {
    expect(toIsoDate(46195.75)).toBe('2026-06-22');
  });

  test('a blank or unparseable cell is null, not today', () => {
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('not a date')).toBeNull();
  });

  test('a one-day absence spans one day, not zero', () => {
    expect(inclusiveDaySpan('2026-06-22', '2026-06-22')).toBe(1);
    expect(inclusiveDaySpan('2026-06-20', '2026-06-23')).toBe(4);
  });

  test('day arithmetic crosses a month boundary correctly', () => {
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDays('2026-07-01', -1)).toBe('2026-06-30');
  });

  test('weekdays are Monday-first, so Monday and Friday sit at the ends', () => {
    expect(weekdayOf('2026-06-22')).toEqual({ index: 0, name: 'Mon' });
    expect(weekdayOf('2026-06-26')).toEqual({ index: 4, name: 'Fri' });
    expect(weekdayOf('2026-06-28')).toEqual({ index: 6, name: 'Sun' });
  });
});

describe('numbers and text', () => {
  test('a blank strength cell is null, not zero', () => {
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber('not a number')).toBeNull();
  });

  test('numbers survive as numbers whether stored as text or not', () => {
    expect(toNumber(136)).toBe(136);
    expect(toNumber('136')).toBe(136);
  });

  test('text is trimmed and blank-ish values collapse to an empty string', () => {
    expect(toText('  Cougar ')).toBe('Cougar');
    expect(toText(null)).toBe('');
  });

  test('name normalisation makes one soldier out of two spellings', () => {
    expect(normaliseName('NG JUN WEI, CALEB')).toBe(normaliseName('Ng Jun Wei  Caleb'));
    expect(normaliseName('')).toBe('');
  });
});
