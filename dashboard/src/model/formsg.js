/**
 * Normalises FormSG report-sick submissions into the shape the views consume.
 *
 * This tab matters more than its row count suggests. In the parade state only 16 of 61
 * `Att C` rows carry any symptom detail — the rest are a bare "MC" — whereas FormSG asks
 * every soldier for a reason and a symptom list. It is therefore the *primary* source for
 * what people are actually reporting sick with, and the parade state is the secondary one.
 *
 * Company comes from a free-text "Unit & Coy" answer, so it is matched against the known
 * company names rather than trusted. An answer naming no known company is kept with a
 * blank company instead of being guessed at or dropped.
 *
 * Every function here is pure.
 */

import { extractSymptoms, keywords } from './classify.js';
import { normaliseName } from './identity.js';
import { toIsoDate, toNumber, toText } from './values.js';
import { COMPANIES, UNIT_TYPE_COMPANY } from './domain.js';
import { battalionStrength } from './metrics.js';

/**
 * Finds the company named in a free-text unit answer.
 * @param {string} text The "Unit & Coy" answer.
 * @returns {string} A known company name, or ''.
 */
function companyFrom_(text) {
  const value = toText(text).toUpperCase();
  return COMPANIES.filter((company) => value.includes(company.toUpperCase()))[0] || '';
}

/**
 * Maps FormSG records to a common submission shape.
 *
 * The form asks two different questions about the same illness and they must not be
 * merged. `symptomAnswer` is a pick-list — eight clean clinical options covering 97% of
 * submissions — and it is what the clinical breakdown counts. `reason` is free text, and
 * it is what the word cloud reads. Folding them into one string, as this function once
 * did, costs both: the pick-list can then only be recovered by searching the blob for its
 * own label, and the cloud fills up with the pick-list's boilerplate wording.
 *
 * `text` keeps the joined form, because the symptom lexicon works better across both
 * fields than across either alone — a soldier who picks "Others" often names the symptom
 * in the reason.
 * @param {Array<!Object>} rows Records from the FormSG tab.
 * @returns {Array<!Object>} Normalised submissions, oldest first.
 */
