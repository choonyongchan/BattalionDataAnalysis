/**
 * Tests for the dashboard's date-range filtering helpers.
 *
 * The cases worth having are the ones that would silently show the wrong slice: an
 * open bound read as a closed one, an episode that straddles the window's edge, and a
 * preset that miscounts across a month boundary.
 */

import { describe, expect, test } from 'bun:test';
import {
  addMonths,
  daysOfMonth,
  firstOfMonth,
  matchPreset,
  mondayFirstIndex,
  overlapsRange,
  resolvePreset,
  withinRange,
} from '../../dashboard/js/model/daterange.js';

describe('withinRange', () => {
  test('is inclusive of both ends', () => {
    expect(withinRange('2026-06-01', '2026-06-01', '2026-06-30')).toBe(true);
    expect(withinRange('2026-06-30', '2026-06-01', '2026-06-30')).toBe(true);
  });

  test('excludes dates outside the range', () => {
    expect(withinRange('2026-05-31', '2026-06-01', '2026-06-30')).toBe(false);
    expect(withinRange('2026-07-01', '2026-06-01', '2026-06-30')).toBe(false);
  });

  test('a null bound is open', () => {
    expect(withinRange('2020-01-01', null, '2026-06-30')).toBe(true);
    expect(withinRange('2099-01-01', '2026-06-01', null)).toBe(true);
    expect(withinRange('2026-06-15', null, null)).toBe(true);
  });

  test('a missing date is never in range', () => {
    expect(withinRange(null, null, null)).toBe(false);
    expect(withinRange('', '2026-06-01', '2026-06-30')).toBe(false);
  });
});

describe('overlapsRange', () => {
  test('a span straddling the lower edge overlaps', () => {
    expect(overlapsRange('2026-05-28', '2026-06-03', '2026-06-01', '2026-06-30')).toBe(true);
  });

  test('a span straddling the upper edge overlaps', () => {
    expect(overlapsRange('2026-06-28', '2026-07-05', '2026-06-01', '2026-06-30')).toBe(true);
  });

  test('a span entirely before or after does not overlap', () => {
    expect(overlapsRange('2026-04-01', '2026-04-10', '2026-06-01', '2026-06-30')).toBe(false);
    expect(overlapsRange('2026-08-01', '2026-08-10', '2026-06-01', '2026-06-30')).toBe(false);
  });

  test('touching an edge by a single day still overlaps', () => {
    expect(overlapsRange('2026-05-01', '2026-06-01', '2026-06-01', '2026-06-30')).toBe(true);
    expect(overlapsRange('2026-06-30', '2026-07-30', '2026-06-01', '2026-06-30')).toBe(true);
  });

  test('null range bounds are open', () => {
    expect(overlapsRange('2020-01-01', '2020-01-02', null, null)).toBe(true);
  });

  test('a one-day span (start equals end) is handled', () => {
    expect(overlapsRange('2026-06-15', '2026-06-15', '2026-06-01', '2026-06-30')).toBe(true);
    expect(overlapsRange('2026-07-15', '2026-07-15', '2026-06-01', '2026-06-30')).toBe(false);
  });
});

describe('resolvePreset', () => {
  test('last7 spans seven inclusive days ending today', () => {
    expect(resolvePreset('last7', '2026-06-22')).toEqual({ from: '2026-06-16', to: '2026-06-22' });
  });

  test('last14 spans fourteen inclusive days ending today', () => {
    expect(resolvePreset('last14', '2026-06-22')).toEqual({ from: '2026-06-09', to: '2026-06-22' });
  });

  test('last7 counts back across a month boundary', () => {
    expect(resolvePreset('last7', '2026-07-03')).toEqual({ from: '2026-06-27', to: '2026-07-03' });
  });

  test('month runs from the first of the current month', () => {
    expect(resolvePreset('month', '2026-06-22')).toEqual({ from: '2026-06-01', to: '2026-06-22' });
  });

  test('all clears both bounds', () => {
    expect(resolvePreset('all', '2026-06-22')).toEqual({ from: null, to: null });
  });

  test('an unknown name falls back to all', () => {
    expect(resolvePreset('nonsense', '2026-06-22')).toEqual({ from: null, to: null });
  });
});

describe('month-grid arithmetic', () => {
  test('firstOfMonth snaps any day to the first', () => {
    expect(firstOfMonth('2026-06-22')).toBe('2026-06-01');
  });

  test('addMonths crosses year boundaries both ways', () => {
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
    expect(addMonths('2026-06-01', -18)).toBe('2024-12-01');
  });

  test('daysOfMonth handles a leap February', () => {
    expect(daysOfMonth('2024-02-01')).toHaveLength(29);
    expect(daysOfMonth('2026-02-01')).toHaveLength(28);
    expect(daysOfMonth('2026-06-01')[0]).toBe('2026-06-01');
    expect(daysOfMonth('2026-06-01')[29]).toBe('2026-06-30');
  });

  test('mondayFirstIndex puts Monday at 0 and Sunday at 6', () => {
    expect(mondayFirstIndex('2026-06-22')).toBe(0); // a Monday
    expect(mondayFirstIndex('2026-06-28')).toBe(6); // the Sunday after
  });
});

describe('matchPreset', () => {
  test('recognises the range a preset produced', () => {
    expect(matchPreset('2026-06-16', '2026-06-22', '2026-06-22')).toBe('last7');
    expect(matchPreset('2026-06-01', '2026-06-22', '2026-06-22')).toBe('month');
    expect(matchPreset(null, null, '2026-06-22')).toBe('all');
  });

  test('returns null for a hand-picked span that matches no preset', () => {
    expect(matchPreset('2026-06-10', '2026-06-18', '2026-06-22')).toBe(null);
  });
});
