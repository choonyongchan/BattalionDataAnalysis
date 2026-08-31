/**
 * Today: what the battalion can field at this parade.
 *
 * The story this view tells, in order, is the one a commander asks it in:
 *
 *   1. How many do I have, and how many turned up?      — the tiles
 *   2. Of those here, how many can I actually employ?   — the donut
 *   3. Why is the rest missing?                         — the reason bars
 *   4. Which company is thin, and why?                  — the stacked bars
 *
 * Two things it refuses to do, because the alternative misleads:
 *
 * - **No battalion total without saying how many companies it covers.** Four of six
 *   filing produces correct arithmetic and a wrong impression.
 * - **Status is never folded into absence.** Attend B and light duty turned up and can
 *   work with limits, so they sit inside the present block, labelled as present.
 */

import { DUTY_CLASS } from '../model/classify.js';
import {
  ABSENCE_REASONS,
  companyBreakdown,
  dutyCountsOn,
  employability,
  topReasonsOn,
} from '../model/metrics.js';
import { barChart, donutChart, stackedBarChart } from '../charts.js';
import {
  banner,
  chartCard,
  deltaOf,
  el,
  fmtDecimal,
  fmtInt,
  sectionHead,
  tile,
} from '../ui.js';

/**
 * The five figures a commander reads first.
 * @param {!Object} view The snapshot.
 * @returns {!HTMLElement} The tile row.
 */
function tiles_(view) {
  const now = employability(view.strength, view.personnel, view.date, view.session);
  const duty = dutyCountsOn(view.personnel, view.date, view.session);
  const before = view.previousDate
    ? employability(view.strength, view.personnel, view.previousDate, view.session)
    : null;
  const dutyBefore = view.previousDate
    ? dutyCountsOn(view.personnel, view.previousDate, view.session)
    : null;

  const presentDelta = deltaOf(
    now.percentPresent,
    before ? before.percentPresent : null,
    'up',
    ' pts'
  );
  const countDelta = (dutyClass) =>
    deltaOf(
      duty.counts[dutyClass],
      dutyBefore ? dutyBefore.counts[dutyClass] : null,
      'down'
    );

  const mcDelta = countDelta(DUTY_CLASS.MC);
  const sickDelta = countDelta(DUTY_CLASS.REPORT_SICK);
  const statusDelta = countDelta(DUTY_CLASS.STATUS);

  return el('div', 'tiles stagger', [
    tile({
      label: 'Accountable strength',
      value: fmtInt(now.accountable),
      fraction: now.companiesReporting.length + ' of 6 companies',
    }),
    tile({
      label: 'Present',
      value: now.percentPresent === null ? '—' : fmtDecimal(now.percentPresent, '%'),
      fraction: fmtInt(now.present) + '/' + fmtInt(now.accountable),
      delta: presentDelta.text,
      deltaClass: presentDelta.className,
    }),
    tile({
      label: 'On MC · Att C',
      value: fmtInt(duty.counts[DUTY_CLASS.MC]),
      fraction: 'excused all duties',
      delta: mcDelta.text,
      deltaClass: mcDelta.className,
    }),
    tile({
      label: 'Reported sick',
      value: fmtInt(duty.counts[DUTY_CLASS.REPORT_SICK]),
      fraction: 'today',
      delta: sickDelta.text,
      deltaClass: sickDelta.className,
    }),
    tile({
      label: 'On status · Att B / LD',
      value: fmtInt(duty.counts[DUTY_CLASS.STATUS]),
      fraction: 'present, with limits',
      delta: statusDelta.text,
      deltaClass: statusDelta.className,
    }),
  ]);
}

/**
 * How many are here: three parts that sum to accountable strength.
 * @param {!Object} view The snapshot.
 * @returns {!HTMLElement} The card.
 */
function employabilityCard_(view) {
  const now = employability(view.strength, view.personnel, view.date, view.session);
  const slices = [
    { name: 'Full duty', value: now.presentFull },
    { name: 'Present, restricted', value: now.restricted },
    { name: 'Absent', value: now.absent },
  ];

  return chartCard({
    title: 'How many soldiers are here today?',
    note: 'Att B / LD counts as present.',
    render: (node) => donutChart(node, { slices, centreLabel: 'accountable' }),
    table: {
      columns: [{ label: 'Group' }, { label: 'Soldiers', numeric: true }, { label: 'Share', numeric: true }],
      rows: slices.map((slice) => [
        slice.name,
        fmtInt(slice.value),
        now.accountable > 0 ? fmtDecimal((slice.value / now.accountable) * 100, '%') : '—',
      ]),
    },
  });
}

/**
 * The reasons the absentees are absent.
 * @param {!Object} view The snapshot.
 * @returns {!HTMLElement} The card.
 */
function reasonsCard_(view) {
  const now = employability(view.strength, view.personnel, view.date, view.session);
  const rows = now.reasons.slice().sort((a, b) => b.count - a.count);

  return chartCard({
    title: 'Why they are absent',
    render: (node) =>
      barChart(node, {
        categories: rows.map((row) => row.label),
        values: rows.map((row) => row.count),
      }),
    table: {
      columns: [{ label: 'Reason' }, { label: 'Soldiers', numeric: true }],
      rows: rows.map((row) => [row.label, fmtInt(row.count)]),
    },
  });
}

