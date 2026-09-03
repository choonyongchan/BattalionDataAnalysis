/**
 * Repairs text-shaped Timestamp cells left behind by a FormSG CSV import.
 *
 * Separate from FormSgSheet because it belongs to the other intake path: rows pasted
 * from FormSG's CSV export rather than relayed through Plumber. The webhook path
 * already writes real Dates.
 */
class FormSgTimestamps {
  /**
   * Rewrites text-shaped Timestamp cells as real Date values.
   *
   * FormSG's CSV export writes timestamps as "07 May 2026 19:21:00". Whether Google
   * Sheets parses that into a Date or leaves it as text depends on how the export was
   * pasted, which is why the column arrives half one and half the other. Real Dates
   * are canonical: they sort chronologically and read back as dates downstream.
   *
   * Re-runnable, and meant to be re-run: every fresh CSV import reintroduces text
   * timestamps. Cells that are already Dates are left untouched, and anything matching
   * neither shape is reported rather than guessed at.
   * @returns {void}
   */
  static normalise() {
    const column = FormSgSchema.columnIndex(FORMSG_TIMESTAMP_HEADER);
    if (column === 0) {
      Logger.log(`No "${FORMSG_TIMESTAMP_HEADER}" column in FORMSG_COLUMNS — nothing to do.`);
      return;
    }

    const sheet = FormSgSchema.sheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      Logger.log('No data rows to normalise.');
      return;
    }

    const range = sheet.getRange(2, column, lastRow - 1, 1);
    const unparsed = [];
    let converted = 0;
    let alreadyDates = 0;

    const normalised = range.getValues().map((cells, i) => {
      const value = cells[0];
      if (value instanceof Date) {
        alreadyDates++;
        return [value];
      }
      if (value === '' || value === null || value === undefined) return [value];

      const parsed = FormSgTimestamps.parseCsvTimestamp_(String(value));
      if (!parsed) {
        unparsed.push(`row ${i + 2}: ${value}`);
        return [value];
      }
      converted++;
      return [parsed];
    });

    range.setValues(normalised);
    // The pasted column may carry plain-text formatting, which would render a Date as
    // a raw serial number. This format also matches FormSG's own CSV rendering.
    range.setNumberFormat('dd mmm yyyy hh:mm:ss');

    Logger.log(`formSgNormaliseTimestamps: ${converted} converted, ${alreadyDates} already Dates, ${unparsed.length} unparsed.`);
    unparsed.slice(0, 20).forEach((entry) => Logger.log(`  unparsed — ${entry}`));
    if (unparsed.length > 20) Logger.log(`  …and ${unparsed.length - 20} more.`);
  }

  /**
   * Parses FormSG's CSV timestamp format, "dd MMM yyyy HH:mm:ss".
   *
   * Built explicitly rather than handed to `new Date(string)`, whose handling of
   * non-ISO formats is implementation-defined. The resulting Date is constructed in
   * the script's timezone (Asia/Singapore, per appsscript.json), which is the timezone
   * FormSG's export is already written in.
   *
   * @param {string} text The cell's text.
   * @returns {?Date} The parsed Date, or null if the text was not in that format.
   * @private
   */
  static parseCsvTimestamp_(text) {
    const match = /^\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(text);
    if (!match) return null;

    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthIndex = months.indexOf(match[2].toLowerCase());
    if (monthIndex === -1) return null;

    const parsed = new Date(
      Number(match[3]),
      monthIndex,
      Number(match[1]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0)
    );
    return isNaN(parsed.getTime()) ? null : parsed;
  }
}
