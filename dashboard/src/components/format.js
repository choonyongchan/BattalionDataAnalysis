/**
 * Formatters shared by every tile, table and chart caption.
 *
 * A missing value formats as an em dash everywhere in the dashboard, never as 0 or a
 * blank cell — a blank strength cell means "not stated", and printing 0 would say the
 * opposite. Ported from the previous implementation's `ui.js`; the formatting rules are
 * unchanged, only the module boundary is new.
 */

/** @type {string[]} Short month names, January first. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Formats a whole number, or an em dash when there is none.
 * @param {?number} value The number.
 * @returns {string} The formatted value.
 */
export function fmtInt(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : Math.round(value).toLocaleString('en-SG');
}

/**
 * Formats a number to one decimal place, or an em dash when there is none.
 * @param {?number} value The number.
 * @param {string=} suffix Text appended when a value is present.
 * @returns {string} The formatted value.
 */
export function fmtDecimal(value, suffix) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(1) + (suffix || '');
}

/**
 * Formats a proportion in the range 0..1 as a percentage.
 * @param {?number} value The proportion.
 * @returns {string} The formatted percentage.
 */
export function fmtShare(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : Math.round(value * 100) + '%';
}

/**
 * Formats an ISO date the way the unit writes it, e.g. '22 Jun 26'.
 * @param {?string} isoDate ISO 'yyyy-MM-dd'.
 * @returns {string} The formatted date, or an em dash when there is none.
 */
export function fmtDate(isoDate) {
  if (!isoDate) {
    return '—';
  }
  const [year, month, day] = isoDate.split('-');
  return Number(day) + ' ' + MONTHS[Number(month) - 1] + ' ' + year.slice(2);
}

/**
 * Formats a fraction as "n of m", the shape every coverage line in the dashboard uses.
 * @param {number} part The numerator.
 * @param {number} whole The denominator.
 * @returns {string} The formatted fraction, e.g. "5 of 45".
 */
export function fmtFraction(part, whole) {
  return fmtInt(part) + ' of ' + fmtInt(whole);
}

/**
 * Formats a clock time from a `values.js` `toTimeOfDay` result.
 * @param {?{hour: number, minute: number}} at A time of day, or null.
 * @returns {string} 'HH:mm', or an em dash when there is none.
 */
export function fmtTime(at) {
  if (!at) {
    return '—';
  }
  return String(at.hour).padStart(2, '0') + ':' + String(at.minute).padStart(2, '0');
}
