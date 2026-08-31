/**
 * Tests for the row contract: what Parser.processRow writes, and where.
 *
 * The row is the pipeline's only state, so this is the file that pins that contract
 * down — an empty parade_response_id means due, a key means done, ERROR plus a reason
 * means failed, and a cleared id means run it again. Everything the old design tracked
 * in four extra columns and a separate errors tab now has to be visible here.
 *
 * Only the network is faked: ParserSheets, ParserRows and ParserSchema all run for
 * real against in-memory sheets, so a write to the wrong column or a missed cleanup
 * shows up as a wrong cell rather than a passing mock.
 */

import { describe, expect, test } from 'bun:test';
import { loadParser } from './harness.js';

/** @type {string} The text seeded into every row under test. */
const RAW_TEXT = 'ARCHER FIRST PARADE STATE ...';

/**
 * A valid extraction, shaped like a real one: the mandatory Company row plus one
 * platoon, a command team, and one personnel entry.
 *
 * @param {!Object=} overrides Fields to merge over the defaults.
 * @returns {!Object} The extraction.
 */
function extraction(overrides) {
  return {
    company: 'Archer',
    date: '2026-06-19',
    session: 'FPS',
    platoons: [
      {
        platoon: 'Company',
        unit_type: 'Company',
        total_strength: 274,
        total_present: 220,
        officer_strength: 5,
        officer_present: 5,
        wospec_strength: null,
        wospec_present: null,
        enlistee_strength: null,
        enlistee_present: null,
      },
      {
        platoon: '3',
        unit_type: 'PLATOON',
        total_strength: 69,
        total_present: 59,
        officer_strength: 1,
        officer_present: 1,
        wospec_strength: null,
        wospec_present: null,
        enlistee_strength: null,
        enlistee_present: null,
      },
    ],
    command_team: [{ role: 'CDO', rank: '2LT', name: 'RYAN' }],
    personnel: [
      {
        name: 'TAN JUN HAO, DARREN',
        rank: 'REC',
        four_d: '3203',
        platoon: '3',
        reason_category: 'Att C',
        start_date: '2026-06-08',
        end_date: '2026-07-05',
        num_days: 28,
        reason: 'MC',
        location: null,
        in_camp: null,
      },
    ],
    ...(overrides || {}),
  };
}

/**
 * Loads an environment holding one unprocessed row at row 2.
 *
 * @param {{text: (string|undefined), id: (string|undefined), rows: (Array|undefined),
 *     header: (Array|null|undefined)}=} options Seeding switches.
 * @returns {!Object} The environment.
 */
function withRow(options) {
  const settings = options || {};
  const rawRows = settings.rows || [
    [new Date(), settings.text === undefined ? RAW_TEXT : settings.text, '', settings.id || '', ''],
  ];
  return loadParser({ rawRows, header: settings.header });
}

/**
 * Reads a row's id and error cells.
 *
 * @param {!Object} env The environment.
 * @param {number} rowIndex 1-based row.
 * @returns {{id: *, error: *}} The outcome cells.
 */
function outcome(env, rowIndex) {
  const columns = env.globals.RAW_RESPONSES_COLUMNS;
  const row = env.rawRow(rowIndex);
  return { id: row[columns.indexOf('parade_response_id')], error: row[columns.indexOf('error')] };
}

/**
 * Counts the data rows (everything below the header) on one output tab.
 *
 * @param {!Object} env The environment.
 * @param {string} sheetName The tab.
 * @returns {number} The data row count, or 0 when the tab does not exist.
 */
function dataRows(env, sheetName) {
  const sheet = env.sheetOf(sheetName);
  return sheet ? sheet.rows.length - 1 : 0;
}

