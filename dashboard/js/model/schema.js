/**
 * What the dashboard requires of each spreadsheet tab.
 *
 * This is the read-side mirror of `src/parser/ParserSchema.js` and
 * `src/formsg/FormSgColumns.js`, which remain the single source of truth for the
 * sheet's shape. Nothing here defines layout — it names the subset of headers the
 * dashboard actually reads, so that a tab it cannot understand fails loudly with the
 * missing header named, rather than silently charting the wrong column.
 *
 * Columns are resolved by header name at read time rather than by fixed index. The
 * dashboard is a read-only consumer, so it can afford to tolerate a column being added
 * or reordered upstream; what it cannot afford is to read `reason` out of the `location`
 * column. `dashboard/test/schema.test.js` asserts every header named here still exists
 * in the canonical column arrays, so an upstream rename breaks a test rather than a
 * chart.
 */

/**
 * Names of the four tabs the dashboard reads.
 * @type {{STRENGTH: string, PERSONNEL: string, ROSTER: string, FORMSG: string}}
 */
export const TABS = {
  STRENGTH: 'Strength Data',
  PERSONNEL: 'Personnel Data',
  ROSTER: 'Command Roster',
  FORMSG: 'Report Sick FormSG Responses',
};

/**
 * Headers read from "Strength Data".
 * @type {string[]}
 */
export const STRENGTH_HEADERS = [
  'parade_response_id',
  'date',
  'session',
  'company',
  'platoon',
  'unit_type',
  'total_strength',
  'total_present',
];

/**
 * Headers read from "Personnel Data".
 * @type {string[]}
 */
export const PERSONNEL_HEADERS = [
  'parade_response_id',
  'date',
  'session',
  'company',
  'platoon',
  'four_d',
  'name',
  'rank',
  'reason_category',
  'start_date',
  'end_date',
  'num_days',
  'reason',
];

/**
 * Headers read from "Command Roster".
 * @type {string[]}
 */
export const ROSTER_HEADERS = ['date', 'session', 'company', 'role', 'rank', 'name'];

/**
 * Headers read from "Report Sick FormSG Responses".
 *
 * Deliberately excludes `SingPass Validated NRIC` and `Masked NRIC`. The dashboard has
 * no use for an NRIC, so it never asks for one — the narrowest read is the one that
 * cannot leak.
 * @type {string[]}
 */
export const FORMSG_HEADERS = [
  'Timestamp',
  'RANK',
  '[Myinfo] Name',
  '4D Number (REC Only)',
  'Unit & Coy',
  'Report Sick Type',
  'Reason for Reporting Sick (Keep Brief)',
  'I am experiencing _____________________ symptoms.',
];

/**
 * NRIC-bearing FormSG headers the dashboard must never request.
 *
 * Named rather than merely omitted so that `dashboard/test/schema.test.js` can assert
 * their absence. An accidental paste into FORMSG_HEADERS then fails a test instead of
 * shipping.
 * @type {string[]}
 */
export const FORBIDDEN_HEADERS = ['SingPass Validated NRIC', 'Masked NRIC'];

/**
 * The six companies the battalion tracks, in parade order.
 *
 * Mirrors `COMPANIES` in `src/parser/ParserSchema.js`. The dashboard needs its own copy
 * to answer "which companies have not reported yet", which requires knowing the full
 * expected set rather than only the set present in the data.
 * @type {string[]}
 */
export const COMPANIES = ['Archer', 'Braves', 'Cougar', 'Stallion', 'Scorpion', 'Hercules'];

/**
 * Allowed parade sessions: first parade of the day, and last.
 * @type {string[]}
 */
export const SESSIONS = ['FPS', 'LPS'];

/**
 * The `unit_type` marking a Strength Data row as a whole-company total.
 *
 * Battalion strength sums only these rows. Summing platoon rows instead would
 * double-count, and would silently drop companies that report no platoon breakdown.
 * @type {string}
 */
export const UNIT_TYPE_COMPANY = 'Company';
