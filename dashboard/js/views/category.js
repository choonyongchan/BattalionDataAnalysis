/**
 * One absence category, from the battalion down to the soldier.
 *
 * MC, report sick and status get the same four questions in the same order, because a
 * commander asks them in that order every time:
 *
 *   1. Is it getting worse?        — the trend, over everything ingested
 *   2. Which company?              — rates, so a big company is not flagged for being big
 *   3. Which platoon?              — the heatmap, with elevated units marked
 *   4. Who, most often?            — the leaderboard
 *
 * One renderer serves all three so the three tabs cannot drift into three layouts. What
 * differs per category is declared in `CATEGORIES` in `app.js` and read from `spec`:
 * status is present-but-restricted rather than absent, MC carries the how-long and
 * what-kind panels, and report sick carries the soldiers' own words.
 *
 * **Rates, not counts, for every comparison.** In the labelled data Braves files 40 MC
 * rows against Hercules' 7, which says nothing until divided by strength — Braves is the
 * larger company.
 */

import { DUTY_CLASS, keywords } from '../model/classify.js';
import { keywordCounts } from '../model/formsg.js';
import {
  categoryTrend,
  companyRates,
  dataQuality,
  durationDistribution,
  leaderboard,
  symptomCounts,
  unitRates,
  weekdayDistribution,
  OUTLIER_Z,
} from '../model/metrics.js';
import { barChart, heatmap, lineChart } from '../charts.js';
import {
  banner,
  chartCard,
  cloud,
  el,
  fmtDate,
  fmtDecimal,
  fmtInt,
  fmtShare,
  sectionHead,
  table,
} from '../ui.js';

/**
 * Episodes of this category.
 * @param {!Object} view The snapshot.
 * @param {!Object} spec The category.
 * @returns {Array<!Object>} The matching episodes.
 */
function episodesOf_(view, spec) {
  return view.episodes.filter((episode) => episode.dutyClass === spec.dutyClass);
}

/**
 * The battalion trend as a rate: the share of the strength in this category.
 *
 * Two charts rather than one with two y-axes. A count and a rate are different scales,
 * and putting them on one plot with two axes is the single most misleading thing a line
 * chart can do — the crossing point is an artefact of the axis choice.
 * @param {!Object} view The snapshot.
 * @param {!Object} spec The category.
 * @returns {!HTMLElement} The card.
 */
function trendCard_(view, spec) {
  const trend = categoryTrend(view.personnel, view.strength, spec.dutyClass, view.session);
  const incomplete = trend.filter((point) => !point.isComplete).length;

  return chartCard({
    title: spec.title + ' rate over time',
    note:
      incomplete > 0
        ? fmtInt(incomplete) + ' of ' + fmtInt(trend.length) + ' parades under 6 companies.'
        : '',
    render: (node) =>
      lineChart(node, {
        dates: trend.map((point) => fmtDate(point.date)),
        series: [
          {
            name: '%',
            values: trend.map((point) =>
              point.per100 === null ? null : Number(point.per100.toFixed(2))
            ),
          },
        ],
        valueName: '%',
      }),
    table: {
      columns: [
        { label: 'Parade' },
        { label: 'Soldiers', numeric: true },
        { label: 'Accountable', numeric: true },
        { label: '%', numeric: true },
        { label: 'Coys', numeric: true },
      ],
      rows: trend.map((point) => [
        fmtDate(point.date),
        fmtInt(point.count),
        fmtInt(point.accountable),
        point.per100 === null ? '—' : fmtDecimal(point.per100),
        point.companiesReporting + '/6',
      ]),
    },
  });
}

/**
 * The same trend as a headcount, which is what a duty roster is planned against.
 * @param {!Object} view The snapshot.
 * @param {!Object} spec The category.
 * @returns {!HTMLElement} The card.
 */
function headcountCard_(view, spec) {
  const trend = categoryTrend(view.personnel, view.strength, spec.dutyClass, view.session);

  return chartCard({
    title: spec.full + ' over time',
    render: (node) =>
      barChart(node, {
        horizontal: false,
        categories: trend.map((point) => fmtDate(point.date)),
        values: trend.map((point) => point.count),
        valueName: 'soldiers',
      }),
    table: {
      columns: [{ label: 'Parade' }, { label: 'Soldiers', numeric: true }],
      rows: trend.map((point) => [fmtDate(point.date), fmtInt(point.count)]),
    },
  });
}

