/**
 * The report-sick flow: source, type, outcome, and — for a Status outcome — which
 * restriction it became.
 *
 * Four stages, five node columns:
 *
 *   Source (parade state only / both / FormSG only)
 *     -> Type (RSI / RSO / Medical Review / FFI / not recorded)
 *     -> Outcome (MC / Status / none recorded)
 *     -> Status bucket, for the Status outcome only
 *
 * This is event-level matching, and it is deliberately a different join from
 * `reconcile.js`'s `reconcileReportSick`, which counts distinct people per company for a
 * company-level cross-check. Here each report-sick episode and each unmatched FormSG
 * submission is one flow, matched to the other source within ±1 day on identity, and then
 * forward to whatever MC or Status followed within the next two days.
 *
 * **Nothing is dropped to make the diagram tidy.** An unmatched event gets its own
 * branch rather than being discarded. Scorpion files zero FormSG submissions in the whole
 * dataset, so every Scorpion event is 'Parade state only' — a fact about a missing form
 * channel, not about Scorpion's health, and `coverage.companiesWithNoFormSg` says so
 * explicitly. A Status row naming several restrictions fans out to several bucket links,
 * so the Status stage's outflow can exceed the Status node's inflow; `coverage.
 * statusMultiLabelled` flags exactly that rather than letting the diagram imply the parts
 * sum to the whole.
 *
 * Every function here is pure.
 */

import { classify, DUTY_CLASS } from './classify.js';
import { COMPANIES } from './domain.js';
import { addDays, isoToUtcMs, MS_PER_DAY } from './dates.js';
import { withinRange } from './dateRange.js';
import { identityOf } from './identity.js';
import { bucketsFor } from './statusBuckets.js';
import { toIsoDate, toText } from './values.js';

/** @type {number} How many days apart a parade-state event and a FormSG one may be and still count as the same event. */
export const SOURCE_MATCH_WINDOW_DAYS = 1;

/** @type {number} Earliest an outcome may start after the report-sick event, inclusive. */
export const OUTCOME_MATCH_MIN_DAYS = 0;

/** @type {number} Latest an outcome may start after the report-sick event, inclusive. */
export const OUTCOME_MATCH_MAX_DAYS = 2;

/** @type {string} The stage-1 label for an event seen only on the parade state. */
const SOURCE_PARADE_ONLY = 'Parade state only';

/** @type {string} The stage-1 label for an event seen in both sources. */
const SOURCE_BOTH = 'Both';

/** @type {string} The stage-1 label for an event seen only on FormSG. */
const SOURCE_FORMSG_ONLY = 'FormSG only';

/** @type {string} The stage-2 label for an event with no recorded type. */
const TYPE_NOT_RECORDED = 'Type not recorded';

/** @type {!Object<string, string>} FormSG's verbatim type answers, shortened. */
const TYPE_LABELS = {
  'Report Sick In-Camp (RSI)': 'RSI',
  'Report Sick Outside (RSO)': 'RSO',
  'Medical Review': 'Medical Review',
  FFI: 'FFI',
};

/** @type {string} The stage-3 label for an MC outcome. */
const OUTCOME_MC = 'MC';

/** @type {string} The stage-3 label for a Status outcome. */
const OUTCOME_STATUS = 'Status';

/** @type {string} The stage-3 label when nothing followed. */
const OUTCOME_NONE = 'None recorded';

/**
 * The number of whole days from one ISO date to another; may be negative.
 * @param {string} fromIso ISO 'yyyy-MM-dd'.
 * @param {string} toIso ISO 'yyyy-MM-dd'.
 * @returns {number} Whole days from `fromIso` to `toIso`.
 */
function daysBetween_(fromIso, toIso) {
  return Math.round((isoToUtcMs(toIso) - isoToUtcMs(fromIso)) / MS_PER_DAY);
}

/**
 * The date a report-sick episode's flow is measured from.
 * @param {!Object} episode An episode from `buildEpisodes`.
 * @returns {?string} ISO 'yyyy-MM-dd', or null when the episode names no date at all.
 */
function episodeEventDate_(episode) {
  return episode.startDate || episode.paradeDates[0] || null;
}

