/**
 * Six lanes, one per company: who filed this morning's parade state, and when.
 *
 * This is the first thing a commander sees each day, and the question it answers is not
 * "how many filed" — that is a number, and a number belongs in a tile. It is "who is
 * missing, and how late is everyone else running", which is a question about *positions on
 * a shared clock*, and that is what a lane chart is for.
 *
 * The design follows from `model/submissions.js`, whose whole point is absence: `filingsOn`
 * always returns all six companies "because a chart built only from who filed cannot show
 * who did not". So the mark that matters most here is the one drawn for a company with no
 * data at all, and it gets the loudest treatment on the chart: a wash across the full lane
 * in `--critical` and the words "Not filed" set at the head of it. A missing company does
 * not read as an empty row — an empty row reads as a rendering bug — it reads as a
 * statement.
 *
 * Three lane states, because the data has three:
 *
 * - **Filed, with a time.** A lead-in bar from the start of the window to the filing time
 *   in the company's own colour, then the dot, then the clock time in ink beside it. The
 *   bar is what makes the chart readable at a glance: six bars of different lengths sort
 *   themselves without the reader parsing a single number.
 * - **Filed, no time of day.** `values.js`'s `toTimeOfDay` returns null for a timestamp
 *   with no clock in it, and `filingIssues` reports it as a data-quality problem. The lane
 *   says so in muted ink rather than parking a dot at midnight.
 * - **Not filed.** The critical wash.
 *
 * Drawn as a `custom` series rather than a scatter because a lane is not a point: it is a
 * band, a rail, a bar, a dot and a label that have to stay in register with each other, and
 * `renderItem` is the only place ECharts lets those be one mark. It also gives the lane a
 * full-width hit target, so a reader hovering anywhere on a company's row gets that
 * company's tooltip rather than having to find a 12px dot.
 */

import { Plot } from './Plot.jsx';
import { TableTwin } from './TableTwin.jsx';
import { fmtClock } from '../format.js';
import { tooltipLines } from './tooltip.js';
import { axisOption, baseOption, seriesColor } from './theme.js';

/** @type {number} Minutes of padding either side of the observed filings. */
const WINDOW_PAD = 45;

/** @type {number} Narrowest window drawn, in minutes; keeps one filing from filling the day. */
const MIN_SPAN = 240;

/** @type {number} Default window start when nothing has been filed at all: 06:00. */
const DEFAULT_FROM = 6 * 60;

/** @type {number} Default window end when nothing has been filed at all: 12:00. */
const DEFAULT_TO = 12 * 60;

/** @type {number} Tallest a lane band is drawn, however much room the card gives it. */
const MAX_LANE_HEIGHT = 34;

/** @enum {string} What a lane says about its company. */
const LANE = {
  FILED: 'filed',
  NO_TIME: 'no-time',
  MISSING: 'missing',
};

/**
 * Which of the three states a company's entry is in.
 * @param {{filed: boolean, at: ?Object}} entry One entry from `filingsOn`.
 * @returns {string} A LANE value.
 */
function stateOf_(entry) {
  if (!entry.filed) {
    return LANE.MISSING;
  }
  return entry.at && Number.isFinite(entry.at.minutes) ? LANE.FILED : LANE.NO_TIME;
}

/**
 * The clock window the lanes are drawn across.
 *
 * Data-driven rather than a fixed 00:00–24:00 day: filings cluster in a couple of hours,
 * and a full day squeezes the whole story into a tenth of the width. Padded and floored to
 * whole hours so the axis ticks land on round times.
 * @param {Array<!Object>} entries Entries from `filingsOn`.
 * @param {?number} from An explicit window start in minutes, or null.
 * @param {?number} to An explicit window end in minutes, or null.
 * @returns {{from: number, to: number}} The window, in minutes past midnight.
 */
function windowFor_(entries, from, to) {
  const times = entries
    .filter((entry) => stateOf_(entry) === LANE.FILED)
    .map((entry) => entry.at.minutes);
  if (times.length === 0) {
    return { from: from ?? DEFAULT_FROM, to: to ?? DEFAULT_TO };
  }
  let start = from ?? Math.floor((Math.min(...times) - WINDOW_PAD) / 60) * 60;
  let end = to ?? Math.ceil((Math.max(...times) + WINDOW_PAD) / 60) * 60;
  if (end - start < MIN_SPAN) {
    end = start + MIN_SPAN;
  }
  return { from: Math.max(0, start), to: Math.min(1440, end) };
}

