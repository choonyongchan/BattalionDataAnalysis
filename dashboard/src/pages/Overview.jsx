/**
 * Battalion overview: who has filed this morning, today's numbers, and how the battalion
 * is trending.
 *
 * Two clocks run on this page and they answer different questions. `selectedDate` names
 * one parade — the timeline and the tile row describe that single day and ignore the
 * range entirely, because "today's strength" should never sit under a span a reader has
 * to remember is active. `dateFrom`/`dateTo` bound every trend and the Sankey; null on
 * both means "all data", the long-standing default.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { dataset, dateFrom, dateTo, selectedDate } from '../app/state.js';
import { Card, Coverage, EmptyState } from '../components/Card.jsx';
import { Tile, TileRow } from '../components/Tile.jsx';
import { ScopeToggle } from '../components/ScopeToggle.jsx';
import { DateRangePicker, PresetBar } from '../components/DateRangePicker.jsx';
import { fmtDate, fmtFraction, fmtInt, fmtShare } from '../components/format.js';
import { ChartCard, Line, Sankey, Timeline } from '../charts/index.js';
import { COMPANIES } from '../model/domain.js';
import { DUTY_CLASS } from '../model/classify.js';
import { toHolidays, holidaysIn, weekendBands } from '../model/calendarMarks.js';
import { datesPresent, battalionStrength, dutyCountsOn } from '../model/metrics.js';
import { eachDay, isoToday, resolvePreset } from '../model/dateRange.js';
import { buildEpisodes } from '../model/episodes.js';
import { toSubmissions, submissionTrend } from '../model/formsg.js';
import { filingsOn, toFilings } from '../model/submissions.js';
import { dutyTrend, presentTrend } from '../model/strength.js';
import { reportSickFlow } from '../model/sankey.js';

/** @type {string} Session every "today" figure and trend describes. */
const SESSION = 'FPS';

/**
 * Sums two same-shaped trends series-by-series, matching series by name.
 * @param {{dates: string[], series: Array<{name: string, values: number[]}>}} a One trend.
 * @param {{dates: string[], series: Array<{name: string, values: number[]}>}} b The other.
 * @returns {{dates: string[], series: Array<{name: string, values: number[]}>}} The sum.
 */
function combineTrends(a, b) {
  return {
    dates: a.dates,
    series: a.series.map((seriesA) => {
      const seriesB = b.series.find((entry) => entry.name === seriesA.name) || { values: [] };
      return {
        name: seriesA.name,
        values: seriesA.values.map((value, index) => {
          const other = seriesB.values[index];
          if (value === null && other === null) return null;
          return (value || 0) + (other || 0);
        }),
      };
    }),
  };
}

/**
 * Counts distinct soldiers reporting sick on one parade (`Report Sick` category), for the
 * tile row — `dutyCountsOn` already gives this via its `counts` map.
 * @param {!Object} duty A `dutyCountsOn` result.
 * @param {string} dutyClass A DUTY_CLASS value.
 * @returns {number} The count.
 */
function countOf(duty, dutyClass) {
  return duty.counts[dutyClass] || 0;
}

/**
 * A trend card: a Line chart plus its Battalion/Companies toggle, sharing one layout so
 * all five trend cards on this page read as the same kind of thing.
 * @param {{title: string, trendFn: function(string): !Object, coverage: string,
 *     unit?: string}} props The card title, a function from scope name to a trend result,
 *     the coverage line, and the axis unit.
 * @returns {!preact.VNode} The card.
 */
function TrendCard({ title, trendFn, coverage, unit }) {
  const [scope, setScope] = useState('battalion');
  const trend = trendFn(scope);

  return (
    <Card title={title}>
      <div class="controlrow">
        <ScopeToggle value={scope} onChange={setScope} />
      </div>
      <ChartCard title="" coverage={coverage}>
        <Line
          categories={trend.dates}
          series={trend.series.map((series) => ({
            ...series,
            slot: scope === 'companies' ? COMPANIES.indexOf(series.name) : undefined,
            neutral: scope === 'battalion',
          }))}
          weekends={trend.weekends}
          holidays={trend.holidays}
          valueName={unit}
        />
      </ChartCard>
    </Card>
  );
}