/**
 * The short type label for a FormSG type answer.
 * @param {string} reportSickType Raw 'Report Sick Type' answer.
 * @returns {string} A TYPE_LABELS value, or TYPE_NOT_RECORDED.
 */
function shortType_(reportSickType) {
  return TYPE_LABELS[toText(reportSickType)] || TYPE_NOT_RECORDED;
}

/**
 * Matches report-sick episodes to FormSG submissions by identity, within the source
 * window, greedily claiming the closest unclaimed submission per episode.
 * @param {Array<!Object>} episodes Report-sick episodes, date-known, in range.
 * @param {Array<!Object>} submissions FormSG submissions, in range.
 * @returns {{matches: Array<{episode: !Object, submission: ?Object}>,
 *     formsgOnly: Array<!Object>}} Every episode paired with a submission or null, and
 *     the submissions no episode claimed.
 */
function matchSources_(episodes, submissions) {
  const byKey = new Map();
  submissions.forEach((submission, index) => {
    const bucket = byKey.get(submission.key) || [];
    bucket.push(index);
    byKey.set(submission.key, bucket);
  });

  const claimed = new Set();
  const matches = episodes.map((episode) => {
    const eventDate = episodeEventDate_(episode);
    const candidates = (byKey.get(episode.key) || []).filter((index) => !claimed.has(index));
    let best = null;
    let bestDiff = Infinity;
    candidates.forEach((index) => {
      const diff = Math.abs(daysBetween_(eventDate, submissions[index].date));
      if (diff <= SOURCE_MATCH_WINDOW_DAYS && diff < bestDiff) {
        best = index;
        bestDiff = diff;
      }
    });
    if (best !== null) {
      claimed.add(best);
      return { episode, submission: submissions[best] };
    }
    return { episode, submission: null };
  });

  const formsgOnly = submissions.filter((_, index) => !claimed.has(index));
  return { matches, formsgOnly };
}

/**
 * Finds what followed a report-sick event: an MC, a Status, or nothing.
 *
 * MC wins when both occur, because Att C means excused all duties — the more
 * consequential outcome — and a single flow cannot fork.
 * @param {string} key The event's identity key.
 * @param {string} eventDate The event's ISO date.
 * @param {Array<!Object>} personnel Normalised Personnel Data records.
 * @returns {{outcome: string, buckets: string[]}} The outcome, and — for Status — every
 *     bucket its reason names.
 */
function outcomeFor_(key, eventDate, personnel) {
  const windowStart = addDays(eventDate, OUTCOME_MATCH_MIN_DAYS);
  const windowEnd = addDays(eventDate, OUTCOME_MATCH_MAX_DAYS);

  const candidates = personnel.filter((row) => {
    if (identityOf(row).key !== key) {
      return false;
    }
    const dutyClass = classify(row);
    if (dutyClass !== DUTY_CLASS.ATT_C && dutyClass !== DUTY_CLASS.STATUS) {
      return false;
    }
    const candidateDate = toIsoDate(row.start_date) || toIsoDate(row.date);
    return candidateDate !== null && candidateDate >= windowStart && candidateDate <= windowEnd;
  });

  const mc = candidates.find((row) => classify(row) === DUTY_CLASS.ATT_C);
  if (mc) {
    return { outcome: OUTCOME_MC, buckets: [] };
  }

  const status = candidates
    .filter((row) => classify(row) === DUTY_CLASS.STATUS)
    .sort((a, b) => (toIsoDate(a.start_date) || toIsoDate(a.date)).localeCompare(toIsoDate(b.start_date) || toIsoDate(b.date)))[0];
  if (status) {
    return { outcome: OUTCOME_STATUS, buckets: bucketsFor(status.reason) };
  }

  return { outcome: OUTCOME_NONE, buckets: [] };
}

/**
 * Adds to a link's running total, creating it at 0 if new.
 * @param {!Map<string, number>} links Link totals keyed by "source|target".
 * @param {string} source Source node name.
 * @param {string} target Target node name.
 * @param {number=} amount Amount to add; defaults to 1.
 * @returns {void}
 */
function addLink_(links, source, target, amount) {
  const key = source + '|' + target;
  links.set(key, (links.get(key) || 0) + (amount === undefined ? 1 : amount));
}