describe('a successful run', () => {
  test('writes the key, clears the error, and fills all three output tabs', () => {
    const env = withRow();
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');

    expect(outcome(env, 2)).toEqual({ id: 'Archer_2026-06-19_FPS', error: '' });
    expect(dataRows(env, env.globals.SHEET_NAMES.STRENGTH_DATA)).toBe(2);
    expect(dataRows(env, env.globals.SHEET_NAMES.PERSONNEL_DATA)).toBe(1);
    expect(dataRows(env, env.globals.SHEET_NAMES.COMMAND_ROSTER)).toBe(1);
  });

  test('creates each output tab with its header row, so no setup step is needed', () => {
    // This is what replaced verifySetup(): the first write provisions the tab.
    const env = withRow();
    env.stubExtraction(extraction());
    expect(env.sheetOf(env.globals.SHEET_NAMES.STRENGTH_DATA)).toBeNull();

    env.globals.Parser.processRow(2, '');

    env.globals.SCRIPT_OWNED_SHEETS.forEach(([name, columns]) => {
      expect(env.sheetOf(name).rows[0]).toEqual(columns);
    });
  });

  test('writes every strength column in its declared order', () => {
    const env = withRow();
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');

    const columns = env.globals.STRENGTH_DATA_COLUMNS;
    const row = env.sheetOf(env.globals.SHEET_NAMES.STRENGTH_DATA).rows[1];
    expect(row).toHaveLength(columns.length);
    expect(row[columns.indexOf('parade_response_id')]).toBe('Archer_2026-06-19_FPS');
    expect(row[columns.indexOf('company')]).toBe('Archer');
    expect(row[columns.indexOf('platoon')]).toBe('Company');
    expect(row[columns.indexOf('unit_type')]).toBe('Company');
    expect(row[columns.indexOf('total_strength')]).toBe(274);
    expect(row[columns.indexOf('total_present')]).toBe(220);
    // A tier the message did not state must be blank, never 0 — 0 is a real headcount.
    expect(row[columns.indexOf('wospec_strength')]).toBe('');
  });

  test('writes every personnel column in its declared order', () => {
    const env = withRow();
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');

    const columns = env.globals.PERSONNEL_DATA_COLUMNS;
    const row = env.sheetOf(env.globals.SHEET_NAMES.PERSONNEL_DATA).rows[1];
    expect(row).toHaveLength(columns.length);
    expect(row[columns.indexOf('name')]).toBe('TAN JUN HAO, DARREN');
    expect(row[columns.indexOf('four_d')]).toBe('3203');
    expect(row[columns.indexOf('reason_category')]).toBe('Att C');
    expect(row[columns.indexOf('num_days')]).toBe(28);
    expect(row[columns.indexOf('in_camp')]).toBe('');
  });

  test('writes no command-roster rows when the message has no command team', () => {
    const env = withRow();
    env.stubExtraction(extraction({ command_team: [] }));
    env.globals.Parser.processRow(2, '');

    expect(outcome(env, 2).id).toBe('Archer_2026-06-19_FPS');
    expect(dataRows(env, env.globals.SHEET_NAMES.COMMAND_ROSTER)).toBe(0);
  });
});

describe('a failing run', () => {
  test('records an extraction failure on the row and writes no output', () => {
    const env = withRow();
    env.stubExtraction(new Error('AI extraction failed after 2 attempts: HTTP 500'));
    env.globals.Parser.processRow(2, '');

    const result = outcome(env, 2);
    expect(result.id).toBe(env.globals.PARADE_ERROR_SENTINEL);
    expect(result.error).toContain('HTTP 500');
    expect(dataRows(env, env.globals.SHEET_NAMES.STRENGTH_DATA)).toBe(0);
  });

  test('records a validation failure the same way, with the reason readable', () => {
    // An unrecognized company and a bad extraction now land identically, because the
    // operator's next move is the same either way: fix the message, clear the id.
    const env = withRow();
    env.stubExtraction(extraction({ company: 'Nonesuch' }));
    env.globals.Parser.processRow(2, '');

    const result = outcome(env, 2);
    expect(result.id).toBe(env.globals.PARADE_ERROR_SENTINEL);
    expect(result.error).toMatch(/company/i);
    expect(dataRows(env, env.globals.SHEET_NAMES.STRENGTH_DATA)).toBe(0);
  });

  test('leaves an earlier run\'s output alone when a reprocess fails validation', () => {
    // deleteOutputsForKey runs only after a key is known, so a failed reprocess must
    // not silently empty the tabs for a submission that was previously fine.
    const env = withRow();
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');
    expect(dataRows(env, env.globals.SHEET_NAMES.STRENGTH_DATA)).toBe(2);

    env.stubExtraction(extraction({ date: 'not-a-date' }));
    env.globals.Parser.processRow(2, 'Archer_2026-06-19_FPS');

    expect(outcome(env, 2).id).toBe(env.globals.PARADE_ERROR_SENTINEL);
    expect(dataRows(env, env.globals.SHEET_NAMES.STRENGTH_DATA)).toBe(2);
  });

  test('propagates lock contention instead of recording it, so the bridge resends', () => {
    // The one failure that must not be written to the row: if the lock is unavailable
    // the write itself cannot happen, and throwing is what produces a 5xx and a resend.
    const env = loadParser({
      lockAcquired: false,
      rawRows: [[new Date(), RAW_TEXT, '', '', '']],
    });
    env.stubExtraction(extraction());

    expect(() => env.globals.Parser.processRow(2, '')).toThrow(/script lock/);
  });
});