/**
 * The shapes one lane is made of.
 *
 * `params.coordSys` gives the plot rectangle, which is what lets a lane span the full
 * width regardless of where — or whether — its dot sits.
 * @param {!Object} params ECharts renderItem params.
 * @param {!Object} api ECharts renderItem api.
 * @param {!Object} palette A palette from `readPalette`.
 * @returns {!Object} A zrender group.
 */
function renderLane_(params, api, palette) {
  const plot = params.coordSys;
  const laneIndex = api.value(1);
  const state = LANE_ORDER[api.value(2)];
  // The colour comes from the lane's own index rather than from ECharts' per-item cycling,
  // because the lane index *is* the company's slot in COMPANIES order — the same slot it
  // wears on the Line chart and everywhere else.
  const color = seriesColor(palette, laneIndex);

  const centreY = api.coord([api.value(0), laneIndex])[1];
  const height = Math.min(api.size([0, 1])[1] * 0.62, MAX_LANE_HEIGHT);
  const top = centreY - height / 2;
  const radius = height / 2;
  const band = { x: plot.x, y: top, width: plot.width, height, r: radius };

  const children = [
    // The lane itself. A sunken band rather than a bare rule: six of these read as six
    // lanes, and the band is the hit target the tooltip hangs off.
    { type: 'rect', shape: band, style: { fill: palette.canvasSunken } },
  ];

  if (state === LANE.MISSING) {
    // The loudest mark on the chart, and deliberately so — see the file header. Opacity
    // rather than a lighter colour, because there is no "critical wash" token and inventing
    // one in a chart file is how a hex gets written down.
    children.push({
      type: 'rect',
      shape: band,
      style: { fill: palette.critical, opacity: 0.12 },
    });
    children.push({
      type: 'text',
      style: {
        text: 'Not filed',
        x: plot.x + 14,
        y: centreY,
        fill: palette.critical,
        font: '600 12px ' + palette.fontUi,
        textVerticalAlign: 'middle',
      },
    });
    return { type: 'group', children };
  }

  if (state === LANE.NO_TIME) {
    children.push({
      type: 'text',
      style: {
        text: 'Filed — no time recorded',
        x: plot.x + 14,
        y: centreY,
        fill: palette.inkMuted,
        font: '12px ' + palette.fontUi,
        textVerticalAlign: 'middle',
      },
    });
    return { type: 'group', children };
  }

  const dotX = api.coord([api.value(0), laneIndex])[0];
  // The elapsed bar. This is the mark that makes the chart legible without reading a
  // number off it: six bars of different lengths sort themselves.
  children.push({
    type: 'rect',
    shape: { x: plot.x, y: top, width: Math.max(0, dotX - plot.x), height, r: radius },
    style: { fill: color, opacity: 0.22 },
  });
  children.push({
    type: 'circle',
    shape: { cx: dotX, cy: centreY, r: 6 },
    // A 2px surface ring, so the dot stays legible against its own bar.
    style: { fill: color, stroke: palette.surface, lineWidth: 2 },
  });

  // The time, inside the plot on whichever side of the dot has room. A label placed
  // unconditionally to the right is clipped for the company that filed last.
  const nearRight = dotX > plot.x + plot.width - 56;
  children.push({
    type: 'text',
    style: {
      text: fmtClock(api.value(0)),
      x: nearRight ? dotX - 12 : dotX + 12,
      y: centreY,
      fill: palette.ink,
      font: '600 12px ' + palette.fontUi,
      textAlign: nearRight ? 'right' : 'left',
      textVerticalAlign: 'middle',
    },
  });

  return { type: 'group', children };
}

/** @type {string[]} LANE values by index, so a state can travel in a numeric data value. */
const LANE_ORDER = [LANE.FILED, LANE.NO_TIME, LANE.MISSING];

/**
 * Builds the ECharts option.
 * @param {!Object} props The component's props.
 * @param {!Object} palette A palette from `readPalette`.
 * @returns {!Object} The option.
 */
