/**
 * Reads the spreadsheet through the Apps Script feed.
 *
 * One POST carrying the password, one JSON reply holding every tab. The password is
 * checked on the Apps Script side (`src/dashboard/DashboardFeed.js`), which is the
 * whole point: a check in this file would be a check the caller could skip by reading
 * the page source, and the spreadsheet would have to be public for the data to be
 * reachable at all.
 *
 * Two request details are not stylistic:
 *
 * - **`Content-Type: text/plain`**, even though the body is JSON. A JSON content type
 *   makes the request non-simple, so the browser sends a CORS preflight first — and
 *   Apps Script web apps do not answer `OPTIONS`, so the request would fail before
 *   the password ever left the machine. `text/plain` keeps it a simple request.
 *   `DashboardFeed.parseBody_` reads the body with `JSON.parse` regardless.
 * - **The password goes in the body, never the URL.** A query string lands in browser
 *   history, in referrer headers, and in Google's request logs. A body does not.
 *
 * The password is held by `app.js` in memory only and passed in on each call, so it
 * is never written to `localStorage`, `sessionStorage`, or a cookie.
 */

import { FEED_URL } from './config.js';
import { toRecords } from './model/normalize.js';
import {
  FORMSG_HEADERS,
  PERSONNEL_HEADERS,
  ROSTER_HEADERS,
  STRENGTH_HEADERS,
  TABS,
} from './model/schema.js';

/**
 * What each error code the feed can return means to the person reading the screen.
 * @type {!Object<string, string>}
 */
const FEED_ERRORS = {
  unauthorised: 'That password is not right.',
  locked_out:
    'Too many wrong passwords. The dashboard has locked itself for 15 minutes — that ' +
    'is the guard against someone guessing, so it cannot be skipped. Try again after.',
  bad_request: 'The feed could not read the request. Check FEED_URL in dashboard/js/config.js.',
};

/**
 * Whether a feed URL has been configured.
 * @returns {boolean} True when `config.js` names an endpoint.
 */
export function isConfigured() {
  return FEED_URL !== '';
}

/**
 * Requests every tab from the feed.
 * @param {string} password The password the viewer typed.
 * @returns {!Promise<!Object<string, !Array<!Array<*>>>>} Tab name to values.
 * @throws {Error} If the password is wrong, or the feed is unreachable.
 */
function fetchTabs_(password) {
  return fetch(FEED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ password }),
  })
    .catch(() => {
      throw new Error(
        'Could not reach the dashboard feed. Check the network connection, and that ' +
          'FEED_URL in dashboard/js/config.js points at a deployed web app.'
      );
    })
    .then((response) => readBody_(response))
    .then((body) => {
      if (!body.ok) {
        const error = new Error(FEED_ERRORS[body.error] || 'The feed refused the request.');
        error.code = body.error || 'unknown';
        throw error;
      }
      return body.tabs || {};
    });
}

/**
 * Parses the feed's reply.
 *
 * An Apps Script exception is answered with an HTML error page rather than JSON, and
 * a `/exec` URL that no longer resolves returns Google's own sign-in page. Both would
 * otherwise surface as an unexplained `SyntaxError`, so a body that is not JSON is
 * reported as what it is: a deployment problem, not a password problem.
 * @param {!Response} response The feed's response.
 * @returns {!Promise<!Object>} The parsed body.
 * @throws {Error} If the body is not JSON.
 */
function readBody_(response) {
  return response.text().then((text) => {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(
        'The feed replied with something other than data (HTTP ' + response.status + '). ' +
          'Usually this means the web app needs redeploying, or FEED_URL is missing ' +
          '"?route=dashboard". See dashboard/README.md.'
      );
    }
  });
}

/**
 * Loads every tab the dashboard reads and maps it to typed records.
 *
 * A tab whose header row no longer matches throws from `toRecords` naming the tab and
 * the missing column, which is the one failure mode worth being loud about: silently
 * reading the wrong column produces a chart that looks entirely plausible and is
 * wrong.
 *
 * The FormSG tab is optional. The feed omits a tab that does not exist, and a
 * battalion that has not set up the report-sick form should get a working dashboard
 * with a note rather than an error naming a tab they have never heard of.
 * @param {string} password The password the viewer typed.
 * @returns {!Promise<!Object>} Records per tab, plus whether FormSG data was available.
 */
export function loadAll(password) {
  if (!isConfigured()) {
    return Promise.reject(
      new Error('No feed URL is set. Add one to dashboard/js/config.js — see dashboard/README.md.')
    );
  }

  return fetchTabs_(password).then((tabs) => {
    const data = {
      strength: toRecords(tabs[TABS.STRENGTH], STRENGTH_HEADERS, TABS.STRENGTH),
      personnel: toRecords(tabs[TABS.PERSONNEL], PERSONNEL_HEADERS, TABS.PERSONNEL),
      roster: toRecords(tabs[TABS.ROSTER], ROSTER_HEADERS, TABS.ROSTER),
      formSg: [],
      formSgAvailable: false,
      formSgNote: '',
    };

    if (!tabs[TABS.FORMSG]) {
      data.formSgNote = 'The spreadsheet has no "' + TABS.FORMSG + '" tab.';
      return data;
    }

    try {
      data.formSg = toRecords(tabs[TABS.FORMSG], FORMSG_HEADERS, TABS.FORMSG);
      data.formSgAvailable = true;
    } catch (error) {
      data.formSgNote = error.message;
    }
    return data;
  });
}
