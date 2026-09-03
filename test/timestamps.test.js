/**
 * Tests for the CSV-import path: repairing text-shaped Timestamp cells as a paste
 * lands, via the installable onEdit trigger.
 */

import { describe, expect, test } from 'bun:test';
import { editEvent, loadFormSg } from './harness.js';

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

/**
 * Builds an onEdit event covering the Timestamp column for the given data rows,
 * on the responses tab.
 * @param {!Object} env A loaded environment.
 * @param {number} firstDataRow 1-based first data row the edit covers.
 * @param {number=} lastDataRow 1-based last data row; defaults to firstDataRow.
 * @param {string=} sheetName Overrides the sheet the edit landed on.
 * @param {number=} column Overrides the edited column.
 * @returns {!Object} The event, ready to pass to `onEditHandler`.
 */
function timestampEditEvent(env, firstDataRow, lastDataRow, sheetName, column) {
  return editEvent({
    sheetName: sheetName === undefined ? env.globals.FORMSG_SHEET_NAME : sheetName,
    column: column === undefined ? env.globals.FormSgSchema.columnIndex(env.globals.FORMSG_TIMESTAMP_HEADER) : column,
    row: firstDataRow,
    lastRow: lastDataRow === undefined ? firstDataRow : lastDataRow,
  });
}

describe('onEditHandler', () => {
  test('converts every text timestamp a paste touches', () => {
    const env = withTimestamps(['07 May 2026 19:21:00', '8 May 2026 08:00', '9 May 2026 09:00']);

    env.globals.FormSgTimestamps.onEditHandler(timestampEditEvent(env, 2, 4));
    const converted = timestampColumn(env);

    expect(converted).toHaveLength(3);
    converted.forEach((value) => expect(value).toBeInstanceOf(Date));
    expect(converted[0].getFullYear()).toBe(2026);
    expect(env.logs.join('\n')).toContain('3 converted');
  });

  test('leaves existing Dates and unparseable cells untouched, without throwing', () => {
    const existing = new Date(2026, 0, 2, 3, 4, 5);
    const env = withTimestamps(['07 May 2026 19:21:00', existing, 'garbage']);

    expect(() => env.globals.FormSgTimestamps.onEditHandler(timestampEditEvent(env, 2, 4))).not.toThrow();
    const [converted, passthrough, unparsed] = timestampColumn(env);

    expect(converted).toBeInstanceOf(Date);
    expect(passthrough).toBe(existing);
    expect(unparsed).toBe('garbage');
    const log = env.logs.join('\n');
    expect(log).toContain('1 converted, 1 unparsed');
    expect(log).toContain('row 4: garbage');
  });

  test('applies the CSV-matching number format', () => {
    const env = withTimestamps(['07 May 2026 19:21:00']);
    env.globals.FormSgTimestamps.onEditHandler(timestampEditEvent(env, 2));

    expect(env.globals.FormSgSchema.sheet().numberFormats).toContain('dd mmm yyyy hh:mm:ss');
  });

  test('ignores an edit on a different sheet', () => {
    const env = withTimestamps(['definitely not a date']);
    env.globals.FormSgTimestamps.onEditHandler(timestampEditEvent(env, 2, 2, 'Some Other Sheet'));

    expect(timestampColumn(env)[0]).toBe('definitely not a date');
  });

  test('ignores an edit outside the Timestamp column', () => {
    const env = withTimestamps(['definitely not a date']);
    const responseIdColumn = env.globals.FormSgSchema.columnIndex(env.globals.FORMSG_RESPONSE_ID_HEADER);

    env.globals.FormSgTimestamps.onEditHandler(timestampEditEvent(env, 2, 2, undefined, responseIdColumn));

    expect(timestampColumn(env)[0]).toBe('definitely not a date');
  });

  test('ignores an edit confined to the header row', () => {
    const env = withTimestamps(['definitely not a date']);

    env.globals.FormSgTimestamps.onEditHandler(timestampEditEvent(env, 1, 1));

    expect(timestampColumn(env)[0]).toBe('definitely not a date');
  });

  test('does not throw when the event or its range is missing', () => {
    expect(() => loadFormSg().globals.FormSgTimestamps.onEditHandler({})).not.toThrow();
    expect(() => loadFormSg().globals.FormSgTimestamps.onEditHandler(undefined)).not.toThrow();
  });
});