function option_(props, palette) {
  const { entries, deadline, from = null, to = null } = props;
  const span = windowFor_(entries, from, to);
  const base = baseOption(palette);

  return {
    ...base,
    // No left gutter beyond the company names, and no bottom unit: the axis is a clock and
    // says so in its own labels. The top gap is the deadline rule's label, which sits above
    // the plot — inside it, the label lands on whichever lane happens to be behind it.
    grid: { left: 8, right: 16, top: deadline ? 22 : 8, bottom: 8, containLabel: true },
    tooltip: {
      ...base.tooltip,
      trigger: 'item',
      formatter: (params) => {
        const entry = params.data.entry;
        const state = stateOf_(entry);
        return tooltipLines(
          entry.company,
          [
            state === LANE.FILED ? 'Filed at ' + fmtClock(entry.at.minutes) : '',
            state === LANE.NO_TIME ? 'Filed, but the timestamp carries no time of day.' : '',
            state === LANE.MISSING ? 'No parade state filed for this session.' : '',
          ],
          palette
        );
      },
    },
    xAxis: axisOption(palette, {
      type: 'value',
      min: span.from,
      max: span.to,
      interval: Math.max(30, Math.round((span.to - span.from) / 6 / 30) * 30),
      axisLabel: {
        color: palette.inkMuted,
        fontSize: 11,
        fontFamily: palette.fontUi,
        formatter: (value) => fmtClock(value),
      },
      splitLine: { show: false },
      axisLine: { show: false },
    }),
    yAxis: axisOption(palette, {
      type: 'category',
      data: entries.map((entry) => entry.company),
      // Index 0 at the top: the lanes are in COMPANIES parade order and should be read down.
      inverse: true,
      splitLine: { show: false },
      axisLine: { show: false },
      axisLabel: { color: palette.ink, fontSize: 13, fontFamily: palette.fontUi, margin: 12 },
    }),
    series: [
      {
        type: 'custom',
        name: 'Filing',
        renderItem: (params, api) => renderLane_(params, api, palette),
        // Encoded so the tooltip and axis pointer know which axis each value belongs to.
        encode: { x: 0, y: 1 },
        data: entries.map((entry, index) => ({
          value: [
            stateOf_(entry) === LANE.FILED ? entry.at.minutes : span.from,
            index,
            LANE_ORDER.indexOf(stateOf_(entry)),
          ],
          entry,
        })),
      },
      {
        // An empty carrier for the deadline rule, so the rule does not depend on the lane
        // series' data and does not move when a lane's state changes.
        type: 'line',
        name: '__deadline',
        silent: true,
        data: [],
        markLine: deadline
          ? {
              silent: true,
              symbol: 'none',
              lineStyle: { color: palette.inkMuted, width: 1, type: 'solid' },
              label: {
                formatter: deadline.label || fmtClock(deadline.minutes),
                // Above the plot, and unrotated: ECharts otherwise lays a markLine's label
                // along its own line, and this line is vertical. `'start'` is the axis's
                // origin end, which on a vertical rule over an inverted category axis is
                // the top — the only place a label does not land on a lane or on a tick.
                position: 'start',
                rotate: 0,
                color: palette.inkMuted,
                fontSize: 11,
              },
              data: [{ xAxis: deadline.minutes }],
            }
          : undefined,
      },
    ],
  };
}

/**
 * The morning filing timeline: six lanes, one day.
 * @param {{entries: Array<{company: string, filed: boolean, at: ?{hour: number,
 *         minute: number, minutes: number}}>,
 *     deadline: ({minutes: number, label: (string|undefined)}|undefined),
 *     from: (number|undefined), to: (number|undefined),
 *     height: (number|undefined), view: (string|undefined)}} props
 *     `entries` is `model/submissions.js`'s `filingsOn` output, passed straight through and
 *     already in `COMPANIES` order — the lane order and the colour slots both come from
 *     that order, so do not sort it; `deadline` draws a labelled vertical rule at a time of
 *     day the parade state is expected by; `from` and `to` override the computed clock
 *     window, in minutes past midnight; `view` is set by `ChartCard`.
 * @returns {!Object} The chart, or its table twin.
 */
export function Timeline(props) {
  const { entries, height = 44 * (props.entries || []).length + 44, view } = props;
  if (view === 'table') {
    return (
      <TableTwin
        columns={[{ label: 'Company' }, { label: 'Filed' }, { label: 'Time', numeric: true }]}
        rows={entries.map((entry) => {
          const state = stateOf_(entry);
          return [
            entry.company,
            state === LANE.MISSING ? 'No' : 'Yes',
            state === LANE.FILED ? fmtClock(entry.at.minutes) : '—',
          ];
        })}
        caption="Parade state filing time by company"
      />
    );
  }
  const missing = entries.filter((entry) => stateOf_(entry) === LANE.MISSING).length;
  return (
    <Plot
      height={height}
      label={
        entries.length -
        missing +
        ' of ' +
        entries.length +
        ' companies filed. Switch to Table for the times.'
      }
      build={(palette) => option_(props, palette)}
    />
  );
}

/**
 * Whether there is anything to draw.
 *
 * Note what is deliberately *not* empty: six companies that all filed nothing. That is the
 * most important thing this chart ever shows, and hiding it behind an empty state would
 * turn the worst morning of the term into a blank card.
 * @param {!Object} props The component's props.
 * @returns {boolean} True when there are no companies at all.
 */
Timeline.isEmpty = (props) => !props.entries || props.entries.length === 0;
