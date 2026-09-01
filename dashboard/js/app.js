/**
 * Application shell: password gate, data load, filters, routing.
 *
 * The shell owns all state. Views are pure render functions taking a snapshot and
 * returning nodes, which is what keeps a filter change from having to know which view is
 * on screen: the shell re-derives the slice and asks whoever is current to draw it again.
 *
 * The filter row lives here rather than in any view, so every panel on screen is always
 * showing the same slice of data.
 *
 * The password is held in a module-scoped variable and nowhere else — not in
 * `sessionStorage`, not in a cookie, not in the DOM after the gate closes. So a reload
 * asks again, which is the right default for a screen in a command post: the session
 * ends when the tab does. It is kept because the feed is the only thing that can verify
 * it, and a reload of the data needs it again.
 */

import { isConfigured, loadAll } from './feed.js';
import { buildEpisodes } from './model/episodes.js';
import { toSubmissions } from './model/formsg.js';
import { datesPresent, sessionsOn } from './model/metrics.js';
import { toIsoDate, toText } from './model/normalize.js';
import { COMPANIES } from './model/schema.js';
import { disposeAll, resizeAll } from './charts.js';
import { banner, el, fmtDate, replace } from './ui.js';
import { renderToday } from './views/today.js';
import { renderCategory } from './views/category.js';
import { renderSoldier } from './views/soldier.js';
import { DUTY_CLASS } from './model/classify.js';

/**
 * View renderers by route name.
 *
 * The three category views are one function, not three: MC, report sick and status ask
 * the same four questions — how is it trending, which company, which platoon, who most
 * often — and answering them from one renderer is what guarantees the three tabs stay
 * readable as the same layout rather than drifting apart panel by panel.
 * @type {!Object<string, function(!Object): Array<Node>>}
 */
const VIEWS = {
  today: renderToday,
  mc: (view) => renderCategory(view, CATEGORIES.mc),
  reportsick: (view) => renderCategory(view, CATEGORIES.reportsick),
  status: (view) => renderCategory(view, CATEGORIES.status),
  soldier: renderSoldier,
};

/**
 * What each category view is about, in the unit's own words.
 * @type {!Object<string, !Object>}
 */
const CATEGORIES = {
  mc: {
    key: 'mc',
    dutyClass: DUTY_CLASS.ATT_C,
    title: 'Att C',
    full: 'Att C',
    noun: 'Att C',
    // The repeat table counts episodes and sums the days they cost. Both columns are
    // named after the category rather than after the model, because "3 episodes, 11
    // days" means nothing to a commander until it reads "3 Att C, 11 days away".
    countLabel: '# Att C',
    daysLabel: 'Days away',
    // Att C is excused all duties, so an MC day is a day of strength the battalion
    // does not have. That is why this view leads on days lost, where the other two
    // lead on headcount.
    countsDays: true,
    showPatterns: true,
  },
  reportsick: {
    key: 'reportsick',
    dutyClass: DUTY_CLASS.REPORT_SICK,
    title: 'Report sick',
    full: 'Report sick',
    noun: 'report sick',
    countLabel: '# Report sick',
    daysLabel: 'Days',
    countsDays: false,
    showReasons: true,
  },
  status: {
    key: 'status',
    dutyClass: DUTY_CLASS.STATUS,
    title: 'Status',
    full: 'Status (Att B / LD)',
    noun: 'status',
    countLabel: '# Status',
    daysLabel: 'Days on status',
    countsDays: true,
    presentButRestricted: true,
  },
};

/** @type {string} The password the viewer typed, held in memory for this tab only. */
let password = '';

/**
 * Everything loaded and derived once per unlock.
 *
 * `session` is derived from the data rather than chosen: every parade state in the sheet
 * is a first parade, so there is nothing to choose between. It stays a variable instead
 * of a hard-coded 'FPS' so that a battalion which starts filing last parades gets its
 * rows read rather than silently dropped.
 * @type {!Object}
 */
const state = {
  data: null,
  episodes: [],
  submissions: [],
  dates: [],
  session: 'FPS',
  filters: { date: null, company: 'ALL' },
};

/**
 * Looks up an element by id.
 * @param {string} id The element id.
 * @returns {!HTMLElement} The element.
 */
function byId(id) {
  return document.getElementById(id);
}

