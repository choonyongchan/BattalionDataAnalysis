/**
 * The password's whole life, from typed to forgotten.
 *
 * It is held in one module-scoped variable and never written to `localStorage`,
 * `sessionStorage`, or a cookie. Locking reloads the page, which is the most complete way
 * to forget it: the variable goes with the document. A failed attempt discards it too, so
 * a wrong password is not left sitting in memory waiting to be retried by something else.
 *
 * There is no password check in this file, and there must not be one. The check happens
 * in `src/dashboard/DashboardFeed.js`, where the caller cannot see or skip it. A check
 * here would be decoration.
 */

import { loadAll } from '../data/feed.js';
import { dataset, loadError, reset, status } from './state.js';

/** @type {string} The password the viewer typed, for this tab only. */
let password = '';

/**
 * Attempts to unlock the dashboard with a password.
 *
 * On failure the password is discarded rather than kept for a retry — the next attempt
 * types it again.
 * @param {string} typed The password from the login form.
 * @returns {!Promise<boolean>} True once data is loaded.
 */
export function unlock(typed) {
  if (typed === '') {
    loadError.value = 'Enter the password.';
    return Promise.resolve(false);
  }

  password = typed;
  status.value = 'loading';
  loadError.value = '';

  return loadAll(password)
    .then((data) => {
      dataset.value = data;
      status.value = 'ready';
      return true;
    })
    .catch((error) => {
      password = '';
      loadError.value = error.message;
      status.value = 'locked';
      return false;
    });
}

/**
 * Re-reads the spreadsheet with the password already held.
 * @returns {!Promise<boolean>} True once fresh data is loaded.
 */
export function refresh() {
  if (password === '') {
    return Promise.resolve(false);
  }
  status.value = 'loading';
  return loadAll(password)
    .then((data) => {
      dataset.value = data;
      status.value = 'ready';
      return true;
    })
    .catch((error) => {
      loadError.value = error.message;
      status.value = 'error';
      return false;
    });
}

/**
 * Forgets the password and everything loaded with it.
 * @returns {void}
 */
export function lock() {
  password = '';
  reset();
  window.location.reload();
}
