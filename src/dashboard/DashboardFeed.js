/**
 * Serves the dashboard's read-only view of the spreadsheet, behind one password.
 *
 * ## Why this exists
 *
 * The dashboard is a static page on GitHub Pages, so it holds no credential of its
 * own and cannot read a private spreadsheet by itself. Something has to. The two
 * ways to give it data are not equally safe:
 *
 *   - Publish the tabs to the web and check a password in the page's JavaScript.
 *     The check is then decoration: the published CSV URLs work for anyone who
 *     reads the page source, password box untouched.
 *   - Keep the spreadsheet private and put the check *here*, where the caller
 *     cannot see or skip it. A wrong password gets `unauthorised` and no rows.
 *
 * This file is the second. The web app is deployed `USER_DEPLOYING`, so it reads the
 * sheet as its owner; the spreadsheet's sharing list never has to grow, and nothing
 * is published anywhere.
 *
 * ## What guards it
 *
 * A shared secret in the `DASHBOARD_PASSWORD` script property, checked exactly as
 * `Parser.isAuthorised_` and `FormSgSheet.isAuthorised_` check theirs, and failing
 * closed the same way: an unset property rejects every request rather than waving it
 * through. Apps Script cannot read request headers, so the password travels in the
 * POST body over HTTPS, as both ingest tokens already do.
 *
 * The difference from those two routes is what a correct guess is worth. Theirs buy
 * an attacker junk rows in one tab, or API spend; this one hands over the whole
 * battalion's names and medical reasons. So it also counts failures
 * (`FAILURE_LIMIT` in `LOCKOUT_SECONDS`) and stops answering when they mount up.
 * That is a speed bump against online guessing, not a guarantee — script cache
 * entries can be evicted early, and the counter is battalion-wide rather than
 * per-caller because an Apps Script handler cannot see who is calling. The real
 * defence is a long random passphrase; see dashboard/README.md.
 *
 * ## Ownership
 *
 * Strictly read-only, and strictly downstream: nothing here writes a cell, and
 * neither intake imports it. It reads whatever the parade-state and FormSG
 * pipelines have already written, and knows nothing about how a row got there. See
 * docs/architecture_patterns.md.
 */

/**
 * Script-property key holding the dashboard password. Kept next to its only reader.
 * @type {string}
 */
const DASHBOARD_PASSWORD_KEY = 'DASHBOARD_PASSWORD';

/**
 * Tabs the dashboard reads, in the order it wants them.
 *
 * A tab that does not exist is reported as absent rather than failing the request.
 * The FormSG intake is genuinely optional, and a battalion that has not set it up
 * should still get a working dashboard instead of an error naming a tab they have
 * never heard of.
 * @type {string[]}
 */
const DASHBOARD_TABS = [
  'Strength Data',
  'Personnel Data',
  'Command Roster',
  'Report Sick FormSG Responses',
];

/** @type {string} Script-cache key counting recent failed password attempts. */
const DASHBOARD_FAILURE_KEY = 'dashboard_failed_attempts';

/** @type {number} Failed attempts tolerated before the route stops answering. */
const FAILURE_LIMIT = 10;

/** @type {number} Seconds a failure counter, and so a lockout, survives. */
const LOCKOUT_SECONDS = 900;

class DashboardFeed {
  /**
   * Handles one dashboard data request end to end.
   *
   * Always answers 200 with a JSON body, because `ContentService` cannot set a
   * status code. The body's `ok` field is what the caller branches on.
   *
   * @param {!Object} e The Apps Script doPost event object.
   * @returns {!GoogleAppsScript.Content.TextOutput} A JSON response body.
   */
  static handlePost(e) {
    const body = DashboardFeed.parseBody_(e);
    if (!body) {
      Logger.log('Dashboard: rejected a request whose body was not readable JSON.');
      return DashboardFeed.reply_({ ok: false, error: 'bad_request' });
    }

    if (DashboardFeed.isLockedOut_()) {
      Logger.log(
        `Dashboard: refused a request while locked out after ${FAILURE_LIMIT} failed ` +
          'password attempts. Unlocks itself; see DashboardFeed.js.'
      );
      return DashboardFeed.reply_({ ok: false, error: 'locked_out' });
    }

    if (!DashboardFeed.isAuthorised_(body.password)) {
      const failures = DashboardFeed.recordFailure_();
      Logger.log(
        `Dashboard: rejected a request with a missing or incorrect password ` +
          `(${failures} of ${FAILURE_LIMIT} before lockout).`
      );
      return DashboardFeed.reply_({ ok: false, error: 'unauthorised' });
    }

    DashboardFeed.clearFailures_();
    return DashboardFeed.reply_({
      ok: true,
      generatedAt: new Date().toISOString(),
      tabs: DashboardFeed.readTabs_(),
    });
  }