describe('the in-progress marker', () => {
  test('writes Processing... with a blank id before the AI call', () => {
    const env = withRow();
    let seenDuringExtraction;
    env.stubExtraction(() => {
      seenDuringExtraction = outcome(env, 2);
      return extraction();
    });
    env.globals.Parser.processRow(2, '');

    expect(seenDuringExtraction).toEqual({ id: '', error: env.globals.PARADE_PROCESSING_SENTINEL });
  });

  test('clears the marker on a successful run', () => {
    const env = withRow();
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');

    expect(outcome(env, 2)).toEqual({ id: 'Archer_2026-06-19_FPS', error: '' });
  });

  test('replaces the marker with the reason on a failing run', () => {
    const env = withRow();
    env.stubExtraction(new Error('AI extraction failed after 2 attempts: HTTP 500'));
    env.globals.Parser.processRow(2, '');

    const result = outcome(env, 2);
    expect(result.id).toBe(env.globals.PARADE_ERROR_SENTINEL);
    expect(result.error).toContain('HTTP 500');
    expect(result.error).not.toContain(env.globals.PARADE_PROCESSING_SENTINEL);
  });

  test('leaves the marker in place when the run is killed after it is written', () => {
    // A blank id plus Processing... is the signature of a run that started and never
    // finished — the row is still due, and now visibly so.
    const env = withRow();
    env.stubExtraction(extraction());
    env.globals.ParserSheets.finishRow = () => {
      throw new Error('killed mid-run');
    };

    expect(() => env.globals.Parser.processRow(2, '')).toThrow(/killed mid-run/);
    expect(outcome(env, 2)).toEqual({ id: '', error: env.globals.PARADE_PROCESSING_SENTINEL });
  });
});

describe('rows that are not due', () => {
  test.each([
    ['an empty cell', ''],
    ['whitespace only', '   \n  '],
  ])('skips a row whose text is %s, with no AI call', (_label, text) => {
    const env = withRow({ text });
    const calls = env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');

    expect(calls).toHaveLength(0);
    expect(outcome(env, 2)).toEqual({ id: '', error: '' });
  });

  test('writes nothing at all when the responses header does not match', () => {
    // A wrong header means every column index is meaningless, so writing an error into
    // what we believe is the error column could overwrite real data. Log only.
    const env = withRow({ header: ['Timestamp', 'Something Else', 'x', 'y', 'z'] });
    const calls = env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');

    expect(calls).toHaveLength(0);
    expect(env.rawRow(2)[3]).toBe('');
    expect(dataRows(env, env.globals.SHEET_NAMES.STRENGTH_DATA)).toBe(0);
    expect(env.logs.join('\n')).toContain('header does not match');
  });

  test('names both the expected and the actual header, so the fix is obvious', () => {
    const env = withRow({ header: ['Timestamp', 'Something Else', 'x', 'y', 'z'] });
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');

    const log = env.logs.join('\n');
    expect(log).toContain('parade_response_id');
    expect(log).toContain('Something Else');
  });
});

describe('reprocessing', () => {
  test('replaces the key\'s output rows rather than duplicating them', () => {
    const env = withRow();
    env.stubExtraction(extraction());

    env.globals.Parser.processRow(2, '');
    env.globals.Parser.processRow(2, 'Archer_2026-06-19_FPS');

    expect(dataRows(env, env.globals.SHEET_NAMES.STRENGTH_DATA)).toBe(2);
    expect(dataRows(env, env.globals.SHEET_NAMES.PERSONNEL_DATA)).toBe(1);
    expect(dataRows(env, env.globals.SHEET_NAMES.COMMAND_ROSTER)).toBe(1);
  });

  test('removes the previous key\'s rows when a corrected message changes the key', () => {
    // The gap this closes: fix a wrong date in the message, clear the id, and the old
    // key's rows would otherwise sit in all three tabs forever with nothing pointing
    // at them.
    const env = withRow();
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');

    env.stubExtraction(extraction({ date: '2026-06-20' }));
    env.globals.Parser.processRow(2, 'Archer_2026-06-19_FPS');

    const strength = env.sheetOf(env.globals.SHEET_NAMES.STRENGTH_DATA);
    const keys = strength.rows.slice(1).map((row) => row[0]);
    expect(keys).toEqual(['Archer_2026-06-20_FPS', 'Archer_2026-06-20_FPS']);
    expect(outcome(env, 2).id).toBe('Archer_2026-06-20_FPS');
  });

  test('keeps another submission\'s rows when clearing the previous key', () => {
    const env = loadParser({
      rawRows: [
        [new Date(), RAW_TEXT, '', '', ''],
        [new Date(), 'BRAVES FIRST PARADE STATE ...', '', '', ''],
      ],
    });

    env.stubExtraction(extraction({ company: 'Braves' }));
    env.globals.Parser.processRow(3, '');
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, '');

    expect(dataRows(env, env.globals.SHEET_NAMES.STRENGTH_DATA)).toBe(4);
    expect(outcome(env, 2).id).toBe('Archer_2026-06-19_FPS');
    expect(outcome(env, 3).id).toBe('Braves_2026-06-19_FPS');
  });

  test('ignores an ERROR sentinel as a previous key', () => {
    // PARADE_ERROR_SENTINEL is not a key, so it must never be handed to a delete.
    const env = withRow();
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(2, env.globals.PARADE_ERROR_SENTINEL);

    expect(outcome(env, 2).id).toBe('Archer_2026-06-19_FPS');
    expect(dataRows(env, env.globals.SHEET_NAMES.STRENGTH_DATA)).toBe(2);
  });
});