/**
 * The Overview page.
 * @returns {!preact.VNode} The page.
 */
export function Overview() {
  const data = dataset.value;

  const episodes = useMemo(() => buildEpisodes(data.personnel), [data.personnel]);
  const submissions = useMemo(() => toSubmissions(data.formSg), [data.formSg]);
  const filings = useMemo(() => toFilings(data.submissions), [data.submissions]);
  const holidays = useMemo(() => toHolidays(data.holidays), [data.holidays]);
  const paradeDates = useMemo(() => datesPresent(data.strength), [data.strength]);

  useEffect(() => {
    if (!selectedDate.value && paradeDates.length > 0) {
      selectedDate.value = paradeDates[paradeDates.length - 1];
    }
  }, [paradeDates]);

  const today = selectedDate.value || paradeDates[paradeDates.length - 1] || null;

  const effectiveFrom = dateFrom.value || paradeDates[0] || today;
  const effectiveTo = dateTo.value || paradeDates[paradeDates.length - 1] || today;
  const trendDates = useMemo(
    () => eachDay(effectiveFrom, effectiveTo),
    [effectiveFrom, effectiveTo]
  );
  const weekends = useMemo(
    () => weekendBands(effectiveFrom, effectiveTo),
    [effectiveFrom, effectiveTo]
  );
  const rangeHolidays = useMemo(
    () => holidaysIn(holidays, effectiveFrom, effectiveTo),
    [holidays, effectiveFrom, effectiveTo]
  );

  if (!today) {
    return (
      <div class="page">
        <header class="pagehead">
          <h1 class="pagehead__title">Battalion overview</h1>
        </header>
        <EmptyState>No parade state has been read yet.</EmptyState>
      </div>
    );
  }

  const strength = battalionStrength(data.strength, today, SESSION);
  const duty = dutyCountsOn(data.personnel, today, SESSION);
  const reportedSickToday = submissions.filter((submission) => submission.date === today).length;
  const filingEntries = filingsOn(filings, today, SESSION);

  const coverageLine =
    'Accurate to the parade states filed for ' +
    fmtDate(today) +
    ' — ' +
    fmtFraction(strength.companiesReporting.length, COMPANIES.length) +
    ' companies.';

  const trendCoverage =
    'Battalion strength observed on ' +
    fmtFraction(trendDates.length, trendDates.length) +
    ' days in range; a company not filing that day is drawn as a gap.';

  return (
    <div class="page">
      <header class="pagehead">
        <div>
          <h1 class="pagehead__title">Battalion overview</h1>
          <p class="pagehead__sub">{fmtDate(today)}</p>
        </div>
      </header>

      <Card title="Today's first parade state" note="One dot per company, at its filing time">
        <Timeline
          entries={filingEntries}
          deadline={{ minutes: 8 * 60, label: '08:00' }}
        />
      </Card>

      <TileRow>
        <Tile label="Total soldiers" value={fmtInt(strength.accountable)} />
        <Tile label="Present soldiers" value={fmtInt(strength.present)} />
        <Tile label="% present" value={fmtShare(strength.percentPresent / 100)} />
        <Tile label="Reporting sick" value={fmtInt(countOf(duty, DUTY_CLASS.REPORT_SICK))} foot="Parade state" />
        <Tile label="Reported sick" value={fmtInt(reportedSickToday)} foot="FormSG" />
        <Tile
          label="MC / MA"
          value={fmtInt(countOf(duty, DUTY_CLASS.ATT_C) + countOf(duty, DUTY_CLASS.MA))}
        />
        <Tile label="On status" value={fmtInt(countOf(duty, DUTY_CLASS.STATUS))} />
      </TileRow>
      <Coverage>{coverageLine}</Coverage>

      <div class="band">
        <h2 class="pagehead__title" style="font-size:21px">
          Trends
        </h2>
        <div class="controlrow">
          <DateRangePicker
            min={paradeDates[0] || today}
            max={paradeDates[paradeDates.length - 1] || today}
            from={dateFrom.value}
            to={dateTo.value}
            onChange={({ from, to }) => {
              dateFrom.value = from;
              dateTo.value = to;
            }}
          />
          <PresetBar
            from={dateFrom.value}
            to={dateTo.value}
            today={isoToday()}
            onSelect={(preset) => {
              const resolved = resolvePreset(preset, isoToday());
              dateFrom.value = resolved.from;
              dateTo.value = resolved.to;
            }}
          />
        </div>
      </div>

      <TrendCard
        title="% present"
        coverage={trendCoverage}
        unit="%"
        trendFn={(scope) => {
          const trend = presentTrend(data.strength, trendDates, { scope, session: SESSION });
          return { ...trend, weekends, holidays: rangeHolidays };
        }}
      />

      <TrendCard
        title="Reporting sick (parade state)"
        coverage={trendCoverage}
        unit="per 100"
        trendFn={(scope) => {
          const trend = dutyTrend(data.personnel, data.strength, DUTY_CLASS.REPORT_SICK, trendDates, {
            scope,
            session: SESSION,
          });
          return { ...trend, weekends, holidays: rangeHolidays };
        }}
      />

      <TrendCard
        title="Reported sick (FormSG)"
        coverage={
          'FormSG submissions; a company with no submissions in range is drawn flat at zero, not a gap.'
        }
        unit="per 100"
        trendFn={(scope) => {
          const trend = submissionTrend(submissions, data.strength, trendDates, { scope, session: SESSION });
          return { ...trend, weekends, holidays: rangeHolidays };
        }}
      />

      <TrendCard
        title="MC / MA"
        coverage={trendCoverage}
        unit="per 100"
        trendFn={(scope) => {
          const mc = dutyTrend(data.personnel, data.strength, DUTY_CLASS.ATT_C, trendDates, {
            scope,
            session: SESSION,
          });
          const ma = dutyTrend(data.personnel, data.strength, DUTY_CLASS.MA, trendDates, {
            scope,
            session: SESSION,
          });
          const trend = combineTrends(mc, ma);
          return { ...trend, weekends, holidays: rangeHolidays };
        }}
      />

      <TrendCard
        title="Status"
        coverage={trendCoverage}
        unit="per 100"
        trendFn={(scope) => {
          const trend = dutyTrend(data.personnel, data.strength, DUTY_CLASS.STATUS, trendDates, {
            scope,
            session: SESSION,
          });
          return { ...trend, weekends, holidays: rangeHolidays };
        }}
      />

      <Card
        title="Report-sick flow"
        note="Parade state and FormSG matched by 4D, else name, within a day; MC/Status matched 0–2 days after."
      >
        <SankeyCard
          personnel={data.personnel}
          episodes={episodes}
          submissions={submissions}
          from={dateFrom.value}
          to={dateTo.value}
        />
      </Card>
    </div>
  );
}

