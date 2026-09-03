/**
 * Report sick: the parade-state and FormSG picture of who is reporting sick.
 *
 * Everything shared with MC/MA and Status lives in `CategoryPage`; this file supplies
 * only what is unique to report sick — the FormSG clinical-bucket trend, the free-text
 * word cloud, and the hour-of-day histogram, none of which the other two categories have
 * a source for.
 */

import { useMemo } from 'preact/hooks';
import { dataset } from '../app/state.js';
import { DUTY_CLASS } from '../model/classify.js';
import { buildEpisodes } from '../model/episodes.js';
import { toSubmissions } from '../model/formsg.js';
import { soldierIndex } from '../model/soldier.js';
import { clinicalBucketOf, reasonKeywords } from '../model/symptoms.js';
import { isWeekend } from '../model/dates.js';
import { withinRange } from '../model/dateRange.js';
import { toTimeOfDay } from '../model/values.js';
import { CategoryPage } from './shared/CategoryPage.jsx';

/** @type {string[]} Hour labels, 00:00 through 23:00. */
const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0') + ':00');

/**
 * Buckets FormSG submissions into hour-of-day bins, split by weekday/weekend.
 * @param {Array<!Object>} submissions Normalised FormSG submissions, already restricted
 *     to the range being drawn.
 * @returns {Array<{label: string, count: number, weekday: number, weekend: number}>} 24
 *     bins, midnight through 23:00, empty hours included.
 */
function hourBins(submissions) {
  const counts = HOUR_LABELS.map(() => ({ weekday: 0, weekend: 0 }));
  submissions.forEach((submission) => {
    const at = toTimeOfDay(submission.timestamp);
    if (!at || !submission.date) return;
    const bucket = counts[at.hour];
    if (isWeekend(submission.date)) {
      bucket.weekend += 1;
    } else {
      bucket.weekday += 1;
    }
  });
  return HOUR_LABELS.map((label, hour) => ({
    label,
    count: counts[hour].weekday + counts[hour].weekend,
    weekday: counts[hour].weekday,
    weekend: counts[hour].weekend,
  }));
}

/**
 * The Report Sick page.
 * @returns {!preact.VNode} The page.
 */
export function ReportSick() {
  const data = dataset.value;
  const episodes = useMemo(() => buildEpisodes(data.personnel), [data.personnel]);
  const submissions = useMemo(() => toSubmissions(data.formSg), [data.formSg]);
  const index = useMemo(() => soldierIndex(data.personnel, submissions), [data.personnel, submissions]);

  const reasonSource = useMemo(
    () => ({ rows: submissions, dateOf: (s) => s.date, labelsOf: (s) => [clinicalBucketOf(s.symptomAnswer)] }),
    [submissions]
  );
  const wordCloudBuilder = (from, to) =>
    reasonKeywords(submissions.filter((s) => withinRange(s.date, from, to)), 60);
  const histogramBuilder = (from, to) =>
    hourBins(submissions.filter((s) => withinRange(s.date, from, to)));

  return (
    <CategoryPage
      title="Report sick"
      dataset={data}
      episodes={episodes}
      dutyClass={DUTY_CLASS.REPORT_SICK}
      leaderboardMetric="count"
      reasonSource={reasonSource}
      showHeatmap
      showWordCloud
      wordCloudBuilder={wordCloudBuilder}
      showHistogram
      histogramBuilder={histogramBuilder}
      soldierIndex={index}
    />
  );
}
