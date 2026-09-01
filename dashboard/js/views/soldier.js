/**
 * Soldier: how often one man has been out, and how long each episode ran.
 *
 * This is the view the parade state cannot give you by reading it. Each daily message
 * says who is out today; only the episode grain says that this is the fourth time in six
 * weeks. Search resolves by 4D number or name, and everything shown is what was recorded —
 * the view makes no inference about why.
 *
 * Ranked by episode count, then days. A weighted score was tried and removed: it demanded
 * a paragraph of explanation next to every table to say what it must not be used for,
 * which is a poor trade for a ranking a commander can already read off two plain columns.
 */

import { DUTY_CLASS } from '../model/classify.js';
import { leaderboard } from '../model/metrics.js';
import { normaliseName, toText } from '../model/normalize.js';
import { banner, el, fmtDate, fmtDecimal, fmtInt, sectionHead, table } from '../ui.js';

/** @type {string} The current search text, kept across re-renders within a session. */
let query = '';

/**
 * Groups a soldier's episodes into a profile.
 * @param {Array<!Object>} episodes The soldier's episodes.
 * @returns {!Object} Their profile.
 */
function profileOf_(episodes) {
  const mc = episodes.filter((episode) => episode.dutyClass === DUTY_CLASS.ATT_C);
  const sick = episodes.filter((episode) => episode.dutyClass === DUTY_CLASS.REPORT_SICK);
  const latest = episodes[episodes.length - 1] || {};
  const mcDays = mc.reduce((total, episode) => total + episode.daysLost, 0);
  return {
    name: latest.name || '',
    rank: latest.rank || '',
    fourD: latest.fourD || '',
    company: latest.company || '',
    platoon: latest.platoon || '',
    mcEpisodes: mc.length,
    mcDays,
    averageMc: mc.length > 0 ? mcDays / mc.length : null,
    sickEpisodes: sick.length,
    episodes,
  };
}

/**
 * Finds soldiers matching the search text.
 * @param {!Object} view The snapshot.
 * @returns {Array<!Object>} Matching profiles, most MC days first.
 */
function search_(view) {
  const needle = normaliseName(query);
  if (needle.length < 2) {
    return [];
  }
  const byKey = new Map();
  view.episodes.forEach((episode) => {
    const haystack = normaliseName(episode.name) + ' ' + toText(episode.fourD).toUpperCase();
    if (!haystack.includes(needle)) {
      return;
    }
    const bucket = byKey.get(episode.key) || [];
    bucket.push(episode);
    byKey.set(episode.key, bucket);
  });
  return Array.from(byKey.values())
    .map(profileOf_)
    .sort((a, b) => b.mcDays - a.mcDays)
    .slice(0, 8);
}

/**
 * Builds the search control.
 * @param {function(): void} onSearch Called when the query changes.
 * @returns {!HTMLElement} The search block.
 */
function searchBox_(onSearch) {
  const input = el('input', {
    class: 'control__input',
    type: 'search',
    id: 'soldier-search',
    placeholder: 'e.g. C4211, or Haziq',
    value: query,
    autocomplete: 'off',
  });
  input.addEventListener('input', (event) => {
    query = event.target.value;
    onSearch();
  });

  return el('div', 'card', [
    el('label', 'control', [
      el('span', 'control__label', 'Find a soldier by 4D or name'),
      input,
    ]),
  ]);
}

/**
 * Renders one soldier's episode history.
 * @param {!Object} profile The soldier's profile.
 * @returns {!HTMLElement} The card.
 */
function profileCard_(profile) {
  const rows = profile.episodes
    .slice()
    .reverse()
    .map((episode) => [
      episode.dutyClass,
      fmtDate(episode.startDate),
      fmtDate(episode.endDate),
      fmtInt(episode.daysLost),
      episode.daysLostSource,
      episode.reasons.join('; ') || '—',
      episode.disagreement
        ? el(
            'span',
            'pill pill--flag',
            'states ' + fmtInt(episode.statedDays) + 'd, dates span ' + fmtInt(episode.spanDays) + 'd'
          )
        : '',
    ]);

  return el('section', 'card', [
    el('div', 'card__head', [
      el(
        'h3',
        'card__title',
        [profile.rank, profile.name].filter(Boolean).join(' ') || 'Unnamed soldier'
      ),
      el('span', 'pill', profile.fourD || 'no 4D'),
    ]),
    el(
      'p',
      'card__note',
      [profile.company, profile.platoon ? 'Platoon ' + profile.platoon : ''].filter(Boolean).join(' · ') ||
        'Unit not recorded'
    ),
    el('div', 'tiles', [
      el('div', 'tile', [
        el('span', 'tile__label', 'MC episodes'),
        el('span', 'tile__value', fmtInt(profile.mcEpisodes)),
      ]),
      el('div', 'tile', [
        el('span', 'tile__label', 'MC days lost'),
        el('span', 'tile__value', fmtInt(profile.mcDays)),
      ]),
      el('div', 'tile', [
        el('span', 'tile__label', 'Average episode'),
        el('span', 'tile__value', fmtDecimal(profile.averageMc, 'd')),
      ]),
      el('div', 'tile', [
        el('span', 'tile__label', 'Times reported sick'),
        el('span', 'tile__value', fmtInt(profile.sickEpisodes)),
      ]),
    ]),
    table(
      [
        { label: 'Type' },
        { label: 'From' },
        { label: 'To' },
        { label: 'Days', numeric: true },
        { label: 'Days from' },
        { label: 'Reason' },
        { label: 'Note' },
      ],
      rows
    ),
  ]);
}

