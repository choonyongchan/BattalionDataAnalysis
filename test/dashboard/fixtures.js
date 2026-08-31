/**
 * Sheet-shaped test data, built by the code that actually writes the sheet.
 *
 * The labelled messages in `parade-state-example/` are hand-checked ground truth, and
 * `src/parser/ParserRows.js` is what turns an extraction into rows. Running the real
 * `ParserRows` over the real labels produces fixtures that **cannot drift from the live
 * sheet layout** — if a column is added, reordered or renamed upstream, these fixtures
 * change with it and the dashboard's tests fail rather than the dashboard quietly
 * charting the wrong column. `test/parser.rows.test.js` already relies on the same
 * labels, so the two suites are pinned to one source of truth.
 *
 * Apps Script sources need no test-only modification to be used this way: `loadParser()`
 * evaluates `src/parser/*.js` in a `node:vm` context that reproduces Apps Script's single
 * shared global scope.
 *
 * These tests live here rather than under `dashboard/` for the same reason `test/` sits
 * outside `src/`: `dashboard/` is a deployment boundary, and everything inside it is
 * published to GitHub Pages. What ships is only what runs in the browser.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadParser } from '../harness.js';

/** @type {string} Directory holding the labelled messages and their expected output. */
const EXAMPLE_DIR = join(import.meta.dir, '..', '..', 'parade-state-example');

/** @type {!Object} Apps Script globals, loaded once; ParserRows holds no state. */
const { globals } = loadParser();

/**
 * Reads every labelled extraction in `parade-state-example/`.
 * @returns {Array<!Object>} The parsed `*-struct.json` objects.
 */
export function labelledExtractions() {
  return readdirSync(EXAMPLE_DIR)
    .filter((file) => file.endsWith('-struct.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(EXAMPLE_DIR, file), 'utf8')));
}

/**
 * Builds the four tabs' values arrays from the labelled extractions.
 *
 * Each tab is returned exactly as the Sheets API returns one: a header row followed by
 * data rows, values in column order.
 * @returns {{strength: Array<Array<*>>, personnel: Array<Array<*>>, roster: Array<Array<*>>}}
 *     Values arrays keyed by tab.
 */
export function sheetValues() {
  const strength = [globals.STRENGTH_DATA_COLUMNS.slice()];
  const personnel = [globals.PERSONNEL_DATA_COLUMNS.slice()];
  const roster = [globals.COMMAND_ROSTER_COLUMNS.slice()];

  labelledExtractions().forEach((extraction) => {
    const id = globals.ParserSchema.paradeResponseId_(
      extraction.company,
      extraction.date,
      extraction.session
    );
    globals.ParserRows.buildStrengthRows(extraction, id).forEach((row) => strength.push(row));
    globals.ParserRows.buildPersonnelRows(extraction, id).forEach((row) => personnel.push(row));
    globals.ParserRows.buildCommandRosterRows(extraction, id).forEach((row) => roster.push(row));
  });

  return { strength, personnel, roster };
}

/**
 * Builds a Personnel Data values array from terse row specs.
 *
 * The labelled examples are almost all one date and one session, which cannot exercise
 * episode grouping, weekday effects or repeat absence. This builds the multi-day shapes
 * those tests need, in the same column order as the real sheet.
 * @param {Array<!Object>} specs Partial rows; unset fields default to ''.
 * @returns {Array<Array<*>>} A values array including the header row.
 */
export function personnelValues(specs) {
  const columns = globals.PERSONNEL_DATA_COLUMNS;
  const rows = specs.map((spec) => columns.map((column) => (column in spec ? spec[column] : '')));
  return [columns.slice(), ...rows];
}

/**
 * Builds a Strength Data values array from terse row specs.
 * @param {Array<!Object>} specs Partial rows; unset fields default to ''.
 * @returns {Array<Array<*>>} A values array including the header row.
 */
export function strengthValues(specs) {
  const columns = globals.STRENGTH_DATA_COLUMNS;
  const rows = specs.map((spec) => columns.map((column) => (column in spec ? spec[column] : '')));
  return [columns.slice(), ...rows];
}

/**
 * Exposes the Apps Script globals so schema tests can assert against the canonical
 * column arrays rather than a copy of them.
 * @returns {!Object} The loaded Apps Script global scope.
 */
export function parserGlobals() {
  return globals;
}
