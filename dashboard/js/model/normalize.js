/**
 * Turns raw Sheets API values into typed records.
 *
 * Two problems this module exists to solve, both of which produce wrong charts rather
 * than errors when handled casually:
 *
 * 1. **Column position is not stable.** Headers are resolved by name at read time, and
 *    a missing required header throws with the tab and header named. Reading `reason`
 *    out of the `location` column would chart cleanly and be entirely wrong.
 * 2. **A date cell arrives in more than one shape.** A cell holding `2026-06-22` may
 *    come back as that string, where the parser wrote text, or as a real date value
 *    Sheets coerced the write into. What must never reach here is a locale-formatted
 *    string like `22/06/2026`, which means June in Singapore and is unparseable
 *    elsewhere, or a UTC rendering of a local midnight, which slides the date back a
 *    day. `DashboardFeed.toJsonValue_` closes both off on the Apps Script side by
 *    formatting every date in the spreadsheet's own timezone; `toIsoDate` reads the
 *    result, and still accepts a Sheets serial number so the function stays correct
 *    for any caller that has one.
 *
 * Every function here is pure.
 */

/** @type {number} Milliseconds in one day. */
const MS_PER_DAY = 86400000;

/**
 * `num_days` sentinel a permanent status carries: "no expiry", not a duration.
 *
 * The parser writes it for a permanent Status entry; the episode model reads it as
 * a flag and never lets it reach a day-count. Mirrors `PERM_STATUS_NUM_DAYS` in
 * `src/parser/ParserSchema.js`.
 * @type {number}
 */
export const PERM_STATUS_NUM_DAYS = 999;

/**
 * Epoch Sheets serial numbers count from: 1899-12-30 UTC, where serial 1 is 1899-12-31.
 * @type {number}
 */
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

/** @type {string[]} Short weekday names, Monday first. */
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Renders a UTC millisecond timestamp as an ISO 'yyyy-MM-dd' date string.
 * @param {number} ms Milliseconds since the Unix epoch, UTC.
 * @returns {string} ISO 'yyyy-MM-dd'.
 */
