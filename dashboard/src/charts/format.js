/**
 * Number and time formatting for chart labels, tooltips and table twins.
 *
 * One copy, so a figure reads the same on the chart, in its tooltip and in the table a
 * reader copies into a brief. A count that says "1,204" on the axis and "1204" in the
 * table looks like two different numbers to someone checking one against the other.
 *
 * Locale is 'en-SG' throughout: this is a Singapore Armed Forces battalion, and the
 * dashboard should not render a number in whatever locale the reading machine happens to
 * carry.
 */

/** @type {!Intl.NumberFormat} Whole numbers with thousands separators. */
const COUNT = new Intl.NumberFormat('en-SG', { maximumFractionDigits: 0 });

/** @type {!Intl.NumberFormat} One decimal place, for a rate. */
const RATE = new Intl.NumberFormat('en-SG', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Formats a count, or an em dash when there is none.
 *
 * A missing value is not zero. Rendering it as 0 tells the reader the battalion reported
 * nobody sick, when the truth is that nobody reported.
 * @param {?number} value The count.
 * @returns {string} The formatted count, or '—'.
 */
export function fmtCount(value) {
  return Number.isFinite(value) ? COUNT.format(Math.round(value)) : '—';
}

/**
 * Formats a rate to one decimal place with an optional suffix.
 * @param {?number} value The rate.
 * @param {string=} suffix Text appended when a value is present, e.g. '%'.
 * @returns {string} The formatted rate, or '—'.
 */
export function fmtRate(value, suffix) {
  return Number.isFinite(value) ? RATE.format(value) + (suffix || '') : '—';
}

/**
 * Formats minutes past midnight as a 24-hour clock time.
 *
 * Zero-padded on both halves because the reader is comparing six of these against each
 * other down a column, and '7:05' next to '11:40' does not line up.
 * @param {?number} minutes Minutes past midnight.
 * @returns {string} 'HH:mm', or '—'.
 */
export function fmtClock(minutes) {
  if (!Number.isFinite(minutes)) {
    return '—';
  }
  const whole = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return String(Math.floor(whole / 60)).padStart(2, '0') + ':' + String(whole % 60).padStart(2, '0');
}

/**
 * Formats a part of a total as a percentage.
 * @param {number} part The part.
 * @param {number} total The whole.
 * @returns {string} e.g. '18.4%', or '—' when the total is zero or missing.
 */
export function fmtShare(part, total) {
  return Number.isFinite(part) && Number.isFinite(total) && total > 0
    ? fmtRate((part / total) * 100, '%')
    : '—';
}