/**
 * The route named by the current location hash.
 * @returns {string} A key of VIEWS.
 */
function currentRoute() {
  const name = (window.location.hash || '').replace('#/', '');
  return VIEWS[name] ? name : 'today';
}

/**
 * Loads the spreadsheet and derives everything the views read.
 * @returns {!Promise<void>} Resolves once the dashboard is showing data.
 */
function load() {
  return loadAll(password).then((data) => {
    state.data = data;
    state.episodes = buildEpisodes(data.personnel);
    state.submissions = toSubmissions(data.formSg);
    state.dates = datesPresent(data.strength);
    state.filters.date = state.dates[state.dates.length - 1] || null;
    state.session = sessionOf_(data.strength, state.filters.date);
    fillControls();
    byId('gate').hidden = true;
    byId('controls').hidden = false;
    byId('lock').hidden = false;
    // The field is cleared once its value is held: leaving the typed password sitting
    // in an input is one screenshot or one shoulder away from being shared.
    byId('password').value = '';
    render();
  });
}

/**
 * Populates the filter row from the data that actually loaded.
 *
 * Options come from the data rather than a fixed list, so a date with no parade state
 * cannot be selected and then quietly show zeroes.
 * @returns {void}
 */
function fillControls() {
  const dateSelect = byId('control-date');
  replace(
    dateSelect,
    state.dates
      .slice()
      .reverse()
      .map((date) => el('option', { value: date }, fmtDate(date)))
  );
  dateSelect.value = state.filters.date || '';

  const companySelect = byId('control-company');
  const present = COMPANIES.filter((company) =>
    state.data.strength.some((row) => toText(row.company) === company)
  );
  replace(companySelect, [
    el('option', { value: 'ALL' }, 'All companies'),
    ...present.map((company) => el('option', { value: company }, company)),
  ]);
  companySelect.value = state.filters.company;
}

/**
 * The parade session to read, taken from the data.
 * @param {Array<!Object>} strengthRows Normalised Strength Data records.
 * @param {?string} isoDate The selected date.
 * @returns {string} The session filed on that date, falling back to 'FPS'.
 */
function sessionOf_(strengthRows, isoDate) {
  return sessionsOn(strengthRows, isoDate)[0] || 'FPS';
}

/**
 * Builds the snapshot a view renders from.
 *
 * Every trend covers everything ingested. There is no window to choose, so `date` selects
 * which parade the "today" figures describe and nothing else — a reader can never be
 * looking at a rate whose span they have to remember.
 * @returns {!Object} The current slice of the data.
 */
function snapshot() {
  const { date, company } = state.filters;
  const inCompany = (row) => company === 'ALL' || toText(row.company) === company;

  return {
    date,
    session: state.session,
    company,
    dates: state.dates,
    firstDate: state.dates[0] || null,
    lastDate: state.dates[state.dates.length - 1] || null,
    previousDate: previousDate_(date),
    strength: state.data.strength.filter(inCompany),
    personnel: state.data.personnel.filter(inCompany),
    roster: state.data.roster.filter(inCompany),
    episodes: state.episodes.filter(
      (episode) => company === 'ALL' || episode.company === company
    ),
    submissions: state.submissions.filter(
      (submission) =>
        company === 'ALL' || submission.company === company || submission.company === ''
    ),
    formSgAvailable: state.data.formSgAvailable,
    formSgNote: state.data.formSgNote,
  };
}

/**
 * The parade date immediately before the selected one.
 * @param {?string} isoDate The selected date.
 * @returns {?string} The previous date with data, or null if this is the earliest.
 */
function previousDate_(isoDate) {
  const index = state.dates.indexOf(isoDate);
  return index > 0 ? state.dates[index - 1] : null;
}

/**
 * Redraws the masthead's signal line and company strip for the current selection.
 * @param {!Object} view The current snapshot.
 * @returns {void}
 */