  /**
   * Checks a request's password against the stored one.
   *
   * Fails closed: if `DASHBOARD_PASSWORD` was never set, `expected` is null and every
   * request is rejected. Mirrors `Parser.isAuthorised_` and
   * `FormSgSheet.isAuthorised_`, deliberately including the plain comparison — a
   * timing side channel measured in microseconds is not reachable through an Apps
   * Script web app, whose own response time varies by hundreds of milliseconds.
   * @param {*} password The password supplied in the request body.
   * @returns {boolean} True if the password is present and matches the stored value.
   * @private
   */
  static isAuthorised_(password) {
    const expected = PropertiesService.getScriptProperties().getProperty(DASHBOARD_PASSWORD_KEY);
    return Boolean(expected) && String(password) === expected;
  }

  /**
   * Whether recent failures have crossed the lockout threshold.
   * @returns {boolean} True while the route should refuse to answer.
   * @private
   */
  static isLockedOut_() {
    return DashboardFeed.failureCount_() >= FAILURE_LIMIT;
  }

  /**
   * Reads the current failure count.
   * @returns {number} Failures recorded in the current window; 0 if none or unreadable.
   * @private
   */
  static failureCount_() {
    const raw = CacheService.getScriptCache().get(DASHBOARD_FAILURE_KEY);
    const count = Number(raw);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  /**
   * Counts one failed attempt, restarting the lockout window.
   *
   * The expiry is re-set on every failure, so sustained guessing keeps the lockout
   * alive rather than waiting it out under a fixed deadline.
   * @returns {number} The new failure count.
   * @private
   */
  static recordFailure_() {
    const next = DashboardFeed.failureCount_() + 1;
    CacheService.getScriptCache().put(DASHBOARD_FAILURE_KEY, String(next), LOCKOUT_SECONDS);
    return next;
  }

  /**
   * Forgets recorded failures after a correct password.
   * @returns {void}
   * @private
   */
  static clearFailures_() {
    CacheService.getScriptCache().remove(DASHBOARD_FAILURE_KEY);
  }

  /**
   * Extracts the request body.
   * @param {!Object} e The Apps Script doPost event object.
   * @returns {?Object} The parsed body, or null if absent or unparseable.
   * @private
   */
  static parseBody_(e) {
    try {
      if (!e || !e.postData || !e.postData.contents) return null;
      const body = JSON.parse(e.postData.contents);
      return body && typeof body === 'object' ? body : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Reads every dashboard tab in full.
   *
   * Values are returned as the sheet holds them, header row included, so the
   * dashboard resolves its columns by header name and tolerates a column being added
   * or reordered upstream.
   * @returns {!Object<string, !Array<!Array<*>>>} Tab name to values; absent tabs omitted.
   * @private
   */
  static readTabs_() {
    const spreadsheet = SpreadsheetApp.getActive();
    const timeZone = spreadsheet.getSpreadsheetTimeZone();
    const tabs = {};
    DASHBOARD_TABS.forEach((name) => {
      const sheet = spreadsheet.getSheetByName(name);
      if (!sheet) {
        Logger.log(`Dashboard: tab "${name}" does not exist; reporting it as absent.`);
        return;
      }
      tabs[name] = DashboardFeed.readSheet_(sheet, timeZone);
    });
    return tabs;
  }

  /**
   * Reads one sheet's used range as JSON-safe values.
   * @param {!GoogleAppsScript.Spreadsheet.Sheet} sheet The sheet to read.
   * @param {string} timeZone The spreadsheet's timezone, for rendering dates.
   * @returns {!Array<!Array<*>>} Cell values, row-major, header row first.
   * @private
   */
  static readSheet_(sheet, timeZone) {
    const rows = sheet.getLastRow();
    const columns = sheet.getLastColumn();
    if (rows === 0 || columns === 0) {
      return [];
    }
    return sheet
      .getRange(1, 1, rows, columns)
      .getValues()
      .map((row) => row.map((cell) => DashboardFeed.toJsonValue_(cell, timeZone)));
  }

  /**
   * Renders one cell as a value JSON can carry without losing its meaning.
   *
   * Dates are the whole reason this function exists. `JSON.stringify` renders a Date
   * in UTC, which turns a parade state dated the 22nd into `2026-06-21T16:00:00Z`
   * and shifts every Singapore date back a day. So a date is formatted in the
   * spreadsheet's own timezone: `yyyy-MM-dd` when it carries no time of day, and
   * `yyyy-MM-dd HH:mm:ss` when it does, which keeps a FormSG submission time
   * intact. The dashboard's `toIsoDate` reads the leading date out of either.
   *
   * @param {*} cell The raw cell value.
   * @param {string} timeZone The spreadsheet's timezone.
   * @returns {*} A string, number, boolean, or '' for a blank cell.
   * @private
   */
  static toJsonValue_(cell, timeZone) {
    if (cell instanceof Date) {
      const hasTime = Utilities.formatDate(cell, timeZone, 'HHmmss') !== '000000';
      const pattern = hasTime ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd';
      return Utilities.formatDate(cell, timeZone, pattern);
    }
    if (cell === null || cell === undefined) {
      return '';
    }
    return cell;
  }

  /**
   * Serialises a response body for the caller.
   * @param {!Object} payload The object to return as JSON.
   * @returns {!GoogleAppsScript.Content.TextOutput} A JSON response.
   * @private
   */
  static reply_(payload) {
    return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
      ContentService.MimeType.JSON
    );
  }
}