function isoFromUtcMs_(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Builds a header-name to column-index map, verifying every required header is present.
 * @param {Array<*>} headerRow Row 1 of the tab, as returned by the Sheets API.
 * @param {string[]} required Headers the dashboard reads from this tab.
 * @param {string} tabName Tab name, used only in the error message.
 * @returns {!Object<string, number>} Header name to zero-based column index.
 * @throws {Error} If any required header is absent from the tab.
 */
export function indexHeaders(headerRow, required, tabName) {
  const header = (headerRow || []).map((cell) => String(cell == null ? '' : cell).trim());
  const index = {};
  header.forEach((name, position) => {
    if (name !== '' && !(name in index)) {
      index[name] = position;
    }
  });

  const missing = required.filter((name) => !(name in index));
  if (missing.length > 0) {
    const named = missing.map((name) => '"' + name + '"').join(', ');
    const noun = missing.length === 1 ? 'column' : 'columns';
    throw new Error(
      '"' + tabName + '" is missing ' + noun + ' ' + named +
        '. The tab layout changed, or the wrong tab was read.'
    );
  }
  return index;
}

/**
 * Maps a tab's data rows to plain objects keyed by header name.
 *
 * The Sheets API omits trailing empty cells, so a short row is not an error — every
 * requested header the row does not reach reads as ''.
 * @param {Array<Array<*>>} values The tab's values including the header row.
 * @param {string[]} required Headers to read.
 * @param {string} tabName Tab name, used only in error messages.
 * @returns {Array<!Object<string, *>>} One object per data row.
 * @throws {Error} If a required header is absent.
 */
export function toRecords(values, required, tabName) {
  const rows = values || [];
  if (rows.length === 0) {
    return [];
  }
  const index = indexHeaders(rows[0], required, tabName);
  return rows.slice(1).map((row) => {
    const record = {};
    required.forEach((name) => {
      const cell = row[index[name]];
      record[name] = cell === undefined || cell === null ? '' : cell;
    });
    return record;
  });
}

/**
 * Coerces a cell to a number, or null when it holds no usable one.
 *
 * Null rather than 0, because a blank strength cell means "not stated"; summing it as
 * zero would understate the battalion without saying so.
 * @param {*} value Cell value.
 * @returns {?number} The number, or null.
 */
export function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const text = String(value == null ? '' : value).trim();
  if (text === '') {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Coerces a cell to an ISO 'yyyy-MM-dd' date string, or null when it holds none.
 *
 * Accepts the forms the feed can produce: an ISO date, an ISO date-and-time whose
 * leading date is what matters, and a Sheets serial number. A serial is read in UTC so
 * the calendar date never shifts with the viewer's timezone — a parade state dated
 * 2026-06-22 must read as the 22nd in Singapore and in London alike.
 * @param {*} value Cell value.
 * @returns {?string} ISO 'yyyy-MM-dd', or null.
 */
export function toIsoDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return isoFromUtcMs_(SHEETS_EPOCH_MS + Math.floor(value) * MS_PER_DAY);
  }
  const text = String(value == null ? '' : value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return match ? match[1] + '-' + match[2] + '-' + match[3] : null;
}

/**
 * Trims a cell to a string, mapping blank-ish values to ''.
 * @param {*} value Cell value.
 * @returns {string} Trimmed text, or ''.
 */
export function toText(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * Normalises a person's name for use as an identity key.
 *
 * Used only as the fallback when `four_d` is blank, which is 14% of personnel rows in
 * the real data. Collapses case, punctuation and runs of whitespace, so
 * "NG JUN WEI, CALEB" and "Ng Jun Wei Caleb" resolve to the same soldier.
 * @param {*} name Raw name cell.
 * @returns {string} A normalised key, or '' when the name is blank.
 */
export function normaliseName(name) {
  return toText(name)
    .toUpperCase()
    .replace(/[.,'"()\/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Converts an ISO date string to UTC milliseconds.
 * @param {string} isoDate ISO 'yyyy-MM-dd'.
 * @returns {number} Milliseconds since the Unix epoch, at UTC midnight of that date.
 */
export function isoToUtcMs(isoDate) {
  const parts = isoDate.split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

/**
 * Adds a whole number of days to an ISO date string.
 * @param {string} isoDate ISO 'yyyy-MM-dd'.
 * @param {number} days Days to add; may be negative.
 * @returns {string} The resulting ISO 'yyyy-MM-dd'.
 */
export function addDays(isoDate, days) {
  return isoFromUtcMs_(isoToUtcMs(isoDate) + days * MS_PER_DAY);
}

/**
 * Counts days from one ISO date to another, inclusive of both ends.
 *
 * Inclusive because a one-day MC has start_date equal to end_date and must count as one
 * day, not zero.
 * @param {string} startIso ISO 'yyyy-MM-dd'.
 * @param {string} endIso ISO 'yyyy-MM-dd'.
 * @returns {number} The inclusive day span; negative when end precedes start.
 */
export function inclusiveDaySpan(startIso, endIso) {
  const days = (isoToUtcMs(endIso) - isoToUtcMs(startIso)) / MS_PER_DAY;
  return days >= 0 ? days + 1 : days;
}

/**
 * Returns the weekday for an ISO date.
 *
 * Monday-first because the bridge-day question is about Mondays and Fridays sitting at
 * the ends of the working week, which a Sunday-first index splits apart.
 * @param {string} isoDate ISO 'yyyy-MM-dd'.
 * @returns {{index: number, name: string}} Day index with Monday as 0, and its short name.
 */
export function weekdayOf(isoDate) {
  const sundayFirst = new Date(isoToUtcMs(isoDate)).getUTCDay();
  const index = (sundayFirst + 6) % 7;
  return { index, name: WEEKDAY_NAMES[index] };
}