/**
 * Rate by company, highest first.
 * @param {!Object} view The snapshot.
 * @param {!Object} spec The category.
 * @returns {!HTMLElement} The card.
 */
function companyCard_(view, spec) {
  const rates = companyRates(view.personnel, view.strength, spec.dutyClass);
  const totalDays = rates.reduce((sum, row) => sum + row.days, 0);
  const totalPaxDays = rates.reduce((sum, row) => sum + row.paxDays, 0);
  const mean = totalPaxDays > 0 ? (totalDays / totalPaxDays) * 100 : null;

  const flagged = rates.filter((row) => row.isOutlier);

  return chartCard({
    title: spec.title + ' rate by company',
    // The only note here names what red means. A status colour carrying a meaning on its
    // own is unreadable in greyscale, and to a viewer who cannot separate it from the
    // series blue it says nothing at all. Everything else the axis and the line already
    // say.
    note:
      flagged.length > 0
        ? 'Red: above ' + OUTLIER_Z + ' SD — ' + flagged.map((row) => row.company).join(', ') + '.'
        : '',
    render: (node) =>
      barChart(node, {
        categories: rates.map((row) => row.company),
        values: rates.map((row) => Number((row.per100 || 0).toFixed(2))),
        valueName: '%',
        highlight: (index) => rates[index].isOutlier,
        meanLine: mean === null ? null : Number(mean.toFixed(2)),
      }),
    table: {
      columns: [
        { label: 'Company' },
        { label: 'Days', numeric: true },
        { label: 'Days observed', numeric: true },
        { label: '%', numeric: true },
        { label: 'z', numeric: true },
      ],
      rows: rates.map((row) => [
        row.company,
        fmtInt(row.days),
        fmtInt(row.paxDays),
        fmtDecimal(row.per100),
        row.z === null ? '—' : row.z.toFixed(1),
      ]),
    },
  });
}

/**
 * Rate by company and platoon, with elevated units marked.
 * @param {!Object} view The snapshot.
 * @param {!Object} spec The category.
 * @returns {!HTMLElement} The card.
 */
function platoonCard_(view, spec) {
  const rates = unitRates(view.personnel, view.strength, spec.dutyClass).filter(
    (row) => row.company !== ''
  );
  // Only units that can actually produce a cell. A unit with pax-days of zero — a
  // company that files one line and no platoon breakdown, say — would otherwise reserve
  // a row or column of the grid and leave it entirely blank, which reads as a broken
  // chart rather than as an absence of data.
  const drawable = rates.filter((row) => row.paxDays > 0);
  const companies = Array.from(new Set(drawable.map((row) => row.company))).sort();
  const platoons = Array.from(new Set(drawable.map((row) => row.platoon))).sort(comparePlatoons_);

  const byKey = new Map(rates.map((row) => [row.company + '|' + row.platoon, row]));
  const cells = [];
  const flagged = [];
  companies.forEach((company, rowIndex) => {
    platoons.forEach((platoon, colIndex) => {
      const row = byKey.get(company + '|' + platoon);
      if (!row || row.paxDays === 0) {
        return;
      }
      cells.push([colIndex, rowIndex, Number((row.per100 || 0).toFixed(2))]);
      if (row.isOutlier) {
        flagged.push({ coord: [colIndex, rowIndex] });
      }
    });
  });

  const outliers = rates.filter((row) => row.isOutlier);

  // The heatmap is only as good as its attribution: rows with no platoon land in the
  // Unassigned column, and if that is most of them the grid is not evidence of anything.
  // Stated as one number rather than a paragraph, and only when it is bad enough to
  // change how the chart should be read.
  const quality = dataQuality(view.personnel);
  const thin = quality.platoon !== null && quality.platoon < 0.9;

  return el('div', null, [
    chartCard({
      title: spec.title + ' rate by platoon',
      note:
        'Dot: above ' + OUTLIER_Z + ' SD.' +
        (thin ? ' ' + fmtShare(1 - quality.platoon) + ' name no platoon.' : ''),
      height: 'chart--tall',
      render: (node) =>
        heatmap(node, {
          rows: companies,
          columns: platoons,
          cells,
          flagged,
          // Returns lines, not markup: `charts.js` inserts each as text.
          detail: (colIndex, rowIndex) => {
            const row = byKey.get(companies[rowIndex] + '|' + platoons[colIndex]);
            if (!row) {
              return [];
            }
            return [
              companies[rowIndex] + ' · Platoon ' + platoons[colIndex],
              fmtDecimal(row.per100, '%') + ' of days observed',
              fmtInt(row.days) + ' days out of ' + fmtInt(row.paxDays),
              row.z === null ? 'too little data to score' : 'z = ' + row.z.toFixed(1),
            ];
          },
        }),
      table: {
        columns: [
          { label: 'Company' },
          { label: 'Platoon' },
          { label: 'Days', numeric: true },
          { label: 'Days observed', numeric: true },
          { label: '%', numeric: true },
          { label: 'z', numeric: true },
        ],
        rows: rates
          .slice()
          .sort((a, b) => (b.per100 || 0) - (a.per100 || 0))
          .map((row) => [
            row.company,
            row.platoon,
            fmtInt(row.days),
            fmtInt(row.paxDays),
            fmtDecimal(row.per100),
            row.z === null ? '—' : row.z.toFixed(1),
          ]),
      },
    }),
    outliers.length === 0
      ? banner('info', 'Even', 'No platoon stands out.')
      : banner(
          'warning',
          'Localised',
          outliers
            .map((row) => row.company + ' platoon ' + row.platoon + ' (' + fmtDecimal(row.per100, '%') + ')')
            .join('; ') + '.'
        ),
  ]);
}

