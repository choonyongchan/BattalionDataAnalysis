/**
 * The company filter shared by the medical pages.
 */

import { COMPANIES } from '../model/domain.js';

/**
 * A plain select offering "All companies" plus each of the six, in parade order.
 * @param {{value: string, onChange: function(string): void}} props `value` is a company
 *     name or 'ALL'.
 * @returns {!preact.VNode} The select.
 */
export function CompanySelect({ value, onChange }) {
  return (
    <label class="control">
      <span class="field__label">Company</span>
      <select class="field" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        <option value="ALL">All companies</option>
        {COMPANIES.map((company) => (
          <option key={company} value={company}>
            {company}
          </option>
        ))}
      </select>
    </label>
  );
}
