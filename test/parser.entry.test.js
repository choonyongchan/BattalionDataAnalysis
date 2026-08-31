/**
 * Tests for the two parade-state entry points: Parser.handlePost and
 * Parser.onEditHandler.
 *
 * Both are guard-heavy and both are cheap to get subtly wrong. The POST handler
 * decides what to reject permanently versus what to let the bridge resend, and the
 * edit handler runs on every edit anywhere in the spreadsheet, so its bail-out
 * conditions matter more than its happy path.
 *
 * `Parser.processRow` is stubbed here — what is under test is which requests and which
 * edits reach it. What it then does with a row is parser.contract.test.js. The dedup
 * path runs against the real ParserSheets and a real fake sheet, because that is the
 * behaviour the endpoint's idempotency depends on.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { editEvent, loadParser, postEvent } from './harness.js';

/** @type {string} The token these tests treat as correct. */
const TOKEN = 'the-right-token';

/**
 * Loads a parser environment with Parser.processRow recorded rather than run.
 *
 * @param {!Object=} options Passed through to loadParser.
 * @returns {!Object} The environment, plus `processed` — the (rowIndex, previousId)
 *     pairs handed to processRow.
 */
function loadWithStubbedProcessRow(options) {
  const env = loadParser(options === undefined ? { token: TOKEN } : options);
  const processed = [];
  env.globals.Parser.processRow = (rowIndex, previousId) => processed.push([rowIndex, previousId]);
  env.processed = processed;
  /** Row indexes only, for the many assertions that do not care about previousId. */
  env.rows = () => processed.map((call) => call[0]);
  return env;
}

/**
 * A well-formed relay body.
 *
 * @param {!Object=} overrides Fields to merge over the defaults.
 * @returns {!Object} The body.
 */
function sampleRelay(overrides) {
  return { token: TOKEN, messageId: 'MSG1', text: 'ARCHER FIRST PARADE STATE ...', ...(overrides || {}) };
}

/**
 * Posts a relay body through handlePost.
 *
 * @param {*} body The request body.
 * @param {!Object=} options Passed through to loadParser.
 * @returns {{reply: !Object, env: !Object}} The parsed reply and its environment.
 */
function relay(body, options) {
  const env = loadWithStubbedProcessRow(options);
  const reply = JSON.parse(env.globals.Parser.handlePost(postEvent(body)).getContent());
  return { reply, env };
}

