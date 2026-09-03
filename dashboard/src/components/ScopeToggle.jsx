/**
 * The Battalion / Companies switch on every trend chart.
 */

/**
 * A two-way segmented toggle.
 * @param {{value: string, onChange: function(string): void}} props `value` is
 *     'battalion' or 'companies'.
 * @returns {!preact.VNode} The toggle.
 */
export function ScopeToggle({ value, onChange }) {
  return (
    <div class="toggle" role="group" aria-label="Chart scope">
      <button
        class="button--toggle"
        type="button"
        aria-pressed={value === 'battalion'}
        onClick={() => onChange('battalion')}
      >
        Battalion
      </button>
      <button
        class="button--toggle"
        type="button"
        aria-pressed={value === 'companies'}
        onClick={() => onChange('companies')}
      >
        Companies
      </button>
    </div>
  );
}
