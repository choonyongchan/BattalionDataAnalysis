/**
 * Sheet-shaped test data, built by the code that actually writes the sheet.
 *
 * `src/parser/ParserRows.js` is what turns an extraction into rows, and the column order
 * here comes straight from its `*_DATA_COLUMNS` constants — so if a column is added,
 * reordered or renamed upstream, these fixtures change with it and the dashboard's tests
 * fail rather than the dashboard quietly charting the wrong column.
 *
 * Apps Script sources need no test-only modification to be used this way: `loadParser()`
 * evaluates `src/parser/*.js` in a `node:vm` context that reproduces Apps Script's single
 * shared global scope.
 *
 * These tests live here rather than under `dashboard/` for the same reason `test/` sits
 * outside `src/`: `dashboard/` is a deployment boundary, and everything inside it is
 * published to GitHub Pages. What ships is only what runs in the browser.
 */

import { loadParser } from '../harness.js';

/** @type {!Object} Apps Script globals, loaded once; ParserRows holds no state. */
const { globals } = loadParser();

/**
 * Builds a Personnel Data values array from terse row specs.
 *
 * Builds the multi-day shapes episode grouping, weekday effects and repeat-absence tests
 * need, in the same column order as the real sheet.
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