/**
 * Present rate by company, weakest first.
 * @param {!Object} view The snapshot.
 * @returns {!HTMLElement} The card.
 */
function presenceCard_(view) {
  const companies = companyBreakdown(view.strength, view.personnel, view.date, view.session);
  const now = employability(view.strength, view.personnel, view.date, view.session);
  const mean = now.percentPresent;

  return chartCard({
    title: 'Present rate by company',
    note: 'Weakest first.',
    render: (node) =>
      barChart(node, {
        categories: companies.map((row) => row.company),
        values: companies.map((row) => Number((row.percentPresent || 0).toFixed(1))),
        valueName: '% present',
        meanLine: mean === null ? null : Number(mean.toFixed(1)),
      }),
    table: {
      columns: [
        { label: 'Company' },
        { label: 'Present', numeric: true },
        { label: 'Strength', numeric: true },
        { label: '% present', numeric: true },
      ],
      rows: companies.map((row) => [
        row.company,
        fmtInt(row.present),
        fmtInt(row.strength),
        row.percentPresent === null ? '—' : fmtDecimal(row.percentPresent, '%'),
      ]),
    },
  });
}

/**
 * Absent headcount by company, split by reason.
 *
 * One chart rather than two, because "which company is thinnest, and is the gap MC or
 * duty" is a single question — splitting it makes the reader hold one answer in their
 * head while looking for the other.
 * @param {!Object} view The snapshot.
 * @returns {!HTMLElement} The card.
 */
function absenceMixCard_(view) {
  const companies = companyBreakdown(view.strength, view.personnel, view.date, view.session)
    .slice()
    .sort((a, b) => b.absent - a.absent);

  const series = ABSENCE_REASONS.map((reason) => ({
    name: reason.label,
    values: companies.map((row) => row.reasons[reason.dutyClass] || 0),
  }));

  // Neutral grey, not a categorical slot: this is the absence of a category rather than
  // one more of them, and giving it a hue would read as a fifth reason.
  const overNamed = companies.some((row) => row.unaccounted < 0);
  const unnamed = companies.map((row) => Math.max(0, row.unaccounted));
  if (unnamed.some((value) => value > 0)) {
    series.push({ name: 'Not named', values: unnamed, neutral: true });
  }

  return el('div', null, [
    chartCard({
      title: 'Absent by company and reason',
      // No note: the legend names the reasons, the axis carries the headcount, and where
      // the absentee list disagrees with the strength line the banner below says so.
      render: (node) =>
        stackedBarChart(node, {
          categories: companies.map((row) => row.company),
          series,
          valueName: 'soldiers',
        }),
      table: {
        columns: [
          { label: 'Company' },
          { label: 'Absent', numeric: true },
          ...ABSENCE_REASONS.map((reason) => ({ label: reason.label, numeric: true })),
          { label: 'Named', numeric: true },
        ],
        rows: companies.map((row) => [
          row.company,
          fmtInt(row.absent),
          ...ABSENCE_REASONS.map((reason) => fmtInt(row.reasons[reason.dutyClass] || 0)),
          fmtInt(row.named),
        ]),
      },
    }),
    overNamed
      ? banner(
          'warning',
          'Check',
          companies
            .filter((row) => row.unaccounted < 0)
            .map((row) => row.company + ' +' + fmtInt(-row.unaccounted))
            .join(', ') +
            ' more absentees named than the strength gap allows.'
        )
      : null,
  ].filter(Boolean));
}

/**
 * What the soldiers at report sick are reporting today.
 * @param {!Object} view The snapshot.
 * @returns {?HTMLElement} The card, or null when nothing was recorded.
 */
function sickReasonsCard_(view) {
  const reasons = topReasonsOn(view.personnel, view.date, view.session, DUTY_CLASS.REPORT_SICK, 8);
  if (reasons.length === 0) {
    return null;
  }

  return chartCard({
    title: 'Reported sick with what',
    render: (node) =>
      barChart(node, {
        categories: reasons.map((row) => row.label),
        values: reasons.map((row) => row.count),
      }),
    table: {
      columns: [{ label: 'Symptom' }, { label: 'Soldiers', numeric: true }],
      rows: reasons.map((row) => [row.label, fmtInt(row.count)]),
    },
  });
}

/**
 * Renders the Today view.
 * @param {!Object} view The snapshot.
 * @returns {Array<Node>} The view's nodes.
 */
export function renderToday(view) {
  const now = employability(view.strength, view.personnel, view.date, view.session);
  if (now.accountable === 0) {
    return [
      banner('warning', 'No data', 'No parade state for this date.'),
    ];
  }

  return [
    tiles_(view),
    now.isComplete || view.company !== 'ALL'
      ? null
      : banner(
          'warning',
          'Incomplete',
          now.companiesReporting.length +
            ' of 6 companies filed. Missing: ' +
            now.companiesMissing.join(', ') +
            '.'
        ),
    sectionHead('The split'),
    el('div', 'grid-2', [employabilityCard_(view), reasonsCard_(view)]),
    sectionHead('By company'),
    presenceCard_(view),
    absenceMixCard_(view),
    sectionHead('Report sick today'),
    sickReasonsCard_(view),
  ].filter(Boolean);
}