describe('duplicate response rows', () => {
  test('deletes another row that already processed to the same key', () => {
    const env = loadParser({
      rawRows: [
        [new Date(), RAW_TEXT, 'MSG1', 'Archer_2026-06-19_FPS', ''],
        [new Date(), RAW_TEXT, 'MSG2', '', ''],
      ],
    });
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(3, '');

    const rows = env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows;
    expect(rows).toHaveLength(2);
    expect(rows[1][2]).toBe('MSG2');
    expect(rows[1][3]).toBe('Archer_2026-06-19_FPS');
  });

  test('leaves a failed row alone, since it holds no key', () => {
    const env = loadParser({
      rawRows: [
        [new Date(), 'unreadable', 'MSG1', 'ERROR', 'Company could not be determined.'],
        [new Date(), RAW_TEXT, 'MSG2', '', ''],
      ],
    });
    env.stubExtraction(extraction());
    env.globals.Parser.processRow(3, '');

    expect(env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows).toHaveLength(3);
  });
});

describe('reprocessPendingRows', () => {
  test('processes every still-blank row, leaving keyed and ERROR rows untouched', () => {
    const env = loadParser({
      rawRows: [
        [new Date(), RAW_TEXT, 'MSG1', '', ''], //                                  row 2 — due
        [new Date(), RAW_TEXT, 'MSG2', 'Braves_2026-06-19_FPS', ''], //             row 3 — done
        [new Date(), 'unreadable', 'MSG3', 'ERROR', 'Company could not be determined.'], // row 4 — failed
        [new Date(), RAW_TEXT, 'MSG4', '', 'Processing...'], //                     row 5 — killed mid-run
      ],
    });
    env.stubExtraction(extraction());

    env.globals.reprocessPendingRows();

    expect(outcome(env, 2)).toEqual({ id: 'Archer_2026-06-19_FPS', error: '' });
    // The ERROR row is left exactly as it was — this macro never retries failures.
    expect(outcome(env, 4)).toEqual({ id: env.globals.PARADE_ERROR_SENTINEL, error: 'Company could not be determined.' });
    // Rows 2 and 5 both resolve to the Archer key, so the duplicate raw row is collapsed away.
    const rawRows = env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows;
    expect(rawRows.map((row) => row[3])).toEqual([
      'parade_response_id',
      'Archer_2026-06-19_FPS',
      'Braves_2026-06-19_FPS',
      env.globals.PARADE_ERROR_SENTINEL,
    ]);
  });

  test('does not skip a blank row when an earlier reprocess deletes a duplicate above it', () => {
    // The live bottom-up re-scan has to survive row indices shifting mid-sweep.
    const env = loadParser({
      rawRows: [
        [new Date(), 'ARCHER FIRST PARADE STATE ...', 'MSG1', '', ''], //   row 2 — due, key A
        [new Date(), RAW_TEXT, 'MSG2', 'Cougar_2026-06-19_FPS', ''], //     row 3 — stale duplicate of row 5's key
        [new Date(), 'BRAVES FIRST PARADE STATE ...', 'MSG3', '', ''], //   row 4 — due, key B
        [new Date(), RAW_TEXT, 'MSG4', '', ''], //                          row 5 — due, key Cougar (collapses row 3)
      ],
    });
    env.stubExtraction((text) => {
      if (text.startsWith('ARCHER')) return extraction();
      if (text.startsWith('BRAVES')) return extraction({ company: 'Braves' });
      return extraction({ company: 'Cougar' });
    });

    env.globals.reprocessPendingRows();

    const rawRows = env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows;
    const keys = rawRows.slice(1).map((row) => row[3]);
    expect(keys.sort()).toEqual(['Archer_2026-06-19_FPS', 'Braves_2026-06-19_FPS', 'Cougar_2026-06-19_FPS']);
    // No blank row left behind.
    expect(keys).not.toContain('');
  });

  test('does nothing on a sheet with no rows below the header', () => {
    const env = loadParser({ rawRows: [] });
    env.stubExtraction(extraction());

    expect(() => env.globals.reprocessPendingRows()).not.toThrow();
    expect(env.sheetOf(env.globals.SHEET_NAMES.RAW_RESPONSES).rows).toHaveLength(1);
  });
});
