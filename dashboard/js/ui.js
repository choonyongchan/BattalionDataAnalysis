/**
 * DOM building blocks shared by every view.
 *
 * Two conventions worth knowing before adding to this file.
 *
 * **Every chart ships with a table twin.** `chartCard` builds both and a toggle between
 * them. That is the accessible equivalent for anything encoded by colour or position, and
 * it is also what S1 copies figures out of — so it is not an afterthought bolted on for
 * compliance, it is half the feature.
 *
 * **Nothing here interpolates untrusted text into markup.** Values from the spreadsheet
 * are soldiers' names and free-text medical reasons typed by people, so every insertion
 * goes through `textContent`. There is no `innerHTML` in this file.
 */

/**
 * Creates an element with optional class, text and children.
 * @param {string} tag Tag name.
 * @param {(string|!Object)=} classNameOrProps Class name, or a property bag.
 * @param {(string|Array<Node>)=} content Text content, or child nodes.
 * @returns {!HTMLElement} The element.
 */
export function el(tag, classNameOrProps, content) {
  const node = document.createElement(tag);
  if (typeof classNameOrProps === 'string') {
    node.className = classNameOrProps;
  } else if (classNameOrProps) {
    Object.entries(classNameOrProps).forEach(([key, value]) => {
      if (key === 'class') {
        node.className = value;
      } else if (key in node) {
        node[key] = value;
      } else {
        node.setAttribute(key, value);
      }
    });
  }
  if (typeof content === 'string') {
    node.textContent = content;
  } else if (Array.isArray(content)) {
    content.forEach((child) => child && node.appendChild(child));
  }
  return node;
}

/**
 * Formats a whole number, or an em dash when there is none.
 * @param {?number} value The number.
 * @returns {string} The formatted value.
 */
export function fmtInt(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : Math.round(value).toLocaleString('en-SG');
}

/**
 * Formats a number to one decimal place, or an em dash when there is none.
 * @param {?number} value The number.
 * @param {string=} suffix Text appended when a value is present.
 * @returns {string} The formatted value.
 */
export function fmtDecimal(value, suffix) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(1) + (suffix || '');
}

/**
 * Formats a proportion in the range 0..1 as a percentage.
 * @param {?number} value The proportion.
 * @returns {string} The formatted percentage.
 */
export function fmtShare(value) {
  return value === null || value === undefined ? '—' : Math.round(value * 100) + '%';
}

/**
 * Formats an ISO date the way the unit writes it.
 * @param {?string} isoDate ISO 'yyyy-MM-dd'.
 * @returns {string} A date like '22 Jun 26'.
 */
