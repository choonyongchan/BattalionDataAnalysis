/**
 * Status: the same shape as Report Sick and MC/MA, over the 10 normalised buckets
 * `statusBuckets.js` folds 403 free-text reasons into. Status is present-but-restricted,
 * never absence — `CategoryPage`'s trend reads it as a rate the same way it reads MC,
 * which is a rate of restriction, not a rate of loss.
 */

import { useMemo } from 'preact/hooks';
import { dataset } from '../app/state.js';
import { DUTY_CLASS } from '../model/classify.js';
import { buildEpisodes } from '../model/episodes.js';
import { toSubmissions } from '../model/formsg.js';
import { soldierIndex } from '../model/soldier.js';
import { bucketsFor } from '../model/statusBuckets.js';
import { CategoryPage } from './shared/CategoryPage.jsx';

/**
 * The Status page.
 * @returns {!preact.VNode} The page.
 */
export function Status() {
  const data = dataset.value;
  const episodes = useMemo(() => buildEpisodes(data.personnel), [data.personnel]);
  const submissions = useMemo(() => toSubmissions(data.formSg), [data.formSg]);
  const index = useMemo(() => soldierIndex(data.personnel, submissions), [data.personnel, submissions]);

  const statusEpisodes = useMemo(() => episodes.filter((e) => e.dutyClass === DUTY_CLASS.STATUS), [episodes]);
  const reasonSource = useMemo(
    () => ({ rows: statusEpisodes, dateOf: (e) => e.startDate, labelsOf: (e) => e.reasons.flatMap(bucketsFor) }),
    [statusEpisodes]
  );

  return (
    <CategoryPage
      title="Status"
      dataset={data}
      episodes={episodes}
      dutyClass={DUTY_CLASS.STATUS}
      leaderboardMetric="status"
      reasonSource={reasonSource}
      showHeatmap
      soldierIndex={index}
    />
  );
}
