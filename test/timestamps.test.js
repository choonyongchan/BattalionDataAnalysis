/**
 * Tests for the CSV-import path: repairing text-shaped Timestamp cells.
 */

import { describe, expect, test } from 'bun:test';
import { loadFormSg } from './harness.js';

/**
 * Builds an environment whose responses tab holds the given Timestamp cells.
 * @param {!Array<*>} timestamps One value per data row, for the Timestamp column.
 * @returns {!Object} The loaded environment, with the sheet already populated.
 */
function withTimestamps(timestamps) {
  const env = loadFormSg();
  const sheet = env.globals.FormSgSchema.sheet();
  const width = env.globals.FORMSG_COLUMNS.length;
  const column = env.globals.FORMSG_COLUMNS.indexOf(env.globals.FORMSG_TIMESTAMP_HEADER);

  timestamps.forEach((value, i) => {
    const row = new Array(width).fill('');
    row[0] = `submission-${i}`;
    row[column] = value;
    sheet.appendRow(row);
  });

  return env;
}

/**
 * Reads the Timestamp column's data cells back out of the responses tab.
 * @param {!Object} env A loaded environment.
 * @returns {!Array<*>} One value per data row.
 */
function timestampColumn(env) {
  const column = env.globals.FORMSG_COLUMNS.indexOf(env.globals.FORMSG_TIMESTAMP_HEADER);
  return env.globals.FormSgSchema.sheet().rows.slice(1).map((row) => row[column]);
}

describe('parseCsvTimestamp_', () => {
  test("parses FormSG's CSV format", () => {
    const { globals } = loadFormSg();
    const parsed = globals.FormSgTimestamps.parseCsvTimestamp_('07 May 2026 19:21:00');

    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(4);
    expect(parsed.getDate()).toBe(7);
    expect(parsed.getHours()).toBe(19);
    expect(parsed.getMinutes()).toBe(21);
    expect(parsed.getSeconds()).toBe(0);
  });

  test('treats seconds as optional', () => {
    const { globals } = loadFormSg();
    expect(globals.FormSgTimestamps.parseCsvTimestamp_('7 May 2026 19:21').getSeconds()).toBe(0);
  });

  test('is case-insensitive about the month', () => {
    const { globals } = loadFormSg();
    expect(globals.FormSgTimestamps.parseCsvTimestamp_('07 MAY 2026 19:21:00').getMonth()).toBe(4);
  });

  test.each(['not a date', '2026-05-07T19:21:00Z', '07 Mayy 2026 19:21:00', '07 Foo 2026 19:21:00', ''])(
    'returns null for %p rather than guessing',
    (text) => {
      const { globals } = loadFormSg();
      expect(globals.FormSgTimestamps.parseCsvTimestamp_(text)).toBeNull();
    }
  );
});

describe('normalise', () => {
  test('converts text timestamps and leaves existing Dates untouched', () => {
    const existing = new Date(2026, 0, 2, 3, 4, 5);
    const env = withTimestamps(['07 May 2026 19:21:00', existing, '']);

    env.globals.FormSgTimestamps.normalise();
    const [converted, passthrough, blank] = timestampColumn(env);

    expect(converted).toBeInstanceOf(Date);
    expect(converted.getFullYear()).toBe(2026);
    expect(passthrough).toBe(existing);
    expect(blank).toBe('');
    expect(env.logs.join('\n')).toContain('1 converted, 1 already Dates, 0 unparsed');
  });

  test('reports unparseable cells instead of overwriting them', () => {
    const env = withTimestamps(['definitely not a date']);
    env.globals.FormSgTimestamps.normalise();

    expect(timestampColumn(env)[0]).toBe('definitely not a date');
    const log = env.logs.join('\n');
    expect(log).toContain('1 unparsed');
    expect(log).toContain('row 2: definitely not a date');
  });

  test('applies the CSV-matching number format', () => {
    const env = withTimestamps(['07 May 2026 19:21:00']);
    env.globals.FormSgTimestamps.normalise();

    expect(env.globals.FormSgSchema.sheet().numberFormats).toContain('dd mmm yyyy hh:mm:ss');
  });

  test('does nothing when there are no data rows', () => {
    const env = withTimestamps([]);
    env.globals.FormSgTimestamps.normalise();

    expect(env.logs.join('\n')).toContain('No data rows to normalise.');
  });
});
