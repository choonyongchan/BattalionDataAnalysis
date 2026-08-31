/**
 * Chart construction, against one shared theme.
 *
 * The rules encoded here, rather than left to each view's judgement:
 *
 * - **Colour is assigned by the job it does.** A single measure across categories gets one
 *   hue — identity comes from the axis labels, so painting each bar differently would
 *   spend eight colours saying nothing. Multiple series get the categorical slots in fixed
 *   order. Magnitude gets the sequential blue ramp. Status colours are never used here.
 * - **One y-axis, always.** Two measures at different scales become two charts.
 * - **Thin marks, hairline solid grid, no dashes.** Dashing reads as "projection" or
 *   "threshold" when it is only a gridline.
 * - **A tooltip on every chart, and a legend whenever there are two or more series.**
 *   Values are also reachable in each card's table twin, so a tooltip never gates a number.
 *
 * `ECHARTS_MISSING` is thrown when the CDN script did not load or failed its integrity
 * check; `app.js` turns that into a message rather than a page of empty boxes.
 */

/** @type {!Object<string, string>} Palette roles, read from the stylesheet. */
const COLOR = readPalette_();

/** @type {number} Slices below this share of the whole carry no direct label. */
const LABEL_MIN_PERCENT = 3;

/** @type {Array<!Object>} Live chart instances, resized together. */
const instances = [];

/**
 * Reads the palette from the CSS custom properties, so the stylesheet stays the one
 * place a colour is defined.
 * @returns {!Object<string, string>} Palette roles to hex values.
 */
function readPalette_() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => (styles.getPropertyValue(name) || fallback).trim();
  return {
    surface: read('--surface-1', '#1a1a19'),
    text: read('--text-primary', '#ffffff'),
    secondary: read('--text-secondary', '#c3c2b7'),
    muted: read('--text-muted', '#8a8981'),
    rule: read('--rule', '#2f2f2d'),
    series: [
      read('--series-1', '#3987e5'),
      read('--series-2', '#d95926'),
      read('--series-3', '#199e70'),
      read('--series-4', '#c98500'),
    ],
    neutral: [
      read('--neutral-1', '#514f4b'),
      read('--neutral-2', '#77766d'),
      read('--neutral-3', '#9d9c92'),
    ],
    sequential: [
      read('--seq-1', '#104281'),
      read('--seq-2', '#1c5cab'),
      read('--seq-3', '#2a78d6'),
      read('--seq-4', '#5598e7'),
      read('--seq-5', '#9ec5f4'),
    ],
    critical: read('--critical', '#d03b3b'),
  };
}

/**
 * The palette, for views that assign a colour per mark rather than per series.
 *
 * Exposed rather than duplicated in the views, so the stylesheet stays the one place a
 * colour is written down.
 * @returns {!Object<string, *>} Palette roles to values.
 */
export function palette() {
  return COLOR;
}

/**
 * Shared option fragments every chart starts from.
 * @returns {!Object} Base ECharts options.
 */
function base_() {
  return {
    backgroundColor: 'transparent',
    animationDuration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300,
    textStyle: { fontFamily: '"IBM Plex Sans", system-ui, sans-serif', color: COLOR.secondary },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      backgroundColor: '#232322',
      borderColor: COLOR.rule,
      textStyle: { color: COLOR.text, fontSize: 12 },
      confine: true,
    },
  };
}

/**
 * Axis styling: hairline, solid, one shade off the surface.
 * @param {!Object=} extra Axis properties to merge in.
 * @returns {!Object} An axis option object.
 */
function axis_(extra) {
  return {
    axisLine: { lineStyle: { color: COLOR.rule } },
    axisTick: { show: false },
    axisLabel: { color: COLOR.muted, fontSize: 11, fontFamily: '"IBM Plex Mono", ui-monospace, monospace' },
    splitLine: { lineStyle: { color: COLOR.rule, type: 'solid' } },
    ...extra,
  };
}

/**
 * A value axis carrying a unit name that stays inside the plot.
 *
 * ECharts centres an axis name on the axis line, which puts roughly half of it outside
 * the SVG: a vertical axis's name overhangs the left edge and a horizontal axis's name
 * overhangs the right, and the browser clips both — a unit label came out with its
 * first characters missing. Aligning the text toward the inside of the plot keeps it
 * whole at either end.
 * @param {string=} name The unit, shown at the far end of the axis.
 * @param {boolean=} vertical Whether this axis runs up the page.
 * @returns {!Object} An axis option object.
 */
