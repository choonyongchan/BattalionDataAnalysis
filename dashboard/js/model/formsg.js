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
import { normaliseName, toIsoDate, toText } from './normalize.js';
import { COMPANIES } from './schema.js';

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
        rank: toText(row.RANK),
        name,
        fourD,
        key: fourD !== '' ? '4D:' + fourD : name !== '' ? 'NAME:' + normaliseName(name) : '',
        company: companyFrom_(row['Unit & Coy']),
        unitText: toText(row['Unit & Coy']),
        text,
        symptoms: extractSymptoms(text),
        keywords: keywords(text),
      };
    })
    .filter((submission) => submission.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Counts keyword frequency across free-text reasons.
 *
 * Built from the soldiers' own words rather than the symptom lexicon, because the cloud's
 * job is to surface phrasing the lexicon has not learned yet.
 * @param {Array<string[]>} keywordLists Per-submission keyword lists.
 * @param {number=} limit Most words to return; defaults to 40.
 * @returns {Array<{word: string, count: number}>} Words, most frequent first.
 */
export function keywordCounts(keywordLists, limit) {
  const counts = new Map();
  keywordLists.forEach((list) => {
    list.forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));
  });
  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit || 40);
}