/**
 * Orders platoon labels so numbers sort numerically and named units follow.
 * @param {string} a First label.
 * @param {string} b Second label.
 * @returns {number} Standard comparator result.
 */
function comparePlatoons_(a, b) {
  const numberA = Number(a);
  const numberB = Number(b);
  const aIsNumber = Number.isFinite(numberA);
  const bIsNumber = Number.isFinite(numberB);
  if (aIsNumber && bIsNumber) {
    return numberA - numberB;
  }
  if (aIsNumber !== bIsNumber) {
    return aIsNumber ? -1 : 1;
  }
  return a.localeCompare(b);
}

/**
 * Soldiers with the most episodes of this category.
 * @param {!Object} view The snapshot.
 * @param {!Object} spec The category.
 * @returns {!HTMLElement} The section.
 */
function leaderboardCard_(view, spec) {
  const rows = leaderboard(episodesOf_(view, spec), spec.dutyClass);
  const repeats = rows.filter((entry) => entry.episodes > 1);

  if (rows.length === 0) {
    return banner('info', 'None', 'No ' + spec.noun + ' episodes recorded.');
  }

  const shown = (repeats.length > 0 ? repeats : rows).slice(0, 15);

  return el('section', 'card', [
    el('div', 'card__head', [
      el('h3', 'card__title', repeats.length > 0 ? 'Most episodes' : 'Longest ' + spec.noun),
    ]),
    el(
      'p',
      'card__note',
      repeats.length > 0
        ? fmtInt(repeats.length) + ' with more than one episode.'
        : 'Ranked by days.'
    ),
    table(
      [
        { label: 'Soldier' },
        { label: 'Coy' },
        { label: 'Plt' },
        { label: 'Episodes', numeric: true },
        { label: 'Days', numeric: true },
        { label: 'Latest' },
      ],
      shown.map((entry) => [
        (entry.rank ? entry.rank + ' ' : '') + (entry.name || entry.fourD || '—'),
        entry.company || '—',
        entry.platoon,
        fmtInt(entry.episodes),
        fmtInt(entry.daysLost),
        entry.lastStart ? fmtDate(entry.lastStart) : '—',
      ])
    ),
  ]);
}

/**
 * What kind of MC, and how long it lasts.
 * @param {!Object} view The snapshot.
 * @param {!Object} spec The category.
 * @returns {Array<Node>} The panels.
 */