function valueAxis_(name, vertical) {
  return axis_({
    type: 'value',
    name: name,
    // A vertical axis takes its unit at the top, aligned left so it does not overhang the
    // plot's left edge. A horizontal one takes it centred underneath instead of at the
    // end: at the end it lands directly above the last tick and reads as part of that
    // number — "soldiers" sitting on top of "60".
    nameLocation: vertical ? 'end' : 'middle',
    nameGap: vertical ? 6 : 24,
    nameTextStyle: {
      color: COLOR.muted,
      fontSize: 11,
      align: vertical ? 'left' : 'center',
    },
  });
}

/**
 * Grid padding that leaves room for a unit label under a horizontal value axis.
 *
 * `containLabel` reserves space for tick labels but not for the axis name, so a name
 * placed beneath the axis falls outside the SVG and is clipped. This is the room it needs.
 * @param {boolean} needed Whether a horizontal axis name will be drawn.
 * @returns {!Object} A grid option object.
 */
function gridFor_(needed) {
  return { ...base_().grid, bottom: needed ? 26 : base_().grid.bottom };
}

/**
 * Creates a chart on an element and registers it for resizing.
 * @param {!HTMLElement} node Container element.
 * @param {!Object} option ECharts option.
 * @returns {!Object} The chart instance.
 * @throws {Error} If the ECharts library is unavailable.
 */
function mount_(node, option) {
  if (!window.echarts) {
    throw new Error('ECHARTS_MISSING');
  }
  const chart = window.echarts.init(node, null, { renderer: 'svg' });
  chart.setOption(option);
  instances.push(chart);

  // ECharts reserves the axis-label gutter by measuring the labels at setOption time. If
  // the web fonts have not arrived yet it measures the fallback, which is narrower, and
  // the real font then overflows the space reserved for it — long category labels lose
  // their first characters. Re-laying out once the fonts land fixes it for good.
  if (document.fonts && document.fonts.status !== 'loaded') {
    document.fonts.ready.then(() => {
      if (!chart.isDisposed()) {
        chart.resize();
      }
    });
  }
  return chart;
}

/**
 * Resizes every live chart. Called on window resize and after a view swap.
 * @returns {void}
 */
export function resizeAll() {
  instances.forEach((chart) => {
    if (!chart.isDisposed()) {
      chart.resize();
    }
  });
}

/**
 * Disposes every chart from the outgoing view.
 *
 * Without this each navigation would leak an instance and its resize listener, and a
 * dashboard left open all day would slow to a crawl.
 * @returns {void}
 */
export function disposeAll() {
  instances.splice(0).forEach((chart) => {
    if (!chart.isDisposed()) {
      chart.dispose();
    }
  });
}

/**
 * A bar chart of one measure across categories.
 *
 * One hue for every bar: the categories are identified by their axis labels, so colour
 * has no work to do here. Horizontal when the labels are words, which is most of the time.
 * @param {!HTMLElement} node Container element.
 * @param {!Object} spec Chart contents.
 * @returns {!Object} The chart instance.
 */