describe('handlePost', () => {
  test('appends and processes a valid relay', () => {
    const { reply, env } = relay(sampleRelay());

    expect(reply).toEqual({ ok: true, messageId: 'MSG1', appended: true, rowIndex: 2 });
    expect(env.rows()).toEqual([2]);

    // The row lands with the text and message id filled and parade_response_id empty,
    // which is what marks it due for processing.
    const columns = env.globals.RAW_RESPONSES_COLUMNS;
    const row = env.rawRow(2);
    expect(row[columns.indexOf('Drop your Parade State here')]).toBe('ARCHER FIRST PARADE STATE ...');
    expect(row[columns.indexOf('wa_message_id')]).toBe('MSG1');
    expect(row[columns.indexOf('parade_response_id')]).toBe('');
    expect(row[columns.indexOf('error')]).toBe('');
  });

  test('skips a redelivery of a message it has already processed', () => {
    const env = loadWithStubbedProcessRow();
    const event = postEvent(sampleRelay());

    env.globals.Parser.handlePost(event);
    // Simulate the first delivery having finished: the row now carries a key.
    env.rawRow(2)[env.globals.RAW_RESPONSES_COLUMNS.indexOf('parade_response_id')] = 'Archer_2026-06-19_FPS';
    const second = JSON.parse(env.globals.Parser.handlePost(event).getContent());

    expect(second).toEqual({ ok: true, messageId: 'MSG1', appended: false, rowIndex: 2 });
    // The point of the dedup: a redelivery of a done message costs no AI call and no
    // second row.
    expect(env.rows()).toEqual([2]);
    expect(env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows).toHaveLength(2);
  });

  test('reprocesses a redelivery whose row is recorded but still blank', () => {
    // A first delivery that appended the row and then died leaves it blank. The
    // resend is the recovery path, so it must reach processRow.
    const env = loadWithStubbedProcessRow();
    const event = postEvent(sampleRelay());

    env.globals.Parser.handlePost(event);
    const second = JSON.parse(env.globals.Parser.handlePost(event).getContent());

    expect(second).toEqual({ ok: true, messageId: 'MSG1', appended: false, rowIndex: 2 });
    expect(env.rows()).toEqual([2, 2]);
    expect(env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows).toHaveLength(2);
  });

  test('reprocesses a redelivery whose row was left mid-flight', () => {
    const env = loadWithStubbedProcessRow({
      token: TOKEN,
      rawRows: [[new Date(), 'ARCHER FIRST PARADE STATE ...', 'MSG1', '', 'Processing...']],
    });

    const reply = JSON.parse(env.globals.Parser.handlePost(postEvent(sampleRelay())).getContent());

    expect(reply).toEqual({ ok: true, messageId: 'MSG1', appended: false, rowIndex: 2 });
    expect(env.processed).toEqual([[2, '']]);
  });

  test('does not reprocess a redelivery of a message that already failed', () => {
    const env = loadWithStubbedProcessRow({
      token: TOKEN,
      rawRows: [[new Date(), 'unreadable', 'MSG1', 'ERROR', 'Company could not be determined.']],
    });

    const reply = JSON.parse(env.globals.Parser.handlePost(postEvent(sampleRelay())).getContent());

    expect(reply).toEqual({ ok: true, messageId: 'MSG1', appended: false, rowIndex: 2 });
    expect(env.rows()).toEqual([]);
    expect(env.logs.join('\n')).toContain('already recorded');
  });

  test('appends a second row for a genuinely different message', () => {
    const env = loadWithStubbedProcessRow();

    env.globals.Parser.handlePost(postEvent(sampleRelay()));
    const second = JSON.parse(env.globals.Parser.handlePost(postEvent(sampleRelay({ messageId: 'MSG2' }))).getContent());

    expect(second.appended).toBe(true);
    expect(second.rowIndex).toBe(3);
    expect(env.rows()).toEqual([2, 3]);
  });

  test('rejects a wrong token without appending', () => {
    const { reply, env } = relay(sampleRelay({ token: 'wrong' }));

    expect(reply).toEqual({ ok: false, error: 'unauthorised' });
    expect(env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows).toHaveLength(1);
    expect(env.processed).toHaveLength(0);
  });

  test('fails closed when the token property was never set', () => {
    // An unset property must reject everything, not wave everything through.
    const { reply, env } = relay(sampleRelay(), {});

    expect(reply).toEqual({ ok: false, error: 'unauthorised' });
    expect(env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows).toHaveLength(1);
  });

  test('rejects an empty token even if the property is somehow empty', () => {
    const { reply } = relay(sampleRelay({ token: '' }), { token: '' });
    expect(reply).toEqual({ ok: false, error: 'unauthorised' });
  });

  test.each([
    ['no messageId', { token: TOKEN, text: 'x' }],
    ['no text', { token: TOKEN, messageId: 'MSG1' }],
    ['an empty object', {}],
    ['malformed JSON', '{"token": "x"'],
  ])('rejects %s as a permanent bad_request', (_label, body) => {
    const { reply, env } = relay(body);

    expect(reply).toEqual({ ok: false, error: 'bad_request' });
    expect(env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows).toHaveLength(1);
  });

  test('rejects a request with no body at all', () => {
    const env = loadWithStubbedProcessRow();
    const reply = JSON.parse(env.globals.Parser.handlePost({}).getContent());
    expect(reply.error).toBe('bad_request');
  });

  test('rethrows a transient failure so the bridge resends', () => {
    // A thrown error is the only way Apps Script emits a 5xx. Lock contention must
    // not be answered 200, or the message is lost.
    const env = loadWithStubbedProcessRow();
    env.globals.Parser.processRow = () => {
      throw new Error('Could not acquire script lock');
    };

    expect(() => env.globals.Parser.handlePost(postEvent(sampleRelay()))).toThrow(/script lock/);
  });

  test('rethrows lock contention from the append itself', () => {
    const env = loadWithStubbedProcessRow({ token: TOKEN, lockAcquired: false });

    expect(() => env.globals.Parser.handlePost(postEvent(sampleRelay()))).toThrow(/script lock/);
  });
});