function patternPanels_(view, spec) {
  const episodes = episodesOf_(view, spec);
  const fromParade = symptomCounts(episodes);
  const fromForm = symptomCounts(
    view.submissions.map((submission) => ({ symptoms: submission.symptoms }))
  );

  const merged = new Map();
  fromParade.counts.forEach((entry) => merged.set(entry.symptom, entry.count));
  fromForm.counts.forEach((entry) =>
    merged.set(entry.symptom, (merged.get(entry.symptom) || 0) + entry.count)
  );
  const symptoms = Array.from(merged.entries())
    .map(([symptom, count]) => ({ symptom, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const durations = durationDistribution(episodes);
  const weekdays = weekdayDistribution(episodes);
  const weekdayTotal = weekdays.reduce((sum, day) => sum + day.count, 0);

  return [
    sectionHead('What kind, and how long'),
    chartCard({
      title: 'Symptoms named',
      note: 'Named on ' + fmtShare(fromParade.coverage) + ' of episodes.',
      height: 'chart--tall',
      render: (node) =>
        barChart(node, {
          categories: symptoms.map((row) => row.symptom),
          values: symptoms.map((row) => row.count),
          valueName: 'mentions',
        }),
      table: {
        columns: [{ label: 'Symptom' }, { label: 'Mentions', numeric: true }],
        rows: symptoms.map((row) => [row.symptom, fmtInt(row.count)]),
      },
    }),
    el('div', 'grid-2', [
      chartCard({
        title: 'How long it lasts',
        render: (node) =>
          barChart(node, {
            horizontal: false,
            categories: durations.map((entry) => String(entry.days)),
            values: durations.map((entry) => entry.count),
            valueName: 'episodes',
          }),
        table: {
          columns: [{ label: 'Days' }, { label: 'Episodes', numeric: true }],
          rows: durations.map((entry) => [entry.days, fmtInt(entry.count)]),
        },
      }),
      chartCard({
        title: 'Which day it starts',
        render: (node) =>
          barChart(node, {
            horizontal: false,
            categories: weekdays.map((day) => day.name),
            values: weekdays.map((day) => day.count),
            valueName: 'episodes',
            meanLine: weekdayTotal > 0 ? Number((weekdayTotal / 7).toFixed(2)) : null,
          }),
        table: {
          columns: [{ label: 'Day' }, { label: 'Episodes', numeric: true }, { label: 'Share', numeric: true }],
          rows: weekdays.map((day) => [
            day.name,
            fmtInt(day.count),
            weekdayTotal > 0 ? fmtShare(day.count / weekdayTotal) : '—',
          ]),
        },
      }),
    ]),
  ];
}

/**
 * The soldiers' own words.
 * @param {!Object} view The snapshot.
 * @param {!Object} spec The category.
 * @returns {Array<Node>} The panels.
 */
function wordPanels_(view, spec) {
  const lists = view.submissions.map((submission) => submission.keywords);
  episodesOf_(view, spec).forEach((episode) => {
    episode.reasons.forEach((reason) => lists.push(keywords(reason)));
  });
  const words = keywordCounts(lists, 40);
  if (words.length === 0) {
    return [];
  }

  return [
    sectionHead('In their words'),
    el('section', 'card', [
      el('div', 'card__head', [el('h3', 'card__title', 'What soldiers write')]),
      cloud(words),
    ]),
  ];
}

/**
 * Renders one category view.
 * @param {!Object} view The snapshot.
 * @param {!Object} spec The category, from CATEGORIES in app.js.
 * @returns {Array<Node>} The view's nodes.
 */
export function renderCategory(view, spec) {
  const episodes = episodesOf_(view, spec);
  const trend = categoryTrend(view.personnel, view.strength, spec.dutyClass, view.session);
  const total = trend.reduce((sum, point) => sum + point.count, 0);

  if (total === 0 && episodes.length === 0) {
    return [
      banner('info', 'None', 'No ' + spec.noun + ' recorded' + (view.company === 'ALL' ? '.' : ' for ' + view.company + '.')),
    ];
  }

  return [
    sectionHead(
      'Is it getting worse?',
      fmtInt(episodes.length) +
        ' episodes' +
        (view.firstDate ? ' · ' + fmtDate(view.firstDate) + ' to ' + fmtDate(view.lastDate) : '')
    ),
    el('div', 'grid-2', [trendCard_(view, spec), headcountCard_(view, spec)]),
    sectionHead('Where is it?'),
    companyCard_(view, spec),
    platoonCard_(view, spec),
    ...(spec.showPatterns ? patternPanels_(view, spec) : []),
    ...(spec.showReasons ? wordPanels_(view, spec) : []),
    sectionHead('Who, most often?'),
    leaderboardCard_(view, spec),
    spec.presentButRestricted
      ? banner(
          'info',
          'Present',
          'Att B / LD: on parade, never counted absent.'
        )
      : null,
  ].filter(Boolean);
}