export function barChart(node, spec) {
  const horizontal = spec.horizontal !== false;
  const categoryAxis = axis_({ type: 'category', data: spec.categories, splitLine: { show: false } });
  const valueAxis = valueAxis_(spec.valueName, !horizontal);

  return mount_(node, {
    ...base_(),
    grid: gridFor_(horizontal && Boolean(spec.valueName)),
    tooltip: { ...base_().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: [
      {
        type: 'bar',
        name: spec.valueName || 'Value',
        data: spec.values.map((value, index) => ({
          value,
          // Set per item rather than only on the series: a data-level itemStyle would
          // otherwise replace the series-level radius and square the bar ends off.
          itemStyle: {
            color: spec.highlight && spec.highlight(index) ? COLOR.critical : COLOR.series[0],
            borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
          },
        })),
        barMaxWidth: 18,
        markLine: spec.meanLine
          ? {
              silent: true,
              symbol: 'none',
              // Placed inside the plot: an end-positioned label is clipped by the grid.
              // `rotate: 0` because ECharts otherwise lays a markLine's label along the
              // line, and on a horizontal bar chart that line is vertical — the caption
              // came out running up the page on its side.
              label: {
                formatter: spec.meanLineLabel || 'battalion mean',
                position: horizontal ? 'insideEndTop' : 'insideStartTop',
                rotate: 0,
                color: COLOR.muted,
                fontSize: 10,
              },
              lineStyle: { color: COLOR.muted, type: 'solid', width: 1 },
              data: [horizontal ? { xAxis: spec.meanLine } : { yAxis: spec.meanLine }],
            }
          : undefined,
      },
    ],
  });
}

/**
 * A multi-series line chart over dates.
 *
 * Series take the categorical slots in fixed order, so a series keeps its colour when a
 * filter removes one of its neighbours. A legend is always present; points are left
 * unlabelled and the crosshair tooltip carries the values.
 * @param {!HTMLElement} node Container element.
 * @param {!Object} spec Chart contents.
 * @returns {!Object} The chart instance.
 */
export function lineChart(node, spec) {
  return mount_(node, {
    ...base_(),
    grid: { ...base_().grid, top: 36 },
    tooltip: { ...base_().tooltip, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: COLOR.rule } } },
    // Right-aligned so it never lands on the y-axis name, which sits top-left.
    legend: {
      show: spec.series.length > 1,
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 10,
      icon: 'roundRect',
      textStyle: { color: COLOR.secondary, fontSize: 11 },
    },
    // `boundaryGap: false` puts the first and last points hard against the plot edges,
    // and their labels are centred on them — so half of each hangs outside the SVG and is
    // clipped. Anchoring the two end labels inward is what keeps the date range readable.
    xAxis: axis_({
      type: 'category',
      data: spec.dates,
      boundaryGap: false,
      splitLine: { show: false },
      axisLabel: {
        color: COLOR.muted,
        fontSize: 11,
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        alignMinLabel: 'left',
        alignMaxLabel: 'right',
      },
    }),
    yAxis: valueAxis_(spec.valueName, true),
    series: spec.series.map((series, index) => ({
      type: 'line',
      name: series.name,
      data: series.values,
      smooth: false,
      symbol: 'circle',
      symbolSize: 8,
      showSymbol: spec.dates.length <= 45,
      lineStyle: { width: 2, color: COLOR.series[index % COLOR.series.length] },
      itemStyle: { color: COLOR.series[index % COLOR.series.length], borderColor: COLOR.surface, borderWidth: 2 },
      // Bridged, not broken. A parade nobody filed leaves a hole in the series, and a
      // gapped line reads as the rate having dropped to nothing rather than as an
      // unfiled day. The straight segment across a gap is an interpolation, so the
      // point itself is left unmarked and the table twin shows the day as '—'.
      connectNulls: true,
    })),
  });
}

/**
 * Renders tooltip lines as a text-only element.
 * @param {Array<string>} lines One line of tooltip text per entry.
 * @returns {!HTMLElement} A div holding the lines, inserted as text.
 */
function linesToNode_(lines) {
  const node = document.createElement('div');
  (lines && lines.length > 0 ? lines : ['No data']).forEach((line) => {
    const row = document.createElement('div');
    row.textContent = line;
    node.appendChild(row);
  });
  return node;
}

/**
 * A company by platoon heatmap of a rate.
 *
 * Sequential single-hue ramp: this encodes magnitude, so a rainbow would invent
 * categories that are not there. Cells that breach the outlier threshold are ringed
 * rather than recoloured, so the flag never competes with the value the colour carries.
 * @param {!HTMLElement} node Container element.
 * @param {!Object} spec Chart contents.
 * @returns {!Object} The chart instance.
 */