describe('onEditHandler', () => {
  /** @type {number} 1-based column of parade_response_id. */
  let idCol;

  beforeEach(() => {
    idCol = loadParser().globals.RAW_RESPONSES_COLUMNS.indexOf('parade_response_id') + 1;
  });

  /**
   * Runs one edit event and returns which rows were reprocessed.
   *
   * @param {!Object} spec Passed to editEvent, less the resolved column number.
   * @returns {{processed: !Array<!Array<*>>, rows: !Array<number>, logs: !Array<string>,
   *     globals: !Object}} The outcome.
   */
  function edit(spec) {
    const env = loadWithStubbedProcessRow();
    const cells = {};
    for (const [row, values] of Object.entries(spec.rows || {})) {
      cells[`${row},${idCol}`] = values.id === undefined ? '' : values.id;
    }

    env.globals.Parser.onEditHandler(
      editEvent({
        sheetName: spec.sheetName === undefined ? env.globals.SHEET_NAMES.RAW_RESPONSES : spec.sheetName,
        column: spec.column === undefined ? idCol : spec.column,
        lastColumn: spec.lastColumn,
        row: spec.row,
        lastRow: spec.lastRow,
        oldValue: spec.oldValue,
        cells,
      })
    );
    return { processed: env.processed, rows: env.rows(), logs: env.logs, globals: env.globals };
  }

  test('reprocesses a row whose parade_response_id was cleared', () => {
    expect(edit({ row: 5, rows: { 5: { id: '' } } }).rows).toEqual([5]);
  });

  test('ignores a row whose parade_response_id was set, not cleared', () => {
    expect(edit({ row: 5, rows: { 5: { id: 'Archer_2026-07-18_FPS' } } }).rows).toEqual([]);
  });

  test('ignores an edit to another sheet', () => {
    expect(edit({ sheetName: 'Strength Data', row: 5, rows: { 5: { id: '' } } }).rows).toEqual([]);
  });

  test('ignores an edit to a column left of parade_response_id', () => {
    expect(edit({ column: 2, lastColumn: 2, row: 5, rows: { 5: { id: '' } } }).rows).toEqual([]);
  });

  test('ignores an edit to a column right of parade_response_id', () => {
    expect(edit({ column: 99, lastColumn: 99, row: 5, rows: { 5: { id: '' } } }).rows).toEqual([]);
  });

  test('acts on a multi-column edit that spans parade_response_id', () => {
    // Selecting several columns and pressing Delete must still count.
    expect(edit({ column: 1, lastColumn: 99, row: 5, rows: { 5: { id: '' } } }).rows).toEqual([5]);
  });

  test('never touches the header row', () => {
    expect(edit({ row: 1, lastRow: 1, rows: { 1: { id: '' } } }).rows).toEqual([]);
  });

  test('skips the header when a range starts at row 1', () => {
    expect(edit({ row: 1, lastRow: 3, rows: { 1: { id: '' }, 2: { id: '' }, 3: { id: '' } } }).rows).toEqual([2, 3]);
  });

  test('reprocesses every cleared row in a multi-row edit', () => {
    const rows = { 2: { id: '' }, 3: { id: 'kept' }, 4: { id: '' } };
    expect(edit({ row: 2, lastRow: 4, rows }).rows).toEqual([2, 4]);
  });

  test('passes the cleared id on, so stale outputs can be removed', () => {
    // A single-cell clear is the forced-reprocess gesture, and the only case where
    // Apps Script supplies the old value. Without it, correcting a message's date
    // would orphan the previous key's output rows.
    const outcome = edit({ row: 5, oldValue: 'Archer_2026-06-19_FPS', rows: { 5: { id: '' } } });
    expect(outcome.processed).toEqual([[5, 'Archer_2026-06-19_FPS']]);
  });

  test('passes no previous id for a multi-row clear, where Sheets supplies none', () => {
    const outcome = edit({ row: 2, lastRow: 3, oldValue: 'ignored', rows: { 2: { id: '' }, 3: { id: '' } } });
    expect(outcome.processed).toEqual([
      [2, ''],
      [3, ''],
    ]);
  });

  test('refuses a bulk clear above the cap, and says why', () => {
    const cap = loadParser().globals.MAX_ONEDIT_REPROCESS_ROWS;
    const rows = {};
    for (let row = 2; row <= cap + 2; row++) {
      rows[row] = { id: '' };
    }

    const outcome = edit({ row: 2, lastRow: cap + 2, rows });
    expect(outcome.rows).toEqual([]);
    expect(outcome.logs.join('\n')).toContain(String(cap));
  });

  test('acts on a bulk clear exactly at the cap', () => {
    const cap = loadParser().globals.MAX_ONEDIT_REPROCESS_ROWS;
    const rows = {};
    for (let row = 2; row <= cap + 1; row++) {
      rows[row] = { id: '' };
    }

    expect(edit({ row: 2, lastRow: cap + 1, rows }).rows).toHaveLength(cap);
  });

  test('survives an event with no range', () => {
    const env = loadWithStubbedProcessRow();
    expect(() => env.globals.Parser.onEditHandler({})).not.toThrow();
    expect(() => env.globals.Parser.onEditHandler(undefined)).not.toThrow();
  });
});

