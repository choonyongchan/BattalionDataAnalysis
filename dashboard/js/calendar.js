/**
 * A two-click month-grid date-range picker.
 *
 * Built by hand rather than with a library for the same reasons the rest of this
 * dashboard is: no dependency to pin or audit, every node made through `el()` so
 * nothing untrusted reaches `innerHTML`, and it degrades to plain buttons a screen
 * reader can walk. The picker owns only its own transient UI state (which month is
 * shown, whether the popover is open, the half-made selection); the committed range
 * lives in the shell and arrives back through `onChange`.
 */

import {
  addMonths,
  daysOfMonth,
  firstOfMonth,
  mondayFirstIndex,
} from './model/daterange.js';
import { el, fmtDate } from './ui.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/**
 * The human label for a month, e.g. 'June 2026'.
 * @param {string} isoFirst ISO 'yyyy-MM-01'.
 * @returns {string} The label.
 */
function monthLabel(isoFirst) {
  const [year, month] = isoFirst.split('-').map(Number);
  return MONTHS[month - 1] + ' ' + year;
}

/**
 * Builds a date-range picker.
 *
 * @param {!Object} spec Picker configuration.
 * @param {string} spec.min Earliest selectable date, ISO 'yyyy-MM-dd'.
 * @param {string} spec.max Latest selectable date, ISO 'yyyy-MM-dd'.
 * @param {?string} spec.from Current range start, or null for "All".
 * @param {?string} spec.to Current range end, or null for "All".
 * @param {function({from: ?string, to: ?string}): void} spec.onChange
 *     Called with the committed range whenever the user completes a selection or
 *     clears it.
 * @returns {!HTMLElement} The picker element, ready to mount.
 */
export function dateRangePicker(spec) {
  const { min, max, onChange } = spec;
  let from = spec.from || null;
  let to = spec.to || null;
  let pendingFrom = null;
  let open = false;
  let shownMonth = firstOfMonth(to || from || max);

  const trigger = el('button', { class: 'daterange__trigger', type: 'button' });
  trigger.setAttribute('aria-haspopup', 'dialog');
  const popover = el('div', 'daterange__popover');
  popover.hidden = true;
  const root = el('div', 'daterange', [trigger, popover]);

  /** Updates the trigger's label from the committed range. */
  function paintTrigger() {
    trigger.textContent =
      from || to ? fmtDate(from) + ' – ' + fmtDate(to) : 'All dates';
    trigger.setAttribute('aria-expanded', String(open));
  }

  /** Sends the current committed range to the shell. */
  function commit() {
    onChange({ from, to });
  }

  /**
   * Closes the popover when a click lands outside the picker.
   * @param {!Event} event The document mousedown.
   */
  function onDocMouseDown(event) {
    if (!root.contains(event.target)) {
      close();
    }
  }

  /** Closes the popover and stops listening for outside clicks. */
  function close() {
    open = false;
    popover.hidden = true;
    pendingFrom = null;
    document.removeEventListener('mousedown', onDocMouseDown);
    paintTrigger();
  }

  /**
   * Handles a click on a day cell, running the two-click selection.
   * @param {string} isoDate The clicked day.
   */
  function pickDay(isoDate) {
    if (pendingFrom === null) {
      pendingFrom = isoDate;
      from = isoDate;
      to = null;
      renderPopover();
      return;
    }
    from = pendingFrom < isoDate ? pendingFrom : isoDate;
    to = pendingFrom < isoDate ? isoDate : pendingFrom;
    pendingFrom = null;
    paintTrigger();
    commit();
    close();
  }

  /** Rebuilds the popover's month grid and footer for the current state. */
  function renderPopover() {
    const prev = el('button', { class: 'calendar__nav', type: 'button' }, '‹');
    prev.setAttribute('aria-label', 'Previous month');
    prev.disabled = shownMonth <= firstOfMonth(min);
    prev.addEventListener('click', () => {
      shownMonth = addMonths(shownMonth, -1);
      renderPopover();
    });

    const next = el('button', { class: 'calendar__nav', type: 'button' }, '›');
    next.setAttribute('aria-label', 'Next month');
    next.disabled = shownMonth >= firstOfMonth(max);
    next.addEventListener('click', () => {
      shownMonth = addMonths(shownMonth, 1);
      renderPopover();
    });

    const head = el('div', 'calendar__head', [
      prev,
      el('span', 'calendar__month', monthLabel(shownMonth)),
      next,
    ]);

    const cells = WEEKDAYS.map((name) => el('span', 'calendar__weekday', name));
    const days = daysOfMonth(shownMonth);
    for (let blank = 0; blank < mondayFirstIndex(days[0]); blank += 1) {
      cells.push(el('span', 'calendar__day calendar__day--blank'));
    }
    days.forEach((isoDate) => {
      const disabled = isoDate < min || isoDate > max;
      let className = 'calendar__day';
      if (from && isoDate === from) {
        className += ' calendar__day--start';
      }
      if (to && isoDate === to) {
        className += ' calendar__day--end';
      }
      if (from && to && isoDate > from && isoDate < to) {
        className += ' calendar__day--in-range';
      }
      const cell = el('button', { class: className, type: 'button' }, String(Number(isoDate.slice(8))));
      cell.disabled = disabled;
      cell.title = fmtDate(isoDate);
      if (!disabled) {
        cell.addEventListener('click', () => pickDay(isoDate));
      }
      cells.push(cell);
    });

    const grid = el('div', 'calendar__grid', cells);

    const clear = el('button', { class: 'calendar__clear', type: 'button' }, 'All dates');
    clear.addEventListener('click', () => {
      from = null;
      to = null;
      pendingFrom = null;
      paintTrigger();
      commit();
      close();
    });

    const hint = el(
      'p',
      'calendar__hint',
      pendingFrom ? 'Pick the end date' : 'Pick the start date'
    );

    popover.textContent = '';
    popover.appendChild(el('div', 'calendar', [head, grid, hint, clear]));
  }

  trigger.addEventListener('click', () => {
    if (open) {
      close();
      return;
    }
    open = true;
    popover.hidden = false;
    shownMonth = firstOfMonth(to || from || max);
    pendingFrom = null;
    renderPopover();
    document.addEventListener('mousedown', onDocMouseDown);
    paintTrigger();
  });

  paintTrigger();
  return root;
}