export function toSubmissions(rows) {
  return rows
    .map((row) => {
      const reason = toText(row['Reason for Reporting Sick (Keep Brief)']);
      const symptomAnswer = toText(row['I am experiencing _____________________ symptoms.']);
      const text = [reason, symptomAnswer].filter((part) => part !== '').join('. ');
      const name = toText(row['[Myinfo] Name']);
      const fourD = toText(row['4D Number (REC Only)']).toUpperCase();
      return {
        date: toIsoDate(row.Timestamp),
        timestamp: row.Timestamp,
        rank: toText(row.RANK),
        name,
        fourD,
        key: fourD !== '' ? '4D:' + fourD : name !== '' ? 'NAME:' + normaliseName(name) : '',
        company: companyFrom_(row['Unit & Coy']),
        unitText: toText(row['Unit & Coy']),
        reportSickType: toText(row['Report Sick Type']),
        reason,
        symptomAnswer,
        text,
        symptoms: extractSymptoms(text),
        keywords: keywords(text),
      };
    })
    .filter((submission) => submission.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The "reported sick" trend (FormSG submissions), battalion-wide or by company.
 *
 * A count, not a rate, in the companies scope: zero FormSG submissions in a day is a real
 * fact about that company, unlike a parade-state gap — nobody has to file a form for the
 * absence of one to be informative. Scorpion's whole FormSG history is zero for exactly
 * this reason, and it is drawn as a flat line at zero rather than a gap, which is the
 * honest picture of a channel with no adoption.
 * @param {Array<!Object>} submissions Normalised FormSG submissions from `toSubmissions`.
 * @param {Array<!Object>} strengthRows Normalised Strength Data records, for the
 *     battalion-scope rate.
 * @param {string[]} dates Dates to plot, oldest first.
 * @param {{scope?: string, session?: string}=} options `scope` is 'battalion' (a rate per
 *     100 accountable) or 'companies' (a raw count per company); `session` defaults to
 *     'FPS' and is used only to look up battalion strength for the rate.
 * @returns {{dates: string[], series: Array<{name: string, values: number[]}>}} The trend.
 */
export function submissionTrend(submissions, strengthRows, dates, options) {
  const scope = (options && options.scope) || 'battalion';
  const session = (options && options.session) || 'FPS';

  const byDate = new Map();
  submissions.forEach((submission) => {
    const bucket = byDate.get(submission.date) || new Map();
    bucket.set(submission.company, (bucket.get(submission.company) || 0) + 1);
    byDate.set(submission.date, bucket);
  });

  if (scope === 'companies') {
    return {
      dates,
      series: COMPANIES.map((company) => ({
        name: company,
        values: dates.map((date) => (byDate.get(date) || new Map()).get(company) || 0),
      })),
    };
  }

  return {
    dates,
    series: [
      {
        name: 'Battalion',
        values: dates.map((date) => {
          const total = Array.from((byDate.get(date) || new Map()).values()).reduce(
            (sum, count) => sum + count,
            0
          );
          const strength = battalionStrength(strengthRows, date, session);
          return strength.accountable > 0 ? (total / strength.accountable) * 100 : 0;
        }),
      },
    ],
  };
}

/**
 * The soldiers submitting the most FormSG report-sick forms.
 *
 * The parade-state "reporting sick" leaderboard (`leaderboards.topByCount` over
 * `DUTY_CLASS.REPORT_SICK` episodes) and this one answer different questions, because
 * they are different sources of the same real-world event: a soldier can submit the form
 * without a matching parade-state row yet, or the reverse. This module has no episode
 * concept — a FormSG submission is already one event, not a daily snapshot to collapse.
 * @param {Array<!Object>} submissions Normalised submissions from `toSubmissions`.
 * @param {number=} limit Rows to return; defaults to 10.
 * @returns {Array<{key: string, fourD: string, name: string, rank: string, company: string,
 *     count: number}>} Most submissions first, ties broken by name. No platoon: FormSG's
 *     "Unit & Coy" answer carries no platoon, so one cannot be shown here — see
 *     `docs/architecture_patterns.md` on deriving nothing the message does not state.
 */
export function topSubmitters(submissions, limit) {
  const bySoldier = new Map();
  submissions.forEach((submission) => {
    if (submission.key === '') return;
    const entry = bySoldier.get(submission.key) || {
      key: submission.key,
      fourD: submission.fourD,
      name: submission.name,
      rank: submission.rank,
      company: submission.company,
      count: 0,
    };
    entry.count += 1;
    entry.name = submission.name || entry.name;
    entry.company = submission.company || entry.company;
    bySoldier.set(submission.key, entry);
  });
  return Array.from(bySoldier.values())
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit || 10);
}

/**
 * FormSG submission rate by company, over the whole span the submissions and strength
 * rows both cover.
 *
 * There is no platoon-level counterpart: FormSG's "Unit & Coy" answer names a company,
 * never a platoon, so ranking platoons on "reported sick" is data this dashboard does not
 * have — the page showing this ranking says so rather than showing an empty column.
 * @param {Array<!Object>} submissions Normalised submissions, already restricted to the
 *     range being ranked.
 * @param {Array<!Object>} strengthRows Normalised Strength Data records, restricted to
 *     the same range.
 * @returns {Array<{company: string, count: number, per100: ?number}>} Companies ranked by
 *     rate, highest first; `per100` is null when the range has no strength on record.
 */
export function submissionRateByCompany(submissions, strengthRows) {
  const counts = new Map(COMPANIES.map((company) => [company, 0]));
  submissions.forEach((submission) => {
    if (counts.has(submission.company)) {
      counts.set(submission.company, counts.get(submission.company) + 1);
    }
  });

  const paxDays = new Map(COMPANIES.map((company) => [company, 0]));
  strengthRows
    .filter((row) => toText(row.unit_type) === UNIT_TYPE_COMPANY)
    .forEach((row) => {
      const company = toText(row.company);
      if (paxDays.has(company)) {
        paxDays.set(company, paxDays.get(company) + (toNumber(row.total_strength) || 0));
      }
    });

  return COMPANIES.map((company) => {
    const days = paxDays.get(company);
    return {
      company,
      count: counts.get(company),
      per100: days > 0 ? (counts.get(company) / days) * 100 : null,
    };
  }).sort((a, b) => (b.per100 || 0) - (a.per100 || 0));
}

/**
 * Counts submissions by their "Report Sick Type" answer.
 *
 * The parts are mutually exclusive and sum to every submission, so this feeds a donut.
 * A blank answer is a real outcome — some rows predate the form question — and is kept as
 * `Unspecified` rather than dropped. The donut reads best with at most four slices, so
 * any types past `limit` are folded into a single `Other`; the total is preserved.
 * @param {Array<!Object>} submissions Normalised submissions from `toSubmissions`.
 * @param {number=} limit Most slices to return; defaults to 4.
 * @returns {Array<{type: string, count: number}>} Types, most frequent first.
 */
export function reportSickTypeCounts(submissions, limit) {
  const cap = limit || 4;
  const counts = new Map();
  submissions.forEach((submission) => {
    const type = toText(submission.reportSickType) || 'Unspecified';
    counts.set(type, (counts.get(type) || 0) + 1);
  });
  const ranked = Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  if (ranked.length <= cap) {
    return ranked;
  }
  const head = ranked.slice(0, cap - 1);
  const tail = ranked.slice(cap - 1);
  return head.concat({
    type: 'Other',
    count: tail.reduce((sum, entry) => sum + entry.count, 0),
  });
}
