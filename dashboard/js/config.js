/**
 * Deployment settings for the dashboard.
 *
 * Nothing here is a secret, and nothing here needs to be. The feed URL names an
 * endpoint that refuses to answer without the password, and the password is never in
 * this file, this repo, or this page — it lives in the `DASHBOARD_PASSWORD` script
 * property on the Apps Script side, is typed by the viewer, and is checked where the
 * viewer cannot see or skip the check.
 *
 * Setting FEED_URL is the one edit needed before the dashboard works; see
 * `dashboard/README.md`.
 */

/**
 * The deployed Apps Script web app, with the dashboard route.
 *
 * This is the same `/exec` URL that already receives parade states and report-sick
 * submissions, with `?route=dashboard` appended — one deployment, three routes. See
 * `src/WebApp.js`.
 *
 * Left unset deliberately rather than filled with a plausible-looking placeholder:
 * `feed.js` checks for the empty string and shows the setup steps instead of
 * failing against a URL that does not exist.
 * @type {string}
 */
export const FEED_URL = 'https://script.google.com/macros/s/AKfycbwm2lXBjeqFFy1wYvufxb8O6W1yG_Md-hhi64R3wzK6RN6v2fLL9TQlHJLxmYlQTLA/exec?route=dashboard';
