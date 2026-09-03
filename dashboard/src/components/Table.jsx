/**
 * A plain data table, used directly by leaderboards and as a chart's table twin.
 *
 * Wrapped in its own horizontally-scrolling box so a wide table never makes the page
 * itself scroll sideways — the one layout rule every page in this dashboard keeps.
 */

/**
 * Renders a table from column definitions and rows.
 * @param {{columns: Array<{key: string, label: string, numeric?: boolean}>,
 *     rows: Array<!Object>, rowKey?: function(!Object, number): (string|number)}} props
 *     `columns` names each field to show and whether it right-aligns as a number;
 *     `rows` are plain objects read by `columns[].key`; `rowKey` picks a React key,
 *     defaulting to the row's index.
 * @returns {!preact.VNode} The table, scroll-boxed.
 */
export function DataTable({ columns, rows, rowKey }) {
  return (
    <div class="tablewrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} class={column.numeric ? 'num' : ''}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey ? rowKey(row, index) : index}>
              {columns.map((column) => (
                <td key={column.key} class={column.numeric ? 'num' : ''}>
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