/**
 * Soldiers out repeatedly, across every category at once.
 *
 * The three category tabs each rank their own; this ranks the man rather than the
 * category, which is the question a commander asks when a name keeps coming up.
 * @param {!Object} view The snapshot.
 * @returns {!HTMLElement} The card.
 */
function repeatCard_(view) {
  const combined = new Map();
  [DUTY_CLASS.ATT_C, DUTY_CLASS.REPORT_SICK, DUTY_CLASS.STATUS].forEach((dutyClass) => {
    leaderboard(view.episodes, dutyClass).forEach((entry) => {
      const merged = combined.get(entry.key) || {
        ...entry,
        mc: 0,
        sick: 0,
        status: 0,
        total: 0,
        days: 0,
      };
      if (dutyClass === DUTY_CLASS.ATT_C) merged.mc = entry.episodes;
      if (dutyClass === DUTY_CLASS.REPORT_SICK) merged.sick = entry.episodes;
      if (dutyClass === DUTY_CLASS.STATUS) merged.status = entry.episodes;
      merged.total += entry.episodes;
      merged.days += entry.daysLost;
      merged.name = entry.name || merged.name;
      merged.company = entry.company || merged.company;
      if (!merged.lastStart || (entry.lastStart && entry.lastStart > merged.lastStart)) {
        merged.lastStart = entry.lastStart;
      }
      combined.set(entry.key, merged);
    });
  });

  const rows = Array.from(combined.values())
    .filter((entry) => entry.total > 1)
    .sort((a, b) => b.total - a.total || b.days - a.days)
    .slice(0, 20);

  if (rows.length === 0) {
    return banner('info', 'None', 'Nobody has more than one episode of any kind.');
  }

  return el('section', 'card', [
    el('div', 'card__head', [el('h3', 'card__title', 'Out most often')]),
    el('p', 'card__note', 'More than one episode of any kind.'),
    table(
      [
        { label: 'Soldier' },
        { label: '4D' },
        { label: 'Coy' },
        { label: 'Plt' },
        { label: 'Att C', numeric: true },
        { label: 'Sick', numeric: true },
        { label: 'Status', numeric: true },
        { label: 'Days', numeric: true },
        { label: 'Latest' },
      ],
      rows.map((entry) => [
        [entry.rank, entry.name].filter(Boolean).join(' ') || '—',
        entry.fourD || '—',
        entry.company || '—',
        entry.platoon,
        fmtInt(entry.mc),
        fmtInt(entry.sick),
        fmtInt(entry.status),
        fmtInt(entry.days),
        entry.lastStart ? fmtDate(entry.lastStart) : '—',
      ])
    ),
  ]);
}

/**
 * Renders the soldier view.
 * @param {!Object} view The snapshot.
 * @param {!Object} context Shell callbacks.
 * @returns {Array<Node>} The view's nodes.
 */
export function renderSoldier(view, context) {
  const results = search_(view);
  const rerender = () => {
    const host = document.getElementById('view');
    const nodes = renderSoldier(view, context);
    host.textContent = '';
    nodes.forEach((node) => node && host.appendChild(node));
    const input = document.getElementById('soldier-search');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };

  const found =
    query.trim().length < 2
      ? el('p', 'note note--muted', 'Search by name or 4D.')
      : results.length === 0
        ? banner('info', 'No match', 'Nobody matches “' + query + '”. Try a 4D number.')
        : null;

  return [
    sectionHead('Find a soldier'),
    searchBox_(rerender),
    found,
    ...results.map(profileCard_),
    sectionHead('Repeat absence'),
    repeatCard_(view),
  ].filter(Boolean);
}