/**
 * The report-sick Sankey, with its coverage findings printed under it.
 * @param {{personnel: Array<!Object>, episodes: Array<!Object>, submissions:
 *     Array<!Object>, from: ?string, to: ?string}} props Inputs to `reportSickFlow`.
 * @returns {!preact.VNode} The card body.
 */
function SankeyCard({ personnel, episodes, submissions, from, to }) {
  const flow = useMemo(
    () => reportSickFlow({ personnel, episodes, submissions, from, to }),
    [personnel, episodes, submissions, from, to]
  );

  return (
    <>
      <ChartCard title="">
        <Sankey nodes={flow.nodes} links={flow.links} />
      </ChartCard>
      <Coverage>
        {fmtInt(flow.coverage.totalEvents)} report-sick events in range — {fmtInt(flow.coverage.sourceCounts.paradeOnly)}{' '}
        parade-state only, {fmtInt(flow.coverage.sourceCounts.both)} in both,{' '}
        {fmtInt(flow.coverage.sourceCounts.formsgOnly)} FormSG only.
        {flow.coverage.companiesWithNoFormSg.length > 0
          ? ' No FormSG channel recorded for ' + flow.coverage.companiesWithNoFormSg.join(', ') + '.'
          : ''}
        {flow.coverage.statusMultiLabelled
          ? ' A status outcome naming several restrictions is counted under each — the Status branch\'s outflow can exceed its inflow.'
          : ''}
      </Coverage>
    </>
  );
}
