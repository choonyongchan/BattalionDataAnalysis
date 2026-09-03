/**
 * The Daily / Weekly / Monthly / Rotational switch on the reasons-over-time charts.
 */

import { GRANULARITIES } from '../model/buckets.js';

/**
 * A four-way segmented radio, reading its options from `buckets.js` so a grain added
 * there appears here for free.
 * @param {{value: string, onChange: function(string): void}} props The current
 *     granularity name, and what to call when it changes.
 * @returns {!preact.VNode} The radio group.
 */
export function GranularityRadio({ value, onChange }) {
  return (
    <div class="toggle" role="radiogroup" aria-label="Group dates by">
      {GRANULARITIES.map((option) => (
        <button
          key={option.name}
          class="button--toggle"
          type="button"
          role="radio"
          aria-checked={value === option.name}
          aria-pressed={value === option.name}
          onClick={() => onChange(option.name)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