export function heatmap(node, spec) {
  const max = Math.max(1, ...spec.cells.map((cell) => cell[2] || 0));
  return mount_(node, {
    ...base_(),
    grid: { ...base_().grid, top: 12, bottom: 48 },
    // The formatter returns an element, not a markup string. An ECharts tooltip renders a
    // returned string as HTML, and the values here — company and platoon labels — reach us
    // from parade-state messages a model extracted from WhatsApp text. Building the node
    // and setting textContent means no sheet value is ever parsed as markup.
    tooltip: {
      ...base_().tooltip,
      formatter: (params) => linesToNode_(spec.detail(params.data[0], params.data[1])),
    },
    xAxis: axis_({ type: 'category', data: spec.columns, splitLine: { show: false }, axisLabel: { color: COLOR.muted, fontSize: 11, fontFamily: '"IBM Plex Mono", ui-monospace, monospace', interval: 0 } }),
    yAxis: axis_({ type: 'category', data: spec.rows, splitLine: { show: false } }),
    visualMap: {
      min: 0,
      max,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      // Sized for a horizontal bar, and labelled at both ends: a colour ramp with no
      // numbers on it tells the reader that a cell is darker, not by how much.
      itemWidth: 14,
      itemHeight: 160,
      text: [max.toFixed(1) + '%', '0%'],
      textGap: 8,
      textStyle: { color: COLOR.muted, fontSize: 11, fontFamily: '"IBM Plex Mono", ui-monospace, monospace' },
      inRange: { color: COLOR.sequential },
    },
    series: [
      {
        type: 'heatmap',
        data: spec.cells,
        // A 2px surface gap between cells, rather than a border drawn around each.
        itemStyle: { borderColor: COLOR.surface, borderWidth: 2, borderRadius: 2 },
        emphasis: { itemStyle: { borderColor: COLOR.text, borderWidth: 2 } },
        // Flagged cells are annotated rather than recoloured, so the flag never competes
        // with the value the cell's colour is carrying.
        markPoint: spec.flagged && spec.flagged.length > 0
          ? {
              symbol: 'circle',
              symbolSize: 12,
              silent: true,
              itemStyle: { color: COLOR.critical, borderColor: COLOR.surface, borderWidth: 2 },
              label: { show: false },
              data: spec.flagged,
            }
          : undefined,
      },
    ],
  });
}

/**
 * A donut chart of parts of one whole.
 *
 * The one form here where a circle is the right answer: the parts are mutually
 * exclusive, they sum to something meaningful, and "how is the battalion split today" is
 * a question about composition rather than comparison. It is capped at four slices and
 * used only where the parts genuinely sum — a pie of things that overlap, or that leave
 * a remainder, is a lie the shape tells for you.
 *
 * Slices are drawn as a ring rather than a filled pie so the total can sit in the middle,
 * which is the number a commander reads first. Every slice is directly labelled with its
 * name and count, so identity never rests on colour alone.
 * @param {!HTMLElement} node Container element.
 * @param {!Object} spec Chart contents.
 * @returns {!Object} The chart instance.
 */
export function donutChart(node, spec) {
  const total = spec.slices.reduce((sum, slice) => sum + (slice.value || 0), 0);
  // A card wide enough to seat the legend beside the ring rather than under it. Below
  // this the legend goes back to a row underneath, which is the only thing that fits on
  // a phone.
  const wide = node.clientWidth >= 620;
  const centre = wide ? ['42%', '50%'] : ['50%', '44%'];

  return mount_(node, {
    ...base_(),
    grid: undefined,
    tooltip: {
      ...base_().tooltip,
      formatter: (params) =>
        linesToNode_([
          params.name,
          fmtCount_(params.value) + ' of ' + fmtCount_(total),
          total > 0 ? (params.value / total * 100).toFixed(1) + '%' : '',
        ].filter(Boolean)),
    },
    legend: {
      ...(wide
        ? { orient: 'vertical', right: '18%', top: 'middle', itemGap: 10 }
        : { bottom: 0, left: 'center' }),
      itemWidth: 10,
      itemHeight: 10,
      icon: 'roundRect',
      textStyle: { color: COLOR.secondary, fontSize: 11 },
    },
    series: [
      {
        type: 'pie',
        // A ring, not a pie: the hole carries the total.
        radius: ['50%', '74%'],
        center: centre,
        avoidLabelOverlap: true,
        padAngle: 1.2,
        itemStyle: { borderColor: COLOR.surface, borderWidth: 2, borderRadius: 2 },
        // On a phone there is no room for a name beside the ring, and ECharts truncates
        // it to an ellipsis that says less than nothing. Below that width each slice
        // carries its value only, and the legend underneath carries the names.
        label: {
          color: COLOR.secondary,
          fontSize: 11,
          // A slice thinner than this cannot hold a leader line without its label
          // landing on its neighbour's. Below the cut the slice keeps its colour, its
          // legend entry, its tooltip and its row in the table twin — it stops
          // competing only for the space it does not have. Off/leave is 6 soldiers of
          // 738 in the real data, and labelling it costs two larger slices their
          // position.
          formatter: (params) =>
            node.clientWidth < 420
              ? fmtCount_(params.value)
              : params.name + '\n' + fmtCount_(params.value),
        },
        labelLine: { lineStyle: { color: COLOR.rule }, length: 8, length2: 8 },
        data: spec.slices.map((slice, index) => {
          // Set on the item, not in the formatter: returning an empty string still
          // reserves the label's slot and still draws its leader line, which lands on
          // the chart as a stub pointing at nothing.
          const labelled =
            total > 0 && ((slice.value || 0) / total) * 100 >= LABEL_MIN_PERCENT;
          return {
            name: slice.name,
            value: slice.value,
            label: { show: labelled },
            labelLine: { show: labelled },
            itemStyle: { color: slice.color || COLOR.series[index % COLOR.series.length] },
          };
        }),
      },
    ],
    graphic: total > 0 ? centreLabel_(spec.centreLabel, total, centre) : undefined,
  });
}

