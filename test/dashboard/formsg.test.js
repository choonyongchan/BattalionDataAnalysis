/**
 * Tests for normalising FormSG report-sick submissions.
 *
 * The cases worth having are the ones that would fail silently: the "Report Sick Type"
 * answer dropped on the floor, and a type breakdown whose slices do not add up to the
 * submissions they came from.
 */

import { describe, expect, test } from 'bun:test';
import { reportSickTypeCounts, submissionTrend, toSubmissions } from '../../dashboard/src/model/formsg.js';
import { toRecords } from '../../dashboard/src/data/records.js';
import { STRENGTH_HEADERS } from '../../dashboard/src/data/tabs.js';

/**
 * A FormSG response row, as `toSubmissions` reads it: an object keyed by header.
 * @param {!Object} overrides Fields to set or replace.
 * @returns {!Object} A row with sane defaults.
 */
function row(overrides) {
  return {
    Timestamp: '2026-06-22 08:30:00',
    RANK: 'REC',
    '[Myinfo] Name': 'TAN JUN HAO',
    '4D Number (REC Only)': '3203',
    'Unit & Coy': 'Cougar Coy',
    'Report Sick Type': 'Report Sick In-Camp (RSI)',
    'Reason for Reporting Sick (Keep Brief)': 'fever',
    'I am experiencing _____________________ symptoms.': 'fever, cough',
    ...overrides,
  };
}

describe('toSubmissions', () => {
  test('surfaces the report sick type verbatim', () => {
    const [submission] = toSubmissions([row({ 'Report Sick Type': '  FFI  ' })]);
    expect(submission.reportSickType).toBe('FFI');
  });

  test('a row with no type column reads as blank, not undefined', () => {
    const bare = row({});
    delete bare['Report Sick Type'];
    expect(toSubmissions([bare])[0].reportSickType).toBe('');
  });
});

/**
 * Builds Strength Data records from column-keyed row specs.
 * @param {Array<!Object>} specs Partial records; unlisted headers read as ''.
 * @returns {Array<!Object>} Normalised records.
 */
function strengthRows(specs) {
  const values = [
    STRENGTH_HEADERS.slice(),
    ...specs.map((spec) => STRENGTH_HEADERS.map((header) => (header in spec ? spec[header] : ''))),
  ];
  return toRecords(values, STRENGTH_HEADERS, 'Strength Data');
}

describe('submissionTrend', () => {
  test('companies scope counts submissions per company, zero for a company with none', () => {
    const submissions = toSubmissions([
      row({ 'Unit & Coy': '40 SAR / Archer', Timestamp: '2026-07-20 08:00:00' }),
      row({ 'Unit & Coy': '40 SAR / Archer', Timestamp: '2026-07-20 09:00:00' }),
    ]);
    const trend = submissionTrend(submissions, [], ['2026-07-20'], { scope: 'companies' });
    const archer = trend.series.find((s) => s.name === 'Archer');
    const scorpion = trend.series.find((s) => s.name === 'Scorpion');
    expect(archer.values[0]).toBe(2);
    expect(scorpion.values[0]).toBe(0);
  });

  test('battalion scope returns a rate per 100 accountable', () => {
    const submissions = toSubmissions([row({ Timestamp: '2026-07-20 08:00:00' })]);
    const strength = strengthRows([
      { date: '2026-07-20', session: 'FPS', company: 'Cougar', unit_type: 'Company', total_strength: 100, total_present: 90 },
    ]);
    const trend = submissionTrend(submissions, strength, ['2026-07-20'], { scope: 'battalion' });
    expect(trend.series[0].values[0]).toBeCloseTo(1);
  });

  test('a day with no strength on record reads as zero, not a division error', () => {
    const submissions = toSubmissions([row({ Timestamp: '2026-07-20 08:00:00' })]);
    const trend = submissionTrend(submissions, [], ['2026-07-20'], { scope: 'battalion' });
    expect(trend.series[0].values[0]).toBe(0);
  });
});

describe('reportSickTypeCounts', () => {
  test('tallies by type, most frequent first', () => {
    const counts = reportSickTypeCounts([
      { reportSickType: 'RSI' },
      { reportSickType: 'RSO' },
      { reportSickType: 'RSI' },
    ]);
    expect(counts).toEqual([
      { type: 'RSI', count: 2 },
      { type: 'RSO', count: 1 },
    ]);
  });

  test('a blank type is counted as Unspecified', () => {
    const counts = reportSickTypeCounts([
      { reportSickType: '' },
      { reportSickType: 'RSI' },
    ]);
    expect(counts).toContainEqual({ type: 'Unspecified', count: 1 });
  });

  test('ties break by type name', () => {
    const counts = reportSickTypeCounts([
      { reportSickType: 'RSO' },
      { reportSickType: 'RSI' },
    ]);
    expect(counts.map((entry) => entry.type)).toEqual(['RSI', 'RSO']);
  });

  test('folds the tail into Other past the slice limit, preserving the total', () => {
    const submissions = [
      { reportSickType: 'RSI' },
      { reportSickType: 'RSI' },
      { reportSickType: 'RSI' },
      { reportSickType: 'RSO' },
      { reportSickType: 'RSO' },
      { reportSickType: 'FFI' },
      { reportSickType: 'Medical Review' },
      { reportSickType: 'Something New' },
    ];
    const counts = reportSickTypeCounts(submissions, 4);
    expect(counts.length).toBe(4);
    expect(counts.slice(0, 3).map((entry) => entry.type)).toEqual(['RSI', 'RSO', 'FFI']);
    expect(counts[counts.length - 1]).toEqual({ type: 'Other', count: 2 });
    expect(counts.reduce((sum, entry) => sum + entry.count, 0)).toBe(submissions.length);
  });

  test('leaves the list alone when it fits the limit', () => {
    const counts = reportSickTypeCounts(
      [{ reportSickType: 'RSI' }, { reportSickType: 'RSO' }, { reportSickType: 'FFI' }],
      4
    );
    expect(counts.map((entry) => entry.type)).toEqual(['FFI', 'RSI', 'RSO']);
  });
});