export function fmtDate(isoDate) {
  if (!isoDate) {
    return '—';
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [year, month, day] = isoDate.split('-');
  return Number(day) + ' ' + months[Number(month) - 1] + ' ' + year.slice(2);
}

/**
 * Builds a stat tile.
 *
 * The hero figure is set in the body sans at proportional widths, with any supporting
 * fraction or delta beneath it in mono — the two jobs want different figures, and mixing
 * them is what makes a large number look loose.
 * @param {!Object} spec Tile contents.
 * @returns {!HTMLElement} The tile.
 */
export function tile(spec) {
  const children = [
    el('span', 'tile__label', spec.label),
    el('span', 'tile__value', spec.value),
  ];
  if (spec.fraction) {
    children.push(el('span', 'fraction', spec.fraction));
  }
  if (spec.delta) {
    children.push(el('span', 'tile__delta ' + (spec.deltaClass || ''), spec.delta));
  }
  return el('div', 'tile', children);
}

/**
 * Formats a change against the previous parade, with its direction named in words.
 *
 * `betterWhen` matters: more soldiers present is good news and more on MC is not, so the
 * emphasis follows the meaning of the measure rather than the sign of the number. Without
 * it a rise in attendance would be tinted the same as a rise in absence. The direction is
 * also written out, so the reading never depends on the colour.
 * @param {?number} current The selected parade's value.
 * @param {?number} previous The previous parade's value.
 * @param {string} betterWhen 'up' when a rise is good news, 'down' when a fall is.
 * @param {string=} unit Suffix for the delta figure.
 * @returns {{text: string, className: string}} Delta text and its emphasis class.
 */
export function deltaOf(current, previous, betterWhen, unit) {
  const usable = (value) => value !== null && value !== undefined && Number.isFinite(value);
  if (!usable(current) || !usable(previous)) {
    return { text: 'no previous parade', className: '' };
  }
  const change = current - previous;
  if (Math.abs(change) < 0.05) {
    return { text: 'unchanged', className: '' };
  }
  const direction = change > 0 ? 'up' : 'down';
  const magnitude =
    Math.abs(change) >= 1 ? fmtInt(Math.abs(change)) : fmtDecimal(Math.abs(change));
  return {
    text: direction + ' ' + magnitude + (unit || '') + ' vs previous parade',
    className: direction === betterWhen ? 'delta--good' : 'delta--concern',
  };
}

/**
 * Builds a banner carrying a status word alongside its colour.
 *
 * The word is what conveys the state; the colour only reinforces it, so the banner still
 * reads correctly in greyscale or for a viewer who cannot separate the hues.
 * @param {string} tone One of 'info', 'warning', 'critical'.
 * @param {string} tag Short status word, shown in caps.
 * @param {string} message The message body.
 * @returns {!HTMLElement} The banner.
 */
export function banner(tone, tag, message) {
  return el('div', 'banner banner--' + tone, [
    el('span', 'banner__tag', tag),
    el('span', null, message),
  ]);
}

/**
 * Builds a table.
 * @param {Array<{label: string, numeric: (boolean|undefined)}>} columns Column specs.
 * @param {Array<Array<*>>} rows Cell values, in column order.
 * @param {boolean=} prose Whether cells hold sentences and should wrap rather than scroll.
 * @returns {!HTMLElement} A scrollable table wrapper.
 */
export function table(columns, rows, prose) {
  const head = el(
    'tr',
    null,
    columns.map((column) => el('th', column.numeric ? 'num' : null, column.label))
  );
  const body = rows.map((row) =>
    el(
      'tr',
      null,
      row.map((cell, index) => {
        const isNode = cell instanceof Node;
        const td = el('td', columns[index] && columns[index].numeric ? 'num' : null);
        if (isNode) {
          td.appendChild(cell);
        } else {
          td.textContent = cell === null || cell === undefined ? '—' : String(cell);
        }
        return td;
      })
    )
  );
  return el('div', 'table-wrap', [
    el('table', prose ? 'table--prose' : null, [
      el('thead', null, [head]),
      el('tbody', null, body),
    ]),
  ]);
}

/**
 * Builds a card holding a chart and its table twin, with a toggle between them.
 * @param {!Object} spec Card contents.
 * @param {string} spec.title Card heading.
 * @param {string=} spec.note One line of context under the heading.
 * @param {function(!HTMLElement): void} spec.render Draws the chart into the given element.
 * @param {!Object} spec.table Column specs and rows for the table twin.
 * @param {string=} spec.height Extra class for the chart container.
 * @returns {!HTMLElement} The card.
 */
export function chartCard(spec) {
  const chart = el('div', 'chart ' + (spec.height || ''));
  const twin = el('div', null, [table(spec.table.columns, spec.table.rows)]);
  twin.hidden = true;

  const toggle = el('button', { class: 'toggle', type: 'button' }, 'Table');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.addEventListener('click', () => {
    const showTable = twin.hidden;
    twin.hidden = !showTable;
    chart.hidden = showTable;
    toggle.setAttribute('aria-pressed', String(showTable));
    toggle.textContent = showTable ? 'Chart' : 'Table';
  });

  const card = el('section', 'card', [
    el('div', 'card__head', [el('h3', 'card__title', spec.title), toggle]),
    spec.note ? el('p', 'card__note', spec.note) : null,
    chart,
    twin,
  ]);

  // Rendered after insertion so the chart can measure a laid-out container.
  queueMicrotask(() => spec.render(chart));
  return card;
}

/**
 * Builds a keyword cloud from weighted words.
 *
 * Deliberately spans rather than a charting plugin: it needs no dependency, reflows on a
 * phone, stays selectable text for a screen reader, and cannot fail to load. Size carries
 * frequency and the count travels in the title attribute, so the ranking is never
 * conveyed by size alone.
 * @param {Array<{word: string, count: number}>} words Words with their counts.
 * @returns {!HTMLElement} The cloud.
 */
export function cloud(words) {
  if (words.length === 0) {
    return el('p', 'note note--muted', 'No free-text reasons in this window.');
  }
  const max = words[0].count;
  const min = words[words.length - 1].count;
  const spread = Math.max(1, max - min);
  return el(
    'div',
    'cloud',
    words.map((entry) => {
      const scale = 0.85 + ((entry.count - min) / spread) * 1.5;
      const span = el('span', 'cloud__word', entry.word);
      span.style.fontSize = scale.toFixed(2) + 'rem';
      span.title = entry.word + ' — ' + entry.count + (entry.count === 1 ? ' mention' : ' mentions');
      return span;
    })
  );
}

/**
 * Builds a section heading with an optional note beside it.
 * @param {string} title Heading text.
 * @param {string=} note Supporting line.
 * @returns {!HTMLElement} The heading block.
 */
export function sectionHead(title, note) {
  return el('div', 'section-head', [
    el('h2', null, title),
    note ? el('p', 'note note--muted', note) : null,
  ]);
}

/**
 * Replaces an element's children.
 * @param {!HTMLElement} parent The element to fill.
 * @param {Array<Node>} children The new children.
 * @returns {void}
 */
export function replace(parent, children) {
  parent.textContent = '';
  children.forEach((child) => child && parent.appendChild(child));
}