/**
 * The total, set in the donut's hole.
 * @param {string} label What the total counts.
 * @param {number} total The total.
 * @returns {Array<!Object>} ECharts graphic elements.
 */
function centreLabel_(label, total, centre) {
  // Anchored to the ring's own centre, not to the canvas. When the legend moves to the
  // right the ring slides left with it, and a canvas-centred total would sit off the
  // hole and over the slices.
  const x = centre[0];
  const y = parseFloat(centre[1]);
  return [
    {
      type: 'text',
      left: x,
      top: y - 7 + '%',
      silent: true,
      style: {
        text: fmtCount_(total),
        fill: COLOR.text,
        font: '600 26px "IBM Plex Sans", system-ui, sans-serif',
        textAlign: 'center',
      },
    },
    {
      type: 'text',
      left: x,
      top: y + 3 + '%',
      silent: true,
      style: {
        text: label || '',
        fill: COLOR.muted,
        font: '11px "IBM Plex Mono", ui-monospace, monospace',
        textAlign: 'center',
      },
    },
  ];
}

/**
 * A stacked bar chart: one bar per category, split into named parts.
 *
 * Used where both the size of a bar and its internal mix matter — "which company is
 * thinnest, and is the gap MC or duty" is one question, and splitting it across two
 * charts makes the reader hold one answer in their head while finding the other.
 *
 * Segments take the categorical slots in fixed order and are separated by a 2px surface
 * gap, which is what keeps two adjacent hues legible for a viewer who cannot tell them
 * apart. A legend is always present, and the card's table twin carries every value.
 * @param {!HTMLElement} node Container element.
 * @param {!Object} spec Chart contents.
 * @returns {!Object} The chart instance.
 */
export function stackedBarChart(node, spec) {
  const horizontal = spec.horizontal !== false;
  const categoryAxis = axis_({ type: 'category', data: spec.categories, splitLine: { show: false } });
  const valueAxis = valueAxis_(spec.valueName, !horizontal);

  return mount_(node, {
    ...base_(),
    grid: { ...gridFor_(horizontal && Boolean(spec.valueName)), top: 36 },
    tooltip: {
      ...base_().tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) =>
        linesToNode_([
          params[0].axisValue,
          ...params
            .filter((entry) => entry.value > 0)
            .map((entry) => entry.seriesName + ': ' + fmtCount_(entry.value)),
        ]),
    },
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 10,
      icon: 'roundRect',
      textStyle: { color: COLOR.secondary, fontSize: 11 },
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: spec.series.map((series, index) => ({
      type: 'bar',
      name: series.name,
      stack: 'total',
      data: series.values,
      barMaxWidth: 22,
      // A 2px surface gap between segments rather than a border: the gap is what makes
      // two adjacent hues separable without adding a third visual channel.
      // A surface-coloured hairline on every side, which reads as a gap where two
      // segments meet: that gap is what keeps adjacent hues separable for a viewer who
      // cannot tell them apart, without spending a third visual channel on it.
      itemStyle: {
        color: series.neutral ? COLOR.muted : COLOR.series[index % COLOR.series.length],
        borderColor: COLOR.surface,
        borderWidth: 1,
      },
    })),
  });
}

/**
 * Formats a count for a chart label, with thousands separators.
 * @param {number} value The value.
 * @returns {string} The formatted count.
 */
function fmtCount_(value) {
  return new Intl.NumberFormat('en-SG').format(Math.round(value || 0));
}