describe('onFormSubmitHandler', () => {
  test('processes the row the Form just inserted', () => {
    // The Form path needs its own trigger because a Form submission does not fire
    // onEdit, so this is the only thing that picks such a row up.
    const env = loadWithStubbedProcessRow();
    env.globals.Parser.onFormSubmitHandler({ range: { getRow: () => 7 } });

    expect(env.processed).toEqual([[7, '']]);
  });
});

describe('reprocessPendingRows', () => {
  /** One raw row with the given id and error cells, text and message id filled. */
  const rawRow = (id, error) => [new Date(), 'ARCHER FIRST PARADE STATE ...', `MSG-${id || 'blank'}`, id, error || ''];

  test('reprocesses every blank row and skips keys and ERROR rows', () => {
    const env = loadWithStubbedProcessRow({
      token: TOKEN,
      rawRows: [
        rawRow(''), //                                 row 2 — due
        rawRow('Archer_2026-06-19_FPS'), //             row 3 — done
        rawRow('ERROR', 'Company could not be determined.'), // row 4 — failed
        rawRow('', 'Processing...'), //                 row 5 — killed mid-flight, still due
      ],
    });

    env.globals.reprocessPendingRows();

    expect(env.rows().slice().sort()).toEqual([2, 5]);
    expect(env.processed.every((call) => call[1] === '')).toBe(true);
  });

  test('does nothing and logs when the due count is above the cap', () => {
    const cap = loadParser().globals.MAX_ONEDIT_REPROCESS_ROWS;
    const rawRows = [];
    for (let i = 0; i < cap + 1; i++) {
      rawRows.push(rawRow(''));
    }
    const env = loadWithStubbedProcessRow({ token: TOKEN, rawRows });

    env.globals.reprocessPendingRows();

    expect(env.rows()).toEqual([]);
    expect(env.logs.join('\n')).toContain(String(cap + 1));
  });

  test('acts on a due count exactly at the cap', () => {
    const cap = loadParser().globals.MAX_ONEDIT_REPROCESS_ROWS;
    const rawRows = [];
    for (let i = 0; i < cap; i++) {
      rawRows.push(rawRow(''));
    }
    const env = loadWithStubbedProcessRow({ token: TOKEN, rawRows });

    env.globals.reprocessPendingRows();

    expect(env.rows()).toHaveLength(cap);
  });

  test('does nothing on a header-only sheet', () => {
    const env = loadWithStubbedProcessRow();

    expect(() => env.globals.reprocessPendingRows()).not.toThrow();
    expect(env.rows()).toEqual([]);
  });
});