function renderMasthead(view) {
  const filed = COMPANIES.filter((company) =>
    state.data.strength.some(
      (row) =>
        toText(row.company) === company &&
        toIsoDate(row.date) === view.date &&
        toText(row.session) === view.session
    )
  );

  byId('signal-line').textContent = [
    'BN PERSONNEL',
    fmtDate(view.date).toUpperCase(),
    view.session,
    filed.length + '/' + COMPANIES.length + ' FILED',
  ].join(' · ');

  replace(
    byId('coy-strip'),
    COMPANIES.map((company) => {
      const isFiled = filed.includes(company);
      const cell = el('li', 'coy-cell' + (isFiled ? ' coy-cell--filed' : ''), company.slice(0, 3));
      cell.title = company + (isFiled ? ' — parade state filed' : ' — no parade state filed');
      return cell;
    })
  );
}

/**
 * Renders the current route.
 * @returns {void}
 */
function render() {
  if (!state.data) {
    return;
  }
  const route = currentRoute();
  Array.from(document.querySelectorAll('.tab')).forEach((tab) => {
    if (tab.dataset.view === route) {
      tab.setAttribute('aria-current', 'page');
    } else {
      tab.removeAttribute('aria-current');
    }
  });

  const view = snapshot();
  renderMasthead(view);

  const host = byId('view');
  disposeAll();
  try {
    replace(host, VIEWS[route](view, { onFilter: setFilter }));
  } catch (error) {
    replace(host, [
      banner(
        'critical',
        'Error',
        error.message === 'ECHARTS_MISSING'
          ? 'The charting library did not load. Check the network connection and reload — the table view in each panel still works once it does.'
          : error.message
      ),
    ]);
  }
  resizeAll();
}

/**
 * Applies a filter change from a view and redraws.
 * @param {string} name Filter name.
 * @param {*} value New value.
 * @returns {void}
 */
function setFilter(name, value) {
  state.filters[name] = value;
  if (name === 'date') {
    state.session = sessionOf_(state.data.strength, value);
  }
  render();
}

/**
 * Shows a message on the password gate.
 * @param {string} message What went wrong, and what to do about it.
 * @returns {void}
 */
function showGateError(message) {
  const node = byId('gate-error');
  node.textContent = message;
  node.hidden = false;
}

/**
 * Wires the filter row, tabs, resize handling and the password gate.
 * @returns {void}
 */
function wire() {
  byId('control-date').addEventListener('change', (event) => setFilter('date', event.target.value));
  byId('control-company').addEventListener('change', (event) =>
    setFilter('company', event.target.value)
  );

  window.addEventListener('hashchange', render);
  window.addEventListener('resize', debounce_(resizeAll, 150));

  // A form, so Enter submits — the whole interaction is one field and one key. The
  // field carries no `required`: HTML validation would block the submit before this
  // handler ran, leaving an empty password answered by a browser bubble in the
  // browser's own voice instead of the gate's. `unlock` does that check itself.
  byId('gate-form').addEventListener('submit', (event) => {
    event.preventDefault();
    unlock();
  });

  byId('lock').addEventListener('click', () => {
    // A reload is the whole sign-out: the password lives only in this page's memory,
    // so discarding the page discards it.
    window.location.reload();
  });
}

/**
 * Tries the typed password against the feed.
 * @returns {void}
 */
function unlock() {
  const typed = byId('password').value;
  if (typed === '') {
    showGateError('Enter the dashboard password.');
    return;
  }

  const button = byId('unlock');
  byId('gate-error').hidden = true;
  button.disabled = true;
  button.textContent = 'Checking…';

  password = typed;
  load().catch((error) => {
    // Discarded on failure so a wrong password is not retried by a later reload of
    // the data, which would spend another attempt against the lockout.
    password = '';
    button.disabled = false;
    button.textContent = 'Unlock';
    byId('password').value = '';
    byId('password').focus();
    showGateError(error.message);
  });
}

/**
 * Debounces a function so a drag-resize does not redraw on every pixel.
 * @param {function(): void} fn The function to debounce.
 * @param {number} wait Milliseconds of quiet before running.
 * @returns {function(): void} The debounced function.
 */
function debounce_(fn, wait) {
  let timer = null;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, wait);
  };
}

/**
 * Starts the dashboard.
 * @returns {void}
 */
function start() {
  wire();

  if (!isConfigured()) {
    byId('gate-form').hidden = true;
    byId('gate-body').textContent =
      'This dashboard has no feed URL yet, so it has nothing to ask for the data. Follow ' +
      'the two setup steps in dashboard/README.md, put the web app URL in ' +
      'dashboard/js/config.js, and reload.';
    return;
  }

  byId('password').focus();
}

start();