/**
 * Builds the report-sick Sankey: nodes, links, and the coverage a reader is owed.
 * @param {{personnel: Array<!Object>, episodes: Array<!Object>, submissions:
 *     Array<!Object>, from: ?string, to: ?string}} args The dataset's personnel rows and
 *     episodes, its FormSG submissions, and the date range to draw.
 * @returns {{nodes: Array<{name: string, stage: string}>, links: Array<{source: string,
 *     target: string, value: number}>, coverage: !Object}} The diagram and its coverage.
 */
export function reportSickFlow({ personnel, episodes, submissions, from, to }) {
  const reportSickEpisodes = episodes.filter((episode) => {
    if (episode.dutyClass !== DUTY_CLASS.REPORT_SICK) {
      return false;
    }
    const date = episodeEventDate_(episode);
    return date !== null && withinRange(date, from, to);
  });
  const subsInRange = (submissions || []).filter(
    (submission) => submission.date && withinRange(submission.date, from, to)
  );

  const { matches, formsgOnly } = matchSources_(reportSickEpisodes, subsInRange);

  const links = new Map();
  const nodeStage = new Map();
  const registerNode = (name, stage) => nodeStage.set(name, stage);

  let paradeOnlyCount = 0;
  let bothCount = 0;
  const statusBucketTotal = { sum: 0 };
  let statusOutcomeTotal = 0;

  /**
   * Routes one event (an episode/submission pair, or a FormSG-only submission) through
   * the four stages and adds its links.
   * @param {string} sourceLabel One of the SOURCE_* constants.
   * @param {string} key The event's identity key.
   * @param {string} eventDate The event's ISO date.
   * @param {string} reportSickType Raw FormSG type answer, or '' when there is none.
   * @returns {void}
   */
  function route(sourceLabel, key, eventDate, reportSickType) {
    const sourceNode = 'Source: ' + sourceLabel;
    const typeNode = 'Type: ' + shortType_(reportSickType);
    registerNode(sourceNode, 'source');
    registerNode(typeNode, 'type');
    addLink_(links, sourceNode, typeNode, 1);

    const { outcome, buckets } = outcomeFor_(key, eventDate, personnel);
    const outcomeNode = 'Outcome: ' + outcome;
    registerNode(outcomeNode, 'outcome');
    addLink_(links, typeNode, outcomeNode, 1);

    if (outcome === OUTCOME_STATUS) {
      statusOutcomeTotal += 1;
      buckets.forEach((bucket) => {
        const bucketNode = 'Status: ' + bucket;
        registerNode(bucketNode, 'status');
        addLink_(links, outcomeNode, bucketNode, 1);
        statusBucketTotal.sum += 1;
      });
    }
  }

  matches.forEach(({ episode, submission }) => {
    const eventDate = episodeEventDate_(episode);
    if (submission) {
      bothCount += 1;
      route(SOURCE_BOTH, episode.key, eventDate, submission.reportSickType);
    } else {
      paradeOnlyCount += 1;
      route(SOURCE_PARADE_ONLY, episode.key, eventDate, '');
    }
  });

  formsgOnly.forEach((submission) => {
    route(SOURCE_FORMSG_ONLY, submission.key, submission.date, submission.reportSickType);
  });

  const companiesWithNoFormSg = COMPANIES.filter(
    (company) => subsInRange.filter((submission) => submission.company === company).length === 0
  );

  const nodes = Array.from(nodeStage.entries()).map(([name, stage]) => ({ name, stage }));
  const linkList = Array.from(links.entries()).map(([key, value]) => {
    const [source, target] = key.split('|');
    return { source, target, value };
  });

  return {
    nodes,
    links: linkList,
    coverage: {
      totalEvents: paradeOnlyCount + bothCount + formsgOnly.length,
      sourceCounts: { paradeOnly: paradeOnlyCount, both: bothCount, formsgOnly: formsgOnly.length },
      matchRule:
        'Matched by 4D, else by name, within ' +
        SOURCE_MATCH_WINDOW_DAYS +
        ' day of the report-sick event; an outcome is an MC or Status starting ' +
        OUTCOME_MATCH_MIN_DAYS +
        '–' +
        OUTCOME_MATCH_MAX_DAYS +
        ' days after it.',
      companiesWithNoFormSg,
      statusMultiLabelled: statusBucketTotal.sum > statusOutcomeTotal,
    },
  };
}
